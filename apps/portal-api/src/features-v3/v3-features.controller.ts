import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { EditorPolicyService } from '../items/editor-policy.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { V3FeaturesService } from './v3-features.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

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
    private readonly prisma: PrismaService,
    private readonly editorPolicy: EditorPolicyService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('features')
  async listFeatures(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
  ) {
    const { geoLimit, rowScope } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );
    const opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
    } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        opts.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
      }
    }
    if (at) opts.at = at;
    if (geoLimit) opts.geoLimit = geoLimit;
    // Layer-level boundary clip (#34). Resolves the geo_boundary
    // item id supplied by the client to its geometry. We bypass
    // per-user authz on the boundary itself: the clip is content
    // scope set by the map author for THIS layer, not access. A
    // viewer who can see the data_layer should see it clipped to
    // the boundary even if they cannot see the boundary item
    // directly. Missing / wrong-type / no-geometry boundary is
    // treated as "no clip" so a deleted boundary cannot silently
    // expand or shrink the result set in unexpected ways.
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    return this.v3.listFeatures(itemId, layerId, opts);
  }

  /** GeoJSON view of a single layer: the map editor's overlay source
   *  hits this per-layer URL for v3 items, the same way v2 items use
   *  /items/:id/geojson. */
  @Get('geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
  ) {
    return this.listFeatures(user, itemId, layerId, bbox, at, clip);
  }

  /**
   * Look up a geo_boundary item by id and return its geometry. Used
   * by the layer-level clip path (#34). Bypasses per-user authz
   * because the clip is layer-content scope, not access (see the
   * docstring on MapLayer.boundaryFilterItemId in shared-types).
   * Returns null when the item is missing, soft-deleted, the wrong
   * type, or has no geometry yet -- all of which the caller treats
   * as "no clip applied" rather than an error so a stale layer
   * config never blocks the map from rendering.
   */
  private async resolveBoundaryGeometry(
    boundaryItemId: string,
  ): Promise<unknown | null> {
    if (!boundaryItemId) return null;
    const row = await this.prisma.item.findFirst({
      where: {
        id: boundaryItemId,
        type: 'geo_boundary',
        deletedAt: null,
      },
      select: { data: true },
    });
    if (!row) return null;
    const geom = (row.data as { geometry?: unknown } | null)?.geometry;
    if (!geom || typeof geom !== 'object') return null;
    return geom;
  }

  @Post('features')
  async append(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() body: AppendFeaturesBodyDto,
    @Headers('x-editor-id') editorId?: string,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    if (editorId) {
      await this.editorPolicy.assertAllows({
        user,
        editorId,
        dataLayerId: itemId,
        layerKey: layerId,
        op: 'create',
      });
    }
    const result = await this.v3.insertFeatures(
      itemId,
      layerId,
      body.features,
      user,
    );
    // Fire editor_feature_created when this insert came through an
    // editor (#128). Notifies the editor item's owner so authors who
    // build a data-collection editor get told when submissions land,
    // matching the Survey123 "send me an email per response" gap.
    // Per-target configurable recipient lists land in a follow-up;
    // for v1 the editor owner is the only recipient. Fire-and-forget
    // so a notify error never rolls back the user's POST.
    if (editorId && result.inserted > 0) {
      void this.notifyEditorFeatureCreated({
        editorId,
        dataLayerId: itemId,
        layerKey: layerId,
        features: body.features,
        creator: user,
      });
    }
    return result;
  }

  /**
   * Helper for the editor_feature_created notification fan-out.
   * Resolves the editor item, the data_layer title, and a best-
   * effort summary string from the first non-empty user-field value
   * of the (first) submitted feature. Notifies the editor's owner.
   */
  private async notifyEditorFeatureCreated(args: {
    editorId: string;
    dataLayerId: string;
    layerKey: string;
    features: AppendFeatureDto[];
    creator: AuthUser;
  }): Promise<void> {
    try {
      const editor = await this.prisma.item.findUnique({
        where: { id: args.editorId },
        select: { id: true, title: true, ownerId: true, type: true },
      });
      if (!editor || editor.type !== 'editor') return;
      const dataLayer = await this.prisma.item.findUnique({
        where: { id: args.dataLayerId },
        select: { title: true },
      });
      const dataLayerTitle = dataLayer?.title ?? args.layerKey;
      const creatorRow = await this.prisma.user.findUnique({
        where: { id: args.creator.id },
        select: { fullName: true, username: true },
      });
      const createdByName =
        creatorRow?.fullName || creatorRow?.username || 'Someone';
      // For v1 we notify per inserted feature; the typical editor
      // submission is one feature at a time. Bulk inserts (e.g. a
      // future import-via-editor flow) would multiply emails which
      // is fine for now -- the recipient list is just the owner.
      for (const f of args.features) {
        const summary = pickFeatureSummary(f.properties);
        const featureId = typeof f.globalId === 'string' ? f.globalId : '';
        await this.notifications.notify(
          editor.ownerId,
          'editor_feature_created',
          {
            editorId: editor.id,
            editorTitle: editor.title,
            dataLayerId: args.dataLayerId,
            dataLayerTitle,
            layerKey: args.layerKey,
            featureId,
            createdByName,
            summary,
          },
        );
      }
    } catch (err) {
      // Notify errors are non-fatal -- the feature already landed.
      // Pinned to debug because a misconfigured editor would
      // otherwise spam the api logs on every collection.
      // eslint-disable-next-line no-console
      console.warn(
        `editor_feature_created notify failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  @Patch('features/:fid')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Body() body: UpdateFeatureBodyDto,
    @Headers('x-editor-id') editorId?: string,
  ) {
    const { rowScope } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'write',
    );
    if (editorId) {
      await this.editorPolicy.assertAllows({
        user,
        editorId,
        dataLayerId: itemId,
        layerKey: layerId,
        op: 'update',
        patchKinds: {
          hasGeometry: body.geometry !== undefined,
          propertyKeys:
            body.properties !== undefined
              ? Object.keys(body.properties as Record<string, unknown>)
              : [],
        },
      });
    }
    const patch: { geometry?: unknown; properties?: Record<string, unknown> } = {};
    if (body.geometry !== undefined) patch.geometry = body.geometry;
    if (body.properties !== undefined) patch.properties = body.properties;
    return this.v3.updateFeature(itemId, layerId, featureId, patch, user, {
      ownRowsOnly: rowScope === 'own',
    });
  }

  @Delete('features/:fid')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Headers('x-editor-id') editorId?: string,
  ) {
    const { rowScope } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'write',
    );
    if (editorId) {
      await this.editorPolicy.assertAllows({
        user,
        editorId,
        dataLayerId: itemId,
        layerKey: layerId,
        op: 'delete',
      });
    }
    await this.v3.deleteFeature(itemId, layerId, featureId, user, {
      ownRowsOnly: rowScope === 'own',
    });
  }

  /** Verify the item exists, is a v3 data_layer, the caller can
   *  read (or edit) it, and the named layer is part of its schema.
   *  Returns the geographic restriction (if any) that applies to this
   *  caller on this item so the query can clip rows to the allowed
   *  area. Null means no restriction: either because the caller has
   *  unrestricted access (owner / admin / org / public) or because
   *  their share(s) don't carry a polygon. */
  private async assertV3Layer(
    user: AuthUser,
    itemId: string,
    layerId: string,
    mode: 'read' | 'write',
  ): Promise<{ geoLimit: unknown | null; rowScope: 'all' | 'own' }> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new NotFoundException('Not a data_layer item');
    }
    const data = item.data as {
      version?: number;
      layers?: Array<{
        id: string;
        parentLayerId?: string;
        editingPolicy?: 'all-rows' | 'own-rows-only';
      }>;
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
    // Geo-limit is only meaningful on read: writes go through
    // canEdit which doesn't use a polygon today (the share either
    // grants edit or doesn't). For reads, consult every matching
    // share's polygon to build the union. Owners / admins return
    // null (no restriction).
    let geoLimit: unknown | null = null;
    const withShares = item as typeof item & { shares?: ItemShare[] };
    const shares = withShares.shares ?? [];
    if (mode === 'read') {
      geoLimit = await this.sharing.geoLimitFor(user, item, shares);
    }
    // Row-scope applies to BOTH reads and writes (#40). On reads it
    // narrows the SELECT; on writes it gates the per-row update /
    // delete to features the caller created. Owner / admin / public
    // / org-public bypass the scope inside SharingService. The
    // layer-level editingPolicy (#41) tightens every matching share
    // when set to 'own-rows-only'.
    const layerPolicy = layer.editingPolicy ?? 'all-rows';
    const rowScope = this.sharing.effectiveRowScope(
      user,
      item,
      shares,
      layerPolicy,
    );
    return { geoLimit, rowScope };
  }
}

/**
 * Best-effort summary string for an editor-feature-created
 * notification. Picks the first non-empty user-field value so the
 * email subject reads "New submission: <something useful>" rather
 * than a uuid. Underscore-prefixed keys (system metadata) are
 * skipped. Falls back to a short literal when nothing's available.
 */
function pickFeatureSummary(
  properties: Record<string, unknown> | undefined,
): string {
  if (!properties) return '(no attributes)';
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined || v === '') continue;
    const s = String(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  }
  return '(no attributes)';
}
