// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-layer adapter for the observation-log engine.
//
// The data_layer item type sits on top of the engine substrate but
// preserves the v3-era output shape: a GeoJSON Feature whose `id` is
// the entity's stable UUID and whose `properties` carry both the
// caller-supplied attributes and a small set of underscore-prefixed
// editor-tracking fields (`_created_by`, `_created_at`, `_edited_by`,
// `_edited_at`, `_global_id`). Maps, popups, attribute tables, and
// derived layers all read this shape today; preserving it lets the
// portal-web side keep working unchanged through Phase 2 cutover.
//
// Phase 2.1 introduces this adapter as additive surface. The legacy
// `DataLayerFeaturesService` is unchanged. Phase 2.2 swaps the v3 service's
// internals to call into this adapter.

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type GeoJsonGeometry,
  type Observation,
  type PrincipalRef,
  type SourceRef,
  cellForGeometry,
  uuidv7,
  validateObservation,
} from '@gratis-gis/engine';

import { EngineService } from './engine.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LensPolicyService } from '../policy/lens-policy.service.js';
import {
  TileCacheService,
  optsFingerprint,
  tileCacheKey,
} from './tile-cache.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { validateGeoJson } from '../common/geometry-validation.js';

/** Argument bag shared by every write helper. */
interface WriteCommon {
  itemId: string;
  layerId: string;
  principal: PrincipalRef;
  /** Optional override for the source bookkeeping. Defaults to a
   *  generic `data_layer:write` tag. */
  source?: SourceRef;
}

export interface CreateFeatureArgs extends WriteCommon {
  /** Caller-supplied attribute payload. Spread into `attrs`. */
  properties?: Record<string, unknown>;
  /** Optional geometry. Cell is computed downstream by `EngineService`. */
  geometry?: GeoJsonGeometry | null;
  /**
   * Optional client-supplied entity id. When present, used as the
   * observation's `entity` instead of generating a fresh UUIDv7.
   * Editors and form runtimes pass this through so a retried POST
   * after a network blip can be recognised as the same feature.
   *
   * IMPORTANT: `globalId` alone does NOT make a write idempotent.
   * Every observation row gets a fresh `id` (the table PK is
   * `(id, tx_time)`), so a retried create with the same `globalId`
   * appends a second `kind='create'` row for the same entity: no
   * constraint fires. Callers that need retry-safe creates must go
   * through `writeFeaturesCreateIdempotent`, which checks for an
   * existing live entity under an advisory lock before inserting.
   *
   * Must be a valid UUID. Validation happens inside the engine.
   */
  globalId?: string;
}

export interface UpdateFeatureArgs extends WriteCommon {
  /** Existing entity id (the v3-era `global_id`). */
  globalId: string;
  /** Replacement attributes. Engine takes the value as-is; partial
   *  updates are the caller's job (read-merge-write pattern lives
   *  in the v3 wrapper). */
  properties?: Record<string, unknown>;
  /** Replacement geometry, or `null` to drop. */
  geometry?: GeoJsonGeometry | null;
}

export interface DeleteFeatureArgs extends WriteCommon {
  globalId: string;
}

export interface ListFeaturesArgs {
  itemId: string;
  layerId: string;
  /** As-of timestamp for bitemporal reads. Defaults to `now`. */
  asOf?: Date;
  /** Hard cap on the result set. Defaults to 100,000 to keep
   *  Prisma's napi bridge happy on large layers (matches the v3
   *  service's HARD_CAP). */
  limit?: number;
  /** Single-entity lookup. When set, only the named entity is
   *  returned. Used by callers that want one feature back rather
   *  than the whole collection (e.g. update path read-back). */
  entity?: string;
  /**
   * Explicit multi-entity filter: restricts the result to the named
   * entities. Same caller contract as `pageFeatures`: ids must be
   * validated as UUIDs upstream (they are cast through `::uuid` in
   * the SQL). Powers selection-scoped operations, e.g. Calculate
   * Field with scope='selection', where silently ignoring the set
   * would widen a write to the whole layer.
   */
  entityIds?: string[];
  /** Viewport filter as `[minLng, minLat, maxLng, maxLat]` in EPSG:4326. */
  bbox?: [number, number, number, number];
  /**
   * Per-share access scope: rows must intersect this polygon (or
   * have null geometry). GeoJSON Polygon, MultiPolygon, or
   * GeometryCollection. Used to enforce share-level geographic
   * restrictions.
   */
  geoLimit?: GeoJsonGeometry;
  /**
   * Layer-level boundary clip: rows must intersect this polygon AND
   * have non-null geometry. Distinct from `geoLimit`; this is the
   * map author's content scope, not a security filter.
   */
  boundaryClip?: GeoJsonGeometry;
  /**
   * When set, restricts the result to features the named user
   * created. Pairs with the share-level rowScope='own' and the
   * layer-level editingPolicy 'own-rows-only'.
   */
  ownRowsOnly?: { userId: string };
  /**
   * Parent-FK filter: narrows to rows whose `attrs->>{column}`
   * equals `parentId`. Used by the field runtime to list children
   * of a given parent feature.
   *
   * The column name is interpolated into the SQL but the caller is
   * responsible for validating it against the layer schema first
   * (the v3 controller does this today).
   */
  parentFkFilter?: { column: string; parentId: string };
  /**
   * Time-attribute window filter (#58). Restricts the result to
   * features whose `attrs->>{field}` falls inside [from, to]. Either
   * bound is optional for open-ended windows. The field is expected
   * to hold ISO-8601 timestamps; non-ISO-shaped values are skipped
   * via a regex guard before the timestamptz cast so a single
   * malformed row can't 500 the whole query.
   *
   * Caller is responsible for validating that `column` is a real
   * date / datetime field on the layer schema (the v3 controller
   * does this).
   */
  timeFilter?: { column: string; from?: string; to?: string };
  /**
   * Set when the layer was provisioned without a geometry column
   * (the related-records pattern). Skips every spatial filter so
   * non-spatial layers pass through cleanly.
   */
  isTable?: boolean;
  /**
   * Optional row-level policy filter (Cedar Phase D). When set,
   * every feature returned by the SQL query is evaluated against
   * `lensPolicy.policy` via LensPolicyService.checkFeature; rows
   * that fail are dropped from the FeatureCollection.
   *
   * Pass `lens` with both an `id` and a `policy` text. Empty /
   * absent policy text short-circuits to passthrough; same for
   * an absent `lensPolicy` argument entirely (Phase B behaviour).
   *
   * `user` is the principal the policy evaluates against. Required
   * when `lens.policy` is set; ignored otherwise.
   *
   * `spatialKeysFor` pre-resolves spatial predicates per feature.
   * Cedar's WASM has no geometry extension, so callers that want
   * spatial rules ("inside assigned polygon") compute the
   * containment in PostGIS upstream and hand the engine the
   * resulting `Set<string>` of qualifying keys per feature. Lens
   * policies reference the same keys via
   * `resource.spatial.contains("assigned_area")`. When omitted,
   * every feature passes an empty spatial set; non-spatial
   * policies (attribute predicates, role checks) work unchanged.
   */
  lensPolicy?: {
    lens: { id: string; policy?: string };
    user: AuthUser;
    spatialKeysFor?: (feature: DataLayerFeature) => string[];
  };
}

/**
 * Argument bag for `iterateFeatures`, the keyset-paginated sibling of
 * `listFeatures`. Same filters, no result cap: iteration walks the
 * whole (filtered) layer in pages, so the 100k `limit` default that
 * protects the buffering read path does not apply. Two members are
 * deliberately absent:
 *
 *   - `entity`: a single-entity lookup has nothing to iterate;
 *     callers that want one feature use `listFeatures`.
 *   - `lensPolicy`: no iterating caller needs row policies yet, and
 *     adding them later should be a conscious decision (the per-page
 *     filter would silently change page sizes).
 */
export type IterateFeaturesArgs = Omit<
  ListFeaturesArgs,
  'limit' | 'entity' | 'lensPolicy'
> & {
  /** Entities fetched per page. Exposed for tests; the default keeps
   *  per-query memory modest while bounding round-trips on big
   *  layers. */
  pageSize?: number;
};

/**
 * Argument bag for `readFeaturePage`: one page of `iterateFeatures`,
 * for callers that resume a walk from the outside (the HTTP feature
 * read with `?cursor=`) instead of holding a generator open.
 */
export type ReadFeaturePageArgs = IterateFeaturesArgs & {
  /**
   * Keyset cursor: return entities strictly greater than this one.
   * Null or absent starts at the beginning. This is an entity id, not
   * an offset, so concurrent writes cannot shift rows between pages.
   */
  after?: string | null;
};

export interface FeaturePage {
  features: DataLayerFeature[];
  /**
   * Pass as `after` to get the next page. Null means end of data, and
   * ONLY that: see the note on `readFeaturePage` about why an empty
   * `features` array does not imply the walk is finished.
   */
  nextCursor: string | null;
  /**
   * The instant this page was read at, resolved from `asOf` or
   * defaulted to now. A caller paging across separate requests must
   * send it back on every subsequent page to keep snapshot semantics.
   */
  asOf: Date;
}

export interface DataLayerFeature {
  type: 'Feature';
  /** Stable entity id. Identical to v3's `global_id`. */
  id: string;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> & {
    _global_id: string;
    _created_by: string;
    _created_at: string;
    _edited_by: string;
    _edited_at: string;
  };
}

/**
 * Row shape both current-state read paths (`listFeatures`,
 * `iterateFeatures`) select from the observation log. Hoisted to
 * module scope so the two paths cannot drift apart.
 */
interface FeatureRow {
  entity: string;
  observation_id: string;
  attrs: Record<string, unknown> | null;
  geom_geojson: GeoJsonGeometry | null;
  edited_by: string;
  edited_at: Date;
  created_by: string;
  created_at: Date;
}

/** Map a log row to the v3 wire shape. Shared by both read paths. */
function rowToFeature(row: FeatureRow): DataLayerFeature {
  return {
    type: 'Feature',
    id: row.entity,
    geometry: row.geom_geojson,
    properties: {
      ...(row.attrs ?? {}),
      _global_id: row.entity,
      _created_by: row.created_by,
      _created_at: row.created_at.toISOString(),
      _edited_by: row.edited_by,
      _edited_at: row.edited_at.toISOString(),
    },
  };
}

/**
 * Tile output: the MVT bytes + a content-derived ETag. The cache
 * mints the ETag during set(); cached returns echo whatever ETag
 * was stored. Controllers turn the ETag into the `ETag` response
 * header and handle `If-None-Match` -> 304.
 */
export interface TileResult {
  mvt: Buffer;
  etag: string;
}

const DEFAULT_SOURCE: SourceRef = { kind: 'data_layer:write' };

/**
 * Encode a `(itemId, layerId)` pair as the canonical engine scope
 * for a data_layer sublayer. Every adapter call uses this; no other
 * surface should construct scopes by hand.
 */
export function dataLayerScope(itemId: string, layerId: string): string {
  return `data_layer:${itemId}:${layerId}`;
}

