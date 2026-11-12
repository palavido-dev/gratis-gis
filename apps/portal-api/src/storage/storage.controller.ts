// SPDX-License-Identifier: AGPL-3.0-or-later
import { hasCapability } from '../auth/capabilities.js';
import { Prisma } from '@prisma/client';
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
import { IsEnum, IsInt, MaxLength, Min, IsString } from 'class-validator';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import {
  SharingService,
  featureScopeFilter,
  isScopeLimited,
  type FeatureScopeFilter,
} from '../items/sharing.service.js';
import { DataLayerEngine } from '../engine/data-layer.js';
import { visibleFeatureIds } from '../data-layer/attachments-access.js';
import { publicTierGeoLimit } from '../public/public-geo-limit.js';
import type { GeoJsonGeometry } from '@gratis-gis/engine';
import type { AssetKind } from './storage.service.js';
import { StorageService } from './storage.service.js';
import {
  LARGE_UPLOAD_KINDS,
  assertLargeGrantRoom,
  recordUploadGrant,
} from './key-ownership.js';
import { contentDisposition } from '../common/content-disposition.js';

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
  'item-point-cloud',
];

const PRIVATE_KINDS_FOR_ROUTE = new Set<AssetKind>([
  'feature-attachment',
  'item-file',
  'item-tile-layer',
  'item-point-cloud',
]);

