// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import type { AssetKind } from './storage.service.js';
import { StorageService } from './storage.service.js';

// Kinds the browser may request a presigned PUT for. `map-icon` is
// deliberately absent (its upload path sanitizes server-side and
// uses uploadBuffer, never a browser presign).
const ASSET_KINDS: AssetKind[] = [
  'item-thumb',
  'group-thumb',
  'user-avatar',
  'org-hero',
  'feature-attachment',
  'item-file',
  'item-tile-layer',
];

const PRIVATE_KINDS_FOR_ROUTE = new Set<AssetKind>([
  'feature-attachment',
  'item-file',
  'item-tile-layer',
  'item-point-cloud',
]);

class PresignUploadDto {
  @IsEnum(ASSET_KINDS) kind!: AssetKind;
  /** Thumbnails stay image-only (the service layer enforces); feature
   *  attachments accept any MIME so we only validate non-empty here. */
  @IsString() @MaxLength(255) contentType!: string;
}

/**
 * Bare key shape we accept on the private download route.  Same
 * pattern as the storage keys we mint (UUID v4), bounded so a
 * malicious caller can't slip a slash-containing key through.
 */
const KEY_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minting presigned URLs requires a valid auth token (the global JWT
 * guard handles that). Beyond auth, we don't gate by role here: any
 * authenticated user may upload imagery for entities they own, and the
 * PATCH endpoint that persists the URL is where we enforce ownership.
 * A leaked presigned URL just lets someone burn 5 MB of our storage,
 * which is a 60-second window and a clear abuse signal if it happens.
 */
@ApiTags('storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
  ) {}

  @Post('presign-upload')
  async presignUpload(
    @CurrentUser() _user: AuthUser,
    @Body() dto: PresignUploadDto,
  ) {
    try {
      return await this.storage.presignUpload(dto.kind, dto.contentType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign upload';
      throw new BadRequestException(msg);
    }
  }

  /**
   * Sharing-checked download of a private-kind storage object.  The
   * url shape is `/api/storage/private/:kind/:key` where `:key` is
   * the UUID returned at upload time (without the `<kind>/` prefix).
   *
   * Sharing-check shape depends on the kind:
   *   - feature-attachment: look up the FeatureAttachment row by
   *     storageKey, then ACL-check the parent item.
   *   - item-file: look up the Item by data->>'storageKey', then
   *     ACL-check.
   *   - item-tile-layer: tile-layer.controller.ts already mediates
   *     these via `/tile-layer/:itemId/file` and has its own
   *     range-aware proxy.  Calls here are unusual; we mirror the
   *     item-file behavior for completeness.
   *
   * Bytes are streamed via the SDK (using portal-api's credentials)
   * so this keeps working after the bucket policy is tightened to
   * deny anonymous GET on private prefixes.  Range header is
   * forwarded so attachment-viewer apps that ask for `bytes=0-` keep
   * working.
   */
  @Public()
  @Get('private/:kind/:key')
  async getPrivateAsset(
    // `user` is nullable here because the endpoint is @Public(). An
    // anonymous browser request hitting an <img src> for a file-item
    // referenced by a publicly-shared web-app needs to succeed; the
    // BFF doesn't add a Bearer token on those requests. When user is
    // null we fall back to the access='public' fast path; when user
    // is present we use the standard sharing check.
    @CurrentUser() user: AuthUser | null,
    @Param('kind') kindParam: string,
    @Param('key') key: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() _req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const kind = kindParam as AssetKind;
    if (!PRIVATE_KINDS_FOR_ROUTE.has(kind)) {
      throw new BadRequestException(`Unsupported kind: ${kindParam}`);
    }
    if (!KEY_SHAPE.test(key)) {
      throw new BadRequestException('Invalid key');
    }

    // Composed storage key the same way the mint path does, so the
    // SDK can find the right object.
    const storageKey = `${kind}/${key}`;

    // Sharing check + filename for content-disposition.
    let filename = key;
    let safeMime = 'application/octet-stream';
    if (kind === 'feature-attachment') {
      const att = await this.prisma.featureAttachment.findFirst({
        where: { storageKey },
        select: {
          fileName: true,
          mime: true,
          itemId: true,
          layerId: true,
        },
      });
      if (!att) throw new NotFoundException('Attachment not found');
      filename = att.fileName || key;
      safeMime = att.mime || 'application/octet-stream';
      // ACL: read on the parent data_layer item. Anonymous callers
      // are only allowed if the parent is access='public'.
      if (user) {
        const item = await this.items.get(user, att.itemId);
        const shares = await this.prisma.itemShare.findMany({
          where: { itemId: att.itemId },
        });
        if (!this.sharing.canRead(user, item, shares)) {
          throw new ForbiddenException('Cannot read this attachment');
        }
      } else {
        const parent = await this.prisma.item.findFirst({
          where: { id: att.itemId, access: 'public', deletedAt: null },
          select: { id: true },
        });
        if (!parent) {
          throw new ForbiddenException('Cannot read this attachment');
        }
      }
    } else if (
      kind === 'item-file' ||
      kind === 'item-tile-layer' ||
      kind === 'item-point-cloud'
    ) {
      // Walk the Item table to find the row that points at this key.
      // Both `item.data->>'storageKey'` and `item.storageRef` get
      // checked because different item types persist the key in
      // different places.
      const item = await this.prisma.item.findFirst({
        where: {
          OR: [
            { storageRef: storageKey },
            { data: { path: ['storageKey'], equals: storageKey } },
            { data: { path: ['pmtilesStorageKey'], equals: storageKey } },
            { data: { path: ['cogStorageKey'], equals: storageKey } },
          ],
          deletedAt: null,
        },
        select: { id: true, type: true, data: true, access: true },
      });
      if (!item) throw new NotFoundException('File not found');
      // Pull mime + filename when present in item.data.
      const data = (item.data ?? {}) as Record<string, unknown>;
      filename =
        (typeof data.fileName === 'string' && data.fileName) ||
        (typeof data.originalFileName === 'string' && data.originalFileName) ||
        key;
      safeMime =
        (typeof data.mime === 'string' && data.mime) ||
        (typeof data.contentType === 'string' && data.contentType) ||
        'application/octet-stream';
      if (user) {
        // ACL: read on the item via the standard guard.
        const itemFull = await this.items.get(user, item.id);
        const shares = await this.prisma.itemShare.findMany({
          where: { itemId: item.id },
        });
        if (!this.sharing.canRead(user, itemFull, shares)) {
          throw new ForbiddenException('Cannot read this file');
        }
      } else if (item.access !== 'public') {
        // Anonymous: only public-shared items resolve.
        throw new ForbiddenException('Cannot read this file');
      }
    }

    // Stream bytes.  Force Content-Disposition: attachment for
    // anything outside an image MIME allowlist so an HTML upload
    // cannot render inline as an XSS payload from this origin.
    const isImage = /^image\/(png|jpeg|webp|gif|svg\+xml)$/i.test(safeMime);
    const upstream = await this.storage.streamObject(storageKey, rangeHeader);

    res.status(upstream.statusCode);
    if (upstream.contentType) res.setHeader('Content-Type', upstream.contentType);
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    if (upstream.contentRange) res.setHeader('Content-Range', upstream.contentRange);
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${isImage ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');

    upstream.body.pipe(res);
  }
}
