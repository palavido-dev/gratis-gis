// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Layer-level read helpers for v3 (multi-layer) data_layer items.
 *
 * Pre-Phase-2.2 this also owned the per-layer `fs_<itemId>_<layerId>`
 * tables (CREATE / DROP / TRUNCATE / column ALTERs). After Phase 2.2
 * the engine substrate took over both writes and reads via the
 * observation log; Phase 2.4 cut the remaining read paths over (bbox
 * aggregate, last-activity timestamp, replace-mode wipe) and Phase
 * 2.5 (this commit) drops the DDL surface entirely. New data_layer
 * items no longer create per-layer tables.
 *
 * The few legacy fs_ tables that already exist in prod are still
 * present; Phase 2.6 will rename this module to `data-layer`, drop
 * the orphans via migration, and retire the V3-prefixed names.
 */

export interface DataLayerLayerShape {
  id: string;
  geometryType: 'point' | 'line' | 'polygon' | null;
  fields?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
    /**
     * Drives two things. (1) Which fields the search UI offers,
     * as always. (2) Which per-field partial trigram indexes
     * DataLayerSearchIndexService (search-index.service.ts)
     * maintains on the observation table: one
     * gin((attrs->>'<field>') gin_trgm_ops) WHERE scope = '<scope>'
     * per searchable field, mirroring the geocoder's rebuildIndexes
     * pattern, built/dropped by the admin housekeeping "Build
     * search indexes" action (schema saves are pure metadata since
     * Phase 2.5, so index reconcile is not inline with the save).
     * The whole-blob trigram index that briefly existed
     * (observation_attrs_trgm) was dropped by migration
     * 20260618120000 as redundant and operationally harmful; never
     * re-add it.
     */
    searchable?: boolean;
  }>;
  parentFkColumn?: string | undefined;
}

