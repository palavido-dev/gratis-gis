// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { isUuid, type GeoJsonGeometry } from '@gratis-gis/engine';
import {
  ExpressionError,
  evaluateExpression,
  parseExpression,
  validateExpression,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import {
  DataLayerEngine,
  type AggregateBin,
  type CreateFeatureArgs,
  type TileResult,
} from '../engine/data-layer.js';

/**
 * A relate as the engine takes it: the parent layer's identity plus
 * the parent's own scope, already authorized by whichever controller
 * built it.
 *
 * Exported and shared rather than redeclared per controller. The
 * authenticated endpoint and the anonymous mirror have to agree about
 * this shape exactly, and the one time they did not, `via` parsed
 * cleanly on the anonymous side and was then dropped, so the endpoint
 * answered 200 with whole-layer numbers for a request that believed
 * it was scoped.
 *
 * The caller MUST have checked read access on the parent and folded
 * the parent's geo limit into `parentGeoLimit` before handing this
 * over. The engine reads a layer the request never named; skipping
 * that check turns a relate into a side channel.
 */
export interface EngineVia {
  myField: string;
  parentField: string;
  parentItemId: string;
  parentLayerId: string;
  parentBbox?: [number, number, number, number];
  parentWhere?: {
    combinator: 'all' | 'any';
    clauses: Array<{ field: string; op: string; value: string }>;
  };
  parentGeoLimit?: GeoJsonGeometry;
}

/**
 * Per-layer feature CRUD for v3 data_layer items.
 *
 * Post-Phase-2.2 this is a thin wrapper over `DataLayerEngine`. The
 * controller-facing surface (DTOs, response shapes, own-rows-only
 * guard, cache-refresh notifications, error semantics) is preserved
 * byte-for-byte; the SQL that used to hit per-layer `fs_*` tables
 * now flows through the observation log via the engine adapter.
 *
 * Per-layer tables still get provisioned upstream by `ItemsService`
 * but they are no longer written to or read from. They become
 * orphans until sub-phase 2.5/2.6 stops creating them and drops the
 * existing ones.
 *
 * Behaviour deltas to know about:
 *
 * - The `SELECT...FOR UPDATE + UPDATE valid_to + INSERT new`
 *   transaction in updateFeature collapses into a single observation
 *   write. The append-only log is naturally last-writer-wins; no
 *   row-level lock is necessary.
 * - The typed-column projection on per-layer tables is gone.
 *   Features land as JSONB `attrs` only. Attribute lookups go
 *   through `attrs->>'field'` (with type casts when needed) instead
 *   of dedicated typed columns.
 * - The `isTable` flag still skips spatial filters in the read path,
 *   matching the v3 wire contract; geometry is just `null` for
 *   table-shaped sublayers.
 * - `gid` (the per-layer integer auto-increment id) is no longer
 *   returned. Callers that need a stable per-row identifier use
 *   `id` (the entity UUID) which has been the public identifier
 *   anyway.
 */

export interface DataLayerFeatureInsert {
  globalId?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | undefined;
}

export interface DataLayerFeatureOut {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
}

@Injectable()
export class DataLayerFeaturesService {
  private readonly log = new Logger(DataLayerFeaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheRefresh: DerivedLayerCacheRefreshService,
    private readonly dataLayer: DataLayerEngine,
    private readonly bboxRefresh: ItemBboxRefreshService,
  ) {}

  /**
   * Fire-and-forget bbox refresh after a feature mutation (#85).
   * The cached `item.bbox` only gets stamped on data_json saves;
   * post-engine-pivot feature writes don't touch data_json, so a
   * data_layer / map / editor that just received feature mutations
   * keeps stale bbox info and silently disappears from the area
   * filter. This kicks off an async refresh after every successful
   * write. Throttled per-item inside the service so a busy field-
   * app sync doesn't write the bbox row on every observation.
   * Errors are swallowed (logged inside the service) because a
   * stamper failure must not break the user's save.
   */
  private scheduleBboxRefresh(itemId: string): void {
    void this.bboxRefresh.refreshItemBbox(itemId);
  }

  /** Current-state feature collection for a layer. Supports bbox
   *  filter + point-in-time (`at`), per-share `geoLimit`, layer
   *  `boundaryClip`, `ownRowsOnly`, and `parentFkFilter`. The
   *  semantics are unchanged from the per-layer-table era; the SQL
   *  underneath now hits the observation log. */
  async listFeatures(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
      /** #115 P12: single-feature lookup by stable entity UUID.
       *  The map popup path uses this after an MVT click to fetch
       *  full attrs by id; without it the popup would force the
       *  layer to return every feature. */
      entity?: string;
      /** SQL-level row cap, threaded straight into the engine's
       *  LIMIT clause. The OGC API Features controller passes the
       *  query's `limit` here so a 1.4M-row layer doesn't load
       *  every row before the JS pagination slice. Defaults at the
       *  engine to 100 000 to match the historical map-render path
       *  that pre-dates server-side pagination; new callers that
       *  paginate should always supply this. */
      limit?: number;
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: DataLayerFeatureOut[] }> {
    const result = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      ...(opts.at !== undefined ? { asOf: new Date(opts.at) } : {}),
      ...(opts.bbox !== undefined ? { bbox: opts.bbox } : {}),
      ...(opts.geoLimit !== undefined
        ? { geoLimit: opts.geoLimit as GeoJsonGeometry }
        : {}),
      ...(opts.boundaryClip !== undefined
        ? { boundaryClip: opts.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(opts.ownRowsOnly !== undefined
        ? { ownRowsOnly: opts.ownRowsOnly }
        : {}),
      ...(opts.parentFkFilter !== undefined
        ? { parentFkFilter: opts.parentFkFilter }
        : {}),
      ...(opts.timeFilter !== undefined
        ? { timeFilter: opts.timeFilter }
        : {}),
      ...(opts.isTable === true ? { isTable: true } : {}),
      ...(opts.entity !== undefined ? { entity: opts.entity } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return result;
  }

  /** Keyset-paginated read of EVERY current-state feature in a
   *  layer (#174 GeoParquet export). Same filter semantics as
   *  listFeatures but no result cap: listFeatures buffers and
   *  silently truncates at its 100k default, which would corrupt a
   *  whole-layer export. Pages come from the engine's cursor walk
   *  on the stable entity key; see
   *  `DataLayerEngine.iterateFeatures` for the no-drop /
   *  no-duplicate argument. */
  async *iterateFeatures(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    } = {},
    pageSize?: number,
  ): AsyncGenerator<DataLayerFeatureOut[], void, undefined> {
    yield* this.dataLayer.iterateFeatures({
      itemId,
      layerId,
      ...(opts.at !== undefined ? { asOf: new Date(opts.at) } : {}),
      ...(opts.bbox !== undefined ? { bbox: opts.bbox } : {}),
      ...(opts.geoLimit !== undefined
        ? { geoLimit: opts.geoLimit as GeoJsonGeometry }
        : {}),
      ...(opts.boundaryClip !== undefined
        ? { boundaryClip: opts.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(opts.ownRowsOnly !== undefined
        ? { ownRowsOnly: opts.ownRowsOnly }
        : {}),
      ...(opts.parentFkFilter !== undefined
        ? { parentFkFilter: opts.parentFkFilter }
        : {}),
      ...(opts.timeFilter !== undefined
        ? { timeFilter: opts.timeFilter }
        : {}),
      ...(opts.isTable === true ? { isTable: true } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    });
  }

  /** One page of the walk above, for callers that cannot hold a
   *  generator open across the read. This is what the HTTP feature
   *  endpoints serve `?cursor=` from, so an external script paging a
   *  1.4M-row layer gets the same no-drop / no-duplicate guarantees
   *  the in-process GeoParquet export gets rather than a second,
   *  weaker pagination. See `DataLayerEngine.readFeaturePage`. */
  async readFeaturePage(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
      timeFilter?: { column: string; from?: string; to?: string };
    } = {},
    page: { after?: string | null; pageSize?: number } = {},
  ): Promise<{
    features: DataLayerFeatureOut[];
    nextCursor: string | null;
    asOf: Date;
  }> {
    return this.dataLayer.readFeaturePage({
      itemId,
      layerId,
      ...(opts.at !== undefined ? { asOf: new Date(opts.at) } : {}),
      ...(opts.bbox !== undefined ? { bbox: opts.bbox } : {}),
      ...(opts.geoLimit !== undefined
        ? { geoLimit: opts.geoLimit as GeoJsonGeometry }
        : {}),
      ...(opts.boundaryClip !== undefined
        ? { boundaryClip: opts.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(opts.ownRowsOnly !== undefined
        ? { ownRowsOnly: opts.ownRowsOnly }
        : {}),
      ...(opts.parentFkFilter !== undefined
        ? { parentFkFilter: opts.parentFkFilter }
        : {}),
      ...(opts.timeFilter !== undefined
        ? { timeFilter: opts.timeFilter }
        : {}),
      ...(opts.isTable === true ? { isTable: true } : {}),
      ...(page.after != null ? { after: page.after } : {}),
      ...(page.pageSize !== undefined ? { pageSize: page.pageSize } : {}),
    });
  }

  /** Bulk-insert features. Optional client-supplied `globalId` is
   *  passed through as the entity id and makes the create
   *  IDEMPOTENT: when a live (not deleted) entity with that id
   *  already exists in the layer, no duplicate is written and the
   *  input resolves to the existing feature. This is what the
   *  editor / form-runtime retry contract always claimed; before
   *  this fix nothing enforced it and a retried POST after a
   *  network blip appended a second `create` observation (double
   *  rows in reads that join the create observation, double
   *  notifications, phantom "new" features).
   *
   *  Routes through `DataLayerEngine.writeFeaturesCreateIdempotent`:
   *  inputs without a globalId take the plain batched-INSERT path
   *  (fresh entities have nothing to dedupe against), inputs with
   *  one go through the advisory-lock + guarded-INSERT transaction
   *  so two concurrent retries cannot both insert.
   *
   *  Response: `inserted` counts rows actually written (a fully
   *  deduplicated retry reports 0, which also keeps the controller
   *  from re-firing creation notifications), `deduplicated` counts
   *  inputs resolved to an existing live feature, and `globalIds`
   *  is order-aligned with the request so the caller can address
   *  every feature (new or pre-existing) by id.
   *
   *  The `isTable` flag is accepted for signature parity with the
   *  pre-engine v3 service; it is no longer used because the engine
   *  handles non-spatial sublayers naturally (null geom). */
  async insertFeatures(
    itemId: string,
    layerId: string,
    inputs: DataLayerFeatureInsert[],
    user: AuthUser,
    _opts: { isTable?: boolean } = {},
  ): Promise<{ inserted: number; deduplicated: number; globalIds: string[] }> {
    if (inputs.length === 0) {
      return { inserted: 0, deduplicated: 0, globalIds: [] };
    }

    const principal = { sub: user.id, displayName: user.username ?? '' };
    const args: CreateFeatureArgs[] = inputs.map((f) => ({
      itemId,
      layerId,
      principal,
      ...(f.globalId !== undefined ? { globalId: f.globalId } : {}),
      ...(f.properties !== undefined ? { properties: f.properties } : {}),
      ...(f.geometry !== undefined
        ? { geometry: f.geometry as GeoJsonGeometry | null }
        : {}),
    }));

    const written = await this.dataLayer.writeFeaturesCreateIdempotent(args);
    const inserted = written.filter((w) => !w.deduplicated).length;
    const deduplicated = written.length - inserted;
    this.log.log(
      `Inserted ${inserted} features into data_layer:${itemId}:${layerId}` +
        (deduplicated > 0
          ? ` (${deduplicated} deduplicated by globalId)`
          : ''),
    );

    // Lazy-grow buffer-by-field caches on any derived layer that
    // reads from this source. Best-effort: notifySourceWrite swallows
    // its own errors so an insert that goes through here is never
    // rolled back by a downstream cache problem. Skipped entirely on
    // a fully-deduplicated retry: nothing changed.
    if (inserted > 0) {
      void this.cacheRefresh.notifySourceWrite(
        itemId,
        layerId,
        inputs.map((f) => f.properties),
      );
      this.scheduleBboxRefresh(itemId);
    }

    return {
      inserted,
      deduplicated,
      globalIds: written.map((w) => w.globalId),
    };
  }

  /**
   * COPY-based bulk-insert. Same input shape as insertFeatures, but
   * routes through `DataLayerEngine.copyFeaturesCreate` which uses
   * PostgreSQL's COPY FROM STDIN protocol instead of multi-row
   * INSERTs. Empirically 5-10x faster on county-scale imports.
   *
   * The caller hands in a started CopyWriter so one transaction
   * spans many batches. Use only from the async-import-job worker.
   * Skips per-batch derived-layer cache invalidation (the worker
   * fires a single bulk invalidation after the import completes
   * for cheaper amortization).
   */
  async bulkInsertFeatures(
    itemId: string,
    layerId: string,
    inputs: DataLayerFeatureInsert[],
    user: AuthUser,
    writer: import('../engine/copy-writer.js').CopyWriter,
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    const principal = { sub: user.id, displayName: user.username ?? '' };
    const args: CreateFeatureArgs[] = inputs.map((f) => ({
      itemId,
      layerId,
      principal,
      ...(f.globalId !== undefined ? { globalId: f.globalId } : {}),
      ...(f.properties !== undefined ? { properties: f.properties } : {}),
      ...(f.geometry !== undefined
        ? { geometry: f.geometry as GeoJsonGeometry | null }
        : {}),
    }));

    const written = await this.dataLayer.copyFeaturesCreate(args, writer);
    return { inserted: written.length };
  }

  /**
   * Paged attribute-table read (#115 P13). Bbox-bounded by default
   * with hard cap + truncation flag; sends attrs only, no geometry.
   */
  async pageFeatures(
    itemId: string,
    layerId: string,
    args: {
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
    } = {},
  ) {
    return this.dataLayer.pageFeatures({
      itemId,
      layerId,
      ...(args.bbox !== undefined ? { bbox: args.bbox } : {}),
      ...(args.q !== undefined ? { q: args.q } : {}),
      ...(args.sort !== undefined ? { sort: args.sort } : {}),
      ...(args.dir !== undefined ? { dir: args.dir } : {}),
      limit: args.limit ?? 5000,
      ...(args.entityIds !== undefined ? { entityIds: args.entityIds } : {}),
      ...(args.geoLimit !== undefined
        ? { geoLimit: args.geoLimit as GeoJsonGeometry }
        : {}),
      ...(args.boundaryClip !== undefined
        ? { boundaryClip: args.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(args.isTable === true ? { isTable: true } : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
    });
  }

  /**
   * Grouped aggregate read. Thin wrapper over the engine adapter;
   * every clip the caller resolved (share geo limit, layer boundary,
   * own-rows-only) passes straight through, because an aggregate is
   * a read and must answer with the caller's rows, not the layer's.
   */
  async aggregateFeatures(
    itemId: string,
    layerId: string,
    args: {
      groupBy?: string[];
      aggs: Array<{
        op: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
        field?: string;
        as: string;
      }>;
      bbox?: [number, number, number, number];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      /**
       * Attribute predicate. Forwarded, not interpreted: the caller
       * has already checked every field against the layer schema.
       *
       * This wrapper forwards by naming each key, so a key missing
       * from the type above is silently dropped rather than rejected.
       * Excess-property checking does not save you either, because
       * the controllers pass a variable rather than an object
       * literal. That is exactly how `where` shipped once as a filter
       * that validated correctly, returned 200, and answered with
       * unfiltered numbers. Add the key in both places.
       */
      where?: {
        combinator: 'all' | 'any';
        clauses: Array<{ field: string; op: string; value: string }>;
      };
      /**
       * Relate scope. The caller has already checked read access on
       * the parent layer and folded its geo limit in; this only
       * forwards. Listed here for the same reason `where` is: the
       * key has to exist in BOTH this type and the spread below or
       * it is silently dropped.
       */
      via?: EngineVia;
      /**
       * Numeric binning. Same rule as `where` and `via` above: named
       * in this type AND spread below, or it vanishes and the chart
       * draws one bar per distinct reading while reporting success.
       */
      bin?: AggregateBin;
      limit?: number;
      asOf?: Date;
    },
  ) {
    return this.dataLayer.aggregateFeatures({
      itemId,
      layerId,
      aggs: args.aggs,
      ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
      ...(args.groupBy !== undefined ? { groupBy: args.groupBy } : {}),
      ...(args.bbox !== undefined ? { bbox: args.bbox } : {}),
      ...(args.where !== undefined ? { where: args.where } : {}),
      ...(args.via !== undefined ? { via: args.via } : {}),
      ...(args.bin !== undefined ? { bin: args.bin } : {}),
      ...(args.geoLimit !== undefined
        ? { geoLimit: args.geoLimit as GeoJsonGeometry }
        : {}),
      ...(args.boundaryClip !== undefined
        ? { boundaryClip: args.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
  }

  /**
   * Attribute search for the map / app search bar. Thin wrapper over
   * the engine's searchFeatures: reaches features anywhere in the
   * layer (not just the viewport) and returns a representative point
   * + envelope per hit so the caller can fly to and highlight an
   * off-screen result.
   */
  async searchFeatures(
    itemId: string,
    layerId: string,
    args: {
      q: string;
      fields?: string[];
      limit?: number;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
    },
  ) {
    return this.dataLayer.searchFeatures({
      itemId,
      layerId,
      q: args.q,
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
      limit: args.limit ?? 8,
      ...(args.geoLimit !== undefined
        ? { geoLimit: args.geoLimit as GeoJsonGeometry }
        : {}),
      ...(args.boundaryClip !== undefined
        ? { boundaryClip: args.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
    });
  }

  /**
   * #30: union bbox of a set of feature ids.  Powers "Zoom to
   * selected" in the attribute table when running against a v3
   * layer in server-paged mode (where /features-page strips
   * geometry so the client cannot compute a bbox locally).
   */
  async selectionExtent(
    itemId: string,
    layerId: string,
    args: {
      entityIds: string[];
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
    },
  ): Promise<[number, number, number, number] | null> {
    return this.dataLayer.selectionExtent({
      itemId,
      layerId,
      entityIds: args.entityIds,
      ...(args.geoLimit !== undefined
        ? { geoLimit: args.geoLimit as GeoJsonGeometry }
        : {}),
      ...(args.boundaryClip !== undefined
        ? { boundaryClip: args.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
    });
  }

  /**
   * Vector-tile bytes for one layer at z/x/y (#115 P12).
   *
   * Pure read-through to DataLayerEngine.mvtTile. Kept here so the
   * controller can stay engine-unaware -- the controller already
   * speaks to this service for every other read, and the auth /
   * sharing guards on the route are unchanged.
   */
  async mvtTile(
    itemId: string,
    layerId: string,
    z: number,
    x: number,
    y: number,
    opts: {
      geoLimit?: unknown;
      boundaryClip?: unknown;
      isTable?: boolean;
      /** Share row-scope (#40). The tile is what the map renders
       *  from, so a scoped /features response is cosmetic without
       *  this. */
      ownRowsOnly?: { userId: string };
      /**
       * Layer's declared field schema. Passed through to the engine
       * so each declared field is projected as an MVT feature
       * property, which is what makes label / popup / filter
       * expressions resolve client-side (#147). Omitted only when
       * the caller can't get the schema (table-mode layers don't
       * have it anyway; they short-circuit to an empty tile).
       */
      fields?: Array<{ name: string; type?: string }>;
    } = {},
  ): Promise<TileResult> {
    return this.dataLayer.mvtTile({
      itemId,
      layerId,
      z,
      x,
      y,
      ...(opts.geoLimit !== undefined
        ? { geoLimit: opts.geoLimit as GeoJsonGeometry }
        : {}),
      ...(opts.boundaryClip !== undefined
        ? { boundaryClip: opts.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(opts.isTable === true ? { isTable: true } : {}),
      ...(opts.ownRowsOnly !== undefined
        ? { ownRowsOnly: opts.ownRowsOnly }
        : {}),
      ...(opts.fields ? { fields: opts.fields } : {}),
    });
  }

  /** Update a feature. Reads the current state through the adapter
   *  (which doubles as the existence + ownership check), merges the
   *  patch with the current values, writes a `kind: 'update'`
   *  observation, and reads the result back. The pre-engine
   *  SELECT-FOR-UPDATE transaction is gone; the append-only log is
   *  naturally last-writer-wins. */
  async updateFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    patch: { geometry?: unknown; properties?: Record<string, unknown> },
    user: AuthUser,
    opts: { ownRowsOnly?: boolean; isTable?: boolean } = {},
  ): Promise<DataLayerFeatureOut> {
    const isTable = opts.isTable === true;

    // Look up the current state. The candidate-entities CTE inside
    // listFeatures filters by created_by when ownRowsOnly is set, so
    // a feature that exists but was created by someone else will
    // come back empty here; we surface that as NotFound to match the
    // pre-engine "don't leak existence" pattern.
    const current = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(opts.ownRowsOnly === true
        ? { ownRowsOnly: { userId: user.id } }
        : {}),
      ...(isTable ? { isTable: true } : {}),
    });
    if (current.features.length === 0) {
      throw new NotFoundException('Feature not found');
    }
    const existing = current.features[0]!;

    const stripUnderscoreKeys = (
      props: Record<string, unknown>,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!k.startsWith('_')) out[k] = v;
      }
      return out;
    };

    const nextProps =
      patch.properties !== undefined
        ? patch.properties
        : stripUnderscoreKeys(existing.properties);

    const nextGeometry: GeoJsonGeometry | null = isTable
      ? null
      : patch.geometry !== undefined
        ? (patch.geometry as GeoJsonGeometry | null)
        : existing.geometry;

    const principal = { sub: user.id, displayName: user.username ?? '' };
    await this.dataLayer.writeFeatureUpdate({
      itemId,
      layerId,
      globalId: featureId,
      principal,
      properties: nextProps,
      geometry: nextGeometry,
    });

    const refreshed = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(isTable ? { isTable: true } : {}),
    });
    const result = refreshed.features[0];
    if (result === undefined) {
      // Defensive: writeFeatureUpdate succeeded but the read came
      // back empty. Treat as 500-equivalent rather than masquerading
      // as 404; this should not happen.
      throw new Error('Feature update succeeded but read-back returned no rows');
    }

    void this.cacheRefresh.notifySourceWrite(itemId, layerId, [nextProps]);
    this.scheduleBboxRefresh(itemId);
    return result;
  }

  /** Soft-delete a feature by appending a `kind: 'delete'`
   *  observation. The read path filters tombstones out, so the
   *  entity disappears from feature collections; nothing is
   *  physically removed from the log. */
  async deleteFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    user: AuthUser,
    opts: { ownRowsOnly?: boolean } = {},
  ): Promise<void> {
    const current = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(opts.ownRowsOnly === true
        ? { ownRowsOnly: { userId: user.id } }
        : {}),
    });
    if (current.features.length === 0) {
      throw new NotFoundException('Feature not found');
    }

    const principal = { sub: user.id, displayName: user.username ?? '' };
    await this.dataLayer.writeFeatureDelete({
      itemId,
      layerId,
      globalId: featureId,
      principal,
    });
    this.scheduleBboxRefresh(itemId);
  }

  /**
   * Bulk attribute calculation across a scope of features (#83).
   * Parses + validates the expression once, evaluates it per row
   * against current property values, and either returns a preview
   * (dryRun) or emits one update observation per affected row via
   * the engine's bulk write path.
   *
   * Hard server cap (MAX_CALC_FIELD_ROWS) so a runaway client can't
   * queue a 5M-row job synchronously.  Callers that genuinely need
   * to recalc tens of thousands of rows should keep the cap in mind
   * and split into smaller scope batches.
   *
   * Output coercion follows outputType: 'number' casts the JS
   * evaluator's result through Number() and rejects NaN; 'string'
   * casts to String(); 'boolean' to Boolean().  null values pass
   * through (the column on that row is cleared).
   */
  async calculateField(args: {
    itemId: string;
    layerId: string;
    expression: string;
    outputName: string;
    outputType: 'number' | 'string' | 'boolean';
    scope: 'all' | 'selection';
    selectedIds?: string[];
    dryRun: boolean;
    user: AuthUser;
    ownRowsOnly?: boolean;
    isTable?: boolean;
  }): Promise<{
    totalRows: number;
    appliedRows: number;
    sample: Array<{
      id: string;
      oldValue: unknown;
      newValue: unknown;
    }>;
    errors: number;
  }> {
    if (!FIELD_NAME_RE.test(args.outputName)) {
      throw new BadRequestException(
        'outputName must match [a-z_][a-z0-9_]* (letters, digits, underscores; not starting with a digit)',
      );
    }
    let ast;
    try {
      ast = parseExpression(args.expression);
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new BadRequestException(
          `expression: ${err.message} (at position ${err.pos})`,
        );
      }
      throw err;
    }

    // 'selection' scope must never fall through to the whole layer:
    // an empty or malformed selection here would silently widen the
    // write to every row (the exact failure mode #selection-scope
    // shipped with, when entityIds was dropped on the engine floor).
    // Validate the ids up front so the engine's ::uuid casts can't
    // 500 and so the documented row cap applies to the selection
    // itself, not just the rows it happens to match.
    let selectionIds: string[] | undefined;
    if (args.scope === 'selection') {
      const ids = args.selectedIds ?? [];
      if (ids.length === 0) {
        throw new BadRequestException(
          "scope 'selection' requires a non-empty selectedIds list",
        );
      }
      if (ids.length > MAX_CALC_FIELD_ROWS) {
        throw new BadRequestException(
          `Calculate Field is capped at ${MAX_CALC_FIELD_ROWS} rows per call; narrow the scope or split into smaller batches`,
        );
      }
      if (ids.some((id) => !isUuid(id))) {
        throw new BadRequestException(
          'selectedIds must be feature ids (UUIDs)',
        );
      }
      selectionIds = ids;
    }

    // Fetch the affected entities.  In 'selection' mode we limit
    // to selectedIds; otherwise we pull every entity in the
    // sublayer.  ownRowsOnly + isTable mirror the regular update
    // path so per-share row scoping is respected.
    const features = await this.dataLayer.listFeatures({
      itemId: args.itemId,
      layerId: args.layerId,
      ...(selectionIds !== undefined ? { entityIds: selectionIds } : {}),
      ...(args.ownRowsOnly === true
        ? { ownRowsOnly: { userId: args.user.id } }
        : {}),
      ...(args.isTable === true ? { isTable: true } : {}),
    });

    const total = features.features.length;
    if (total > MAX_CALC_FIELD_ROWS) {
      throw new BadRequestException(
        `Calculate Field is capped at ${MAX_CALC_FIELD_ROWS} rows per call; narrow the scope or split into smaller batches`,
      );
    }

    // Light schema validation against the upstream fields.  We
    // gather field names from the first row's properties as a
    // pragmatic stand-in for the schema; sublayer schema lookup
    // would be more correct but the row sample matches what the
    // user is editing.
    const schemaSeed = features.features[0]?.properties ?? {};
    const validationErrors = validateExpression(
      ast,
      Object.keys(schemaSeed).map((name) => ({ name, type: 'unknown' as const })),
    );
    if (validationErrors.length > 0) {
      throw new BadRequestException(
        `expression: ${validationErrors.join('; ')}`,
      );
    }

    // Compute (oldValue, newValue) per row.  Eval failures (e.g. a
    // row missing a referenced field) collapse to null + count
    // toward `errors`; the operation continues so a few bad rows
    // don't abort a 5000-row recalc.
    let errors = 0;
    const sample: Array<{ id: string; oldValue: unknown; newValue: unknown }> = [];
    const updates: Array<{
      id: string;
      newProperties: Record<string, unknown>;
      geometry: GeoJsonGeometry | null;
    }> = [];
    const stripUnderscoreKeys = (
      props: Record<string, unknown>,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!k.startsWith('_')) out[k] = v;
      }
      return out;
    };
    for (const f of features.features) {
      const oldValue = (f.properties as Record<string, unknown>)[args.outputName];
      let raw: unknown;
      try {
        raw = evaluateExpression(ast, f.properties as Record<string, unknown>);
      } catch {
        errors += 1;
        raw = null;
      }
      const coerced = coerceOutputValue(raw, args.outputType);
      if (sample.length < 5) {
        sample.push({ id: String(f.id), oldValue, newValue: coerced });
      }
      const cleanedProps = stripUnderscoreKeys(
        f.properties as Record<string, unknown>,
      );
      updates.push({
        id: String(f.id),
        newProperties: { ...cleanedProps, [args.outputName]: coerced },
        geometry: (f.geometry ?? null) as GeoJsonGeometry | null,
      });
    }

    if (args.dryRun) {
      return { totalRows: total, appliedRows: 0, sample, errors };
    }

    const principal = {
      sub: args.user.id,
      displayName: args.user.username ?? '',
    };
    await this.dataLayer.writeFeaturesUpdate(
      updates.map((u) => ({
        itemId: args.itemId,
        layerId: args.layerId,
        globalId: u.id,
        principal,
        properties: u.newProperties,
        geometry: u.geometry,
      })),
    );

    void this.cacheRefresh.notifySourceWrite(
      args.itemId,
      args.layerId,
      updates.map((u) => u.newProperties),
    );
    this.scheduleBboxRefresh(args.itemId);

    return { totalRows: total, appliedRows: updates.length, sample, errors };
  }
}

const FIELD_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const MAX_CALC_FIELD_ROWS = 10_000;

function coerceOutputValue(
  raw: unknown,
  outputType: 'number' | 'string' | 'boolean',
): unknown {
  if (raw === null || raw === undefined) return null;
  if (outputType === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (outputType === 'boolean') {
    return Boolean(raw);
  }
  return String(raw);
}
