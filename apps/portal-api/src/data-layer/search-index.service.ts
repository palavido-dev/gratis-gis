// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { DataLayerLayerShape } from './tables.service.js';
import type { FeatureFieldType } from '@gratis-gis/shared-types';

/**
 * Per-searchable-field trigram indexing for data_layer attribute
 * search (the "make search fast without the whole-blob index"
 * workstream that the searchable-flag docstring and the
 * observation_attrs_trgm revert both pointed at).
 *
 * What gets indexed and why this exact expression:
 *
 *   DataLayerEngine.searchFeatures narrows its candidate scan with
 *   (verbatim from engine/data-layer.ts, one per-field arm in the
 *   OR for each searchable field the caller passes):
 *
 *     AND attrs::text ILIKE ${pattern}
 *     AND ((attrs->>${f}) ILIKE ${pattern} OR ...)
 *
 *   For each field a layer author marks `searchable`, we create a
 *   partial GIN trigram index whose expression matches the per-field
 *   arm exactly:
 *
 *     CREATE INDEX ... ON observation
 *       USING gin ((attrs->>'<field>') gin_trgm_ops)
 *       WHERE scope = '<data_layer:item:layer>'
 *
 *   The planner then serves the OR through a BitmapOr of per-field
 *   Bitmap Index Scans and re-checks the broad `attrs::text ILIKE`
 *   on the small candidate set (verified plan on PostGIS 17). The
 *   expression must stay in lock-step with searchFeatures: if the
 *   query ever changes shape, these indexes silently stop matching.
 *
 *   Every arm of the OR needs an index or the planner falls back to
 *   scanning the scope for the whole disjunction; that is why field
 *   names are escaped into the expression (quote-doubling) instead
 *   of skipped when they contain spaces, the way CSV-derived
 *   headers ("Owner Name") routinely do. The geocoder's stricter
 *   [a-zA-Z0-9_] gate exists because it embeds the field name in
 *   the INDEX NAME too; here the name is a hash, so the field only
 *   ever appears inside a single-quoted literal.
 *
 * What deliberately does NOT get indexed:
 *
 *   The whole-blob `attrs::text` predicate. A trigram index over the
 *   full attrs JSON (observation_attrs_trgm) was multi-GB on prod,
 *   overran disk and statement_timeout when built inline in a
 *   migration, and was reverted by migration 20260618120000. It was
 *   also redundant once the per-field indexes exist. Do not re-add
 *   it here or anywhere else.
 *
 * Why CREATE INDEX is NOT CONCURRENTLY:
 *
 *   `observation` is a partitioned table (RANGE on tx_time, managed
 *   by pg_partman; migration 20260508081000) and Postgres rejects
 *   CREATE INDEX CONCURRENTLY on a partitioned parent outright,
 *   still true on PG 17: "cannot create index on partitioned table
 *   ... concurrently" (verified against postgis/postgis:17-3.5; the
 *   pg spec pins it). So we mirror GeocodingService.rebuildIndexes:
 *   a plain CREATE INDEX on the parent, which propagates to every
 *   existing and future partition. That takes a SHARE lock per
 *   partition while it builds: reads keep flowing, feature writes
 *   stall for the build window (the geocoder measured ~30-60s per
 *   field on a 1M-row layer and ships that trade in prod for the
 *   same admin-clicked-a-button situation). This is nothing like
 *   the observation_attrs_trgm incident, which was a whole-blob
 *   index built inline during a DEPLOY migration. If the write
 *   stall ever becomes a problem, the escalation path is the
 *   per-partition CREATE INDEX CONCURRENTLY + ALTER INDEX ATTACH
 *   PARTITION dance, not CONCURRENTLY on the parent.
 *
 * Transaction posture:
 *
 *   Every statement here runs through `this.prisma.$executeRawUnsafe`
 *   / `$queryRaw` on the base PrismaService client: one autocommit
 *   statement per call, never inside prisma.$transaction. Callers
 *   (the housekeeping build action) must keep it that way; index
 *   DDL inside a long transaction would pin locks for the whole
 *   transaction lifetime, and it would break the CONCURRENTLY
 *   escalation path outright (CIC cannot run in a transaction).
 *
 * Invalid-index hygiene:
 *
 *   Partitioned-index trees can end up INVALID without any
 *   concurrent build: a `CREATE INDEX ... ON ONLY` that never got
 *   its partitions attached, a crashed REINDEX CONCURRENTLY leaving
 *   a *_ccnew child, or a future switch to the per-partition
 *   CONCURRENTLY pattern failing mid-flight. `CREATE INDEX IF NOT
 *   EXISTS` would see the broken index and silently keep it, so
 *   every reconcile pass first detects our indexes whose parent OR
 *   any attached child is invalid and drops them for a clean
 *   rebuild.
 */