@Injectable()
export class DataLayerTablesService {
  private readonly log = new Logger(DataLayerTablesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate the feature-extent of every spatial layer in a v3
   * data_layer into a single [w,s,e,n] envelope (#90). Non-spatial
   * sublayers (geometryType === null) carry no geometry and are
   * skipped. Returns null when no layer in the set yields a usable
   * extent: the caller stores that as `bbox = []` so the area
   * filter correctly excludes the item from "what's in this area?"
   * results until features land.
   */
  async aggregateBbox(
    itemId: string,
    layers: DataLayerLayerShape[],
  ): Promise<[number, number, number, number] | null> {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    let any = false;
    for (const layer of layers) {
      if (layer.geometryType === null) continue;
      const scope = `data_layer:${itemId}:${layer.id}`;
      try {
        // Phase 2.4: aggregate over the engine's current-truth
        // projection (latest observation per entity, not deleted)
        // instead of the legacy fs_ table. After Phase 2.2 stopped
        // populating fs_ tables, the old query returned stale data.
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{
            minx: number | null;
            miny: number | null;
            maxx: number | null;
            maxy: number | null;
          }>
        >(
          `SELECT
             ST_XMin(ST_Extent(geom))::float8 AS minx,
             ST_YMin(ST_Extent(geom))::float8 AS miny,
             ST_XMax(ST_Extent(geom))::float8 AS maxx,
             ST_YMax(ST_Extent(geom))::float8 AS maxy
           FROM (
             SELECT DISTINCT ON (entity) entity, geom, kind
             FROM observation
             WHERE scope = $1
               AND valid_to IS NULL
             ORDER BY entity, valid_from DESC, tx_time DESC
           ) latest
           WHERE kind <> 'delete' AND geom IS NOT NULL`,
          scope,
        );
        const r = rows[0];
        if (
          r?.minx != null &&
          r.miny != null &&
          r.maxx != null &&
          r.maxy != null
        ) {
          w = Math.min(w, r.minx);
          s = Math.min(s, r.miny);
          e = Math.max(e, r.maxx);
          n = Math.max(n, r.maxy);
          any = true;
        }
      } catch (err) {
        this.log.debug(
          `aggregateBbox: could not read scope ${scope}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    return any ? [w, s, e, n] : null;
  }

  /**
   * Most recent feature-level activity across every layer in a v3
   * data_layer (#95). Used by the housekeeping stale-item heuristic
   * so a data_layer with active feature edits doesn't look "stale"
   * just because nobody changed the item card.
   */
  async lastDataActivityAt(
    itemId: string,
    layers: DataLayerLayerShape[],
  ): Promise<Date | null> {
    let max: Date | null = null;
    for (const layer of layers) {
      const scope = `data_layer:${itemId}:${layer.id}`;
      try {
        // Phase 2.4: latest tx_time over every observation in the
        // scope. Each create/update/delete writes a new row, so
        // MAX(tx_time) == "most recent activity at the feature
        // level," which is exactly what the housekeeping
        // stale-item heuristic needs.
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{ ts: Date | null }>
        >(
          `SELECT MAX(tx_time) AS ts FROM observation WHERE scope = $1`,
          scope,
        );
        const ts = rows[0]?.ts;
        if (ts && (!max || ts > max)) {
          max = ts;
        }
      } catch {
        // No observations for this scope yet -- treat as no
        // activity. Genuinely a "never populated" signal.
      }
    }
    return max;
  }

  /**
   * Empty a layer's data without dropping the data_layer item itself
   * (#244). Replace-mode ingest contract: "this is the data now,
   * forget what was there before." Phase 2.4 rewires this onto the
   * engine: every observation in the scope is removed, including
   * history. The append-only log alternative (write a tombstone per
   * entity) preserves history but isn't what replace-ingest asked
   * for and would balloon the log on full-file refreshes.
   *
   * Caveat: this DELETE commits in its own transaction. The async
   * import worker no longer calls it for replace mode; it runs the
   * scoped delete through CopyWriter.deleteScope INSIDE the COPY
   * transaction, so a failed or cancelled replace rolls back to the
   * pre-import rows instead of an empty layer. The synchronous
   * ingest controller still uses this method and carries that
   * empty-on-failure caveat.
   */
  async truncateLayer(itemId: string, layerId: string): Promise<void> {
    const scope = `data_layer:${itemId}:${layerId}`;
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM observation WHERE scope = $1`,
      scope,
    );
    this.log.log(`Wiped engine scope ${scope} (replace ingest)`);
  }

  /**
   * Return the count of currently-live entities in a layer scope
   * (one row per entity, latest observation, tombstones excluded).
   * Replaces the pre-Phase-2.5 `SELECT COUNT(*) FROM "fs_..."` the
   * ingest controller used to capture a "before-replace" row count
   * for the response. Best-effort: failures swallow to zero so a
   * count error never blocks a successful ingest.
   */
  /**
   * Recompute and persist `featureCount` on every layer of a v3
   * data_layer's `data.layers[]`. The count is what lets clients
   * pick a sensible default rendering (the QGIS plugin opens layers
   * at or under a threshold as true feature layers and keeps the
   * huge ones on tiles), so it has to exist and stay fresh, not
   * just be stamped once at ingest. Called from the import worker
   * after a successful job and from the housekeeping extent
   * recompute, which doubles as the backfill for items created
   * before the field was maintained. Returns true when a write
   * happened. Best-effort like the other read helpers: a failure
   * here must never fail the operation that triggered it.
   */
  async stampFeatureCounts(itemId: string): Promise<boolean> {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    const data = row?.data as
      | { version?: number; layers?: Array<Record<string, unknown>> }
      | null;
    if (!data || data.version !== 3 || !Array.isArray(data.layers)) {
      return false;
    }
    let changed = false;
    const nextLayers: Array<Record<string, unknown>> = [];
    for (const layer of data.layers) {
      const layerId = (layer as { id?: unknown }).id;
      if (typeof layerId !== 'string' || layerId === '') {
        nextLayers.push(layer);
        continue;
      }
      const count = await this.countLiveEntities(itemId, layerId);
      if (layer.featureCount === count) {
        nextLayers.push(layer);
        continue;
      }
      nextLayers.push({ ...layer, featureCount: count });
      changed = true;
    }
    if (!changed) return false;
    await this.prisma.item.update({
      where: { id: itemId },
      data: {
        data: { ...(data as object), layers: nextLayers } as never,
      },
    });
    return true;
  }

  async countLiveEntities(
    itemId: string,
    layerId: string,
  ): Promise<number> {
    const scope = `data_layer:${itemId}:${layerId}`;
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        `SELECT COUNT(*)::bigint AS count
         FROM (
           SELECT DISTINCT ON (entity) entity, kind
           FROM observation
           WHERE scope = $1
             AND valid_to IS NULL
           ORDER BY entity, valid_from DESC, tx_time DESC
         ) latest
         WHERE kind <> 'delete'`,
        scope,
      );
      return Number(rows?.[0]?.count ?? 0n);
    } catch (err) {
      this.log.debug(
        `countLiveEntities: scope ${scope}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return 0;
    }
  }
}
