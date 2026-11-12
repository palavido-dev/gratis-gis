// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import type { FeatureFieldType } from '@gratis-gis/shared-types';

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
    /**
     * The full FeatureFieldType, not a subset. This used to omit
     * multi_select, and the two readV3Layers copies that parse
     * fields coerced anything unrecognised to 'string', so a
     * searchable multi_select got a text trigram index built over a
     * JSONB array. Keep in step with shared-types.
     */
    type: FeatureFieldType;
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
   * results until features land. A failed read throws: answering
   * null would make the caller store an empty extent for a layer
   * that has features, which drops it out of area search.
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
             ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
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
        this.log.warn(
          `aggregateBbox: could not read scope ${scope}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        throw err;
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
    // Count outside any lock: it can be slow on a big layer.
    const counts = new Map<string, number>();
    for (const layer of data.layers) {
      const layerId = (layer as { id?: unknown }).id;
      if (typeof layerId !== 'string' || layerId === '') continue;
      // A failed count is left out, so the layer keeps its last known
      // featureCount. Writing 0 would tell the QGIS plugin a huge
      // layer is empty and safe to download whole.
      const count = await this.readLiveCount(itemId, layerId);
      if (count !== null) counts.set(layerId, count);
    }
    if (counts.size === 0) return false;
    // Then write only featureCount, against the row as it is now and
    // under the same row lock commitLayerSync takes. Writing back the
    // `data` read above would put a stale syncVersion back if an edit
    // committed while we counted, and the cursor would go backwards.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ data: unknown }>>`
        SELECT data_json AS data FROM item WHERE id = ${itemId}::uuid FOR UPDATE
      `;
      const current = locked[0]?.data as
        | { version?: number; layers?: Array<Record<string, unknown>> }
        | null
        | undefined;
      if (!current || current.version !== 3 || !Array.isArray(current.layers)) {
        return false;
      }
      let changed = false;
      const nextLayers = current.layers.map((layer) => {
        const layerId = (layer as { id?: unknown }).id;
        if (typeof layerId !== 'string' || !counts.has(layerId)) return layer;
        const count = counts.get(layerId);
        if (layer.featureCount === count) return layer;
        changed = true;
        return { ...layer, featureCount: count };
      });
      if (!changed) return false;
      await tx.item.update({
        where: { id: itemId },
        data: {
          data: { ...(current as object), layers: nextLayers } as never,
        },
      });
      return true;
    });
  }

  async countLiveEntities(
    itemId: string,
    layerId: string,
  ): Promise<number> {
    return (await this.readLiveCount(itemId, layerId)) ?? 0;
  }

  /** Live entity count, or null when the count query failed. */
  private async readLiveCount(
    itemId: string,
    layerId: string,
  ): Promise<number | null> {
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
           ORDER BY entity, valid_from DESC, tx_time DESC, id DESC
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
      return null;
    }
  }
}
