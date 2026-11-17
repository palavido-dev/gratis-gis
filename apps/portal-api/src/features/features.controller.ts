// SPDX-License-Identifier: AGPL-3.0-or-later
import { withLockedItem } from '../items/item-data-lock.js';
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
import type { ItemShare, Prisma } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import {
  SharingService,
  isScopeLimited,
  type FeatureScope,
} from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertNotV3DataLayer } from './v3-guard.js';
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
    assertNotV3DataLayer(item);
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
    assertNotV3DataLayer(item);
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
    const item = await this.requireReadAccess(user, id);
    const scope = await this.scopeFor(user, item, 'read');

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
    if (scope) queryOpts.scope = scope;

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
    const item = await this.requireEditAccess(user, id);
    const scope = await this.scopeFor(user, item, 'edit');
    if (scope) {
      await this.features.assertGeometriesInsideLimit(
        scope,
        dto.features.map((f) => f.geometry),
      );
    }
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
    const item = await this.requireEditAccessAndProvision(user, id);
    // Import replaces every row of the layer, which a share limited to
    // some rows or some area cannot authorize.
    if (await this.scopeFor(user, item, 'edit')) {
      throw new ForbiddenException(
        'Your share on this layer is limited to some rows or an area, so you cannot replace the whole layer',
      );
    }

    if (!body.features || !Array.isArray(body.features)) {
      throw new BadRequestException('Body must be a GeoJSON FeatureCollection with a features array');
    }

    const inputs: InsertFeatureInput[] = body.features.map((f: unknown, i: number) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new BadRequestException(`features[${i}] is not a GeoJSON Feature object`);
      }
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
    const item = await this.requireReadAccess(user, id);
    const scope = await this.scopeFor(user, item, 'read');
    return this.features.getFeature(id, fid, at, scope);
  }

  /** Get the full version history for a feature. */
  @Get(':fid/history')
  async history(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
  ) {
    const item = await this.requireReadAccess(user, id);
    const scope = await this.scopeFor(user, item, 'read');
    return this.features.getHistory(id, fid, scope);
  }

  /** Update a feature's geometry and/or properties. */
  @Patch(':fid')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('fid') fid: string,
    @Body() dto: UpdateFeatureDto,
  ) {
    const item = await this.requireEditAccess(user, id);
    const scope = await this.scopeFor(user, item, 'edit');
    const patch: UpdateFeatureInput = {};
    if (dto.geometry !== undefined) patch.geometry = dto.geometry;
    if (dto.properties !== undefined) patch.properties = dto.properties;
    const result = await this.features.updateFeature(id, fid, patch, user, scope);
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
    const item = await this.requireEditAccess(user, id);
    const scope = await this.scopeFor(user, item, 'edit');
    await this.features.deleteFeature(id, fid, user, scope);
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
    const parent = await this.requireReadAccess(user, id);
    const child = await this.requireReadAccess(user, childItemId);
    // The parent must be visible to the caller, and the children are
    // clipped to the caller's scope on the child layer.
    const fk = relationshipFk(parent, childItemId, fkColumn);
    const parentScope = await this.scopeFor(user, parent, 'read');
    await this.features.getFeature(id, fid, undefined, parentScope);
    const childScope = await this.scopeFor(user, child, 'read');

    const opts: Parameters<typeof this.features.getRelatedFeatures>[3] = {
      limit: limitStr ? Math.min(parseInt(limitStr, 10), 5_000) : 500,
      offset: offsetStr ? parseInt(offsetStr, 10) : 0,
    };
    if (at !== undefined) opts.at = at;
    if (childScope) opts.scope = childScope;

    const feats = await this.features.getRelatedFeatures(
      childItemId,
      fid,
      fk,
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
    const parent = await this.requireReadAccess(user, id);
    const child = await this.requireEditAccess(user, childItemId);
    const fk = relationshipFk(parent, childItemId, body.fkColumn);
    // The parent feature must exist (and be visible), whether or not
    // the caller is scope-limited.
    const parentScope = await this.scopeFor(user, parent, 'read');
    await this.features.getFeature(id, fid, undefined, parentScope);
    const childScope = await this.scopeFor(user, child, 'edit');
    if (childScope) {
      await this.features.assertGeometriesInsideLimit(childScope, [body.geometry]);
    }

    const input: Parameters<typeof this.features.createRelatedFeature>[3] = {
      properties: body.properties ?? {},
    };
    if (body.globalId !== undefined) {
      if (
        typeof body.globalId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.globalId)
      ) {
        throw new BadRequestException('globalId must be a UUID');
      }
      input.globalId = body.globalId;
    }
    if (body.geometry !== undefined) input.geometry = body.geometry;

    const result = await this.features.createRelatedFeature(
      childItemId,
      fid,
      fk,
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
   * The caller's share scope on this layer, from the same resolver
   * the v3 routes use, or undefined when nothing limits them. These
   * routes read the per-item table directly, so without this a
   * geo-limited or own-rows grantee read and wrote every row.
   */
  private async scopeFor(
    user: AuthUser,
    item: Awaited<ReturnType<ItemsService['get']>>,
    action: 'read' | 'edit',
  ): Promise<FeatureScope | undefined> {
    const shares = (item as { shares?: ItemShare[] }).shares ?? [];
    const editingPolicy = (item.data as { editingPolicy?: unknown } | null)
      ?.editingPolicy;
    const scope = await this.sharing.featureScopeFor(user, item, shares, {
      action,
      layerPolicy:
        editingPolicy === 'own-rows-only' ? 'own-rows-only' : 'all-rows',
    });
    return isScopeLimited(scope) ? scope : undefined;
  }

  /**
   * After any write, refresh the item's metadata (feature count, bbox,
   * updatedAt) so the portal item card reflects current state without a
   * separate manual step.
   */
  private async syncItemMeta(itemId: string): Promise<void> {
    try {
      const s = await this.features.stats(itemId);
      // Read and write under the item row lock so a concurrent writer
      // (a syncVersion bump, a schema save) is not rolled back by a
      // stale copy of item.data.
      await withLockedItem(this.prisma, itemId, async (tx, locked) => {
        if (!locked) return;
        const existing = (locked.data ?? {}) as Record<string, unknown>;
        // The route guards refuse v3 items; never downgrade one here.
        if (existing.version === 3) return;
        await tx.item.update({
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
      });
    } catch (err) {
      // Non-fatal: metadata sync failure shouldn't roll back the write.
      // Pass user-controlled fields as separate console args (not
      // interpolated into the format string) so a crafted item id or
      // error message can't smuggle in format specifiers or CR/LF
      // sequences that would corrupt the log stream (CodeQL
      // js/log-injection).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('syncItemMeta failed for %s: %s', itemId, msg);
    }
  }
}

/**
 * The FK column of the registered relationship from `parent` to the
 * child layer. The routes used to take any column name from the
 * caller, so a child row could point at a layer that is not its
 * parent, and names like `properties` or `created_by` reached SQL.
 */
function relationshipFk(
  parent: { data: unknown },
  childItemId: string,
  requested: string | undefined,
): string {
  const rels = (parent.data as { relationships?: unknown } | null)?.relationships;
  const rel = Array.isArray(rels)
    ? (rels as Array<{ relatedItemId?: unknown; fkColumn?: unknown }>).find(
        (r) => r?.relatedItemId === childItemId,
      )
    : undefined;
  if (!rel || typeof rel.fkColumn !== 'string') {
    throw new BadRequestException('These layers have no registered relationship');
  }
  if (requested !== undefined && requested !== rel.fkColumn) {
    throw new BadRequestException(`fkColumn must be "${rel.fkColumn}" for this relationship`);
  }
  return rel.fkColumn;
}
