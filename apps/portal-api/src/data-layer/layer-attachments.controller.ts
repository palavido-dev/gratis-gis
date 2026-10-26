// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { assertAttachmentAccess } from './attachments-access.js';
import { DataLayerAttachmentsService } from './attachments.service.js';

class ListLayerAttachmentsQuery {
  /**
   * Comma-separated feature UUIDs. Mutually exclusive with `all`
   * in spirit: the service requires one or the other.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  featureIds?: string;

  /** When true, return every attachment on the layer. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === '1' || value === 'true')
  @IsBoolean()
  all?: boolean;
}

/**
 * Layer-wide attachment inventory (#226). Lives at
 * `/items/:id/layers/:layerId/attachments` so a bulk photo inventory
 * is one request instead of one per feature.
 */
@ApiTags('features', 'v3', 'attachments')
@ApiBearerAuth()
@Controller('items/:id/layers/:layerId/attachments')
export class DataLayerLayerAttachmentsController {
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
    @Query() query: ListLayerAttachmentsQuery,
  ) {
    await assertAttachmentAccess(
      this.items,
      this.sharing,
      user,
      itemId,
      layerId,
      'download',
    );
    const featureIds = (query.featureIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return this.attachments.listForLayer(itemId, layerId, {
      featureIds,
      all: query.all === true,
    });
  }
}