/**
 * Build a SQL `SELECT` that materialises the data_layer's current
 * truth from the observation log, exposing the same column shape
 * that the legacy v3 per-layer table did: `global_id`, `geom`,
 * `properties`. Used by callers that compose raw SQL pipelines
 * around a data_layer source (DerivedLayersService is the main
 * one).
 *
 * The scope is embedded as a single-quoted literal because it's
 * built from internal item/layer ids (UUID + identifier shape, no
 * user-supplied content) and the consumers use positional params
 * for their own filters; embedding keeps the param numbering clean
 * for them. We still escape any single quotes defensively.
 *
 * Conditions come in two buckets because the observation log is a
 * version history, not a row-per-feature table, and applying a
 * content predicate BEFORE the latest-per-entity collapse is the
 * ghost-feature bug: an old version that matches the predicate
 * "wins" the DISTINCT ON for an entity whose real latest version is
 * deleted or no longer matches, resurrecting it.
 *
 *   - `collapseConditions` participate in latest-picking. Only
 *     version-independent clauses belong here: bitemporal window
 *     bounds (`valid_from <= $1`, `valid_to IS NULL`) and entity-id
 *     restrictions (`entity = ANY($1)`). They narrow WHICH history
 *     is visible, never which version of an entity is current.
 *   - `contentConditions` are predicates on row content (geometry,
 *     attrs). They are used twice: once to discover candidate
 *     entities (any version matching keeps index pushdown), and
 *     once re-applied to the collapsed latest row, which is the
 *     semantically correct place for them.
 *
 * Each entry must already be a complete `column op value` clause.
 * Positional `$n` placeholders may appear in either bucket;
 * duplicating a `contentConditions` clause reuses the same `$n`
 * parameters (PostgreSQL allows repeated references).
 *
 * Returns the SELECT body without surrounding parens or alias.
 * Callers wrap as appropriate:
 *   - As a CTE:           `source AS (${fragment})`
 *   - As a FROM source:   `FROM (${fragment}) AS s`
 */
