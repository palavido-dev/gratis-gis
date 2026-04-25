import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
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
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Prisma } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FeaturesService,
  type InsertFeatureInput,
  type UpdateFeatureInput,
} from './features.service.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

class FeatureGeometryDto {
  @IsString() type!: string;
  // coordinates can be any nested array: left loose intentionally.
  coordinates!: unknown;
}

class CreateFeatureDto {
  @IsOptional() @IsUUID('loose') globalId?: string;
  @IsOptional() @IsObject() geometry?: FeatureGeometryDto;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

class BulkImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFeatureDto)
  features!: CreateFeatureDto[];
}

class UpdateFeatureDto {
  @IsOptional() @IsObject() geometry?: Record<string, unknown>;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * REST endpoints for individual features within a data_layer item.
 *
 * All routes sit under /items/:id/features so the item-level sharing
 * check is the outer authorization gate, consistent with how the rest
 * of the portal API works.
 *
 * The temporal model: every write expires the old version (sets valid_to)
 * and inserts a new row. GET by default returns current state (valid_to IS NULL);
 * pass ?at=<ISO timestamp> for point-in-time queries.
 */
@ApiTags('features')
@ApiBearerAuth()
@Controller('items/:id/features')
export class FeaturesController {
  constructor(
    private readonly features: FeaturesService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
  ) {}

  // -------------------------------------------------------------------------
  // Auth helpers
  // -------------------------------------------------------------------------

  private async requireReadAccess(user: AuthUser, itemId: string) {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException('Item is not a feature service');
    }
    if (!(await this.features.tableExists(itemId))) {
      throw new NotFoundException('Feature table not provisioned for this item');
    }
    return item;
  }

  private async requireEditAccess(user: AuthUser, itemId: string) {
    const item = await this.requireReadAccess(user, itemId);
    const shares = await this.prisma.itemShare.findMany({ where: { itemId } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item');
    }
    return item;
  }

  /**
   * Edit access check that auto-provisions the PostGIS table if it does not
   * yet exist. Used by bulk import, which IS the first write that creates v2.
   */
  private async requireEditAccessAndProvision(user: AuthUser, itemId: string) {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException('Item is not a feature service');
    }
    const shares = await this.prisma.itemShare.findMany({ where: { itemId } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item');
    }
    // Create the PostGIS table on the first import. Idempotent.
    await this.features.provisionTable(itemId);
    return item;
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * List current features, optionally filtered by bounding box or
   * time-traveled to an arbitrary point in time.
   *
   * ?bbox=minX,minY,maxX,maxY
   * ?at=2025-01-01T00:00:00Z
   * ?limit=500
   * ?offset=0
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('since') since?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('meta') meta?: string,
  ) {
    await this.requireReadAccess(user, id);

    let parsedBbox: [number, number, number, number] | undefined;
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (
        parts.length !== 4 ||
        parts.some(isNaN) ||
        parts[0] === undefined || parts[1] === undefined ||
        parts[2] === undefined || parts[3] === undefined
      ) {
        throw new BadRequestException('bbox must be minX,minY,maxX,maxY');
      }
      parsedBbox = [parts[0], parts[1], parts[2], parts[3]];
    }

    const limit = limitStr ? Math.min(parseInt(limitStr, 10), 10_000) : 2_000;
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

    const queryOpts: Parameters<typeof this.features.query>[1] = { limit, offset };
    if (parsedBbox !== undefined) queryOpts.bbox = parsedBbox;
    if (since !== undefined) queryOpts.since = since;
    else if (at !== undefined) queryOpts.at = at;
    if (meta === 'true') queryOpts.includeMeta = true;

    const feats = await this.features.query(id, queryOpts);

    return { type: 'FeatureCollection', features: feats };
  }

  /**
   * Append one or more features to the service. Does NOT replace existing
   * features: use POST /import to replace all.
   */
  @Post()
  async append(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: BulkImportDto,
  ) {
    await this.requireEditAccess(user, id);
    const inputs: InsertFeatureInput[] = dto.features.map((f) => {
      const input: InsertFeatureInput = { properties: f.properties ?? {} };
      if (f.globalId !== undefined) input.globalId = f.globalId;
      if (f.geometry !== undefined) input.geometry = f.geometry;
      return input;
    });
    const result = await this.features.bulkInsert(id, inputs, user);
    await this.syncItemMeta(id);
    return result;
  }

