// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Request, Response } from 'express';

import {
  TileCacheOverloadError,
  matchesIfNoneMatch,
  tileOverloadRetryAfterSeconds,
} from '../engine/tile-cache.service.js';
import { onceDrain, streamFeatureCollection } from './feature-stream.js';
import {
  parseAggregateQuery,
  rejectUnknownAggregateParams,
} from './aggregate-params.js';

import type { ItemShare } from '@prisma/client';
import {
  isEditorItem,
  type FeatureField,
  type FeatureRecord,
  type MapLayerFilter,
} from '@gratis-gis/shared-types';
import type { GeoJsonGeometry } from '@gratis-gis/engine';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { EditorPolicyService } from '../items/editor-policy.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DataLayerFeaturesService,
  type EngineVia,
} from './features.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  csvColumnPlan,
  csvFeatureRow,
  csvHeaderRow,
  type CsvExportOptions,
} from './csv-export.js';
import { parsePagingParams } from './feature-paging.js';
import { writeGeoParquetExport } from './geoparquet-export.js';
import { DuckDbUnavailableError } from '../ingest/parquet-reader.js';

class AppendFeatureDto {
  @IsOptional() @IsString() globalId?: string;
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

class CalculateFieldDto {
  @IsString() expression!: string;
  @IsString() outputName!: string;
  @IsString() outputType!: 'number' | 'string' | 'boolean';
  @IsString() scope!: 'all' | 'selection';
  @IsOptional() @IsArray() @IsString({ each: true }) selectedIds?: string[];
  @IsOptional() dryRun?: boolean;
}

class AppendFeaturesBodyDto {
  @IsArray()
  // Bulk-append cap. Caps adversarial loop-bound: without it a
  // crafted POST with features.length === 10_000_000 would spin
  // through assertGeometriesInsideLimit's per-row Intersects loop
  // and tie up the worker. Real field-app sync flushes ship dozens
  // of rows per request; 5000 leaves a wide margin without leaving
  // an unbounded loop reachable from anonymous traffic.
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => AppendFeatureDto)
  features!: AppendFeatureDto[];
}

