import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import type { ItemShare } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { V3FeaturesService } from './v3-features.service.js';

class AppendFeatureDto {
  @IsOptional() @IsString() globalId?: string;
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

class AppendFeaturesBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppendFeatureDto)
  features!: AppendFeatureDto[];
}

class UpdateFeatureBodyDto {
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

/**
 * Per-layer feature CRUD for v3 data_layer items.
 *
 * Routes sit under /items/:id/layers/:layerId/... so they live
 * alongside the item-level routes but don't collide with v1/v2's
 * /items/:id/features endpoints.
 *
 * Auth: ItemsService.get() is called at the start of each handler to
 * enforce visibility (throws 403/404 as needed); sharing rights drive
 * read vs write gating via canEdit().
 */
@ApiTags('features', 'v3')
@ApiBearerAuth()
@Controller('items/:id/layers/:layerId')
export class V3FeaturesController {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly v3: V3FeaturesService,
  ) {}

  @Get('features')
  async listFeatures(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    const { geoLimit } = await this.assertV3Layer(user, itemId, layerId, 'read');
    const opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
    } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        opts.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
      }
    }
    if (at) opts.at = at;
    if (geoLimit) opts.geoLimit = geoLimit;
    return this.v3.listFeatures(itemId, layerId, opts);
  }

  /** GeoJSON view of a single layer — the map editor's overlay source
   *  hits this per-layer URL for v3 items, the same way v2 items use
   *  /items/:id/geojson. */
  @Get('geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    return this.listFeatures(user, itemId, layerId, bbox, at);
  }

  @Post('features')
  async append(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() body: AppendFeaturesBodyDto,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    return this.v3.insertFeatures(itemId, layerId, body.features, user);
  }

  @Patch('features/:fid')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Body() body: UpdateFeatureBodyDto,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    const patch: { geometry?: unknown; properties?: Record<string, unknown> } = {};
    if (body.geometry !== undefined) patch.geometry = body.geometry;
    if (body.properties !== undefined) patch.properties = body.properties;
    return this.v3.updateFeature(itemId, layerId, featureId, patch, user);
  }

  @Delete('features/:fid')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    await this.v3.deleteFeature(itemId, layerId, featureId, user);
  }

  /** Verify the item exists, is a v3 data_layer, the caller can
   *  read (or edit) it, and the named layer is part of its schema.
   *  Returns the geographic restriction (if any) that applies to this
   *  caller on this item so the query can clip rows to the allowed
   *  area. Null means no restriction — either because the caller has
   *  unrestricted access (owner / admin / org / public) or because
   *  their share(s) don't carry a polygon. */
  private async assertV3Layer(
    user: AuthUser,
    itemId: string,
    layerId: string,
    mode: 'read' | 'write',
  ): Promise<{ geoLimit: unknown | null }> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new NotFoundException('Not a data_layer item');
    }
    const data = item.data as {
      version?: number;
      layers?: Array<{ id: string; parentLayerId?: string }>;
    } | null;
    if (data?.version !== 3) {
      throw new NotFoundException(
        'Item is not a v3 multi-layer data_layer',
      );
    }
    const layers = data.layers ?? [];
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema`,
      );
    }
    if (mode === 'write') {
      // Authoritative edit gate: same helper update() uses.
      await this.items.assertCanEdit(user, itemId);
    }
    // Geo-limit is only meaningful on read — writes go through
    // canEdit which doesn't use a polygon today (the share either
    // grants edit or doesn't). For reads, consult every matching
    // share's polygon to build the union. Owners / admins return
    // null (no restriction).
    let geoLimit: unknown | null = null;
    if (mode === 'read') {
      const withShares = item as typeof item & { shares?: ItemShare[] };
      geoLimit = await this.sharing.geoLimitFor(
        user,
        item,
        withShares.shares ?? [],
      );
    }
    return { geoLimit };
  }
}
