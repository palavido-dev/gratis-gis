// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { FEATURE_ATTACHMENT_MAX_BYTES } from '../storage/storage.service.js';
import { DataLayerAttachmentsService } from './attachments.service.js';

class RegisterAttachmentDto {
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
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
  ) {
    await this.assertFeatureAccess(user, itemId, layerId, 'download');
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
    await this.assertFeatureAccess(user, itemId, layerId, 'write');
    return this.attachments.register(
      itemId,
      layerId,
      featureId,
      dto,
      user.id,
    );
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
    await this.assertFeatureAccess(user, itemId, layerId, 'write');
    await this.attachments.remove(itemId, layerId, featureId, attachmentId);
  }

  /**
   * Verify the item exists, is a v3 data_layer with this layer in
   * its schema, and the caller has the right permission level.
   * #224: list/download uses canDownload (not mere canRead);
   * writes also honour attachmentsEnabled on the sublayer.
   */
  private async assertFeatureAccess(
    user: AuthUser,
    itemId: string,
    layerId: string,
    mode: 'download' | 'write',
  ): Promise<void> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new NotFoundException('Not a data_layer item');
    }
    const data = item.data as {
      version?: number;
      layers?: Array<{ id: string; attachmentsEnabled?: boolean }>;
    } | null;
    if (data?.version !== 3) {
      throw new NotFoundException(
        'Attachments are supported on v3 feature-services only',
      );
    }
    const layer = (data.layers ?? []).find((l) => l.id === layerId);
    if (!layer) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema`,
      );
    }
    if (mode === 'write') {
      if (layer.attachmentsEnabled === false) {
        throw new ForbiddenException(
          'Attachments are disabled on this layer',
        );
      }
      await this.items.assertCanEdit(user, itemId);
      return;
    }
    // download: same tier as CSV / GeoParquet (#224).
    const shares = (
      item as { shares?: Parameters<SharingService['canDownload']>[2] }
    ).shares ?? [];
    if (!this.sharing.canDownload(user, item, shares)) {
      throw new ForbiddenException(
        'Download permission is required to access attachments',
      );
    }
  }
}
