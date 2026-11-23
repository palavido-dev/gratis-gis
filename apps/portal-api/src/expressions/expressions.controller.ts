// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { MAX_EXPRESSION_LENGTH } from '@gratis-gis/shared-types';
import { ExpressionsService, MAX_EVALUATE_EXPRESSIONS, MAX_EVALUATE_ROWS } from './expressions.service.js';
import type { ItemWithShares } from './expression-data.js';

class EvaluateDto {
  /** Expressions by a caller-chosen key, such as a popup field name. */
  @IsObject()
  expressions!: Record<string, string>;

  @IsOptional() @IsArray() @ArrayMaxSize(MAX_EVALUATE_ROWS) @IsString({ each: true })
  featureIds?: string[];

  @IsOptional() @IsInt() @Min(1) @Max(MAX_EVALUATE_ROWS)
  limit?: number;
}

/**
 * Server-side expression evaluation for one layer: the builder's
 * preview, popups, and the list of sources the builder offers.
 */
@ApiTags('expressions')
@ApiBearerAuth()
@Controller('items/:id/layers/:layerId/expressions')
export class ExpressionsController {
  constructor(
    private readonly items: ItemsService,
    private readonly expressions: ExpressionsService,
  ) {}

  @Post('evaluate')
  @HttpCode(200)
  async evaluate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('layerId') layerId: string,
    @Body() dto: EvaluateDto,
  ) {
    const entries = Object.entries(dto.expressions ?? {});
    if (entries.length > MAX_EVALUATE_EXPRESSIONS) {
      throw new BadRequestException(`At most ${MAX_EVALUATE_EXPRESSIONS} expressions per request`);
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || v.length > MAX_EXPRESSION_LENGTH || k.length > 100) {
        throw new BadRequestException('Each expression must be text');
      }
    }
    const item = (await this.items.get(user, id)) as unknown as ItemWithShares;
    if (item.type !== 'data_layer') throw new BadRequestException('Expressions run on data layers');
    return this.expressions.evaluate({
      viewer: user,
      item,
      layerId,
      expressions: dto.expressions,
      ...(dto.featureIds ? { featureIds: dto.featureIds } : {}),
      ...(dto.limit ? { limit: dto.limit } : {}),
    });
  }

  @Get('sources')
  async sources(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('layerId') layerId: string,
  ) {
    const item = (await this.items.get(user, id)) as unknown as ItemWithShares;
    if (item.type !== 'data_layer') throw new BadRequestException('Expressions run on data layers');
    return this.expressions.sources(user, item, layerId);
  }
}
