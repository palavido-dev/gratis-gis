// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { isUuid, type GeoJsonGeometry } from '@gratis-gis/engine';
import {
  ExpressionError,
  describeViolations,
  evaluateExpression,
  fieldRefTypeFor,
  parseExpression,
  validateExpression,
  validateFeatureProperties,
  type FeatureField,
  type FieldDomain,
  type FieldRef,
  type MapLayerFilter,
  type ResolvedPickLists,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuthSyncService, type AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from '../items/sharing.service.js';
import { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';
import {
  DataLayerEngine,
  type AggregateBin,
  type AggregateVia,
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

/** What `loadLayerSchema` returns and `bulkInsertFeatures` optionally takes. */
export interface LayerSchema {
  fields: FeatureField[];
  pickLists: ResolvedPickLists;
}

/**
 * Drop the `_`-prefixed editor-tracking keys (`_global_id`,
 * `_created_by`, ...) that the read path inlines into `properties`.
 * They are derived on read, so writing them back would freeze a
 * stale copy into `attrs` and shadow the live values next time.
 * Applied to every property bag about to be persisted on an update.
 */
function stripUnderscoreKeys(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

@Injectable()
export class DataLayerFeaturesService {
  private readonly log = new Logger(DataLayerFeaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheRefresh: DerivedLayerCacheRefreshService,
    private readonly dataLayer: DataLayerEngine,
    private readonly bboxRefresh: ItemBboxRefreshService,
    private readonly sharing: SharingService,
    private readonly authSync: AuthSyncService,
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

  /**
   * Undeclared keys already reported, by `itemId:layerId:sortedKeys`.
   * Schema drift is worth one line in the log, not one per row of a
   * 40,000-row import. Bounded by clearing when it grows past a few
   * thousand entries, which a long-lived replica would otherwise reach
   * only after years of distinct drift.
   */
  private readonly reportedUnknownKeys = new Set<string>();

  /**
   * The layer's declared fields plus any pick lists its domains point
   * at, for `validateFeatureProperties`.
   *
   * Read straight off `item.data` rather than through one of the five
   * `readV3Layers` copies: those narrow a field down to name, type and
   * searchable, and drop `domain`, `storage` and `nullable`, which are
   * three of the five things there is any point in validating.
   *
   * Returns an empty field list for v1/v2 items and for layers that
   * declare no fields, which makes the validator a no-op there. That
   * is deliberate: a layer with no schema has nothing to disagree
   * with, and schema-free v3 layers must stay writable.
   *
   * Public so the async import worker can load the schema once for a
   * whole job and hand it to every `bulkInsertFeatures` batch, rather
   * than paying an item read plus a pick-list read per batch.
   */
  async loadLayerSchema(itemId: string, layerId: string): Promise<LayerSchema> {
    const empty: LayerSchema = { fields: [], pickLists: {} };
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true, ownerId: true },
    });
    const data = item?.data;
    if (!data || typeof data !== 'object') return empty;
    const d = data as { version?: unknown; layers?: unknown };
    if (d.version !== 3 || !Array.isArray(d.layers)) return empty;

    const layer = (d.layers as Array<Record<string, unknown>>).find(
      (l) => l && typeof l === 'object' && l.id === layerId,
    );
    const rawFields = layer?.fields;
    if (!Array.isArray(rawFields) || rawFields.length === 0) return empty;
    const fields = rawFields.filter(
      (f): f is FeatureField =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as FeatureField).name === 'string' &&
        (f as FeatureField).name.length > 0,
    );
    if (fields.length === 0) return empty;

    const refDomains = fields
      .map((f) => f.domain)
      .filter(
        (dom): dom is Extract<FieldDomain, { type: 'coded-value-ref' }> =>
          !!dom && dom.type === 'coded-value-ref',
      );
    // A malformed reference is an authoring bug, not a runtime absence.
    // It degrades the same way (that field's domain goes unchecked) but
    // deserves to be visible, because nothing else will ever say so.
    for (const dom of refDomains) {
      if (!isUuid(dom.pickListItemId)) {
        this.log.warn(
          `data_layer:${itemId}:${layerId} has a coded-value-ref domain whose pickListItemId is not a UUID (${JSON.stringify(dom.pickListItemId)}); that field's domain is not enforced`,
        );
      }
    }
    const refIds = [
      ...new Set(refDomains.map((d) => d.pickListItemId).filter((id) => isUuid(id))),
    ];
    if (refIds.length === 0) return { fields, pickLists: {} };

    // Resolve the referenced lists AS THE LAYER'S OWNER would see them.
    //
    // The domain is part of the layer's schema and the owner wired it
    // in, so the owner's read right on the list is the honest test of
    // whether it belongs there. Resolving with no check, as this used
    // to, let an author point a domain at any pick list by id and then
    // probe its membership one value at a time: the 400 no longer
    // lists codes, but accept-or-reject is still an oracle. A list the
    // owner cannot read is treated exactly like a deleted one: it does
    // not land here, and the validator leaves that field's domain
    // unchecked rather than making the layer read-only by accident.
    //
    // The owner, not the caller: a share recipient writing a row must
    // be judged by the same domain the owner authored, or two people
    // editing the same layer would be held to different rules.
    const owner = item?.ownerId
      ? await this.authSync.principalForUserId(item.ownerId)
      : null;
    const lists = owner
      ? await this.prisma.item.findMany({
          where: {
            AND: [
              { id: { in: refIds }, type: 'pick_list', deletedAt: null },
              this.sharing.visibleWhere(owner),
            ],
          },
          select: { id: true, data: true },
        })
      : [];
    const unresolved = refIds.filter((id) => !lists.some((l) => l.id === id));
    if (unresolved.length > 0) {
      this.log.warn(
        `data_layer:${itemId}:${layerId} references pick list(s) its owner cannot read or that no longer exist (${unresolved.join(', ')}); those domains are not enforced`,
      );
    }
    const pickLists: ResolvedPickLists = {};
    for (const list of lists) {
      const listData = list.data as { entries?: unknown } | null;
      if (!listData || !Array.isArray(listData.entries)) continue;
      pickLists[list.id] = (listData.entries as Array<Record<string, unknown>>)
        .filter((e) => e && (typeof e.code === 'string' || typeof e.code === 'number'))
        .map((e) => ({ code: e.code as string | number }));
    }
    return { fields, pickLists };
  }

  /**
   * Validate one feature's attributes against the layer schema and
   * return the COERCED properties to persist.
   *
   * Enforced here in the service rather than in the controller so that
   * every writer is covered by one implementation: the REST endpoints,
   * the form runtime, the OSM save-as-layer path, the ArcGIS importer,
   * the sample seeder and the async import worker all land in this
   * class, and several of them never touch a controller at all.
   *
   * Callers must persist the returned object. Discarding it and
   * writing the original input silently drops every coercion, which
   * would leave the validator doing nothing except occasionally
   * saying no.
   */
  private async validateProperties(
    itemId: string,
    layerId: string,
    properties: Record<string, unknown> | undefined,
    mode: 'create' | 'patch',
    user: AuthUser,
    context?: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (properties === undefined) return undefined;
    const [out] = await this.validateAll(itemId, layerId, [{ properties }], mode, user, {
      ...(context ? { context } : {}),
    });
    return out;
  }

  /**
   * Batch form of `validateProperties`: loads the layer schema ONCE
   * (or takes one the caller already loaded) and validates every input
   * against it, returning the coerced property bags positionally.
   *
   * The positional contract matters. The caller rebuilds its engine
   * arguments by index, so returning a filtered or reordered list here
   * would attach one feature's attributes to another's geometry.
   *
   * Rejects on the first offending row and names it, because a bulk
   * import that reports "row 41,208: Depth is a number field; 'n/a' is
   * not a number" tells the operator which column to fix, while a
   * partial import leaves them reconciling two datasets.
   *
   * Two things happen here besides validation, both on purpose:
   *
   * - On a create, `submitted_by` is overwritten with the caller's own
   *   id when the layer declares that column. The field runtime sends
   *   it from the client so its offline queue can render the row, but
   *   the server is the only party that knows who is actually holding
   *   the token; trusting the client would let anyone with edit rights
   *   attribute an observation to any user id they liked, and the
   *   responses view renders that id as a person's name. `submitted_at`
   *   is NOT overwritten: capture time is client-authoritative (offline
   *   is the only place that knows it) and is only filled when absent.
   *
   * - Undeclared keys are logged once per distinct set per layer. The
   *   validator preserves them (rejecting would break the form runtime,
   *   dropping would lose data) but nothing else would ever say the
   *   schema has drifted from what its writers send.
   */
  private async validateAll(
    itemId: string,
    layerId: string,
    inputs: ReadonlyArray<{ properties?: Record<string, unknown> | undefined }>,
    mode: 'create' | 'patch',
    user: AuthUser,
    opts: { schema?: LayerSchema; context?: string } = {},
  ): Promise<Array<Record<string, unknown> | undefined>> {
    const originals = inputs.map((f) => f.properties);
    const { fields, pickLists } =
      opts.schema ?? (await this.loadLayerSchema(itemId, layerId));
    if (fields.length === 0) return originals;

    const declaresSubmittedBy = fields.some((f) => f.name === 'submitted_by');
    const declaresSubmittedAt = fields.some((f) => f.name === 'submitted_at');
    const rowLabel = (i: number) =>
      opts.context ? `${opts.context}: ` : originals.length > 1 ? `Row ${i + 1}: ` : '';

    return originals.map((original, i) => {
      if (original === undefined) return undefined;
      // Stamp BEFORE validating, not after. Done the other way round,
      // a queued field record captured before the client learned to
      // send submitted_at would fail the required check on every
      // sync attempt forever, and the offline queue retries failed
      // records on each drain.
      let properties = original;
      if (mode === 'create' && (declaresSubmittedBy || declaresSubmittedAt)) {
        properties = { ...original };
        if (declaresSubmittedBy) properties.submitted_by = user.id;
        if (
          declaresSubmittedAt &&
          (properties.submitted_at === undefined || properties.submitted_at === null)
        ) {
          properties.submitted_at = new Date().toISOString();
        }
      }
      const result = validateFeatureProperties(fields, properties, {
        mode,
        pickLists,
      });
      if (!result.ok) {
        throw new BadRequestException(
          rowLabel(i) + describeViolations(result.violations),
        );
      }
      if (result.unknownFields.length > 0) {
        const key = `${itemId}:${layerId}:${[...result.unknownFields].sort().join(',')}`;
        if (!this.reportedUnknownKeys.has(key)) {
          if (this.reportedUnknownKeys.size > 5000) this.reportedUnknownKeys.clear();
          this.reportedUnknownKeys.add(key);
          this.log.warn(
            `data_layer:${itemId}:${layerId} received keys its schema does not declare: ${result.unknownFields.join(', ')} (preserved, not enforced)`,
          );
        }
      }
      return result.value;
    });
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
    // Schema check before anything is written, in 'create' mode so a
    // required field the caller omitted entirely is caught here rather
    // than surfacing later as an empty column nobody can explain.
    const validated = await this.validateAll(itemId, layerId, inputs, 'create', user);
    const args: CreateFeatureArgs[] = inputs.map((f, i) => ({
      itemId,
      layerId,
      principal,
      ...(f.globalId !== undefined ? { globalId: f.globalId } : {}),
      ...(validated[i] !== undefined ? { properties: validated[i] } : {}),
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
      void this.cacheRefresh.notifySourceWrite(itemId, layerId, validated);
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
   *
   * `schema` is optional and the worker should pass it: it is called
   * once per COPY batch, so without it a 1.4M-row import at 5k per
   * batch would read the item and its pick lists 280 times inside the
   * import transaction. Load it once with `loadLayerSchema` before the
   * loop. Left optional so a caller that forgets is still validated,
   * just more slowly.
   */
  async bulkInsertFeatures(
    itemId: string,
    layerId: string,
    inputs: DataLayerFeatureInsert[],
    user: AuthUser,
    writer: import('../engine/copy-writer.js').CopyWriter,
    schema?: LayerSchema,
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    const principal = { sub: user.id, displayName: user.username ?? '' };
    // Same schema gate as the interactive create path. The bulk
    // importer is exactly where bad data has historically entered (the
    // numeric osm_id in a text-declared column came in this way), so
    // exempting it would leave the hole open at the widest point.
    const validated = await this.validateAll(itemId, layerId, inputs, 'create', user, {
      ...(schema ? { schema } : {}),
    });
    const args: CreateFeatureArgs[] = inputs.map((f, i) => ({
      itemId,
      layerId,
      principal,
      ...(f.globalId !== undefined ? { globalId: f.globalId } : {}),
      ...(validated[i] !== undefined ? { properties: validated[i] } : {}),
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
      where?: MapLayerFilter;
      ownRowsOnly?: { userId: string };
      /**
       * Bitemporal read instant and relate (#25). Same rule as every
       * other key on this wrapper: named in this type AND spread
       * below, or it is silently dropped. Which is exactly what
       * happened on this pair's first deploy: engine correct, both
       * controllers correct, pg specs green, and the live endpoint
       * answered the whole layer because this wrapper was the one
       * hop nobody re-checked. Fourth occurrence of the trap.
       */
      asOf?: Date;
      via?: EngineVia;
    } = {},
  ) {
    // Key-by-key forwarding. Adding an option means adding it in two
    // places, and the spec below asserts on the object the engine
    // RECEIVED rather than on the rows, because a dropped key here
    // returns a plausible answer to the wrong question.
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
      ...(args.where !== undefined ? { where: args.where } : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
      ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
      ...(args.via !== undefined ? { via: args.via } : {}),
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
   * #77: predicate-driven union bbox. Same forwarding rule as every
   * wrapper on this class: each key named in this type AND in the
   * spread, and the forwarding spec carries the full-option case.
   */
  async filteredExtent(
    itemId: string,
    layerId: string,
    args: {
      where?: MapLayerFilter;
      via?: EngineVia;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      asOf?: Date;
    } = {},
  ): Promise<[number, number, number, number] | null> {
    return this.dataLayer.filteredExtent({
      itemId,
      layerId,
      ...(args.where !== undefined ? { where: args.where } : {}),
      ...(args.via !== undefined ? { via: args.via } : {}),
      ...(args.geoLimit !== undefined
        ? { geoLimit: args.geoLimit as GeoJsonGeometry }
        : {}),
      ...(args.boundaryClip !== undefined
        ? { boundaryClip: args.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(args.ownRowsOnly !== undefined
        ? { ownRowsOnly: args.ownRowsOnly }
        : {}),
      ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
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
      /**
       * Attribute predicate and relate, applied server side.
       *
       * These reached the controllers before they reached here, and
       * the tile came back byte-identical to the unfiltered one: this
       * method rebuilds the engine's arguments key by key, so an
       * option missing from the list below is dropped in silence.
       * TypeScript does not catch it, because `opts` arrives as a
       * variable rather than a fresh object literal and excess
       * property checking does not apply.
       */
      where?: MapLayerFilter;
      via?: AggregateVia;
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
      ...(opts.where !== undefined ? { where: opts.where } : {}),
      ...(opts.via !== undefined ? { via: opts.via } : {}),
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

    // MERGE the patch over the current values. This is what the
    // docblock above has always promised and what every caller
    // assumed; the code used to replace the whole bag instead, so a
    // client that sent only the keys it changed silently cleared every
    // other column. The field runtime's edit path sends only the
    // form's own keys, which on a paired submissions layer meant an
    // edit wiped `submitted_at` and `submitted_by`.
    //
    // Merging is also what makes 'patch' mode validation exact: a key
    // the caller did not mention keeps its value, so "not mentioned"
    // and "cleared" are different things, and only the second can
    // violate a required field. Under replace semantics they were the
    // same write and the validator had to pick a side.
    //
    // Underscore keys are stripped from BOTH sides: the read path
    // inlines them and a client that echoes them back would otherwise
    // freeze a stale `_created_at` into attrs.
    const base = stripUnderscoreKeys(existing.properties);
    const nextProps =
      patch.properties !== undefined
        ? {
            ...base,
            ...stripUnderscoreKeys(
              (await this.validateProperties(
                itemId,
                layerId,
                patch.properties,
                'patch',
                user,
              )) ?? patch.properties,
            ),
          }
        : base;

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

    // Check the expression against the layer's DECLARED schema.
    //
    // This used to seed the field list from the first row's property
    // keys, which meant the type of every reference was 'unknown' (so
    // `acres + owner` type-checked) and a field absent from row one
    // read as a typo. The declared schema is now available, so use it.
    // Layers with no schema keep the old row-sampled behaviour,
    // because there is nothing better to check against.
    const { fields: layerFields, pickLists } = await this.loadLayerSchema(
      args.itemId,
      args.layerId,
    );
    const schemaRefs: FieldRef[] =
      layerFields.length > 0
        ? layerFields.map((f) => ({ name: f.name, type: fieldRefTypeFor(f.type) }))
        : Object.keys(features.features[0]?.properties ?? {}).map((name) => ({
            name,
            type: 'unknown' as const,
          }));
    const validationErrors = validateExpression(ast, schemaRefs);
    if (validationErrors.length > 0) {
      throw new BadRequestException(
        `expression: ${validationErrors.join('; ')}`,
      );
    }

    // The output has to be a field the layer actually declares.
    // Without this, Calculate Field invents a column: the value lands
    // in the JSONB attributes, the attribute table (which renders
    // declared fields) never shows it, and the author concludes the
    // calculation silently did nothing.
    const outputField = layerFields.find((f) => f.name === args.outputName);
    if (layerFields.length > 0 && !outputField) {
      throw new BadRequestException(
        `This layer has no field called "${args.outputName}". Add it to the layer first, then run the calculation.`,
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
    for (const f of features.features) {
      const oldValue = (f.properties as Record<string, unknown>)[args.outputName];
      let raw: unknown;
      try {
        raw = evaluateExpression(ast, f.properties as Record<string, unknown>);
      } catch {
        errors += 1;
        raw = null;
      }
      let coerced = coerceOutputValue(raw, args.outputType);

      // The computed value still has to satisfy the target field:
      // outputType is what the AUTHOR asked the expression to produce,
      // which is not necessarily what the column declares, and it says
      // nothing at all about domains, ranges or field length. A row
      // whose result the field cannot hold counts as an error and is
      // left untouched rather than written as a value that would fail
      // the same check on the way back in.
      if (outputField) {
        const check = validateFeatureProperties(
          [outputField],
          { [args.outputName]: coerced },
          { mode: 'patch', pickLists },
        );
        if (!check.ok) {
          errors += 1;
          if (sample.length < 5) {
            sample.push({ id: String(f.id), oldValue, newValue: oldValue });
          }
          continue;
        }
        coerced = check.value[args.outputName];
      }

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