/** Result of one reconcile pass, shaped like the geocoder's
 *  rebuildIndexes result so admin surfaces can render both the
 *  same way. */
export interface SearchIndexReconcileResult {
  created: string[];
  kept: string[];
  dropped: string[];
  /** Broken (invalid) indexes that were dropped before recreate. */
  droppedInvalid: string[];
  /** Fields we refused to index, with the reason (unsafe name). */
  skippedFields: Array<{ scope: string; field: string; reason: string }>;
}

/** Org-wide build result for the housekeeping action. */
export interface SearchIndexBuildResult extends SearchIndexReconcileResult {
  scannedItems: number;
  /** Layers that declare at least one searchable field. */
  indexedLayers: number;
  /** Indexes whose scope no longer maps to any data_layer layer
   *  anywhere in the portal (deleted item / removed layer). */
  orphansDropped: string[];
  durationMs: number;
}

@Injectable()
export class DataLayerSearchIndexService {
  private readonly log = new Logger(DataLayerSearchIndexService.name);

  /**
   * Mirrors the geocoder's `idx_geo_` convention: fixed prefix, an
   * owner segment, a field segment. Both segments are md5 halves
   * here (not the raw ids) because a scope embeds two ids plus
   * separators and a field name is arbitrary user text: hashing
   * keeps the relation name deterministic, collision-safe, well
   * under Postgres's 63-char identifier cap, and free of any
   * characters that would need identifier quoting.
   */
  static readonly INDEX_NAME_PREFIX = 'idx_ggs';

  /** Everything we ever create matches this; everything we ever
   *  drop must match it too (same trust-boundary re-validation the
   *  geocoder does before interpolating a name into DDL). */
  static readonly INDEX_NAME_RE = /^idx_ggs_[a-f0-9]{16}_[a-f0-9]{16}$/;

  constructor(private readonly prisma: PrismaService) {}

  // ===============================================================
  // Pure name / DDL generation (unit-tested verbatim)
  // ===============================================================

  static scopeHash(scope: string): string {
    return createHash('md5').update(scope, 'utf8').digest('hex').slice(0, 16);
  }

  static fieldHash(field: string): string {
    return createHash('md5').update(field, 'utf8').digest('hex').slice(0, 16);
  }

  static indexName(scope: string, field: string): string {
    return `${this.INDEX_NAME_PREFIX}_${this.scopeHash(scope)}_${this.fieldHash(field)}`;
  }

