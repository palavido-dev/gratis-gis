// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import type { RegisterFeatureAttachmentInput } from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import {
  FEATURE_ATTACHMENT_MAX_BYTES,
  StorageService,
} from '../storage/storage.service.js';
import { assertAttachmentAccess } from './attachments-access.js';
import { DataLayerAttachmentsService } from './attachments.service.js';

class RegisterAttachmentDto implements RegisterFeatureAttachmentInput {
  @IsString() @MaxLength(500) fileName!: string;
  @IsString() @MaxLength(255) mime!: string;
  @IsInt() @Min(0) @Max(FEATURE_ATTACHMENT_MAX_BYTES) sizeBytes!: number;
  @IsString() @MaxLength(1024) storageKey!: string;
  @IsString() @MaxLength(2048) storageUrl!: string;
}

/**
 * Per-feature attachment endpoints for v3 items. Mount under the same
 * path prefix as v3 feature CRUD so everything for a feature lives
 * under /items/:id/layers/:layerId/features/:fid/.
 *
 * Upload flow:
 *   1. Client POSTs /storage/presign-upload { kind: 'feature-attachment',
 *      contentType }. Returns { uploadUrl, publicUrl, key, maxBytes }.
 *   2. Client PUTs the bytes directly to MinIO at uploadUrl.
 *   3. Client POSTs here with { fileName, mime, sizeBytes, storageKey,
 *      storageUrl } to register the metadata.
 * The API never buffers the bytes, which is important for attachments
 * (can be 25 MB).
 */
@ApiTags('features', 'v3', 'attachments')
@ApiBearerAuth()
@Controller('items/:id/layers/:layerId/features/:fid/attachments')
export class DataLayerAttachmentsController {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly attachments: DataLayerAttachmentsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
  ) {
    await assertAttachmentAccess(
      this.items,
      this.sharing,
      user,
      itemId,
      layerId,
      'download',
    );
    return this.attachments.list(itemId, layerId, featureId);
  }

  @Post()
  async register(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Body() dto: RegisterAttachmentDto,
  ) {
    await assertAttachmentAccess(
      this.items,
      this.sharing,
      user,
      itemId,
      layerId,
      'write',
    );
    return this.attachments.register(
      itemId,
      layerId,
      featureId,
      dto,
      user.id,
    );
  }

  /**
   * Stream attachment bytes by id (#226). Resolves the row's stored
   * key so clients never have to parse storageUrl. Mirrors the
   * private-asset route's Content-Disposition / XSS policy.
   */
  @Get(':attId/download')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Param('attId') attachmentId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await assertAttachmentAccess(
      this.items,
      this.sharing,
      user,
      itemId,
      layerId,
      'download',
    );
    const row = await this.attachments.getForDownload(
      itemId,
      layerId,
      featureId,
      attachmentId,
    );
    const upstream = await this.storage.streamObject(
      row.storageKey,
      rangeHeader,
    );
    const servedType = (upstream.contentType ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    const inlineSafe = /^image\/(png|jpeg|webp|gif|avif)$/.test(servedType);
    const safeName = row.fileName.replace(/["\\\r\n]/g, '');

    res.status(upstream.statusCode);
    if (upstream.contentType) {
      res.setHeader('Content-Type', upstream.contentType);
    }
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    if (upstream.contentRange) {
      res.setHeader('Content-Range', upstream.contentRange);
    }
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${inlineSafe ? 'inline' : 'attachment'}; filename="${safeName}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.on('close', () => upstream.body.destroy());
    upstream.body.pipe(res);
  }

  @Delete(':attId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Param('attId') attachmentId: string,
  ) {
    await assertAttachmentAccess(
      this.items,
      this.sharing,
      user,
      itemId,
      layerId,
      'write',
    );
    await this.attachments.remove(itemId, layerId, featureId, attachmentId);
  }
}