export class PresignUploadDto {
  @IsEnum(ASSET_KINDS) kind!: AssetKind;
  /** Thumbnails stay image-only (the service layer enforces); feature
   *  attachments accept any MIME so we only validate non-empty here. */
  @IsString() @MaxLength(255) contentType!: string;
  /** Declared upload size in bytes. The server refuses an over-cap
   *  upload and signs the size into the presigned PUT so the client
   *  cannot upload more than the size we validated. Required: while it
   *  was optional "for older clients", the per-kind cap was advisory
   *  for every caller that left it out, and four call sites in our own
   *  web app did. */
  @IsInt() @Min(0) sizeBytes!: number;
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
 * guard handles that). Small kinds (avatars, thumbnails, attachments)
 * are open to any signed-in user; the PATCH or attach that persists
 * the key is where ownership is enforced. The large kinds (tile
 * layers and point clouds, up to 8 GB per URL) need the publish
 * capability, since only a contributor can create the item they
 * belong to, and a user may hold only a few such URLs at once.
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
    private readonly engine: DataLayerEngine,
  ) {}

  private async assertAttachmentFeatureVisible(
    att: { itemId: string; layerId: string; featureId: string },
    access: { shareScope: FeatureScopeFilter; isTable: boolean },
  ): Promise<void> {
    const visible = await visibleFeatureIds(
      this.engine,
      att.itemId,
      att.layerId,
      [att.featureId],
      access,
    );
    if (!visible.has(att.featureId)) {
      throw new NotFoundException('Attachment not found');
    }
  }

  @Post('presign-upload')
  async presignUpload(
    @CurrentUser() user: AuthUser,
    @Body() dto: PresignUploadDto,
  ) {
    if (LARGE_UPLOAD_KINDS.has(dto.kind) && !hasCapability(user, 'can_publish_items')) {
      throw new ForbiddenException(
        'Uploading tile layers and point clouds needs a contributor or admin role.',
      );
    }
    await assertLargeGrantRoom(this.prisma, dto.kind, user.id);
    let signed;
    try {
      signed = await this.storage.presignUpload(
        dto.kind,
        dto.contentType,
        dto.sizeBytes,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign upload';
      throw new BadRequestException(msg);
    }
    // Record who was issued the key. Attach paths accept a key only
    // from the user it was issued to (storage/key-ownership.ts).
    await recordUploadGrant(this.prisma, dto.kind, signed.key, user.id);
    return signed;
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
    if (kind === 'feature-attachment') {
      // Oldest row decides the ACL. Attach paths refuse a copied key
      // now, but rows from before that check can share one, and the
      // copy is always the newer row.
      const att = await this.prisma.featureAttachment.findFirst({
        where: { storageKey },
        orderBy: { createdAt: 'asc' },
        select: {
          fileName: true,
          itemId: true,
          layerId: true,
          featureId: true,
        },
      });
      if (!att) throw new NotFoundException('Attachment not found');
      filename = att.fileName || key;
      // #224: attachments are binaries (site photos); honour the
      // download tier the same way CSV / GeoParquet exports do.
      // Anonymous callers are only allowed if the parent is
      // access='public' (public implies download).
      if (user) {
        const item = await this.items.get(user, att.itemId);
        const shares = await this.prisma.itemShare.findMany({
          where: { itemId: att.itemId },
        });
        if (!this.sharing.canDownload(user, item, shares)) {
          throw new ForbiddenException('Cannot download this attachment');
        }
        // A direct key link must not reach further than the layer
        // attachment routes: the feature has to be inside the
        // caller's own-rows and geo limit.
        const layer = attachmentLayer(item.data, att.layerId);
        const scope = await this.sharing.featureScopeFor(user, item, shares, {
          action: 'read',
          layerPolicy: layer?.editingPolicy ?? 'all-rows',
        });
        if (isScopeLimited(scope)) {
          await this.assertAttachmentFeatureVisible(att, {
            shareScope: featureScopeFilter(scope),
            isTable: layer?.geometryType === null,
          });
        }
      } else {
        const parent = await this.prisma.item.findFirst({
          where: { id: att.itemId, access: 'public', deletedAt: null },
          select: { id: true, data: true, publicGeoBoundaryId: true },
        });
        if (!parent) {
          throw new ForbiddenException('Cannot download this attachment');
        }
        // The public tier boundary clips anonymous readers too.
        const clip = await publicTierGeoLimit(
          this.prisma,
          parent.publicGeoBoundaryId,
        );
        if (clip !== undefined) {
          const layer = attachmentLayer(parent.data, att.layerId);
          await this.assertAttachmentFeatureVisible(att, {
            shareScope: { geoLimit: clip as GeoJsonGeometry },
            isTable: layer?.geometryType === null,
          });
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
      //
      // Containment (`@>`) is what the item_data_gin index serves, and
      // storage_ref has its own index, so this is a pair of index
      // probes. The JSON path equality used before matched the same
      // rows but scanned and detoasted every item on each download.
      const owners = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "item"
        WHERE deleted_at IS NULL
          AND (
            storage_ref = ${storageKey}
            OR data_json @> jsonb_build_object('storageKey', ${storageKey}::text)
            OR data_json @> jsonb_build_object('pmtilesStorageKey', ${storageKey}::text)
            OR data_json @> jsonb_build_object('cogStorageKey', ${storageKey}::text)
          )
        ORDER BY created_at ASC
        LIMIT 1`);
      const item = owners[0]
        ? await this.prisma.item.findUnique({
            where: { id: owners[0].id },
            select: { id: true, type: true, data: true, access: true },
          })
        : null;
      if (!item) throw new NotFoundException('File not found');
      // Pull the filename when present in item.data.
      const data = (item.data ?? {}) as Record<string, unknown>;
      filename =
        (typeof data.fileName === 'string' && data.fileName) ||
        (typeof data.originalFileName === 'string' && data.originalFileName) ||
        key;
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
    // anything outside a raster-image allowlist so an HTML upload
    // cannot render inline as an XSS payload from this origin.
    // The decision keys off the Content-Type actually going out on
    // the wire (the stored object's), NOT the DB-recorded mime:
    // the two can disagree (the presigned PUT stamps the stored
    // type, register() records whatever the client claimed), and
    // the browser acts on the served header.  SVG is deliberately
    // absent from the allowlist: it is a script container, so it
    // downloads like any other active type.  Unknown or missing
    // types default to attachment.
    const upstream = await this.storage.streamObject(storageKey, rangeHeader);
    // Tear down the S3 read stream when the client disconnects (or the
    // response finishes) so its socket returns to the pool instead of
    // draining to the end. `pipe` does not destroy the source on a
    // destination close, and range-read viewers abort constantly.
    // destroy() is idempotent, so firing on a normal finish is safe.
    // Registered before any header is set, so a throw below cannot
    // leave the stream open until the SDK's idle timeout.
    res.on('close', () => upstream.body.destroy());
    const servedType = (upstream.contentType ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const inlineSafe = /^image\/(png|jpeg|webp|gif|avif)$/.test(servedType);

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
      contentDisposition(inlineSafe ? 'inline' : 'attachment', filename),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    upstream.body.pipe(res);
  }
}

/** The v3 layer an attachment hangs off, for its policy and type. */
function attachmentLayer(
  data: unknown,
  layerId: string,
):
  | { editingPolicy?: 'all-rows' | 'own-rows-only'; geometryType?: string | null }
  | undefined {
  const layers = (data as {
    layers?: Array<{
      id: string;
      editingPolicy?: 'all-rows' | 'own-rows-only';
      geometryType?: string | null;
    }>;
  } | null)?.layers;
  return layers?.find((l) => l.id === layerId);
}