  /**
   * A field name is embeddable when quote-doubling alone makes it a
   * safe single-quoted literal under BOTH standard_conforming_strings
   * settings: no backslash (an escape char when the setting is off),
   * no control bytes, bounded length. Returns null when safe, else
   * the human-readable reason (surfaced in the reconcile result so
   * an admin can see why a field stayed unindexed).
   */
  static unsafeFieldReason(field: string): string | null {
    if (field.length === 0) return 'empty field name';
    if (field.length > 200) return 'field name longer than 200 characters';
    if (field.includes('\\')) return 'field name contains a backslash';
    // The control-char range being matched is the point of this test.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(field)) {
      return 'field name contains control characters';
    }
    return null;
  }

  /**
   * The exact DDL. The expression `(attrs->>'<field>') gin_trgm_ops`
   * must match the per-field predicate DataLayerEngine.searchFeatures
   * emits, `(attrs->>${f}) ILIKE ${pattern}`, or the planner will not
   * match the index to the query. gin_trgm_ops serves ILIKE (~~*)
   * lookups. The partial WHERE keeps each index to one layer's rows,
   * exactly like the geocoder's partial indexes: the query's own
   * `scope = $1` lets the planner prove the predicate on its custom
   * plans (partial indexes never match a generic plan, which keeps
   * the custom plan cheaper, so the planner keeps choosing it).
   */
  static createIndexSql(name: string, field: string, scope: string): string {
    return (
      `CREATE INDEX IF NOT EXISTS "${name}" ON observation ` +
      `USING gin ((attrs->>'${field.replace(/'/g, "''")}') gin_trgm_ops) ` +
      `WHERE scope = '${scope.replace(/'/g, "''")}'`
    );
  }

  static dropIndexSql(name: string): string {
    return `DROP INDEX IF EXISTS "${name}"`;
  }

  // ===============================================================
  // Reconcile one item's layers
  // ===============================================================

  /**
   * Bring the physical indexes for one data_layer item in line with
   * its declared schema: an index per (layer, searchable field),
   * nothing else under the item's scope prefixes. Idempotent; safe
   * to re-run any time. Drops cover both "field unmarked" and
   * "field removed": anything under a layer's scope hash that the
   * current schema no longer wants goes away.
   */
  async reconcileItem(
    itemId: string,
    layers: DataLayerLayerShape[],
  ): Promise<SearchIndexReconcileResult> {
    const out: SearchIndexReconcileResult = {
      created: [],
      kept: [],
      dropped: [],
      droppedInvalid: [],
      skippedFields: [],
    };
    for (const layer of layers) {
      const scope = `data_layer:${itemId}:${layer.id}`;
      await this.reconcileScope(scope, layer, out);
    }
    return out;
  }

  private async reconcileScope(
    scope: string,
    layer: DataLayerLayerShape,
    out: SearchIndexReconcileResult,
  ): Promise<void> {
    const desired = new Map<string, { field: string; sql: string }>();
    for (const f of layer.fields ?? []) {
      if (f.searchable !== true) continue;
      const reason = DataLayerSearchIndexService.unsafeFieldReason(f.name);
      if (reason !== null) {
        // One unindexable arm makes the whole OR unindexable for
        // the layer, so this is worth surfacing loudly rather than
        // the geocoder's quiet skip.
        this.log.warn(
          `search-index: not indexing field in scope ${scope}: ${reason}`,
        );
        out.skippedFields.push({ scope, field: f.name, reason });
        continue;
      }
      const name = DataLayerSearchIndexService.indexName(scope, f.name);
      desired.set(name, {
        field: f.name,
        sql: DataLayerSearchIndexService.createIndexSql(name, f.name, scope),
      });
    }

    const prefix = `${DataLayerSearchIndexService.INDEX_NAME_PREFIX}_${DataLayerSearchIndexService.scopeHash(scope)}_`;

    // Existing indexes under this layer's prefix, same discovery the
    // geocoder uses (pg_indexes only lists valid-or-not parents; the
    // validity probe below is separate because pg_indexes has no
    // validity column).
    const existingRows = await this.prisma.$queryRaw<
      Array<{ indexname: string }>
    >`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE ${`${prefix}%`}
    `;
    const existing = new Set(existingRows.map((r) => r.indexname));

    // Invalid-tree probe: a parent flagged !indisvalid (e.g. ON ONLY
    // never attached) or any attached child left !indisvalid (e.g. a
    // crashed REINDEX/CIC). CREATE INDEX IF NOT EXISTS would keep
    // such a wreck forever, so drop it first and let the create pass
    // rebuild it.
    const invalidRows = await this.prisma.$queryRaw<
      Array<{ indexname: string }>
    >`
      SELECT c.relname AS indexname
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname LIKE ${`${prefix}%`}
        AND (
          NOT i.indisvalid
          OR EXISTS (
            SELECT 1
            FROM pg_inherits h
            JOIN pg_index ci ON ci.indexrelid = h.inhrelid
            WHERE h.inhparent = c.oid
              AND NOT ci.indisvalid
          )
        )
    `;
    for (const r of invalidRows) {
      if (!DataLayerSearchIndexService.INDEX_NAME_RE.test(r.indexname)) {
        this.log.warn(
          `search-index: refusing to drop unexpected invalid index '${r.indexname}'`,
        );
        continue;
      }
      await this.prisma.$executeRawUnsafe(
        DataLayerSearchIndexService.dropIndexSql(r.indexname),
      );
      out.droppedInvalid.push(r.indexname);
      existing.delete(r.indexname);
    }

    // Drop indexes for fields no longer searchable (or renamed:
    // rename = old hash dropped here + new hash created below).
    for (const name of existing) {
      if (desired.has(name)) continue;
      if (!DataLayerSearchIndexService.INDEX_NAME_RE.test(name)) {
        // Same explicit trust boundary as the geocoder: we minted
        // every name we ever drop, so anything else that slipped
        // through the LIKE filter is not ours to touch.
        this.log.warn(
          `search-index: refusing to drop unexpected index name '${name}'`,
        );
        continue;
      }
      await this.prisma.$executeRawUnsafe(
        DataLayerSearchIndexService.dropIndexSql(name),
      );
      out.dropped.push(name);
    }

    // Create what's missing. IF NOT EXISTS keeps re-runs idempotent
    // (invalid survivors were already dropped above, so IF NOT
    // EXISTS can only be skipping a healthy index here).
    for (const [name, d] of desired) {
      if (existing.has(name)) {
        out.kept.push(name);
        continue;
      }
      await this.prisma.$executeRawUnsafe(d.sql);
      out.created.push(name);
      this.log.log(
        `search-index: built ${name} on (attrs->>'${d.field}') for ${scope}`,
      );
    }
  }

  // ===============================================================
  // Org-wide build (housekeeping "Build search indexes" action)
  // ===============================================================

  /**
   * Walk every data_layer item in the org and reconcile its search
   * indexes; then sweep indexes whose scope hash matches NO layer of
   * ANY item portal-wide (the layer or item is gone). The orphan
   * sweep deliberately looks across all orgs and includes trashed
   * items as owners: indexes are global DB objects, and a restore
   * from the recycle bin should not come back slow because a
   * different org's build pass swept its indexes.
   */
  async buildForOrg(orgId: string): Promise<SearchIndexBuildResult> {
    const start = Date.now();
    const out: SearchIndexBuildResult = {
      created: [],
      kept: [],
      dropped: [],
      droppedInvalid: [],
      skippedFields: [],
      orphansDropped: [],
      scannedItems: 0,
      indexedLayers: 0,
      durationMs: 0,
    };

    const items = await this.prisma.item.findMany({
      where: { orgId, type: 'data_layer', deletedAt: null },
      select: { id: true, data: true },
    });
    out.scannedItems = items.length;
    for (const item of items) {
      const layers = readSearchableLayers(item.data);
      if (layers === null || layers.length === 0) continue;
      out.indexedLayers += layers.filter((l) =>
        (l.fields ?? []).some((f) => f.searchable === true),
      ).length;
      const r = await this.reconcileItem(item.id, layers);
      out.created.push(...r.created);
      out.kept.push(...r.kept);
      out.dropped.push(...r.dropped);
      out.droppedInvalid.push(...r.droppedInvalid);
      out.skippedFields.push(...r.skippedFields);
    }

    out.orphansDropped = await this.dropOrphanIndexes();
    out.durationMs = Date.now() - start;
    return out;
  }

  /**
   * Drop idx_ggs indexes whose scope-hash segment doesn't belong to
   * any (item, layer) pair currently stored on any data_layer item,
   * trashed or not. Hashes are one-way, so membership is decided by
   * hashing every known scope and set-testing the segment.
   */
  private async dropOrphanIndexes(): Promise<string[]> {
    const all = await this.prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE ${`${DataLayerSearchIndexService.INDEX_NAME_PREFIX}_%`}
    `;
    if (all.length === 0) return [];

    const owners = await this.prisma.item.findMany({
      where: { type: 'data_layer' },
      select: { id: true, data: true },
    });
    const knownScopeHashes = new Set<string>();
    for (const item of owners) {
      const layers = readSearchableLayers(item.data);
      for (const l of layers ?? []) {
        knownScopeHashes.add(
          DataLayerSearchIndexService.scopeHash(
            `data_layer:${item.id}:${l.id}`,
          ),
        );
      }
    }

    const dropped: string[] = [];
    for (const r of all) {
      if (!DataLayerSearchIndexService.INDEX_NAME_RE.test(r.indexname)) {
        continue;
      }
      const scopeHash = r.indexname.slice(
        DataLayerSearchIndexService.INDEX_NAME_PREFIX.length + 1,
        DataLayerSearchIndexService.INDEX_NAME_PREFIX.length + 17,
      );
      if (knownScopeHashes.has(scopeHash)) continue;
      await this.prisma.$executeRawUnsafe(
        DataLayerSearchIndexService.dropIndexSql(r.indexname),
      );
      dropped.push(r.indexname);
      this.log.log(`search-index: dropped orphan ${r.indexname}`);
    }
    return dropped;
  }
}

/**
 * Local narrowing of a data_layer item's v3 payload down to what
 * indexing needs (layer ids + field names + searchable flags).
 * Duplicated from items.service.readV3Layers on purpose, the same
 * way housekeeping.service, housekeeping-schedule.service and
 * item-bbox-refresh.service carry their own copies: importing ItemsService here would create a DI
 * cycle (ItemsModule imports DataLayerTablesModule).
 */
export function readSearchableLayers(
  data: unknown,
): DataLayerLayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { version?: unknown }).version;
  // Numeric 3 only, matching items.service. See the note on the
  // housekeeping.service copy (2026-08-24 review).
  if (v !== 3) return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  const out: DataLayerLayerShape[] = [];
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const gt = (l as { geometryType?: unknown }).geometryType;
    const geometryType: DataLayerLayerShape['geometryType'] =
      gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
    const rawFields = (l as { fields?: unknown }).fields;
    const fields: NonNullable<DataLayerLayerShape['fields']> = Array.isArray(
      rawFields,
    )
      ? (rawFields as Array<Record<string, unknown>>)
          .map((f) => {
            const name = typeof f.name === 'string' ? f.name : '';
            const type: FeatureFieldType =
              f.type === 'number' ||
              f.type === 'boolean' ||
              f.type === 'date' ||
              f.type === 'multi_select'
                ? f.type
                : 'string';
            return f.searchable === true
              ? { name, type, searchable: true as const }
              : { name, type };
          })
          .filter((f) => f.name.length > 0)
      : [];
    out.push({ id, geometryType, fields });
  }
  return out;
}