export function dataLayerSourceSqlFragment(
  scope: string,
  opts: {
    collapseConditions?: string[];
    contentConditions?: string[];
  } = {},
): string {
  const escapedScope = scope.replace(/'/g, "''");
  const collapse =
    opts.collapseConditions && opts.collapseConditions.length > 0
      ? ` AND ${opts.collapseConditions.join(' AND ')}`
      : '';
  const content = opts.contentConditions ?? [];
  // Stage 1 (only when content predicates exist): candidate entities
  // are those with ANY observation matching the predicate. The inner
  // select keeps the collapse window so partition-invisible rows
  // cannot nominate candidates; that stays a superset of the correct
  // result because the latest row itself is one of the rows probed.
  const candidateSemiJoin =
    content.length > 0
      ? `
        AND entity IN (
          SELECT entity
          FROM observation
          WHERE scope = '${escapedScope}'${collapse}
            AND ${content.join(' AND ')}
        )`
      : '';
  // Stage 3: the same predicates re-checked against the collapsed
  // latest row, next to the tombstone filter.
  const latestRecheck =
    content.length > 0 ? ` AND ${content.join(' AND ')}` : '';
  // DISTINCT ON entity + ORDER BY valid_from DESC, tx_time DESC
  // gives us the most recent observation per entity within the
  // collapse window (stage 2; full content history per candidate).
  // Outer WHERE drops entities whose latest is a tombstone
  // (kind = 'delete'), so deleted features fall out.
  return `
    SELECT
      entity AS global_id,
      geom,
      attrs AS properties
    FROM (
      SELECT DISTINCT ON (entity)
        entity, geom, attrs, kind, valid_from, valid_to
      FROM observation
      WHERE scope = '${escapedScope}'${collapse}${candidateSemiJoin}
      ORDER BY entity, valid_from DESC, tx_time DESC
    ) latest
    WHERE kind <> 'delete'${latestRecheck}
  `;
}

@Injectable()
export class DataLayerEngine {
  constructor(
    private readonly engine: EngineService,
    private readonly prisma: PrismaService,
    private readonly lensPolicy: LensPolicyService,
    private readonly tileCache: TileCacheService,
  ) {}

  scope(itemId: string, layerId: string): string {
    return dataLayerScope(itemId, layerId);
  }

  /**
   * Create a new feature. Generates a fresh entity id (UUIDv7) and
   * writes a single `kind: 'create'` observation. The entity id is
   * surfaced as `globalId` for v3 callers that store it on the
   * client side.
   */
  async writeFeatureCreate(
    args: CreateFeatureArgs,
  ): Promise<{ globalId: string; observationId: string }> {
    const entity = args.globalId ?? uuidv7();
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity,
      kind: 'create',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { globalId: entity, observationId: requireId(obs.id) };
  }

  /**
   * Bulk variant of `writeFeatureCreate`. Used by the v3 ingest path
   * and by anything else that produces many features at once. Routes
   * through `EngineService.writeMany`, so all rows land in batched
   * INSERTs (500 per statement) and a 100k-row import stays under
   * the BFF timeout.
   *
   * Each input gets a fresh UUIDv7 entity id. The returned array is
   * order-aligned with the input array.
   */
  async writeFeaturesCreate(
    inputs: CreateFeatureArgs[],
  ): Promise<Array<{ globalId: string; observationId: string }>> {
    if (inputs.length === 0) return [];

    const observations: Observation[] = inputs.map((args) => ({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId ?? uuidv7(),
      kind: 'create',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    }));

    const written = await this.engine.writeMany(observations);
    return written.map((obs) => ({
      globalId: obs.entity,
      observationId: requireId(obs.id),
    }));
  }

  /**
   * Retry-safe variant of `writeFeaturesCreate` for the online POST
   * path. Inputs WITHOUT a `globalId` behave exactly like
   * `writeFeaturesCreate` (fresh entity, plain batched insert: a
   * caller who didn't supply an id has nothing to be idempotent
   * against). Inputs WITH a `globalId` are treated as "create if no
   * live entity with this id exists": when the layer already holds a
   * live (latest observation not a tombstone) entity under that id,
   * no row is written and the input is reported as `deduplicated` so
   * the caller can return the existing feature instead of minting a
   * duplicate. A deleted entity does NOT dedupe: re-creating under
   * the same id after a delete is a legitimate new `create`
   * observation (resurrection), matching how the read path treats
   * the log.
   *
   * Concurrency: the observation log is append-only and deliberately
   * has NO unique constraint we could ride with ON CONFLICT:
   *   - uniqueness on (scope, entity, kind='create') would forbid
   *     the legitimate re-create-after-delete case above, and
   *   - the table is partitioned by tx_time, so any unique index
   *     must include tx_time, which cannot express cross-partition
   *     entity uniqueness at all.
   * A bare INSERT ... WHERE NOT EXISTS is also insufficient on its
   * own: under READ COMMITTED two concurrent retries each take a
   * snapshot before the other commits, both pass the NOT EXISTS, and
   * both insert. So we serialise per (scope, entity) with a
   * transaction-scoped advisory lock: the second retry blocks on
   * `pg_advisory_xact_lock` until the first commits, then its
   * NOT EXISTS probe (a fresh statement snapshot) sees the committed
   * row and skips the insert. The guarded INSERT is kept as well so
   * the check-and-insert is atomic within one statement even if a
   * future caller reaches this SQL without the lock. Lock keys are
   * taken in sorted order inside one statement so two overlapping
   * multi-row batches cannot deadlock.
   *
   * Everything (locks, probe, insert) runs inside one transaction;
   * releasing the lock before the insert committed would reopen the
   * race.
   */
  async writeFeaturesCreateIdempotent(
    inputs: CreateFeatureArgs[],
  ): Promise<
    Array<{ globalId: string; observationId: string | null; deduplicated: boolean }>
  > {
    if (inputs.length === 0) return [];

    // Split by dedupe eligibility, remembering original positions so
    // the result array stays order-aligned with the input array.
    const withId: Array<{ index: number; args: CreateFeatureArgs; entity: string }> = [];
    const withoutId: Array<{ index: number; args: CreateFeatureArgs }> = [];
    inputs.forEach((args, index) => {
      if (args.globalId !== undefined) {
        withId.push({ index, args, entity: args.globalId });
      } else {
        withoutId.push({ index, args });
      }
    });

    const results = new Array<{
      globalId: string;
      observationId: string | null;
      deduplicated: boolean;
    }>(inputs.length);

    if (withoutId.length > 0) {
      const written = await this.writeFeaturesCreate(
        withoutId.map((w) => w.args),
      );
      withoutId.forEach((w, i) => {
        results[w.index] = { ...written[i]!, deduplicated: false };
      });
    }

    if (withId.length > 0) {
      // Duplicate globalIds inside ONE batch dedupe in JS: the SQL
      // guard's NOT EXISTS probes a pre-statement snapshot, so two
      // rows for the same entity in one INSERT would both pass it.
      // First occurrence wins; later ones report deduplicated.
      const firstByEntity = new Map<string, number>();
      const uniqueRows: Array<{ args: CreateFeatureArgs; obs: Observation }> = [];
      for (const w of withId) {
        const scope = this.scope(w.args.itemId, w.args.layerId);
        const key = `${scope}|${w.entity}`;
        if (firstByEntity.has(key)) continue;
        firstByEntity.set(key, uniqueRows.length);
        // Fill bookkeeping and validate exactly like EngineService
        // .write() would, so this path rejects the same malformed
        // input the plain path rejects.
        const obs: Observation = {
          scope,
          entity: w.entity,
          kind: 'create',
          validFrom: new Date(),
          validTo: null,
          attrs: w.args.properties ?? null,
          geom: w.args.geometry ?? null,
          author: w.args.principal,
          source: w.args.source ?? DEFAULT_SOURCE,
          parents: [],
          id: uuidv7(),
          txTime: new Date(),
          cell: cellForGeometry(w.args.geometry ?? null),
        };
        validateObservation(obs);
        uniqueRows.push({ args: w.args, obs });
      }

      // Sorted advisory-lock keys: global ordering prevents
      // deadlocks between concurrent overlapping batches.
      const lockKeys = uniqueRows
        .map(({ obs }) => `${obs.scope}|${obs.entity}`)
        .sort();

      const ids = uniqueRows.map(({ obs }) => requireId(obs.id));
      const txTimes = uniqueRows.map(({ obs }) => obs.txTime as Date);
      const validFroms = uniqueRows.map(({ obs }) => obs.validFrom);
      const scopes = uniqueRows.map(({ obs }) => obs.scope);
      const entities = uniqueRows.map(({ obs }) => obs.entity);
      const attrsJson = uniqueRows.map(({ obs }) =>
        obs.attrs !== null ? JSON.stringify(obs.attrs) : null,
      );
      const geomJson = uniqueRows.map(({ obs }) =>
        obs.geom !== null ? JSON.stringify(obs.geom) : null,
      );
      const cells = uniqueRows.map(({ obs }) => obs.cell ?? null);
      const authors = uniqueRows.map(({ obs }) => obs.author.sub);
      const sourceJson = uniqueRows.map(({ obs }) => JSON.stringify(obs.source));

      const insertedKeys = await this.prisma.$transaction(async (tx) => {
        // One statement takes every lock in sorted order. The ORDER
        // BY subquery pins evaluation order; xact locks release at
        // commit/rollback automatically.
        //
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns
        // `void`, and the Prisma pg driver adapter cannot deserialize
        // a void result column: it throws UnsupportedNativeDataType
        // / "Failed to deserialize column of type 'void'" and takes
        // the whole transaction with it. That
        // broke every feature-insert path (form submissions, ingest,
        // OSM save-as-layer, AGO import, sample seeding) on Prisma 7.8.
        // We discard the result anyway, so ask for a row count instead
        // of rows. Do not "simplify" this back to $queryRaw.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(k, 0))
          FROM (SELECT k FROM unnest(${lockKeys}::text[]) AS k ORDER BY k) locks
        `;
        // Set-based guarded insert: one row per unnest element,
        // skipped when the entity's latest observation is live.
        // `parents` is the constant empty array on the create path
        // (see writeFeaturesCreate), inlined because uuid[][] does
        // not unnest per-row.
        const rows = await tx.$queryRaw<
          Array<{ scope: string; entity: string }>
        >`
          INSERT INTO observation (
            id, tx_time, valid_from, valid_to, scope, entity, kind,
            attrs, geom, cell, author_sub, source, parents
          )
          SELECT
            t.id, t.tx_time, t.valid_from, NULL, t.scope, t.entity, 'create',
            t.attrs::jsonb,
            CASE WHEN t.geom_json IS NULL THEN NULL
                 ELSE ST_GeomFromGeoJSON(t.geom_json) END,
            t.cell, t.author_sub, t.source::jsonb, '{}'::uuid[]
          FROM unnest(
            ${ids}::uuid[],
            ${txTimes}::timestamptz[],
            ${validFroms}::timestamptz[],
            ${scopes}::text[],
            ${entities}::uuid[],
            ${attrsJson}::text[],
            ${geomJson}::text[],
            ${cells}::text[],
            ${authors}::text[],
            ${sourceJson}::text[]
          ) AS t(id, tx_time, valid_from, scope, entity, attrs,
                 geom_json, cell, author_sub, source)
          WHERE NOT EXISTS (
            SELECT 1
            FROM (
              SELECT kind
              FROM observation
              WHERE scope = t.scope
                AND entity = t.entity
              ORDER BY valid_from DESC, tx_time DESC
              LIMIT 1
            ) latest
            WHERE latest.kind <> 'delete'
          )
          RETURNING scope, entity
        `;
        // Keyed by scope AND entity: a batch may span scopes, and the
        // same entity id deduping in one scope must not mask a real
        // insert of that id in another.
        return new Set(rows.map((r) => `${r.scope}|${r.entity}`));
      });

      for (const w of withId) {
        const scope = this.scope(w.args.itemId, w.args.layerId);
        const key = `${scope}|${w.entity}`;
        const uniqueIndex = firstByEntity.get(key)!;
        const row = uniqueRows[uniqueIndex]!;
        const inserted =
          insertedKeys.has(key) &&
          // A same-batch duplicate is a dedupe even though its first
          // occurrence inserted.
          withId.find(
            (x) =>
              `${this.scope(x.args.itemId, x.args.layerId)}|${x.entity}` === key,
          ) === w;
        results[w.index] = {
          globalId: w.entity,
          observationId: inserted ? requireId(row.obs.id) : null,
          deduplicated: !inserted,
        };
      }
    }

    return results;
  }

  /**
   * COPY-based bulk variant of writeFeaturesCreate. Same input
   * shape, same output shape; the difference is the path the
   * observations take to the database.
   *
   * The caller hands in a started CopyWriter so one transaction
   * can span many batches (cheaper than one transaction per
   * batch). Use only for the async-import-job worker -- online
   * single-row writes still go through writeFeaturesCreate so
   * they pick up validation, derived-layer cache invalidation,
   * and the regular insert path.
   */
  async copyFeaturesCreate(
    inputs: CreateFeatureArgs[],
    writer: import('./copy-writer.js').CopyWriter,
  ): Promise<Array<{ globalId: string; observationId: string }>> {
    if (inputs.length === 0) return [];

    const observations: Observation[] = inputs.map((args) => ({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId ?? uuidv7(),
      kind: 'create',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    }));

    const written = await this.engine.copyMany(observations, writer);
    return written.map((obs) => ({
      globalId: obs.entity,
      observationId: requireId(obs.id),
    }));
  }

  /**
   * Append a `kind: 'update'` observation for an existing entity.
   * The latest observation per entity is what the read path returns,
   * so writing a new observation is enough; we never mutate prior
   * rows.
   */
  async writeFeatureUpdate(
    args: UpdateFeatureArgs,
  ): Promise<{ observationId: string }> {
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId,
      kind: 'update',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { observationId: requireId(obs.id) };
  }

  /**
   * Bulk variant of `writeFeatureUpdate` (#83 attribute-table Calculate
   * Field).  Same input shape per row, batched through
   * `EngineService.writeMany` so a single calculate-field-on-N-rows
   * call lands in batched INSERTs rather than N round-trips.
   */
  async writeFeaturesUpdate(
    inputs: UpdateFeatureArgs[],
  ): Promise<Array<{ observationId: string }>> {
    if (inputs.length === 0) return [];
    const observations: Observation[] = inputs.map((args) => ({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId,
      kind: 'update',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    }));
    const written = await this.engine.writeMany(observations);
    return written.map((obs) => ({ observationId: requireId(obs.id) }));
  }

  /**
   * Tombstone an entity by appending a `kind: 'delete'` observation.
   * The read path filters tombstones out, so the entity disappears
   * from feature collections without anything being physically
   * removed from the log.
   */
  async writeFeatureDelete(
    args: DeleteFeatureArgs,
  ): Promise<{ observationId: string }> {
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId,
      kind: 'delete',
      validFrom: new Date(),
      validTo: null,
      attrs: null,
      geom: null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { observationId: requireId(obs.id) };
  }

  /**
   * Read the features in a data_layer sublayer at `asOf` (default
   * `now`). The output preserves v3's wire shape so existing
   * controllers, the layer detail page, and the map renderer keep
   * working without changes.
   *
   * Single SQL query that joins the latest-observation-per-entity
   * (DISTINCT ON) against the creation row for the same entity, so
   * the editor-tracking metadata lands without a second round-trip.
   * All v3-era filters (bbox, geoLimit, boundaryClip, ownRowsOnly,
   * parentFkFilter, isTable) are pushed into the WHERE clause.
   *
   * Tombstones (`kind = 'delete'`) are filtered out: deleted
   * entities never appear in the result.
   *
   * Underscore-prefixed properties match the v3 wire shape:
   * `_global_id`, `_created_by`, `_created_at`, `_edited_by`,
   * `_edited_at`.
   */
  async listFeatures(
    args: ListFeaturesArgs,
  ): Promise<{ type: 'FeatureCollection'; features: DataLayerFeature[] }> {
    const scope = this.scope(args.itemId, args.layerId);
    const asOf = args.asOf ?? new Date();
    const limit = args.limit ?? 100000;

    const { candidateFilters, currentFilters, contentFilters } =
      this.buildReadFilters(args);

    // Prisma.join() rejects an empty array, so collapse to Prisma.empty
    // when no extra filter fragments were collected. Each fragment
    // already begins with `AND` so concatenation is just space-joining.
    const candidateExtras =
      candidateFilters.length > 0
        ? Prisma.join(candidateFilters, ' ')
        : Prisma.empty;
    const currentExtras =
      currentFilters.length > 0
        ? Prisma.join(currentFilters, ' ')
        : Prisma.empty;

    // Per EXPLAIN ANALYZE on a 1.4M-row scope (2026-05-21): the
    // outer LIMIT alone wasn't enough. With the `entity IN
    // candidate_entities` semi-join, Postgres hash-aggregated
    // all 1.4M scope-entities into a driver set and nested-loop
    // bbox-checked every one, blowing past the 30s timeout for
    // even a county-sized bbox.
    //
    // Two-shape strategy:
    //
    //  - When there are NO candidate filters (ownRowsOnly /
    //    entity= unset, the common /items?bbox= path), the
    //    semi-join against candidate_entities is doing nothing
    //    useful -- every entity in scope has a `create`
    //    observation by construction (an entity exists iff it
    //    was created). Drop the candidate_entities CTE and the
    //    IN check.
    //
    //  - When candidate filters ARE present (ownRowsOnly,
    //    entity=), they semantically must be applied to the
    //    `create` row, not the current state (someone else can
    //    edit an entity I created, leaving its current author
    //    different from its creator). Keep candidate_entities
    //    and the IN; the entity sets here are small (a single
    //    user's items, or a single entity), so the slow path is
    //    fine.
    //
    // ALSO always limit `currents` -- it's referenced twice
    // (by creates + the outer SELECT) so Postgres materializes
    // the full DISTINCT ON otherwise.
    const usesCandidateCte = candidateFilters.length > 0;
    const canPushCandidateLimit =
      usesCandidateCte &&
      currentFilters.length === 0 &&
      contentFilters.length === 0;
    // Inner LIMIT must be >= the outer LIMIT to satisfy the user's
    // request, plus a small buffer so the kind='delete' filter in the
    // outer SELECT doesn't leave us short. The previous floor of 100
    // tanked the QGIS OAPIF schema probe: QGIS opens a layer by
    // hitting `/items?limit=1`, the engine then dragged in 100
    // current-state polygons (avg 114 KB of ST_AsGeoJSON each on the
    // WV Parcels layer = 11 MB shipped from Postgres for a 2 KB
    // response), and the trip took ~9s. A small additive buffer
    // (10 extra rows) absorbs typical tombstone churn without
    // ballooning small probes.
    const innerLimit = limit + 10;

    let rows: FeatureRow[];
    if (contentFilters.length === 0) {
      // No content predicates: the DISTINCT ON collapse over the
      // scope IS the correct read (the canonical unfiltered shape).
      // This branch's SQL is unchanged from before the ghost-feature
      // fix so the hot map-render path keeps its plan and its cache
      // behaviour.
      const candidateLimit = canPushCandidateLimit
        ? Prisma.sql`ORDER BY entity LIMIT ${innerLimit}`
        : Prisma.empty;
      const currentsLimit = Prisma.sql`LIMIT ${innerLimit}`;
      const candidateCte = usesCandidateCte
        ? Prisma.sql`
        candidate_entities AS (
          SELECT entity
          FROM observation
          WHERE scope = ${scope}
            AND kind = 'create'
            ${candidateExtras}
          ${candidateLimit}
        ),`
        : Prisma.empty;
      const currentsCandidateFilter = usesCandidateCte
        ? Prisma.sql`AND entity IN (SELECT entity FROM candidate_entities)`
        : Prisma.empty;
      rows = await this.prisma.$queryRaw<FeatureRow[]>`
      WITH ${candidateCte}
      currents AS (
        SELECT DISTINCT ON (entity)
          id AS observation_id,
          entity,
          attrs,
          ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
          kind,
          author_sub AS edited_by,
          tx_time AS edited_at
        FROM observation
        WHERE scope = ${scope}
          AND valid_from <= ${asOf}
          ${currentsCandidateFilter}
          ${currentExtras}
        ORDER BY entity, valid_from DESC, tx_time DESC
        ${currentsLimit}
      ),
      creates AS (
        SELECT entity,
               author_sub AS created_by,
               tx_time    AS created_at
        FROM observation
        WHERE scope = ${scope}
          AND kind = 'create'
          AND entity IN (SELECT entity FROM currents)
      )
      SELECT
        c.entity,
        c.observation_id,
        c.attrs,
        c.geom_geojson,
        c.edited_by,
        c.edited_at,
        cr.created_by,
        cr.created_at
      FROM currents c
      JOIN creates cr ON cr.entity = c.entity
      WHERE c.kind <> 'delete'
      ORDER BY c.entity
      LIMIT ${limit}
    `;
    } else {
      // Content predicates present (bbox / geoLimit / boundaryClip /
      // parentFk / timeFilter): candidate-then-collapse-then-filter.
      //
      // Applying these predicates to raw observation rows before the
      // DISTINCT ON (the pre-fix shape) resurrected ghosts: an OLD
      // version inside the bbox out-ranked nothing (the true latest
      // was excluded by the very filter) and became "current" for an
      // entity that was deleted or edited away.
      //
      //   Stage 1 (content_candidates): entities with ANY observation
      //     matching the pushdown predicates. Keeps the GIST / GIN
      //     index pushdown for discovery; over-matching is fine
      //     because stage 3 re-checks.
      //   Stage 2 (currents LATERAL): each candidate collapsed to its
      //     true latest observation over its FULL history (same
      //     ordering keys as the canonical DISTINCT ON above:
      //     valid_from DESC, tx_time DESC within scope + asOf).
      //     LATERAL ... LIMIT 1 rather than DISTINCT ON so each
      //     candidate costs one descent of the (scope, entity,
      //     valid_from DESC) index instead of sorting full histories.
      //   Stage 3: tombstone + content predicates applied to the
      //     latest row only, INSIDE currents, so the innerLimit below
      //     it counts live matching features: a limit above the
      //     filter would re-introduce the drop-live-rows bug.
      //
      // The candidate subquery is ordered so the innerLimit prefix is
      // deterministic in entity order (OGC offset paging slices the
      // result; an arbitrary subset would shuffle pages).
      //
      // No tx_time floor is added anywhere: these queries never
      // constrained partitions before, so stage 2 seeing full history
      // is not a pruning regression.
      const contentExtras = Prisma.join(contentFilters, ' ');
      const candidateCte = usesCandidateCte
        ? Prisma.sql`
        candidate_entities AS (
          SELECT entity
          FROM observation
          WHERE scope = ${scope}
            AND kind = 'create'
            ${candidateExtras}
        ),`
        : Prisma.empty;
      const contentCandidateFilter = usesCandidateCte
        ? Prisma.sql`AND entity IN (SELECT entity FROM candidate_entities)`
        : Prisma.empty;
      rows = await this.prisma.$queryRaw<FeatureRow[]>`
      WITH ${candidateCte}
      content_candidates AS (
        SELECT DISTINCT entity
        FROM observation
        WHERE scope = ${scope}
          AND valid_from <= ${asOf}
          ${contentCandidateFilter}
          ${currentExtras}
          ${contentExtras}
      ),
      currents AS (
        SELECT
          l.observation_id,
          l.entity,
          l.attrs,
          l.geom_geojson,
          l.kind,
          l.edited_by,
          l.edited_at
        FROM (SELECT entity FROM content_candidates ORDER BY entity) cand
        CROSS JOIN LATERAL (
          SELECT
            id AS observation_id,
            entity,
            attrs,
            geom,
            ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
            kind,
            author_sub AS edited_by,
            tx_time AS edited_at
          FROM observation
          WHERE scope = ${scope}
            AND entity = cand.entity
            AND valid_from <= ${asOf}
          ORDER BY valid_from DESC, tx_time DESC
          LIMIT 1
        ) l
        WHERE l.kind <> 'delete'
          ${contentExtras}
        ORDER BY l.entity
        LIMIT ${innerLimit}
      ),
      creates AS (
        SELECT entity,
               author_sub AS created_by,
               tx_time    AS created_at
        FROM observation
        WHERE scope = ${scope}
          AND kind = 'create'
          AND entity IN (SELECT entity FROM currents)
      )
      SELECT
        c.entity,
        c.observation_id,
        c.attrs,
        c.geom_geojson,
        c.edited_by,
        c.edited_at,
        cr.created_by,
        cr.created_at
      FROM currents c
      JOIN creates cr ON cr.entity = c.entity
      WHERE c.kind <> 'delete'
      ORDER BY c.entity
      LIMIT ${limit}
    `;
    }

    const features: DataLayerFeature[] = rows.map(rowToFeature);

    // Phase D: row-level filter through LensPolicyService when the
    // caller attached a lens with policy text. The service short-
    // circuits on absent / whitespace policy so the unpolicied
    // path stays at Phase B speed.
    const filtered = this.applyLensPolicy(features, args.lensPolicy);

    return { type: 'FeatureCollection', features: filtered };
  }

  /**
   * Translate the caller-facing read filters into SQL fragments.
   * Split out of `listFeatures` so `iterateFeatures` applies the
   * exact same semantics; any new filter added here reaches both
   * paths automatically.
   *
   * Three buckets, because the observation log is a version history
   * and WHERE placement decides which version a filter sees:
   *
   *   - `candidateFilters` apply to the entity's `create`
   *     observation (ownRowsOnly must match the creator even after
   *     someone else edits the row).
   *   - `currentFilters` are version-INDEPENDENT restrictions
   *     (entity ids never change across observations), safe to
   *     apply to raw log rows before the latest-per-entity
   *     collapse.
   *   - `contentFilters` are predicates on row CONTENT (geometry,
   *     attrs). Applying them before the collapse is the
   *     ghost-feature bug (an old matching version resurrects a
   *     deleted / edited-away feature), so the read paths use them
   *     twice: candidate discovery over any version, then a
   *     re-check against the collapsed latest row.
   */
  private buildReadFilters(
    args: Pick<
      ListFeaturesArgs,
      | 'ownRowsOnly'
      | 'entity'
      | 'entityIds'
      | 'isTable'
      | 'bbox'
      | 'geoLimit'
      | 'boundaryClip'
      | 'parentFkFilter'
      | 'timeFilter'
    >,
  ): {
    candidateFilters: Prisma.Sql[];
    currentFilters: Prisma.Sql[];
    contentFilters: Prisma.Sql[];
  } {
    // Bound user-supplied geometry size before it reaches PostGIS;
    // throws GeometryTooLargeError (BadRequest at the controller).
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);

    const candidateFilters: Prisma.Sql[] = [];
    const currentFilters: Prisma.Sql[] = [];
    const contentFilters: Prisma.Sql[] = [];

    if (args.ownRowsOnly !== undefined) {
      candidateFilters.push(
        Prisma.sql`AND author_sub = ${args.ownRowsOnly.userId}`,
      );
    }

    if (args.entity !== undefined) {
      candidateFilters.push(
        Prisma.sql`AND entity = ${args.entity}::uuid`,
      );
    }

    if (args.entityIds !== undefined && args.entityIds.length > 0) {
      // Same fragment shape as `pageFeatures`: the caller validates
      // these are UUIDs upstream; cast each through ::uuid so a
      // non-uuid string can't reach the planner. Applied to the
      // current-state rows (not the candidate CTE) because entity
      // ids never change across observations, so filtering the
      // currents directly is equivalent and skips the semi-join.
      currentFilters.push(
        Prisma.sql`AND entity = ANY(ARRAY[${Prisma.join(
          args.entityIds.map((id) => Prisma.sql`${id}::uuid`),
        )}])`,
      );
    }

    if (!args.isTable) {
      // All three spatial filters are content predicates: geometry
      // changes across versions, so they must never decide the
      // latest-per-entity collapse.
      if (args.bbox !== undefined) {
        const [w, s, e, n] = args.bbox;
        contentFilters.push(
          Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
        );
      }
      if (args.geoLimit !== undefined) {
        const json = JSON.stringify(args.geoLimit);
        contentFilters.push(
          Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`,
        );
      }
      if (args.boundaryClip !== undefined) {
        const json = JSON.stringify(args.boundaryClip);
        contentFilters.push(
          Prisma.sql`AND geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
        );
      }
    }

    if (args.parentFkFilter !== undefined) {
      // Column name is caller-validated against the layer schema in
      // the v3 controller. Quote-safe by virtue of the schema regex
      // matching only [a-z0-9_]+; we still wrap in a JSONB key
      // expression that uses single quotes so the column name lives
      // inside the SQL string, not as a bound parameter (JSONB key
      // operators do not bind via $params).
      const col = sanitizeJsonbKey(args.parentFkFilter.column);
      contentFilters.push(
        Prisma.sql`AND attrs->>${col} = ${args.parentFkFilter.parentId}`,
      );
    }

    if (args.timeFilter !== undefined) {
      // Same sanitize / interpolation discipline as parentFkFilter:
      // the column is validated against the layer schema upstream
      // and the value is rendered into the SQL string via the
      // sanitizeJsonbKey helper (PostgreSQL doesn't bind JSONB key
      // operators through $params).
      //
      // The regex guard `~` filters to ISO-8601-shaped strings
      // before the ::timestamptz cast so a single malformed row
      // (`attrs->>field = "n/a"`) can't 500 the whole query. The
      // pattern matches `YYYY-MM-DD` plus an optional time tail; any
      // value that doesn't start with a date drops to NULL via the
      // CASE expression and naturally fails the comparison.
      const col = sanitizeJsonbKey(args.timeFilter.column);
      const dateRe = '^[0-9]{4}-[0-9]{2}-[0-9]{2}';
      if (args.timeFilter.from !== undefined) {
        contentFilters.push(
          Prisma.sql`AND (CASE WHEN attrs->>${col} ~ ${dateRe} THEN (attrs->>${col})::timestamptz END) >= ${args.timeFilter.from}::timestamptz`,
        );
      }
      if (args.timeFilter.to !== undefined) {
        contentFilters.push(
          Prisma.sql`AND (CASE WHEN attrs->>${col} ~ ${dateRe} THEN (attrs->>${col})::timestamptz END) <= ${args.timeFilter.to}::timestamptz`,
        );
      }
    }

    return { candidateFilters, currentFilters, contentFilters };
  }

  /**
   * Stream the current-state features of a sublayer in stable,
   * bounded pages. This is the read surface for whole-layer exports
   * (GeoParquet today): `listFeatures` buffers and silently caps at
   * its `limit` (default 100k), which is exactly wrong for an export
   * that must contain every row.
   *
   * Mechanics: keyset pagination on `entity`, the stable unique key
   * of the current-state read (`DISTINCT ON (entity)` yields exactly
   * one row per entity, and the query orders by entity). Each page
   * selects the first `pageSize` entities strictly greater than the
   * previous page's last entity, so consecutive pages partition the
   * entity keyspace into contiguous, non-overlapping ranges:
   *
   *   - no duplicates: the cursor advances strictly (`entity >
   *     cursor`), so an entity emitted once can never match again;
   *   - no drops: pages take the *smallest* remaining entities in
   *     order, so every entity that matches the filters falls into
   *     exactly one page; iteration only stops when a page comes
   *     back shorter than `pageSize`, i.e. no matching entities
   *     remain above the cursor.
   *
   * No OFFSET is involved anywhere, so concurrent writes cannot
   * shift rows between pages. The as-of instant is pinned once at
   * the first page: entities created, edited, or tombstoned after
   * iteration starts carry `valid_from > asOf` and are invisible to
   * every page, giving the export snapshot semantics. (The one
   * exception is a write back-dated to `valid_from <= asOf` landing
   * mid-export; it can change a not-yet-visited row's content, but
   * never duplicates or drops an entity.)
   *
   * Tombstones are handled inside the loop rather than in SQL:
   * deleted entities still occupy page slots (the cursor must
   * advance past them or a page of 100% tombstones would loop
   * forever) but are filtered from the yielded batch. This is also
   * why the method cannot ride on `listFeatures`: its outer
   * `kind <> 'delete'` filter runs after an inner `LIMIT limit+10`,
   * so a tombstone-heavy stretch would silently shorten a page and
   * a short page is this method's end-of-data signal.
   *
   * ownRowsOnly keeps the candidate-CTE shape from `listFeatures`
   * (the creator filter must look at the `create` observation, not
   * current state) but skips its LIMIT push-down: a per-user create
   * set is small, and an unbounded candidate CTE keeps the cursor
   * logic obviously correct.
   *
   * Content filters (bbox / geoLimit / boundaryClip / parentFk /
   * timeFilter) switch the page to candidate-then-collapse-then-
   * filter, same reasoning as `listFeatures`: pages walk CANDIDATE
   * entities (any version matched), each candidate is collapsed to
   * its true latest observation, and the content predicate is
   * evaluated against that latest row as a SQL boolean
   * (`content_match`) rather than a WHERE clause. Emitting every
   * candidate row keeps the cursor arithmetic sound: an entity whose
   * latest no longer matches still occupies a page slot (the cursor
   * must advance past it, and a short page must still mean
   * end-of-data), it is just filtered from the yielded batch exactly
   * like a tombstone.
   */
  async *iterateFeatures(
    args: IterateFeaturesArgs,
  ): AsyncGenerator<DataLayerFeature[], void, undefined> {
    // Pinned once here rather than per page: `readFeaturePage`
    // defaults `asOf` to now when it is not given, so letting each
    // page default independently would walk a moving snapshot. That
    // does not duplicate (the cursor still advances strictly) but it
    // can DROP: an entity created between two pages whose id sorts
    // below the cursor falls into a range already passed.
    const asOf = args.asOf ?? new Date();
    let after: string | null = null;
    for (;;) {
      const page = await this.readFeaturePage({ ...args, asOf, after });
      if (page.features.length > 0) yield page.features;
      if (page.nextCursor === null) return;
      after = page.nextCursor;
    }
  }

  /**
   * One keyset page of the walk above.
   *
   * Exposed separately because a caller that cannot hold a generator
   * open across the read (an HTTP handler serving `?cursor=`) would
   * otherwise need a second pagination implementation, and would have
   * to rediscover the tombstone and short-page subtleties documented
   * on `iterateFeatures`. `iterateFeatures` is implemented in terms of
   * this method precisely so the two cannot drift.
   *
   * `nextCursor` is null ONLY at true end of data, and is deliberately
   * NOT derived from `features.length`. A page can come back with zero
   * live features and still have data behind it: a run of tombstones,
   * or (on the filtered shape) candidates whose latest version no
   * longer matches. A caller that stopped on an empty batch would
   * truncate the read silently, which is the exact failure this whole
   * path exists to avoid.
   *
   * `asOf` is echoed back because snapshot semantics belong to the
   * walk, not to one page: an HTTP caller must send the same instant
   * with the cursor on every subsequent request or it inherits the
   * drop described on `iterateFeatures`.
   */
  async readFeaturePage(args: ReadFeaturePageArgs): Promise<FeaturePage> {
    const scope = this.scope(args.itemId, args.layerId);
    const asOf = args.asOf ?? new Date();
    const cursor: string | null = args.after ?? null;
    const pageSize = Math.min(
      Math.max(Math.floor(args.pageSize ?? 10_000), 1),
      50_000,
    );

    const { candidateFilters, currentFilters, contentFilters } =
      this.buildReadFilters(args);
    const candidateExtras =
      candidateFilters.length > 0
        ? Prisma.join(candidateFilters, ' ')
        : Prisma.empty;
    const currentExtras =
      currentFilters.length > 0
        ? Prisma.join(currentFilters, ' ')
        : Prisma.empty;
    const usesCandidateCte = candidateFilters.length > 0;
    const candidateCte = usesCandidateCte
      ? Prisma.sql`
        candidate_entities AS (
          SELECT entity
          FROM observation
          WHERE scope = ${scope}
            AND kind = 'create'
            ${candidateExtras}
        ),`
      : Prisma.empty;
    const currentsCandidateFilter = usesCandidateCte
      ? Prisma.sql`AND entity IN (SELECT entity FROM candidate_entities)`
      : Prisma.empty;
    const usesContent = contentFilters.length > 0;
    const contentExtras = usesContent
      ? Prisma.join(contentFilters, ' ')
      : Prisma.empty;

    // `content_match` only exists on the filtered shape; absent
    // means "no content predicate", which matches everything.
    type IterRow = FeatureRow & {
      kind: string;
      content_match?: boolean | null;
    };

    // ::uuid cast so the comparison uses uuid btree ordering, the
    // same ordering ORDER BY entity produces; a text comparison
    // would disagree with it and corrupt the pagination.
    const cursorFilter: Prisma.Sql =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND entity > ${cursor}::uuid`;
    const rows: IterRow[] = usesContent
        ? await this.prisma.$queryRaw<IterRow[]>`
        WITH ${candidateCte}
        content_candidates AS (
          SELECT DISTINCT entity
          FROM observation
          WHERE scope = ${scope}
            AND valid_from <= ${asOf}
            ${cursorFilter}
            ${currentsCandidateFilter}
            ${currentExtras}
            ${contentExtras}
          ORDER BY entity
          LIMIT ${pageSize}
        ),
        currents AS (
          SELECT
            l.observation_id,
            l.entity,
            l.attrs,
            l.geom_geojson,
            l.kind,
            l.edited_by,
            l.edited_at,
            (TRUE ${contentExtras}) AS content_match
          FROM content_candidates cand
          CROSS JOIN LATERAL (
            SELECT
              id AS observation_id,
              entity,
              attrs,
              geom,
              ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
              kind,
              author_sub AS edited_by,
              tx_time AS edited_at
            FROM observation
            WHERE scope = ${scope}
              AND entity = cand.entity
              AND valid_from <= ${asOf}
            ORDER BY valid_from DESC, tx_time DESC
            LIMIT 1
          ) l
        ),
        creates AS (
          SELECT entity,
                 author_sub AS created_by,
                 tx_time    AS created_at
          FROM observation
          WHERE scope = ${scope}
            AND kind = 'create'
            AND entity IN (SELECT entity FROM currents)
        )
        SELECT
          c.entity,
          c.observation_id,
          c.attrs,
          c.geom_geojson,
          c.kind,
          c.content_match,
          c.edited_by,
          c.edited_at,
          cr.created_by,
          cr.created_at
        FROM currents c
        JOIN creates cr ON cr.entity = c.entity
        ORDER BY c.entity
      `
        : await this.prisma.$queryRaw<IterRow[]>`
        WITH ${candidateCte}
        currents AS (
          SELECT DISTINCT ON (entity)
            id AS observation_id,
            entity,
            attrs,
            ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
            kind,
            author_sub AS edited_by,
            tx_time AS edited_at
          FROM observation
          WHERE scope = ${scope}
            AND valid_from <= ${asOf}
            ${cursorFilter}
            ${currentsCandidateFilter}
            ${currentExtras}
          ORDER BY entity, valid_from DESC, tx_time DESC
          LIMIT ${pageSize}
        ),
        creates AS (
          SELECT entity,
                 author_sub AS created_by,
                 tx_time    AS created_at
          FROM observation
          WHERE scope = ${scope}
            AND kind = 'create'
            AND entity IN (SELECT entity FROM currents)
        )
        SELECT
          c.entity,
          c.observation_id,
          c.attrs,
          c.geom_geojson,
          c.kind,
          c.edited_by,
          c.edited_at,
          cr.created_by,
          cr.created_at
        FROM currents c
        JOIN creates cr ON cr.entity = c.entity
        ORDER BY c.entity
      `;
    if (rows.length === 0) return { features: [], nextCursor: null, asOf };
    const live = rows
      .filter(
        (r) =>
          r.kind !== 'delete' &&
          // SQL booleans: TRUE matches, FALSE and NULL (e.g. a
          // bbox test against a NULL latest geometry) do not.
          (r.content_match === undefined || r.content_match === true),
      )
      .map(rowToFeature);
    return {
      features: live,
      // A short page means no matching entities remain above the
      // cursor. Otherwise advance past every SCANNED entity,
      // tombstones (and, on the filtered shape, latest-no-longer-
      // matches candidates) included; rows are entity-ordered so the
      // last one is the page maximum. Advancing by the last LIVE row
      // instead would re-scan any trailing tombstones forever.
      nextCursor:
        rows.length < pageSize ? null : rows[rows.length - 1]!.entity,
      asOf,
    };
  }

  /**
   * Paged attribute-table read: returns current-state features
   * (attrs only, no geometry) for a layer with optional bbox
   * filter, free-text search, sort, and a hard cap with truncation
   * indicator. The attribute-table card on the map page calls this
   * to populate its rows.
   *
   * Why a separate path instead of reusing listFeatures:
   *
   *   The map attribute table never needs geometry (the map
   *   itself already has it via MVT or otherwise). Sending the
   *   geometry over the wire on a 5000-row response inflates the
   *   payload by 10-100x for polygon-heavy layers. It also skips
   *   the `creates` join (no `_created_*` columns in the table
   *   card), so the read stays a single collapse pass.
   *
   *   The collapse itself is NOT optional though: bbox / search
   *   predicates and the tombstone filter must only ever see the
   *   latest observation per entity. The pre-fix shape filtered
   *   raw log rows first, which resurrected deleted or
   *   edited-away features whose OLD versions still matched
   *   (ghost rows in the attribute table).
   *
   *   The LIMIT N+1 trick at the end lets us tell the caller
   *   whether the result set was capped without an extra COUNT
   *   query. If `limit + 1` rows came back we know there's more
   *   and trim the response to exactly `limit`. If fewer, we got
   *   everything.
   *
   * Search (`q`): server-side ILIKE across every JSONB attribute
   * value cast to text, evaluated over any version for candidate
   * discovery and re-checked on the latest row. Honest about cost:
   * there is no index behind this predicate (see the searchFeatures
   * note), so a fully-unbounded (no bbox) big-layer query scans the
   * scope. With a bbox filter (the default UX path) the candidate
   * scan is bounded by the GIST hit-set and runs sub-second.
   *
   * Sort: any attribute name or one of the synthetic columns
   * (_global_id, _created_at, _edited_at). Same honest-about-cost
   * note as search: bbox-bounded sort is fast; unbounded sort by
   * a non-indexed attr on a 1.4M-row layer is not. The UI's
   * default "extent only" toggle keeps users on the fast path.
   */
  async pageFeatures(args: {
    itemId: string;
    layerId: string;
    bbox?: [number, number, number, number];
    q?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    limit: number;
    entityIds?: string[];
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
    isTable?: boolean;
  }): Promise<{
    features: Array<{ id: string; properties: Record<string, unknown> }>;
    count: number;
    truncated: boolean;
  }> {
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const scope = this.scope(args.itemId, args.layerId);
    const limit = Math.min(Math.max(args.limit | 0, 1), 5000);
    const fetchN = limit + 1;

    // Split the same way buildReadFilters splits: entity-id
    // restrictions are version-independent and may sit inside the
    // collapse; content predicates (geometry, attrs) must not, or
    // old versions resurrect ghosts.
    const collapseFilters: Prisma.Sql[] = [];
    const contentFilters: Prisma.Sql[] = [];
    if (!args.isTable) {
      if (args.bbox !== undefined) {
        const [w, s, e, n] = args.bbox;
        contentFilters.push(
          Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
        );
      }
      if (args.geoLimit !== undefined) {
        const json = JSON.stringify(args.geoLimit);
        contentFilters.push(
          Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`,
        );
      }
      if (args.boundaryClip !== undefined) {
        const json = JSON.stringify(args.boundaryClip);
        contentFilters.push(
          Prisma.sql`AND geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
        );
      }
    }
    if (args.entityIds !== undefined && args.entityIds.length > 0) {
      // The caller validates these are UUIDs upstream; cast each
      // through ::uuid in the IN clause so a non-uuid string can't
      // reach the planner.
      const ids = args.entityIds.slice(0, 1000);
      collapseFilters.push(
        Prisma.sql`AND entity = ANY(ARRAY[${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`),
        )}])`,
      );
    }
    if (args.q !== undefined && args.q.trim().length > 0) {
      // Pattern-escape the user input so SQL meta-characters don't
      // turn into wildcards. ILIKE pattern: %escaped%.
      const escaped = args.q
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      // Cast the entire JSONB to text and ILIKE over it. This
      // searches every attribute value in one comparison. It's a
      // single per-row predicate so the planner doesn't fan out
      // per-column. Returns false negatives on values stored as
      // numbers/booleans (their text repr matches) which is
      // acceptable -- the user is doing a free-text search, they
      // expect "contains" semantics.
      contentFilters.push(Prisma.sql`AND attrs::text ILIKE ${pattern}`);
    }
    const collapseExtras =
      collapseFilters.length > 0
        ? Prisma.join(collapseFilters, ' ')
        : Prisma.empty;

    // Currency read: latest observation per entity, THEN tombstone +
    // content predicates. The pre-fix single-pass DISTINCT ON put
    // `kind <> 'delete'` and the content filters into the raw-row
    // WHERE, which silently redefined "latest" as "latest matching
    // row" and resurrected deleted / edited-away features. The
    // former `valid_to IS NULL` clause is gone for the same reason:
    // data_layer writes never set valid_to, the canonical
    // listFeatures collapse ignores it, and inside the collapse it
    // would be another version-dependent filter waiting to
    // resurrect rows if valid_to ever were maintained.
    //
    // The CALLER's sort is applied as a JS pass over the bounded
    // result; with limit+1 capped at 5001 the JS sort cost is
    // negligible.
    const sortCol = args.sort;
    const sortDirDesc = args.dir === 'desc';

    interface Row {
      entity: string;
      attrs: Record<string, unknown> | null;
      edited_by: string;
      edited_at: Date;
    }
    const rows =
      contentFilters.length === 0
        ? // No content predicate: collapse the scope (optionally
          // narrowed to explicit entity ids) and drop tombstones
          // after. The subquery form (not a CTE) lets the planner
          // stream the DISTINCT ON off the (scope, entity,
          // valid_from DESC) index and stop at fetchN live rows.
          await this.prisma.$queryRaw<Row[]>`
      SELECT entity, attrs, edited_by, edited_at
      FROM (
        SELECT DISTINCT ON (entity)
          entity,
          attrs,
          kind,
          author_sub AS edited_by,
          tx_time AS edited_at
        FROM observation
        WHERE scope = ${scope}
          ${collapseExtras}
        ORDER BY entity, valid_from DESC, tx_time DESC
      ) latest
      WHERE kind <> 'delete'
      LIMIT ${fetchN}
    `
        : // Content predicates: candidate-then-collapse-then-filter,
          // same three stages as listFeatures. The candidate set is
          // ordered so the fetchN prefix is deterministic, and the
          // LATERAL collapse costs one index descent per candidate.
          await this.prisma.$queryRaw<Row[]>`
      WITH content_candidates AS (
        SELECT DISTINCT entity
        FROM observation
        WHERE scope = ${scope}
          ${collapseExtras}
          ${Prisma.join(contentFilters, ' ')}
      )
      SELECT l.entity, l.attrs, l.edited_by, l.edited_at
      FROM (SELECT entity FROM content_candidates ORDER BY entity) cand
      CROSS JOIN LATERAL (
        SELECT
          entity,
          attrs,
          geom,
          kind,
          author_sub AS edited_by,
          tx_time AS edited_at
        FROM observation
        WHERE scope = ${scope}
          AND entity = cand.entity
        ORDER BY valid_from DESC, tx_time DESC
        LIMIT 1
      ) l
      WHERE l.kind <> 'delete'
        ${Prisma.join(contentFilters, ' ')}
      ORDER BY l.entity
      LIMIT ${fetchN}
    `;
    const sortKey: (r: Row) => string | number = (() => {
      if (sortCol === '_global_id' || !sortCol) {
        return (r: Row) => r.entity;
      }
      if (sortCol === '_edited_at') {
        return (r: Row) => r.edited_at.getTime();
      }
      const col = sortCol;
      return (r: Row) => {
        const v = r.attrs?.[col] as unknown;
        if (v === null || v === undefined) return '';
        return typeof v === 'number' ? v : String(v);
      };
    })();
    rows.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (va < vb) return sortDirDesc ? 1 : -1;
      if (va > vb) return sortDirDesc ? -1 : 1;
      return 0;
    });

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return {
      features: kept.map((r) => ({
        id: r.entity,
        properties: {
          ...(r.attrs ?? {}),
          _global_id: r.entity,
          _edited_by: r.edited_by,
          _edited_at: r.edited_at.toISOString(),
        },
      })),
      count: kept.length,
      truncated,
    };
  }

  /**
   * Attribute search for the map / app search bar.
   *
   * Unlike pageFeatures (which the attribute table uses and which is
   * bbox-bounded and geometry-stripped), this reaches features
   * anywhere in the layer, not just the current viewport: the whole
   * point of searching a parcels layer by owner name is to find a
   * parcel that is NOT on screen. To make picking a result useful it
   * returns a representative interior point (for the fly-to marker)
   * and the feature's envelope (for a bbox zoom) per hit, computed in
   * the same query so the caller needs no second round-trip.
   *
   * Matching is two-layered:
   *   1. `attrs::text ILIKE '%q%'` matches across every attribute.
   *      No index backs this whole-blob predicate and none should:
   *      the trigram index over the full attrs JSON that briefly
   *      existed (`observation_attrs_trgm`) was dropped by migration
   *      20260618120000 (multi-GB to build, overran prod disk and
   *      statement_timeout); do not silently re-add it. Indexing
   *      lives on the per-field arms instead, see 2.
   *   2. When the caller passes `fields` (the layer author's
   *      configured searchable attributes) the match is narrowed to
   *      `attrs->>'field' ILIKE '%q%'` over just those fields, so a
   *      hit buried in an unrelated column (a legal description, a
   *      note) doesn't surface. These arms are what
   *      DataLayerSearchIndexService (data-layer/search-index.
   *      service.ts) indexes: one partial trigram index per
   *      searchable field, gin((attrs->>'<field>') gin_trgm_ops)
   *      WHERE scope = '<scope>', built via the admin housekeeping
   *      "Build search indexes" action. The planner serves the OR
   *      as a BitmapOr of per-field index scans and re-checks the
   *      whole-blob ILIKE on that small candidate set, so indexed
   *      layers stop scanning the scope per keystroke. The index
   *      expression mirrors this query's arms byte-for-byte; if
   *      the SQL below changes shape, change the service's DDL in
   *      lock-step or the indexes silently stop matching. Without
   *      `fields` (or before an admin builds indexes) candidate
   *      discovery scans the scope's rows: bearable on small
   *      layers, slow on county scale.
   *
   * Ghost-safety: the predicates discover CANDIDATE entities over
   * any version (that is where the per-field indexes plug in), the
   * candidates collapse to their true latest observation, and the
   * predicates are re-checked against that latest row. Filtering
   * raw versions directly (the pre-fix shape) surfaced features
   * whose old versions matched but whose latest was deleted or
   * edited to no longer match.
   *
   * Geo-limit and boundary-clip are applied exactly as pageFeatures
   * applies them, so a user with a clipped view can't pull a feature
   * outside their clip into the search results.
   */
  async searchFeatures(args: {
    itemId: string;
    layerId: string;
    q: string;
    fields?: string[];
    limit: number;
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
  }): Promise<{
    results: Array<{
      id: string;
      properties: Record<string, unknown>;
      point: [number, number] | null;
      bbox: [number, number, number, number] | null;
    }>;
    truncated: boolean;
  }> {
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const q = args.q.trim();
    if (q.length === 0) return { results: [], truncated: false };
    const scope = this.scope(args.itemId, args.layerId);
    const limit = Math.min(Math.max(args.limit | 0, 1), 50);
    const fetchN = limit + 1;

    // Same pattern-escape as pageFeatures: SQL meta-characters must
    // not turn into wildcards. ILIKE pattern is %escaped%.
    const escaped = q
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;

    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`AND attrs::text ILIKE ${pattern}`);
    const fields = (args.fields ?? []).filter((f) => f.length > 0);
    if (fields.length > 0) {
      // Each field name is a bound parameter to `->>`, so an arbitrary
      // attribute key can't be smuggled into the SQL text. The caller
      // also whitelists field names against the layer schema.
      const perField = fields.map(
        (f) => Prisma.sql`(attrs->>${f}) ILIKE ${pattern}`,
      );
      filters.push(Prisma.sql`AND (${Prisma.join(perField, ' OR ')})`);
    }
    if (args.geoLimit !== undefined) {
      const json = JSON.stringify(args.geoLimit);
      filters.push(
        Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`,
      );
    }
    if (args.boundaryClip !== undefined) {
      const json = JSON.stringify(args.boundaryClip);
      filters.push(
        Prisma.sql`AND geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    const filterExtras = Prisma.join(filters, ' ');

    interface Row {
      entity: string;
      attrs: Record<string, unknown> | null;
      px: number | null;
      py: number | null;
      minx: number | null;
      miny: number | null;
      maxx: number | null;
      maxy: number | null;
    }
    // Candidate discovery over any version, LATERAL collapse to the
    // latest observation per candidate (same ordering keys the
    // canonical listFeatures collapse uses: valid_from DESC, tx_time
    // DESC within the scope), then tombstone + predicates re-checked
    // against that latest row. The point / bbox projections read the
    // LATEST geometry, so a hit can't fly the map to a stale
    // location. ST_PointOnSurface (not centroid) guarantees a point
    // that lands inside the geometry even for concave parcels, which
    // makes the dropped pin sit on the parcel rather than off in a
    // notch. Table layers (geom NULL) yield null point + bbox and
    // the client shows the hit without a fly-to.
    const rows = await this.prisma.$queryRaw<Row[]>`
      WITH content_candidates AS (
        SELECT DISTINCT entity
        FROM observation
        WHERE scope = ${scope}
          ${filterExtras}
      )
      SELECT
        l.entity,
        l.attrs,
        CASE WHEN geom IS NOT NULL THEN ST_X(ST_PointOnSurface(geom)) END AS px,
        CASE WHEN geom IS NOT NULL THEN ST_Y(ST_PointOnSurface(geom)) END AS py,
        CASE WHEN geom IS NOT NULL THEN ST_XMin(geom) END AS minx,
        CASE WHEN geom IS NOT NULL THEN ST_YMin(geom) END AS miny,
        CASE WHEN geom IS NOT NULL THEN ST_XMax(geom) END AS maxx,
        CASE WHEN geom IS NOT NULL THEN ST_YMax(geom) END AS maxy
      FROM (SELECT entity FROM content_candidates ORDER BY entity) cand
      CROSS JOIN LATERAL (
        SELECT entity, attrs, geom, kind
        FROM observation
        WHERE scope = ${scope}
          AND entity = cand.entity
        ORDER BY valid_from DESC, tx_time DESC
        LIMIT 1
      ) l
      WHERE l.kind <> 'delete'
        ${filterExtras}
      ORDER BY l.entity
      LIMIT ${fetchN}
    `;

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return {
      results: kept.map((r) => {
        const point: [number, number] | null =
          r.px !== null &&
          r.py !== null &&
          Number.isFinite(Number(r.px)) &&
          Number.isFinite(Number(r.py))
            ? [Number(r.px), Number(r.py)]
            : null;
        const bbox: [number, number, number, number] | null =
          r.minx !== null &&
          r.miny !== null &&
          r.maxx !== null &&
          r.maxy !== null
            ? [Number(r.minx), Number(r.miny), Number(r.maxx), Number(r.maxy)]
            : null;
        return {
          id: r.entity,
          properties: {
            ...(r.attrs ?? {}),
            _global_id: r.entity,
          },
          point,
          bbox,
        };
      }),
      truncated,
    };
  }

  /**
   * #30: union bbox of the named features in WGS84.  Used by the
   * AttributeTable's "Zoom to selected" affordance in server-paged
   * mode: /features-page strips geometry to keep the payload small,
   * so the client cannot compute a bbox locally and falls back to
   * this endpoint.  Returns null when none of the requested entities
   * have geometry (table layers, or selection of all-null-geom rows)
   * so the caller can surface a friendly "no extent" message.
   *
   * Geo-limit and boundary-clip filters are applied the same way
   * pageFeatures applies them, so a user with a clipped view of a
   * layer can't zoom to a feature outside their clip via this
   * endpoint.
   */
  async selectionExtent(args: {
    itemId: string;
    layerId: string;
    entityIds: string[];
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
  }): Promise<[number, number, number, number] | null> {
    if (args.entityIds.length === 0) return null;
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const scope = this.scope(args.itemId, args.layerId);
    // Same UUID coercion + cap as pageFeatures so the planner sees
    // a safe IN list.
    const ids = args.entityIds.slice(0, 1000);

    const filters: Prisma.Sql[] = [];
    if (args.geoLimit !== undefined) {
      const json = JSON.stringify(args.geoLimit);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    if (args.boundaryClip !== undefined) {
      const json = JSON.stringify(args.boundaryClip);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    const filterExtras =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // Pick the latest observation per entity (DISTINCT ON), then
    // aggregate ST_Extent over the resulting geometries.  The outer
    // SELECT uses ST_Extent which returns a `box2d`; we read its
    // bounds via ST_XMin/ST_YMin/ST_XMax/ST_YMax to get plain
    // numbers back to JS without a custom Prisma type.
    //
    // Only the entity-id restriction may live inside the collapse
    // (ids are version-independent). The tombstone, null-geom, and
    // geo-limit / boundary-clip checks apply to the collapsed
    // LATEST row: putting them into the raw-row WHERE (the pre-fix
    // shape) made a deleted or moved-away feature contribute its
    // OLD geometry to the extent, so "Zoom to selected" flew to
    // places the selection no longer occupies. The former
    // `valid_to IS NULL` clause is dropped to match the canonical
    // listFeatures collapse (data_layer writes never set valid_to;
    // pre-collapse it is a latent resurrection filter). No
    // candidate stage is needed: the id list (<= 1000) already
    // bounds the collapse to cheap per-entity index descents.
    interface ExtentRow {
      xmin: number | null;
      ymin: number | null;
      xmax: number | null;
      ymax: number | null;
    }
    const rows = await this.prisma.$queryRaw<ExtentRow[]>`
      WITH current AS (
        SELECT DISTINCT ON (entity)
          entity, geom, kind
        FROM observation
        WHERE scope = ${scope}
          AND entity = ANY(ARRAY[${Prisma.join(
            ids.map((id) => Prisma.sql`${id}::uuid`),
          )}])
        ORDER BY entity, valid_from DESC, tx_time DESC
      )
      SELECT
        ST_XMin(ST_Extent(geom)) AS xmin,
        ST_YMin(ST_Extent(geom)) AS ymin,
        ST_XMax(ST_Extent(geom)) AS xmax,
        ST_YMax(ST_Extent(geom)) AS ymax
      FROM current
      WHERE kind <> 'delete'
        AND geom IS NOT NULL
        ${filterExtras}
    `;
    const r = rows[0];
    if (
      !r ||
      r.xmin === null ||
      r.ymin === null ||
      r.xmax === null ||
      r.ymax === null
    ) {
      return null;
    }
    return [r.xmin, r.ymin, r.xmax, r.ymax];
  }

  /**
   * Build a Mapbox Vector Tile for one layer at a given z/x/y. The
   * tile contains the layer's current-state features clipped to the
   * tile envelope.
   *
   * Why MVT instead of the listFeatures GeoJSON path:
   *
   *   Rendering a county-scale dataset (1.4M parcels) as a single
   *   GeoJSON FeatureCollection means the api serves hundreds of MB
   *   per request, the browser parses it on the main thread, and
   *   MapLibre re-tessellates the whole thing before drawing.
   *   Empirically that pegs both threads for tens of seconds and
   *   the page becomes unresponsive while the work runs. MVT is
   *   what AGO and every other production map stack uses for big
   *   layers: per-tile vector geometry, bbox-clipped, gzipped,
   *   cached by the browser. The same 1.4M polygons render
   *   incrementally as the user pans, at native MapLibre speed.
   *
   * The tile payload only includes the `_global_id` property so it
   * stays small. Popup / attribute access still routes through
   * listFeatures with `entity: <featureId>`; the click handler in
   * the web client fetches full attrs on demand.
   *
   * Authz model is the same as listFeatures: the caller has already
   * passed the canRead check via the controller. We do NOT plumb
   * lens-policy row filters through MVT yet; if a layer's lens
   * policy filters rows out, those rows would still leak in the
   * tile. Acceptable for v1 (lens policies aren't widely used);
   * tracked as a Phase-D follow-up. Geo-limit and boundary clip,
   * which are the much more common scoping mechanisms, ARE honored
   * via ST_Intersects clauses.
   *
   * Geometry-less ("table mode") sublayers return an empty MVT.
   */
  async mvtTile(args: {
    itemId: string;
    layerId: string;
    z: number;
    x: number;
    y: number;
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
    isTable?: boolean;
    /**
     * Layer's declared field schema. Each entry's name is projected
     * into the MVT as a feature property so MapLibre expressions
     * (`['get', 'fieldName']` for labels, popups, and filters) can
     * resolve at render time. Without this the tile only carries
     * `_global_id` + geometry and every {{field}} resolves to null.
     * Caller should pass the layer's `fields[]` from its schema;
     * names must already be validated (the data_layer field-name
     * regex prevents SQL identifier injection).
     */
    fields?: Array<{ name: string; type?: string }>;
  }): Promise<TileResult> {
    if (args.isTable === true) {
      // Empty MVT is stable (always Buffer.alloc(0)); compute the
      // ETag from a fixed token so the empty-tile case still
      // round-trips 304 correctly when a client revalidates.
      return { mvt: Buffer.alloc(0), etag: '"empty-table"' };
    }
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);

    const scope = this.scope(args.itemId, args.layerId);

    // Single-flight cache: hit -> return stored buffer + ETag;
    // someone else computing this key -> await their Promise;
    // otherwise compute fresh, store, return. Keying on
    // (scope, z/x/y, opts fingerprint) so requests with
    // different per-tile options (different field projections,
    // distinct geoLimit, etc.) get separate slots and don't
    // collide.
    const cacheKey = tileCacheKey({
      scope,
      z: args.z,
      x: args.x,
      y: args.y,
      optsFingerprint: optsFingerprint(args),
    });
    const result = await this.tileCache.getOrCompute(cacheKey, () =>
      this.computeMvtTileBytes(args, scope),
    );
    return { mvt: result.buf, etag: result.etag };
  }

  /**
   * The Postgres-side work of building an MVT tile. Split out
   * from mvtTile() so it can be invoked through TileCacheService
   * .getOrCompute() and share single-flight semantics with
   * concurrent callers asking for the same (scope, z, x, y).
   *
   * `maxFeaturesPerTile` exists so the integration spec can prove
   * the limit-after-collapse behaviour with a tiny budget instead
   * of seeding 5000+ rows; production callers never pass it.
   */
  private async computeMvtTileBytes(
    args: {
      z: number;
      x: number;
      y: number;
      geoLimit?: GeoJsonGeometry;
      boundaryClip?: GeoJsonGeometry;
      fields?: Array<{ name: string; type?: string }>;
      maxFeaturesPerTile?: number;
    },
    scope: string,
  ): Promise<Buffer> {
    const filters: Prisma.Sql[] = [];

    if (args.geoLimit !== undefined) {
      const json = JSON.stringify(args.geoLimit);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    if (args.boundaryClip !== undefined) {
      const json = JSON.stringify(args.boundaryClip);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    const filterExtras =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // Build the per-field projection list. Each declared field gets
    // a `(attrs->>'name')::cast AS "name"` projection so it lands in
    // the MVT as a typed feature property. Identifier names must
    // not be parameterized in PostgreSQL bind protocol; Prisma.raw
    // is safe here because the field-name regex enforced by the
    // schema (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is stricter than the
    // identifier whitelist we apply below. Belt-and-suspenders: we
    // reject any name that fails the regex even though the schema
    // path should have caught it upstream.
    const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
    const fieldProjections: Prisma.Sql[] = [];
    if (Array.isArray(args.fields)) {
      for (const f of args.fields) {
        if (!SAFE_NAME.test(f.name)) continue;
        const cast = sqlCastForFieldType(f.type);
        // `attrs` is the JSONB column on observation; `->>'name'`
        // extracts as text, then we cast where the schema declares
        // a numeric / boolean / date type so MapLibre's typed
        // expressions (e.g. `['>', ['get', 'pop'], 5]`) actually
        // work without string coercion warnings.
        fieldProjections.push(
          Prisma.raw(
            `(attrs->>'${f.name}')${cast} AS "${f.name}"`,
          ),
        );
      }
    }
    const fieldProjection =
      fieldProjections.length > 0
        ? Prisma.sql`, ${Prisma.join(fieldProjections, ', ')}`
        : Prisma.empty;
    // `currents` needs `attrs` available so the outer projection
    // can read it. Only include the JSONB column when we have at
    // least one field to project, to keep the row narrower in the
    // (rare) no-fields case.
    const currentsAttrs =
      fieldProjections.length > 0 ? Prisma.sql`, attrs` : Prisma.empty;

    // ST_TileEnvelope(z, x, y) returns the tile bbox in EPSG:3857
    // (Web Mercator). We bbox-filter on the geom column in 4326 by
    // transforming the envelope back to 4326 first; the && operator
    // uses the spatial index. ST_AsMVTGeom then transforms each
    // surviving geometry into the tile's local coordinate space
    // (4096-unit grid, with the 64-unit buffer that MapLibre needs
    // to avoid seams at tile edges).
    //
    // Candidate-then-collapse-then-filter, same staging as
    // listFeatures' filtered path:
    //
    //   1. `tile_candidates` finds ENTITIES with any observation
    //      version touching the tile envelope. Keeping this a
    //      separate CTE lets Postgres drive it off the GIST geom
    //      index instead of the entity-ordered btree. The pre-fix
    //      shape limited RAW ROWS here, which had two bugs: a
    //      heavily-edited feature's superseded versions could eat
    //      the whole tile budget and evict live neighbours
    //      (limit-before-dedupe), and an old in-tile version
    //      resurrected a feature whose latest was deleted or moved
    //      out (filter-before-collapse). Grouping by entity fixes
    //      both: fifty versions of one parcel cost one candidate
    //      slot. The LIMIT here is entity-level sampling for
    //      low-zoom tiles over huge layers (a z=4 tile over 1.4M
    //      parcels); only entities whose latest fails stage 3
    //      (real churn: deletes / move-outs) can waste a sampled
    //      slot now.
    //
    //   2. `currents` collapses each candidate to its true latest
    //      observation over its FULL history via LATERAL ... LIMIT 1
    //      (one descent of the (scope, entity, valid_from DESC)
    //      btree per candidate; same ordering keys as the canonical
    //      listFeatures collapse). No `valid_to IS NULL` clause:
    //      data_layer writes never set valid_to, the canonical
    //      collapse ignores it, and pre-collapse it is a latent
    //      resurrection filter. Stage 3 then re-checks tombstone +
    //      envelope + sanity + geo filters against that latest row,
    //      and the tile budget LIMIT is applied AFTER those checks,
    //      so it counts live in-tile features only.
    //
    //   3. `visible_features` filters out null geoms (geometries
    //      that ST_AsMVTGeom couldn't represent at this zoom)
    //      so ST_AsMVT doesn't emit empty feature stubs.
    interface TileRow {
      mvt: Buffer;
    }
    // No pre-simplification: empirically, ST_AsMVTGeom's built-in
    // quantization to the 4096-unit grid handles low-zoom
    // detail-shedding by itself, dropping sub-pixel features as
    // NULL. Pre-running ST_Simplify with any non-trivial
    // tolerance produced triangle artifacts on parcels (small
    // polygons collapsed to their three farthest-apart vertices,
    // making the layer look like a constellation of wedges).
    // The tile_candidates LIMIT below is what actually caps work at
    // low zoom; performance stayed sub-second on the 1.4M-row WV
    // Parcels layer at every zoom from 4 to 14 without
    // pre-simplification.
    // Cap features per tile. 5000 is a sweet spot: enough for a
    // dense rural county to come through whole at z=12; small
    // enough that a state-wide z=6 tile completes well inside the
    // 30s statement_timeout and downstream MVT serialization stays
    // bounded. Layers that are sparse enough to fit in fewer rows
    // are unaffected -- this is a worst-case ceiling, not a floor.
    const MAX_FEATURES_PER_TILE = args.maxFeaturesPerTile ?? 5000;
    const rows = await this.prisma.$queryRaw<TileRow[]>`
      WITH tile_candidates AS (
        SELECT entity
        FROM observation
        WHERE scope = ${scope}
          AND geom IS NOT NULL
          AND geom && ST_Transform(ST_TileEnvelope(${args.z}::integer, ${args.x}::integer, ${args.y}::integer), 4326)
          -- Sanity-filter out geometries whose bbox spans more
          -- than a degree (~100 km) in either dimension AND that
          -- carry few vertices. Garbage parcels (the case this
          -- filter was originally added for) are typically 4-6
          -- vertex polygons whose bbox accidentally spans a
          -- whole state; rendering them flat-shaded turns into a
          -- cross-state triangle that swamps the layer at low
          -- zoom.
          --
          -- The vertex count gate (ST_NPoints > 50) lets through
          -- legitimately-huge polygons that follow real-world
          -- features: state boundaries, watersheds, ICE
          -- enforcement zones, the 100-mile border buffer.
          -- Real complex polygons carry hundreds-to-millions of
          -- vertices; garbage triangles do not. Without this
          -- exception, an AGO-imported "100 Mile Border Zone"
          -- layer (8743 polygons, some spanning the entire
          -- US-Mexico border) rendered with only the small
          -- in-tile polygons visible, and the user saw "the
          -- majority of polygons don't appear" (#70).
          --
          -- ST_NPoints is a cheap pure-geometry call, on the
          -- same order of magnitude as ST_XMax / ST_XMin, so
          -- this stays effectively free on the index-scan hot
          -- path. Applying it during candidate discovery is safe:
          -- a latest row that passes stage 3 qualifies its own
          -- entity here (any predicate re-checked on the latest
          -- row may prefilter candidates without false negatives).
          AND (
            (ST_XMax(geom) - ST_XMin(geom)) < 1.0
            AND (ST_YMax(geom) - ST_YMin(geom)) < 1.0
            OR ST_NPoints(geom) > 50
          )
          ${filterExtras}
        GROUP BY entity
        LIMIT ${MAX_FEATURES_PER_TILE}
      ),
      currents AS (
        SELECT l.entity, l.geom${currentsAttrs}
        FROM tile_candidates cand
        CROSS JOIN LATERAL (
          SELECT entity, geom, kind${currentsAttrs}
          FROM observation
          WHERE scope = ${scope}
            AND entity = cand.entity
          ORDER BY valid_from DESC, tx_time DESC
          LIMIT 1
        ) l
        WHERE l.kind <> 'delete'
          AND l.geom IS NOT NULL
          AND l.geom && ST_Transform(ST_TileEnvelope(${args.z}::integer, ${args.x}::integer, ${args.y}::integer), 4326)
          AND (
            (ST_XMax(l.geom) - ST_XMin(l.geom)) < 1.0
            AND (ST_YMax(l.geom) - ST_YMin(l.geom)) < 1.0
            OR ST_NPoints(l.geom) > 50
          )
          ${filterExtras}
        LIMIT ${MAX_FEATURES_PER_TILE}
      ),
      tile_features AS (
        SELECT
          entity::text AS _global_id,
          ST_AsMVTGeom(
            ST_Transform(geom, 3857),
            ST_TileEnvelope(${args.z}::integer, ${args.x}::integer, ${args.y}::integer),
            4096,
            64,
            true
          ) AS geom
          ${fieldProjection}
        FROM currents
      ),
      visible_features AS (
        SELECT * FROM tile_features WHERE geom IS NOT NULL
      )
      SELECT
        COALESCE(ST_AsMVT(visible_features, 'features', 4096, 'geom'), '\\x'::bytea) AS mvt
      FROM visible_features
    `;
    // Prisma 7's @prisma/adapter-pg returns Postgres `bytea` values
    // as Uint8Array, not Buffer. The previous `raw instanceof Buffer`
    // check was true under Prisma 6's Rust engine (which mapped bytea
    // straight to Buffer) but false under the driver adapter, which
    // silently dropped every successful tile to Buffer.alloc(0) and
    // surfaced as "MVT 200 with empty body, map shows no parcels."
    // Accept any Uint8Array (Buffer is itself a Uint8Array subclass
    // so this covers both adapters) and wrap with Buffer.from() so
    // downstream code that expects Buffer-shaped APIs keeps working.
    const raw = rows[0]?.mvt;
    if (raw instanceof Uint8Array) {
      return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    }
    return Buffer.alloc(0);
  }

  /**
   * Apply a Cedar-evaluated row filter to the engine's read output.
   * Pulled into its own method so the spec for Phase D can drive
   * it directly without rebuilding a full PostGIS query path.
   *
   * Honours the caller-supplied `spatialKeysFor` to resolve spatial
   * predicates upstream of the policy check; the policy then sees
   * a Set<string> of keys the feature qualifies for and evaluates
   * `.contains("assigned_area")` natively.
   */
  private applyLensPolicy(
    features: DataLayerFeature[],
    spec: ListFeaturesArgs['lensPolicy'],
  ): DataLayerFeature[] {
    if (!spec) return features;
    if (!spec.lens.policy || spec.lens.policy.trim().length === 0) {
      return features;
    }
    return features.filter((feature) => {
      const spatial = spec.spatialKeysFor
        ? spec.spatialKeysFor(feature)
        : [];
      return this.lensPolicy.checkFeature({
        user: spec.user,
        lens: spec.lens,
        feature: {
          entityId: feature.id,
          attrs: feature.properties as Record<string, unknown>,
          spatial,
        },
      });
    });
  }
}

/**
 * Sanitize a JSONB key name so it is safe to embed in a single-quoted
 * SQL literal. Keys flow from the v3 controller after schema-name
 * validation, so this is belt-and-suspenders against an upstream miss.
 * Replaces every character that is not `[a-zA-Z0-9_]` with `_`.
 */
function sanitizeJsonbKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

function requireId(id: string | undefined): string {
  if (id === undefined) {
    throw new Error('engine returned observation without id');
  }
  return id;
}

/**
 * Map a FeatureFieldType to a PostgreSQL cast suffix so the JSONB
 * `->>` text extraction lands in MVT with the right typed
 * property. Boolean and date are intentionally string-typed in
 * MVT (MVT itself doesn't have boolean/date wire types; MapLibre
 * compares them as strings), so we leave those uncast. Number
 * fields go through `::numeric` so `['>', ['get', 'pop'], 5]`
 * works without coercion warnings. Unknown / missing types fall
 * back to text.
 */
function sqlCastForFieldType(type: string | undefined): string {
  if (type === 'number') return '::numeric';
  return '';
}
