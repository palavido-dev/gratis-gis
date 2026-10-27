// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { DrawingsPromoteService } from './drawings-promote.service.js';

class PromoteDrawingDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

/**
 * Promote a drawing set to a data_layer (#154 Phase 1.5).
 *
 * Lives in its own controller/module so ItemsModule does not have
 * to import DataLayerFeaturesModule (which already imports
 * ItemsModule). Same pattern as OsmSaveAsLayerController.
 */
@ApiTags('drawings')
@ApiBearerAuth()
@Controller('items/:mapId/drawings')
export class DrawingsPromoteController {
  constructor(private readonly promoteSvc: DrawingsPromoteService) {}

  @Post(':drawingId/promote')
  promote(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Param('drawingId') drawingId: string,
    @Body() dto: PromoteDrawingDto,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    if (!isUuid(drawingId)) {
      throw new BadRequestException('drawingId must be a UUID');
    }
    if (!user) {
      throw new BadRequestException('Authentication required.');
    }
    return this.promoteSvc.promote({
      user,
      mapId,
      drawingId,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
    });
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