  /**
   * Replace all current features atomically. Expires existing rows and
   * inserts the new set. This is the primary ingest path for client-side
   * uploads (GeoJSON, KML, etc.) once the service has a PostGIS table.
   */
  @Post('import')
  async bulkImport(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { type?: string; features?: unknown[] },
  ) {
    await this.requireEditAccessAndProvision(user, id);

    if (!body.features || !Array.isArray(body.features)) {
      throw new BadRequestException('Body must be a GeoJSON FeatureCollection with a features array');
    }

    const inputs: InsertFeatureInput[] = body.features.map((f: unknown) => {
      const feat = f as { type?: string; geometry?: unknown; properties?: Record<string, unknown>; id?: string };
      const input: InsertFeatureInput = { properties: feat.properties ?? {} };
      if (typeof feat.id === 'string') input.globalId = feat.id;
      if (feat.geometry !== undefined) input.geometry = feat.geometry;
      return input;
    });

    const result = await this.features.replaceAll(id, inputs, user);
    await this.syncItemMeta(id);
    return result;
  }

  /** Get a single feature by its global_id. */
  @Get(':fid')
  async getOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Query('at') at?: string,
  ) {
    await this.requireReadAccess(user, id);
    return this.features.getFeature(id, fid, at);
  }

  /** Get the full version history for a feature. */
  @Get(':fid/history')
  async history(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
  ) {
    await this.requireReadAccess(user, id);
    return this.features.getHistory(id, fid);
  }

  /** Update a feature's geometry and/or properties. */
  @Patch(':fid')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Body() dto: UpdateFeatureDto,
  ) {
    await this.requireEditAccess(user, id);
    const patch: UpdateFeatureInput = {};
    if (dto.geometry !== undefined) patch.geometry = dto.geometry;
    if (dto.properties !== undefined) patch.properties = dto.properties;
    const result = await this.features.updateFeature(id, fid, patch, user);
    await this.syncItemMeta(id);
    return result;
  }

  /** Soft-delete a feature by expiring its current version. */
  @Delete(':fid')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
  ) {
    await this.requireEditAccess(user, id);
    await this.features.deleteFeature(id, fid, user);
    await this.syncItemMeta(id);
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // Related-table read/write
  // -------------------------------------------------------------------------

  /**
   * List child records related to a specific parent feature.
   *
   * URL: GET /items/:id/features/:fid/related/:childItemId
   *   :id        : parent feature-service item
   *   :fid       : parent feature global_id
   *   :childItemId: child feature-service item
   *
   * Query: ?fkColumn=parent_global_id (defaults to "parent_global_id")
   *        ?at=<ISO timestamp>
   *        ?limit=100
   *        ?offset=0
   */
  @Get(':fid/related/:childItemId')
  async listRelated(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Param('childItemId') childItemId: string,
    @Query('fkColumn') fkColumn?: string,
    @Query('at') at?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    // Caller must be able to read the parent AND the child.
    await this.requireReadAccess(user, id);
    await this.requireReadAccess(user, childItemId);

    const opts: Parameters<typeof this.features.getRelatedFeatures>[3] = {
      limit: limitStr ? Math.min(parseInt(limitStr, 10), 5_000) : 500,
      offset: offsetStr ? parseInt(offsetStr, 10) : 0,
    };
    if (at !== undefined) opts.at = at;

    const feats = await this.features.getRelatedFeatures(
      childItemId,
      fid,
      fkColumn ?? 'parent_global_id',
      opts,
    );
    return { type: 'FeatureCollection', features: feats };
  }

  /**
   * Create a child record related to a specific parent feature.
   *
   * URL: POST /items/:id/features/:fid/related/:childItemId
   *
   * Body: { globalId?, geometry?, properties?, fkColumn? }
   */
  @Post(':fid/related/:childItemId')
  async createRelated(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Param('childItemId') childItemId: string,
    @Body()
    body: {
      globalId?: string;
      geometry?: unknown;
      properties?: Record<string, unknown>;
      fkColumn?: string;
    },
  ) {
    await this.requireReadAccess(user, id);
    await this.requireEditAccess(user, childItemId);

    const input: Parameters<typeof this.features.createRelatedFeature>[3] = {
      properties: body.properties ?? {},
    };
    if (body.globalId) input.globalId = body.globalId;
    if (body.geometry !== undefined) input.geometry = body.geometry;

    const result = await this.features.createRelatedFeature(
      childItemId,
      fid,
      body.fkColumn ?? 'parent_global_id',
      input,
      user,
    );
    await this.syncItemMeta(childItemId);
    return result;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * After any write, refresh the item's metadata (feature count, bbox,
   * updatedAt) so the portal item card reflects current state without a
   * separate manual step.
   */
  private async syncItemMeta(itemId: string): Promise<void> {
    try {
      const s = await this.features.stats(itemId);
      const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { data: true } });
      const existing = (item?.data ?? {}) as Record<string, unknown>;
      await this.prisma.item.update({
        where: { id: itemId },
        data: {
          data: {
            ...existing,
            version: 2,
            storageType: 'postgis',
            featureCount: s.featureCount,
            bbox: s.bbox,
            updatedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Non-fatal: metadata sync failure shouldn't roll back the write.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`syncItemMeta failed for ${itemId}: ${msg}`);
    }
  }
}