class UpdateFeatureBodyDto {
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

/**
 * #196: engine feature ids are entity UUIDs. Anything else can never
 * match a row, and letting it through means the raw query 500s on
 * the uuid cast deep inside the engine. The practical case: a map
 * selection built against a source without stable row ids carries
 * sequential numbers ("4"); the delete/update widgets used to relay
 * those straight into the URL.
 */
const FEATURE_ID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertFeatureIdShape(featureId: string): void {
  if (!FEATURE_ID_SHAPE.test(featureId)) {
    throw new BadRequestException(
      'That selection does not match a saved feature. Reselect the feature on the map and try again.',
    );
  }
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
export class DataLayerFeaturesController {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly v3: DataLayerFeaturesService,
    private readonly prisma: PrismaService,
    private readonly editorPolicy: EditorPolicyService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('features')
  async listFeatures(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Res() res: Response,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
    // #247: parent-FK filter. When `parentFk` + `parentId` are both
    // present, the SELECT is narrowed to rows whose
    // properties->>parentFk equals parentId. Used by the field
    // runtime to list existing related rows under a parent feature.
    @Query('parentFk') parentFk?: string,
    @Query('parentId') parentId?: string,
    // #115 P12: single-feature lookup by stable entity id. The MVT
    // popup path calls /features?entity=<id> after a click to pull
    // full attrs (the tile itself only ships _global_id). Without
    // this, every popup on an MVT layer would fan out to the full
    // layer scan -- on a 1.4M-parcel dataset that's the symptom
    // the user just hit: popup stuck on "Loading...".
    @Query('entity') entity?: string,
    // #58: time-attribute window filter. When `timeField` is set,
    // the engine narrows the result to rows whose attribute falls
    // in [timeFrom, timeTo]. Either bound is optional; only the
    // ones provided are applied. The field is validated against
    // the layer schema before reaching the engine.
    @Query('timeField') timeField?: string,
    @Query('timeFrom') timeFrom?: string,
    @Query('timeTo') timeTo?: string,
    // Keyset pagination (#220). Both absent keeps the historical
    // whole-collection response byte for byte, which is what the map
    // renderer and every existing client depend on.
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    await this.readFeatures(user, itemId, layerId, res, {
      bbox,
      at,
      clip,
      parentFk,
      parentId,
      entity,
      timeField,
      timeFrom,
      timeTo,
      limit,
      cursor,
    });
  }

  /**
   * The shared body of `/features` and `/geojson`.
   *
   * Named arguments on purpose: the two routes differ only in which
   * query params they accept, and threading a dozen positional
   * optionals from one handler to the other is how a caller silently
   * ends up passing `bbox` where `entity` was expected the next time
   * a parameter is inserted in the middle.
   */
  private async readFeatures(
    user: AuthUser,
    itemId: string,
    layerId: string,
    res: Response,
    // `| undefined` rather than `?`: under exactOptionalPropertyTypes
    // these come straight off @Query decorators as possibly-undefined
    // values, and an absent param and an explicit undefined mean the
    // same thing here.
    q: {
      bbox: string | undefined;
      at: string | undefined;
      clip: string | undefined;
      parentFk: string | undefined;
      parentId: string | undefined;
      entity?: string | undefined;
      timeField?: string | undefined;
      timeFrom?: string | undefined;
      timeTo?: string | undefined;
      limit: string | undefined;
      cursor: string | undefined;
    },
  ) {
    const { at, entity, limit, cursor } = q;
    const { opts } = await this.buildScopedReadOpts(user, itemId, layerId, {
      bbox: q.bbox,
      clip: q.clip,
      parentFk: q.parentFk,
      parentId: q.parentId,
      timeField: q.timeField,
      timeFrom: q.timeFrom,
      timeTo: q.timeTo,
    });
    const fullOpts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
      entity?: string;
    } = { ...opts };
    if (at) fullOpts.at = at;
    if (entity) fullOpts.entity = entity;

    const paging = parsePagingParams(limit, cursor);
    if (paging !== null) {
      // `entity` is a single-feature lookup; paging it is meaningless
      // and quietly ignoring one of the two would surprise the caller.
      if (entity) {
        throw new BadRequestException(
          'Use either a single feature lookup or paging, not both.',
        );
      }
      res.json(await this.pagedFeatures(fullOpts, itemId, layerId, paging));
      return;
    }
    if (entity) {
      // Single-feature lookup: bounded to 0 or 1 features, so buffering
      // it is fine and keeps the exact single-object response shape.
      res.json(await this.v3.listFeatures(itemId, layerId, fullOpts));
      return;
    }
    // Whole-collection read. Stream it rather than buffering up to
    // 100k features and serialising them in one synchronous pass,
    // which could OOM a replica (anonymously, on the public mirror).
    // Same opts the CSV export already streams over.
    const iterOpts: Parameters<typeof this.v3.iterateFeatures>[2] = {
      ...opts,
    };
    if (at) iterOpts.at = at;
    await streamFeatureCollection(
      res,
      this.v3.iterateFeatures(itemId, layerId, iterOpts),
    );
  }

  /**
   * Serve one keyset page and tell the caller how to ask for the next.
   *
   * `asOf` is echoed into the response and expected back on the
   * following request (as `at`) because the snapshot has to be pinned
   * across the whole walk, not per request: an entity created between
   * two pages whose id sorts below the cursor would otherwise fall in
   * a range already passed and never be returned. The engine's
   * generator pins it internally; over HTTP only the client can.
   */
  private async pagedFeatures(
    fullOpts: {
      at?: string;
      bbox?: [number, number, number, number];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    },
    itemId: string,
    layerId: string,
    paging: { pageSize: number; after: string | null },
  ) {
    const page = await this.v3.readFeaturePage(itemId, layerId, fullOpts, {
      pageSize: paging.pageSize,
      after: paging.after,
    });
    return {
      type: 'FeatureCollection' as const,
      features: page.features,
      // Foreign members on a FeatureCollection are legal GeoJSON
      // (RFC 7946 section 6.1) and keep a paged response readable by
      // any plain GeoJSON consumer, which a bespoke envelope would
      // not be.
      nextCursor: page.nextCursor,
      asOf: page.asOf.toISOString(),
    };
  }

  /**
   * Resolve the sharing-scoped read options every feature read on
   * this controller applies: bbox parse, per-share geo limit,
   * layer-level boundary clip, own-rows scope, and the validated
   * parent-FK / time-window filters. Extracted from listFeatures so
   * the GeoParquet export iterates under EXACTLY the same scoping
   * as the buffered reads; a filter added here reaches both.
   *
   * Also surfaces the asserted item so callers that need a further
   * permission check (the export's canDownload gate) reuse the row
   * the visibility check already fetched.
   */
  private async buildScopedReadOpts(
    user: AuthUser,
    itemId: string,
    layerId: string,
    q: {
      bbox: string | undefined;
      clip: string | undefined;
      parentFk: string | undefined;
      parentId: string | undefined;
      timeField: string | undefined;
      timeFrom: string | undefined;
      timeTo: string | undefined;
    },
  ): Promise<{
    opts: {
      bbox?: [number, number, number, number];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    };
    isTable: boolean;
    layer: {
      id: string;
      fields?: Array<{ name: string }>;
      parentFkColumn?: string;
    };
    item: Awaited<ReturnType<ItemsService['get']>>;
  }> {
    const { geoLimit, rowScope, isTable, layer, item } =
      await this.assertV3Layer(user, itemId, layerId, 'read');
    const opts: {
      bbox?: [number, number, number, number];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    } = {};
    if (isTable) opts.isTable = true;
    if (q.bbox) {
      const parts = q.bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        opts.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
      }
    }
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
    if (q.clip) {
      const geom = await this.resolveBoundaryGeometry(q.clip);
      if (geom) opts.boundaryClip = geom;
    }
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    // #247 / #268: parent-FK filter. Two-step validation:
    //   1. column name must be a safe identifier (regex) so it can be
    //      embedded in the SQL string literal `properties->>'col'`
    //      without escaping shenanigans.
    //   2. column must be a real attribute on this layer -- either a
    //      user-declared field OR the layer's parentFkColumn (the
    //      relate-back FK that lives alongside fields[] on the v3
    //      layer descriptor, not inside it). Without #2 a typo /
    //      spoofed column never reaches the SQL; without the
    //      parentFkColumn branch the legitimate filter from a
    //      child-of-parent query was silently dropped, which made
    //      the field runtime show every related row under every
    //      parent (#268).
    // parentId is parameterized so any string is fine.
    if (q.parentFk && q.parentId) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(q.parentFk)) {
        // Silently drop malformed identifiers rather than 400ing the
        // request -- the runtime might fall back to "show no related
        // rows" gracefully and the worker can still tap Add. Logging
        // this would also be reasonable; for now the silent drop
        // matches how a missing geo_boundary clip is handled above.
      } else if (
        !schemaHasField(layer, q.parentFk) &&
        !layerHasParentFk(layer, q.parentFk)
      ) {
        // Column not on this layer's schema -- same silent-drop
        // rationale as the regex case.
      } else {
        opts.parentFkFilter = { column: q.parentFk, parentId: q.parentId };
      }
    }
    // #58: time-attribute window filter. Validate the column the
    // same way parentFk does: identifier-safe regex AND the field
    // is declared on the layer's schema. Either bound is allowed
    // to be omitted (open-ended window). Empty strings degrade to
    // "not set" so a slider that hasn't dragged its handle yet
    // doesn't accidentally constrain the result.
    if (q.timeField) {
      const safeFrom =
        typeof q.timeFrom === 'string' && q.timeFrom.length > 0
          ? q.timeFrom
          : undefined;
      const safeTo =
        typeof q.timeTo === 'string' && q.timeTo.length > 0
          ? q.timeTo
          : undefined;
      const haveBound = safeFrom !== undefined || safeTo !== undefined;
      if (haveBound) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(q.timeField)) {
          // Silently drop. Same rationale as the parentFk path:
          // the runtime should fall back to "no filter" rather
          // than 400ing a request from a slider widget.
        } else if (!schemaHasField(layer, q.timeField)) {
          // Field not on this layer; drop.
        } else {
          opts.timeFilter = {
            column: q.timeField,
            ...(safeFrom !== undefined ? { from: safeFrom } : {}),
            ...(safeTo !== undefined ? { to: safeTo } : {}),
          };
        }
      }
    }
    return { opts, isTable, layer, item };
  }

  /**
   * Mapbox Vector Tile of a single layer at z/x/y (#115 P12).
   *
   * Endpoint shape: GET /items/:id/layers/:layerId/tile/:z/:x/:y.mvt
   *
   * Used by the map page for big data_layers (anything more than a
   * few thousand features). Browser MapLibre fetches per-tile as
   * the user pans/zooms; each tile is small (KB) and the request is
   * bbox-bounded to the tile envelope, so even 1.4M-parcel layers
   * render incrementally at native MapLibre speed instead of
   * choking on one giant GeoJSON payload.
   *
   * Auth + share gates match /geojson: assertV3Layer in 'read' mode
   * resolves the user's effective row scope and geo limit, plus the
   * layer-level boundary clip (?clip=<geo_boundary_id>).
   *
   * The `.mvt` is in the path rather than as a Content-Type negotiation
   * because MapLibre's tile-URL templates don't speak Accept headers
   * and this is the convention every tile server (pg_tileserv,
   * martin, vector tile spec) follows.
   */
  @Get('tile/:z/:x/:y.mvt')
  async tile(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('z') zStr: string,
    @Param('x') xStr: string,
    @Param('y') yStr: string,
    @Query('clip') clip?: string,
  ) {
    const { geoLimit, rowScope, isTable, layer } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );
    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z < 0 ||
      z > 24 ||
      x < 0 ||
      y < 0
    ) {
      throw new BadRequestException('Invalid tile coordinates.');
    }
    const opts: {
      geoLimit?: unknown;
      boundaryClip?: unknown;
      isTable?: boolean;
      ownRowsOnly?: { userId: string };
      fields?: Array<{ name: string; type?: string }>;
    } = {};
    if (isTable) opts.isTable = true;
    if (geoLimit) opts.geoLimit = geoLimit;
    // #40: the tile has to honour row-scope like /features does. This
    // is the endpoint the map renders from, and it projects every
    // declared field below, so without it a share configured
    // rowScope='own' handed the whole layer to the viewer through the
    // map while /features dutifully withheld it.
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    // #147: project the layer's declared fields into the tile so
    // labels, popups, and filters have feature properties to read
    // at render time. Without this every {{field}} evaluates to
    // null. Filter to non-system field names; identifier safety is
    // enforced again in the engine.
    if (layer && Array.isArray(layer.fields)) {
      opts.fields = layer.fields
        .filter(
          (f): f is { name: string; type?: string } =>
            typeof f.name === 'string' && f.name.length > 0,
        )
        .map((f) => ({
          name: f.name,
          ...(typeof f.type === 'string' ? { type: f.type } : {}),
        }));
    }
    let mvt: Buffer;
    let etag: string;
    try {
      ({ mvt, etag } = await this.v3.mvtTile(itemId, layerId, z, x, y, opts));
    } catch (e) {
      if (e instanceof TileCacheOverloadError) {
        // Concurrency cap saturated. 503 with Retry-After
        // tells the client to back off briefly rather than
        // retry-immediately + amplify the storm.
        res.setHeader('Retry-After', String(tileOverloadRetryAfterSeconds()));
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).end();
        return;
      }
      throw e;
    }
    // If-None-Match revalidation: the client cached this tile and
    // is asking whether the server's copy still matches. Equal
    // ETag -> 304 Not Modified with no body, lets the client reuse
    // its cached buffer with no transfer.
    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
    res.setHeader('ETag', etag);
    // Per-tile responses are pure functions of (scope, z, x, y) and
    // the layer's current state. Browser-side caching on a short TTL
    // keeps panning back-and-forth fast without us paying the round-
    // trip every time. The "current state" updates on every write,
    // so we don't want stale tiles for long: a minute is the right
    // balance for an authoring tool. The ETag above lets the
    // browser revalidate cheaply when the TTL elapses.
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(mvt);
  }

  /**
   * Paged attribute-table read (#115 P13).
   *
   * The map page's attribute-table card calls this once per pan,
   * once per search keystroke, once per sort-header click. Returns
   * attribute rows (NO geometry -- the map already has it) for the
   * given bbox-bounded subset, with a hard cap and truncation
   * flag. With the default "extent only" UX toggle the bbox keeps
   * the result set small even on a 1.4M-parcel layer.
   *
   * Sort: any attribute on the layer schema OR one of
   * `_global_id`, `_edited_at`, `_created_at`. Direction asc|desc.
   *
   * Search (`q`): free-text ILIKE across attribute values. Bbox-
   * bounded; on a fully-unbounded big-layer query it'll be slow
   * but the default UI doesn't trigger that path.
   *
   * `entityIds`: optional explicit set; powers the "Show selected
   * only" toggle. Capped at 1000.
   *
   * Response shape:
   *   { features: Array<{ id, properties }>, count, truncated }
   *
   * `truncated: true` means the underlying query had > limit rows
   * and the UI should surface a "Showing 5,000+ rows; zoom in or
   * filter" banner.
   */
  @Get('features-page')
  async featuresPage(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: 'asc' | 'desc',
    @Query('limit') limit?: string,
    @Query('entityIds') entityIds?: string,
    @Query('clip') clip?: string,
  ) {
    const { geoLimit, rowScope, isTable, layer } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );

    const opts: {
      bbox?: [number, number, number, number];
      q?: string;
      sort?: string;
      dir?: 'asc' | 'desc';
      limit?: number;
      entityIds?: string[];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      isTable?: boolean;
      ownRowsOnly?: { userId: string };
    } = {};
    if (isTable) opts.isTable = true;
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        opts.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
      }
    }
    if (q) opts.q = q;
    // Whitelist sort column against the layer schema + the two
    // synthetic columns we support. Unknown columns silently fall
    // back to default (entity order) -- matches how parentFk
    // validation handles bad columns elsewhere in this controller.
    if (sort) {
      const SYNTHETIC = new Set(['_global_id', '_edited_at', '_created_at']);
      if (SYNTHETIC.has(sort) || schemaHasField(layer, sort)) {
        opts.sort = sort;
      }
    }
    if (dir === 'asc' || dir === 'desc') opts.dir = dir;
    if (limit) {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) {
        opts.limit = Math.min(Math.max(Math.floor(n), 1), 5000);
      }
    }
    if (entityIds) {
      const ids = entityIds
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s))
        .slice(0, 1000);
      if (ids.length > 0) opts.entityIds = ids;
    }
    if (geoLimit) opts.geoLimit = geoLimit;
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    return this.v3.pageFeatures(itemId, layerId, opts);
  }

  /**
   * Grouped aggregate read for dashboard widgets.
   *
   * `?agg=count`, `?agg=sum:acres&groupBy=status`, optionally
   * bbox-bounded and clipped. Returns one row per group (top-N by the
   * first aggregate when capped) or a single row when ungrouped.
   *
   * This exists so a chart or indicator does not have to download the
   * layer to count it, and, more importantly, so the number it shows
   * is the CALLER'S number: assertV3Layer resolves the same geo limit
   * and row scope every other read on this controller uses, and both
   * pass through to the engine. Client-side aggregation over a full
   * export cannot do that, which is why this is the primary path and
   * the whole-layer fetch is only a small-layer fallback.
   */
  @Get('aggregate')
  async aggregate(
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('clip') clip?: string,
  ) {
    rejectUnknownAggregateParams(Object.keys(req.query));
    const parsed = parseAggregateQuery(req.query as Record<string, unknown>);
    const { geoLimit, rowScope, layer } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );
    // Group keys and aggregate fields must name real columns. An
    // unknown name would otherwise aggregate a JSONB miss: every row
    // NULL, a confidently wrong zero on the dashboard.
    for (const name of [
      ...parsed.groupBy,
      ...parsed.aggs.map((a) => a.field).filter((f): f is string => !!f),
      // Filter fields get the same treatment. A predicate on a
      // misspelled column matches nothing, and "0 of 625" reads as a
      // finding rather than as a typo.
      ...(parsed.where?.clauses ?? []).map((c) => c.field),
      ...(parsed.via ? [parsed.via.myField] : []),
      // The binned field too. A misspelled one would produce a single
      // NULL bucket, which renders as one unlabelled bar: a histogram
      // that looks like a finding rather than like a typo.
      ...(parsed.bin ? [parsed.bin.field] : []),
    ]) {
      if (!schemaHasField(layer, name)) {
        throw new BadRequestException(
          `"${name}" is not a field on this layer.`,
        );
      }
    }

    // A relate reads a SECOND layer, one this request never named in
    // its path. Without its own read check it is a side channel:
    // point a widget at a layer you may read, relate it through one
    // you may not, and the counts describe the parent. So the parent
    // goes through the same assertion as the child, which also hands
    // back the parent's geo limit and row scope to apply INSIDE the
    // semi-join. A parent the caller cannot read 404s exactly as a
    // direct read of it would, so the relate leaks no more than
    // asking about the parent directly.
    let via: EngineVia | undefined;
    if (parsed.via) {
      const parent = await this.assertV3Layer(
        user,
        parsed.via.parentItemId,
        parsed.via.parentLayerId,
        'read',
      );
      for (const name of [
        parsed.via.parentField,
        ...(parsed.via.parentWhere?.clauses ?? []).map((c) => c.field),
      ]) {
        if (!schemaHasField(parent.layer, name)) {
          throw new BadRequestException(
            `"${name}" is not a field on the related layer.`,
          );
        }
      }
      via = {
        myField: parsed.via.myField,
        parentField: parsed.via.parentField,
        parentItemId: parsed.via.parentItemId,
        parentLayerId: parsed.via.parentLayerId,
        ...(parsed.via.parentBbox
          ? { parentBbox: parsed.via.parentBbox }
          : {}),
        ...(parsed.via.parentWhere
          ? { parentWhere: parsed.via.parentWhere }
          : {}),
        ...(parent.geoLimit
          ? { parentGeoLimit: parent.geoLimit as GeoJsonGeometry }
          : {}),
      };
      // Row scope on the parent has no expression inside the
      // semi-join yet, and a relate that ignored it would hand a
      // row-scoped viewer counts derived from rows they cannot see.
      // Refuse rather than answer.
      if (parent.rowScope === 'own') {
        throw new BadRequestException(
          'The related layer is shared to you one row at a time, ' +
            'which a relate cannot honour yet.',
        );
      }
    }
    const opts: {
      groupBy?: string[];
      aggs: typeof parsed.aggs;
      bbox?: [number, number, number, number];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      where?: typeof parsed.where;
      via?: EngineVia;
      bin?: typeof parsed.bin;
      limit?: number;
      asOf?: Date;
    } = { aggs: parsed.aggs };
    if (parsed.groupBy.length > 0) opts.groupBy = parsed.groupBy;
    if (parsed.bbox) opts.bbox = parsed.bbox;
    if (parsed.where) opts.where = parsed.where;
    if (via) opts.via = via;
    if (parsed.bin) opts.bin = parsed.bin;
    if (parsed.limit !== undefined) opts.limit = parsed.limit;
    if (parsed.asOf !== undefined) opts.asOf = parsed.asOf;
    if (geoLimit) opts.geoLimit = geoLimit;
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    return this.v3.aggregateFeatures(itemId, layerId, opts);
  }

  /**
   * Attribute search for the map / app search bar.
   *
   * Distinct from /features-page (which the attribute table uses):
   * that one is bbox-bounded and strips geometry, so it can't find an
   * off-screen feature or tell the caller where it is. This searches
   * the whole layer and returns a representative point + envelope per
   * hit so picking a result can fly to and highlight it.
   *
   * `q`: the free-text query. Empty returns an empty result set.
   * `fields`: comma-separated attribute names to scope the match to
   *   (the layer author's configured searchable fields). Each is
   *   whitelisted against the layer schema before it reaches the
   *   engine, so an arbitrary key can't be injected. Omitted means
   *   match across every attribute.
   * `limit`: hard cap, defaulted and clamped engine-side.
   * `clip`: optional geo_boundary item id, same layer-author content
   *   clip the other reads honor.
   *
   * Read access, the share's geo-limit, and its row-scope are all
   * enforced by assertV3Layer + the engine filters, identical to
   * /features-page.
   *
   * This comment previously claimed the opposite, that "row-scoping
   * governs who can edit a row, not whether a reader can find it".
   * That was wrong and it was load-bearing: four read endpoints
   * enforced row-scope and four (this one among them) did not, and
   * the permissive ones won because they returned the same data. The
   * schema docstring ("only sees / edits"), effectiveRowScope
   * computing with action='read', the existence of editRowScope
   * (whose entire purpose is read=all with edit=own), and the UX
   * checklist entry "bob sees only his own features" all say reads
   * are scoped. Do not reintroduce the exemption.
   */
  @Get('features-search')
  async featuresSearch(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('q') q?: string,
    @Query('fields') fields?: string,
    @Query('limit') limit?: string,
    @Query('clip') clip?: string,
  ) {
    const { geoLimit, rowScope, layer } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );
    const text = (q ?? '').trim();
    if (text.length === 0) return { results: [], truncated: false };

    const opts: {
      q: string;
      fields?: string[];
      limit?: number;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
    } = { q: text };
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };

    if (fields) {
      const wanted = fields
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && schemaHasField(layer, f));
      if (wanted.length > 0) opts.fields = wanted;
    }
    if (limit) {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) {
        opts.limit = Math.min(Math.max(Math.floor(n), 1), 50);
      }
    }
    if (geoLimit) opts.geoLimit = geoLimit;
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    return this.v3.searchFeatures(itemId, layerId, opts);
  }

  /**
   * #30: union bbox of the named features.  Powers the
   * AttributeTable's "Zoom to selected" button in server-paged
   * mode (where /features-page strips geometry from the response,
   * so the client cannot compute a bbox locally).  Returns null
   * when none of the requested ids have geometry; the client
   * surfaces a friendly "no extent" message instead of zooming.
   */
  @Get('selection-extent')
  async selectionExtent(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('entityIds') entityIds?: string,
    @Query('clip') clip?: string,
  ): Promise<{ bbox: [number, number, number, number] | null }> {
    const { geoLimit, rowScope } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'read',
    );
    if (!entityIds) return { bbox: null };
    const ids = entityIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) =>
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          s,
        ),
      )
      .slice(0, 1000);
    if (ids.length === 0) return { bbox: null };
    const opts: {
      entityIds: string[];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
    } = { entityIds: ids };
    // Without this a scoped viewer could pass ids they cannot read and
    // get back a bbox covering them. An extent leaks location even
    // though it carries no attributes.
    if (rowScope === 'own') opts.ownRowsOnly = { userId: user.id };
    if (geoLimit) opts.geoLimit = geoLimit;
    if (clip) {
      const geom = await this.resolveBoundaryGeometry(clip);
      if (geom) opts.boundaryClip = geom;
    }
    const bbox = await this.v3.selectionExtent(itemId, layerId, opts);
    return { bbox };
  }

  /** GeoJSON view of a single layer: the map editor's overlay source
   *  hits this per-layer URL for v3 items, the same way v2 items use
   *  /items/:id/geojson. */
  @Get('geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Res() res: Response,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
    @Query('parentFk') parentFk?: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    await this.readFeatures(user, itemId, layerId, res, {
      bbox,
      at,
      clip,
      parentFk,
      parentId,
      limit,
      cursor,
    });
  }

  /**
   * CSV export of a single layer (#107). Same read scoping as
   * /geojson, plus the download-tier gate (#32): as of the
   * consistency pass that followed the GeoParquet export (#174),
   * every attachment-download endpoint on this controller requires
   * SharingService.canDownload, while /geojson stays read-gated
   * because it is the map renderer's overlay source, not a
   * download.
   *
   * For multi_select fields, the canonical jsonb-array storage gets
   * flattened to a comma-joined RFC-4180 quoted cell so downstream
   * AGO / Survey123 / Excel consumers see the format they expect
   * without us polluting internal storage with the AGO shape.
   *
   * Geometry columns are emitted alongside attributes: lon/lat for
   * point layers, WKT for everything else, attribute-only for
   * table-mode sublayers. Suppress all geometry columns with
   * ?geometry=none.
   *
   * Returns Content-Disposition: attachment so the browser saves
   * the response with a sensible filename instead of trying to
   * render text/csv inline.
   */
  @Get('csv')
  async csv(
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
    @Query('parentFk') parentFk?: string,
    @Query('parentId') parentId?: string,
    @Query('geometry') geometry?: 'none' | 'wkt' | 'lonlat' | 'auto',
  ) {
    // Visibility + download gate and scoped read opts BEFORE any feature
    // read, same as /geoparquet. buildScopedReadOpts applies bbox, clip,
    // geo limits, own-rows scope, and parentFk in one place.
    const { opts, isTable, layer, item } = await this.buildScopedReadOpts(
      user,
      itemId,
      layerId,
      {
        bbox,
        clip,
        parentFk,
        parentId,
        timeField: undefined,
        timeFrom: undefined,
        timeTo: undefined,
      },
    );
    const withShares = item as typeof item & { shares?: ItemShare[] };
    if (!this.sharing.canDownload(user, item, withShares.shares ?? [])) {
      throw new ForbiddenException(
        'This layer is shared with you as view only. Downloading the data requires a share with download permission.',
      );
    }

    const iterOpts: Parameters<typeof this.v3.iterateFeatures>[2] = {
      ...opts,
    };
    if (at) iterOpts.at = at;

    const fields: FeatureField[] = (layer?.fields ?? []) as FeatureField[];

    // Geometry-mode opts. `auto` (default) uses lon/lat for point layers
    // and WKT for everything else; explicit modes force the shape.
    // Table-mode sublayers always omit geometry. isPoint comes from the
    // declared geometry type rather than sniffing a feature, because the
    // stream has no first feature to peek at.
    const csvOpts: CsvExportOptions = {};
    if (isTable || geometry === 'none') {
      csvOpts.includeGeometry = false;
    } else if (geometry === 'wkt') {
      csvOpts.emitWkt = true;
      csvOpts.emitLonLat = false;
    } else if (geometry === 'lonlat') {
      csvOpts.emitWkt = false;
      csvOpts.emitLonLat = true;
    }
    const isPoint =
      (layer as { geometryType?: string } | undefined)?.geometryType ===
      'point';
    const plan = csvColumnPlan(fields, csvOpts, isPoint);

    const filenameStem = layerId.replace(/[^\w.-]+/g, '_');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${filenameStem}.csv"`,
    );

    // Stream over the keyset iterator, one page at a time, so the whole
    // layer is exported rather than the first 100k rows. The old path
    // buffered listFeatures (capped, in-memory) and silently truncated:
    // a CSV that looked complete but was missing most of a large layer.
    // Headers are already sent, so a mid-stream error cannot become an
    // HTTP error; the CRLF-joined body is identical to featuresToCsv.
    try {
      res.write(csvHeaderRow(plan));
      for await (const batch of this.v3.iterateFeatures(
        itemId,
        layerId,
        iterOpts,
      )) {
        let chunk = '';
        for (const feat of batch as FeatureRecord[]) {
          chunk += '\r\n' + csvFeatureRow(feat, plan);
        }
        // Honour socket backpressure. The DB cursor will always
        // outrun a slow WAN client, so without awaiting drain the
        // difference buffers in the response's writable queue and, on
        // a large layer, reconverges on the whole file in memory,
        // undoing the point of streaming.
        if (chunk && !res.write(chunk)) {
          await onceDrain(res);
        }
      }
      res.end();
    } catch {
      // Best-effort: the response has already started, so there is no
      // clean way to signal an error to the client beyond ending the
      // stream. The paged read is snapshot-pinned so a partial file is
      // at least internally consistent up to where it stopped.
      res.end();
    }
  }

  /**
   * GeoParquet export of a single layer (#174, export side).
   *
   * Same read scoping as /csv and /geojson (share geo limits,
   * boundary clip, own-rows scope, bbox / at / parentFk params) but
   * with a gate the older exports lacked at first: the caller must
   * hold the DOWNLOAD tier, not just read. SharingService.canDownload
   * has described that tier since #32 and the item payload has
   * surfaced it to clients; this route was the first enforcer, and
   * /csv now shares the gate (consistency decision after #174).
   * /geojson stays read-gated on purpose: it is the map renderer's
   * overlay source, and download-gating it would blank maps for
   * view-only users.
   *
   * Unlike /csv this endpoint does NOT buffer the layer through
   * listFeatures (whose 100k default cap silently truncates big
   * layers). It walks the engine's keyset iterator so every current
   * feature lands in the file, streams the rows into DuckDB, and
   * COPYs to parquet with the spatial extension loaded, which
   * writes real GeoParquet `geo` metadata. Table-mode sublayers
   * export as plain parquet (attributes only), mirroring the CSV
   * geometry omission.
   *
   * The file is staged under a mkdtemp dir (cleaned in finally) and
   * streamed to the response with a Content-Disposition attachment
   * name derived from the item title + layer name.
   */
  @Get('geoparquet')
  async geoparquet(
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
    @Query('parentFk') parentFk?: string,
    @Query('parentId') parentId?: string,
  ) {
    const { opts, isTable, layer, item } = await this.buildScopedReadOpts(
      user,
      itemId,
      layerId,
      {
        bbox,
        clip,
        parentFk,
        parentId,
        timeField: undefined,
        timeFrom: undefined,
        timeTo: undefined,
      },
    );

    // Download-tier gate (#32): bulk extract requires more than
    // view. Owners, org admins, and public / org items pass (same
    // scope as canRead there); an explicit share must carry the
    // download, edit, or admin permission. 403, not 404: the caller
    // already proved they can read the item, so existence is not a
    // secret.
    const withShares = item as typeof item & { shares?: ItemShare[] };
    if (!this.sharing.canDownload(user, item, withShares.shares ?? [])) {
      throw new ForbiddenException(
        'This layer is shared with you as view only. Downloading the data requires a share with download permission.',
      );
    }

    const iterOpts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    } = { ...opts };
    if (at) iterOpts.at = at;

    const fields: FeatureField[] = (layer?.fields ?? []) as FeatureField[];

    // mkdtemp: atomic + 0700, same rationale as the ingest temp
    // dirs (CodeQL js/insecure-temporary-file).
    const workDir = await mkdtemp(join(tmpdir(), 'gg-export-'));
    try {
      let result: { path: string; rows: number };
      try {
        result = await writeGeoParquetExport({
          workDir,
          fields,
          includeGeometry: !isTable,
          batches: this.v3.iterateFeatures(itemId, layerId, iterOpts),
        });
      } catch (err) {
        // Same mapping IngestService applies on the import side: a
        // missing binding / extension is an operator problem, not a
        // request problem.
        if (err instanceof DuckDbUnavailableError) {
          throw new InternalServerErrorException(err.message);
        }
        throw err;
      }

      const filenameStem = exportFilenameStem(item, layerId);
      // application/vnd.apache.parquet is the IANA-registered type;
      // the BFF forwards Content-Type and (as of this change)
      // Content-Disposition verbatim, so the browser sees both.
      res.setHeader('content-type', 'application/vnd.apache.parquet');
      res.setHeader(
        'content-disposition',
        `attachment; filename="${filenameStem}.parquet"`,
      );
      try {
        await pipeline(createReadStream(result.path), res);
      } catch {
        // Headers are already gone once streaming starts, so a
        // client abort / socket error cannot become an HTTP error
        // response. pipeline() has destroyed both streams; the
        // finally below still removes the temp dir.
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup; a leaked temp dir is not worth
        // failing the response over.
      });
    }
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

  /**
   * #82: assert every supplied geometry intersects the caller's
   * effective geo limit. ST_Intersects (not ST_Within) so a line /
   * polygon that crosses the boundary is accepted -- the read clip
   * trims the visible result to the inside. Throws 422 with a
   * structured payload that includes the offending row indices so
   * the field-app sync flush can flag them in the queue without
   * reparsing free-form messages. No-op when the caller is owner /
   * admin / unscoped (geoLimit = null) and for table-mode sublayers
   * that don't carry a geom column.
   */
  private async assertGeometriesInsideLimit(
    geoLimit: unknown | null,
    isTable: boolean,
    geoms: Array<unknown | null | undefined>,
  ): Promise<void> {
    if (!geoLimit || isTable) return;
    if (geoms.length === 0) return;
    // Filter to indices that have a geometry to check; absent /
    // null geometries pass (a write with no geom can't violate a
    // spatial limit -- editors of attribute-only fields hit this).
    const candidates: Array<{ index: number; geom: unknown }> = [];
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g && typeof g === 'object') candidates.push({ index: i, geom: g });
    }
    if (candidates.length === 0) return;
    const limitJson = JSON.stringify(geoLimit);
    const offending: number[] = [];
    // One round-trip per candidate. Bulk batch sizes in normal
    // traffic stay small (a field-app sync flush is on the order
    // of dozens, not thousands). If we ever need thousand-row
    // imports to gate fast, fold this into a single unnest+ANY
    // query; for v1 the loop keeps the error-reporting trivial.
    for (const { index, geom } of candidates) {
      const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT ST_Intersects(
          ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}::text), 4326),
          ST_SetSRID(ST_GeomFromGeoJSON(${limitJson}::text), 4326)
        ) AS ok
      `;
      const ok = rows[0]?.ok === true;
      if (!ok) offending.push(index);
    }
    if (offending.length > 0) {
      throw new UnprocessableEntityException({
        message:
          offending.length === 1
            ? "This feature is outside the area you're allowed to edit. Move the feature inside the boundary or ask the layer owner to grant access to a wider area."
            : `${offending.length} features are outside the area you're allowed to edit. Move them inside the boundary or ask the layer owner to grant access to a wider area.`,
        code: 'feature_outside_write_scope',
        offendingIndices: offending,
      });
    }
  }

  /**
   * Append features to a sublayer.
   *
   * Idempotency: a feature that carries a client-supplied `globalId`
   * is created at most once. When a live entity with that id already
   * exists in the layer, the row is NOT re-inserted; the response
   * counts it under `deduplicated` and its id still appears in
   * `globalIds`, so a client retrying after a network blip can treat
   * the 201 as "my feature exists" either way. Enforced in SQL under
   * an advisory lock (see writeFeaturesCreateIdempotent), not by
   * convention. `inserted` counts rows actually written, which also
   * gates the creation notifications below so a retry cannot
   * double-notify.
   *
   * Response: { inserted, deduplicated, globalIds } with `globalIds`
   * order-aligned to the request features.
   */
  @Post('features')
  async append(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() body: AppendFeaturesBodyDto,
    @Headers('x-editor-id') editorId?: string,
    @Headers('x-data-collection-id') dataCollectionId?: string,
  ) {
    const { isTable, geoLimit } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'write',
    );
    await this.assertGeometriesInsideLimit(
      geoLimit,
      isTable,
      body.features.map((f) => f.geometry),
    );
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
      { isTable },
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
    // Same fan-out for the field-deployment write path. The runtime
    // sends an x-data-collection-id header (mirroring x-editor-id).
    // Both headers are mutually exclusive in practice -- a single
    // request comes from one surface or the other. We notify the
    // data_collection's owner per inserted feature so field-team
    // managers get the same "an edit just landed" signal Editor
    // owners do.
    if (
      dataCollectionId &&
      !editorId &&
      result.inserted > 0
    ) {
      void this.notifyDataCollectionFeatureCreated({
        dataCollectionId,
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
        select: { id: true, title: true, ownerId: true, type: true, data: true },
      });
      // #258: accept both legacy type='editor' and migrated
      // type='web_app' + data.template='editor'.
      if (!editor || !isEditorItem(editor)) return;
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

  /**
   * Helper for the data_collection_feature_created notification
   * fan-out (#229). Same shape as notifyEditorFeatureCreated above
   * but keys on the data_collection item id from the
   * x-data-collection-id header. Notifies the deployment owner per
   * inserted feature. Per-deployment recipient lists are a Phase B
   * extension.
   */
  private async notifyDataCollectionFeatureCreated(args: {
    dataCollectionId: string;
    dataLayerId: string;
    layerKey: string;
    features: AppendFeatureDto[];
    creator: AuthUser;
  }): Promise<void> {
    try {
      const dc = await this.prisma.item.findUnique({
        where: { id: args.dataCollectionId },
        select: { id: true, title: true, ownerId: true, type: true },
      });
      if (!dc || dc.type !== 'data_collection') return;
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
      for (const f of args.features) {
        const summary = pickFeatureSummary(f.properties);
        const featureId = typeof f.globalId === 'string' ? f.globalId : '';
        await this.notifications.notify(
          dc.ownerId,
          'data_collection_feature_created',
          {
            dataCollectionId: dc.id,
            dataCollectionTitle: dc.title,
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
      // Same swallow rationale as the editor variant: notify errors
      // are non-fatal because the feature already landed.
      // eslint-disable-next-line no-console
      console.warn(
        `data_collection_feature_created notify failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * #83: Calculate Field on the attribute table.  Bulk-evaluate an
   * expression against scoped features and append one `update`
   * observation per row.  Dry-run mode returns the same shape with
   * appliedRows=0 and a 5-row preview so the UI can show a
   * confirm-before-applying dialog.
   *
   * Scoped via the `scope` field on the body:
   *   - 'all'        every feature in the sublayer (capped server-side)
   *   - 'selection'  only the entity ids in selectedIds
   *
   * Permissions: write access on the layer; row-scope shares are
   * respected via ownRowsOnly.
   */
  @Post('features/calculate-field')
  async calculateField(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() body: CalculateFieldDto,
  ) {
    const { rowScope, isTable } = await this.assertV3Layer(
      user,
      itemId,
      layerId,
      'write',
    );
    return this.v3.calculateField({
      itemId,
      layerId,
      expression: body.expression,
      outputName: body.outputName,
      outputType: body.outputType,
      scope: body.scope,
      ...(body.selectedIds ? { selectedIds: body.selectedIds } : {}),
      dryRun: body.dryRun === true,
      user,
      ownRowsOnly: rowScope === 'own',
      isTable,
    });
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
    assertFeatureIdShape(featureId);
    const { rowScope, isTable, geoLimit } = await this.assertV3Layer(
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
    // #82: gate geometry edits the same way appends are gated. An
    // attribute-only PATCH (no geometry in the body) bypasses the
    // check because a row already accepted yesterday shouldn't fail
    // an attribute edit today even if the boundary tightened.
    if (body.geometry !== undefined) {
      await this.assertGeometriesInsideLimit(geoLimit, isTable, [
        body.geometry,
      ]);
    }
    const patch: { geometry?: unknown; properties?: Record<string, unknown> } = {};
    if (body.geometry !== undefined) patch.geometry = body.geometry;
    if (body.properties !== undefined) patch.properties = body.properties;
    return this.v3.updateFeature(itemId, layerId, featureId, patch, user, {
      ownRowsOnly: rowScope === 'own',
      isTable,
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
    assertFeatureIdShape(featureId);
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
  ): Promise<{
    geoLimit: unknown | null;
    rowScope: 'all' | 'own';
    /**
     * True when the resolved layer was provisioned without a `geom`
     * column (geometryType=null, the related-event-tracking pattern
     * from #174). Threads through to the v3 service so SELECT /
     * INSERT / UPDATE statements skip every reference to geom on
     * table sublayers (#192).
     */
    isTable: boolean;
    /**
     * #247 / #268: the resolved layer schema. Callers that need to
     * validate a request-supplied field name (e.g. parentFk) against
     * the actual column list use this rather than re-fetching the
     * item. Includes `parentFkColumn` so the parent-FK filter can
     * recognize the relate-back column even though it's not inside
     * fields[].
     */
    layer: {
      id: string;
      fields?: Array<{ name: string }>;
      parentFkColumn?: string;
    };
    /**
     * The asserted item row, shares included, exactly as the
     * visibility check fetched it. Surfaced so follow-up permission
     * decisions (the GeoParquet export's canDownload gate) evaluate
     * against the same snapshot without a second lookup.
     */
    item: Awaited<ReturnType<ItemsService['get']>>;
  }> {
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
        geometryType?: string | null;
        fields?: Array<{ name: string }>;
        parentFkColumn?: string;
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
    // #82: geo-limit applies on BOTH reads and writes. Reads narrow
    // the SELECT to the polygon (existing behavior). Writes use the
    // same polygon to gate incoming feature geometries: a write
    // outside the caller's effective geo limit is rejected up-front
    // so the data integrity story stays honest. Without this gate a
    // contributor could add a feature outside their boundary, watch
    // it disappear from their next read (silently clipped), and
    // wonder where their work went; meanwhile the row would still
    // be visible to owners / admins. Owners and admins return null
    // here (no restriction) inside SharingService.
    const withShares = item as typeof item & { shares?: ItemShare[] };
    const shares = withShares.shares ?? [];
    const geoLimit = await this.sharing.geoLimitFor(user, item, shares);
    // Row-scope applies to BOTH reads and writes (#40). On reads it
    // narrows the SELECT; on writes it gates the per-row update /
    // delete to features the caller created. Owner / admin / public
    // / org-public bypass the scope inside SharingService. The
    // layer-level editingPolicy (#41) tightens every matching share
    // when set to 'own-rows-only'. #83: when the request is a write
    // (mode='write'), pull the share's editRowScope override; reads
    // use rowScope as before. Same composition rules either way.
    const layerPolicy = layer.editingPolicy ?? 'all-rows';
    const rowScope = this.sharing.effectiveRowScope(
      user,
      item,
      shares,
      layerPolicy,
      mode === 'write' ? 'edit' : 'read',
    );
    // Match tables.service's convention: null geometryType means
    // a table sublayer (no geom column was provisioned). undefined
    // shouldn't happen in well-formed v3 data but if it does we err
    // toward "spatial layer" so the historic codepath that selects
    // geom keeps working -- a layer that genuinely has geom but is
    // missing its geometryType field would silently lose geometry
    // otherwise.
    const isTable = layer.geometryType === null;
    return { geoLimit, rowScope, isTable, layer, item };
  }
}

/**
 * Attachment filename stem for the GeoParquet export: item title +
 * layer label (or name), sanitized to header-safe ASCII. The CSV
 * route predates assertV3Layer surfacing the item and falls back to
 * the layer id; here we have the real title, so use it. Underscore
 * runs collapse and the stem is length-capped so a florid title
 * cannot produce an unwieldy or header-breaking filename.
 */
function exportFilenameStem(
  item: { title: string; data: unknown },
  layerId: string,
): string {
  const layers =
    (item.data as {
      layers?: Array<{ id: string; name?: string; label?: string }>;
    } | null)?.layers ?? [];
  const layerMeta = layers.find((l) => l.id === layerId);
  const layerPart = layerMeta?.label || layerMeta?.name || layerId;
  const stem = `${item.title}_${layerPart}`
    // \w without the unicode flag is [A-Za-z0-9_]: everything else
    // (spaces, quotes, accents, path separators) collapses to _,
    // which keeps the Content-Disposition value trivially safe.
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return stem.length > 0 ? stem : 'layer';
}

/**
 * #247: tiny predicate used by the listFeatures parent-FK filter to
 * confirm the supplied column actually exists on the target layer's
 * schema before letting it through to the SQL builder. Defined at
 * module scope (not a method) so it doesn't pull `this` into a hot
 * codepath; takes the minimal layer shape the assertV3Layer helper
 * surfaces.
 */
function schemaHasField(
  layer: { fields?: Array<{ name: string }> } | undefined,
  fieldName: string,
): boolean {
  if (!layer || !Array.isArray(layer.fields)) return false;
  return layer.fields.some((f) => f.name === fieldName);
}

/**
 * Is `name` the parentFkColumn declared on this layer? The
 * parentFkColumn is the relate-back FK a child layer declares to
 * point at its parent (e.g. status -> inspection_point); it lives
 * as a sibling property on the layer descriptor, NOT inside
 * fields[]. The parent-FK filter is the one place a request-supplied
 * column name should match against parentFkColumn rather than the
 * fields list (#268).
 */
function layerHasParentFk(
  layer: { parentFkColumn?: string } | undefined,
  fieldName: string,
): boolean {
  if (!layer) return false;
  return typeof layer.parentFkColumn === 'string'
    && layer.parentFkColumn === fieldName;
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
