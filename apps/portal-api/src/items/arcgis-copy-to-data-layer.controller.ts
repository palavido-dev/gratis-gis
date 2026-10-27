// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ARCGIS_COPY_FEATURE_HARD_CAP } from '../import-ago/hosted-fs.js';
import { ArcgisCopyToDataLayerService } from './arcgis-copy-to-data-layer.service.js';

class CopyToDataLayerDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  layerIds?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(ARCGIS_COPY_FEATURE_HARD_CAP)
  maxFeatures?: number;
}

/**
 * Copy selected ArcGIS FeatureServer layers into a portal data_layer.
 * Own module (like drawings-promote) so ItemsModule does not cycle
 * through DataLayerFeaturesModule via ImportAgoModule.
 */
@ApiTags('arcgis-service')
@ApiBearerAuth()
@Controller('items')
export class ArcgisCopyToDataLayerController {
  constructor(private readonly copySvc: ArcgisCopyToDataLayerService) {}

  @Post(':id/copy-to-data-layer')
  copy(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Body() dto: CopyToDataLayerDto,
  ) {
    if (!isUuid(itemId)) {
      throw new BadRequestException('id must be a UUID');
    }
    if (!user) {
      throw new BadRequestException('Authentication required.');
    }
    return this.copySvc.copy({
      user,
      itemId,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.layerIds !== undefined ? { layerIds: dto.layerIds } : {}),
      ...(dto.maxFeatures !== undefined
        ? { maxFeatures: dto.maxFeatures }
        : {}),
    });
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
