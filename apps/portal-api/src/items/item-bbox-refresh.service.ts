// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import { itemBbox } from './item-bbox.js';
import { extractDependencies } from './dependency-extractor.js';

/**
 * Per-item bbox refresh (#85). Pre-engine-pivot, item.bbox was
 * stamped on every `data_json` save and that was enough -- features
 * lived inline in the data blob. Post-pivot, feature writes go
 * through the observation log and don't touch data_json, so the
 * cached bbox stays whatever the item had at create time. Effect:
 * a data_layer with 10k features added still reads as bbox=null
 * for the area-filter, which silently filters it (and every map /
 * editor that references it) out of "in this area" search results.
 *
 * This service computes a fresh bbox for one item and walks the
 * forward reference chain (data_layer -> map -> editor) so every
 * item that depends on the affected layer also picks up the new
 * extent. Throttled per-item so a busy field-app sync flush doesn't
 * write the bbox row on every observation -- 60s is enough to
 * coalesce a feature-by-feature flush of a thousand rows into a
 * single update.
 *
 * Designed to be called fire-and-forget from the engine write path:
 * a stamper failure must not break the user's save, so all errors
 * are caught + logged.
 */
@Injectable()
export class ItemBboxRefreshService {
  private static readonly REFRESH_THROTTLE_MS = 60_000;
  private static readonly MAX_REVERSE_HOPS = 2;

  private readonly log = new Logger(ItemBboxRefreshService.name);
  private readonly throttle = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLayerTables: DataLayerTablesService,
  ) {}

  /**
   * Refresh `item.bbox` for the given id and walk reverse deps so
   * maps + editors that reference it pick up the new extent. Skips
   * the actual work when the same id was refreshed within the
   * throttle window. Returns the new bbox (or null) so callers can
   * log when useful; `null` is also returned when the call is
   * throttled, so callers shouldn't infer "item has no bbox" from
   * a null return value.
   */
  async refreshItemBbox(
    itemId: string,
  ): Promise<[number, number, number, number] | null> {
    const last = this.throttle.get(itemId) ?? 0;
    const now = Date.now();
    if (now - last < ItemBboxRefreshService.REFRESH_THROTTLE_MS) {
      return null;
    }
    this.throttle.set(itemId, now);

    try {
      const freshById = new Map<
        string,
        [number, number, number, number] | null
      >();
      const seen = new Set<string>();
      // Queue entries are { id, hop } so we can stop the reverse-dep
      // walk at MAX_REVERSE_HOPS hops away from the seed. data_layer
      // (hop 0) -> map (hop 1) -> editor (hop 2) covers every shipped
      // referencing chain today; deeper paths are caught by the cron.
      const queue: Array<{ id: string; hop: number }> = [
        { id: itemId, hop: 0 },
      ];
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const it = await this.prisma.item.findUnique({
          where: { id: entry.id },
          select: { id: true, type: true, data: true, bbox: true },
        });
        if (!it) continue;

        const next = await this.computeBbox(it, freshById);
        freshById.set(it.id, next);

        if (!bboxEqual(it.bbox as number[] | null | undefined, next)) {
          await this.prisma.item.update({
            where: { id: it.id },
            data: { bbox: next ?? [] },
          });
        }

        if (entry.hop < ItemBboxRefreshService.MAX_REVERSE_HOPS) {
          const reverseRefs = await this.findReferencingItems(it.id);
          for (const r of reverseRefs) {
            if (!seen.has(r)) queue.push({ id: r, hop: entry.hop + 1 });
          }
        }
      }
      return freshById.get(itemId) ?? null;
    } catch (err) {
      this.log.warn(
        `refreshItemBbox failed for item=${itemId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
  }

  /**
   * Compute the new bbox for one item using the same per-type rules
   * as the org-wide `recomputeExtents` pass:
   *   - data_layer: aggregate ST_Extent across the engine's current
   *     observation projection (the actual feature footprint, not
   *     whatever was in data_json at create time)
   *   - map: union of referenced data_layer / arcgis_service items'
   *     bboxes (from freshById when available, else from the DB row)
   *   - editor / web_app+template=editor: union of the referenced
   *     map's bbox + each target's data_layer bbox
   *   - everything else: itemBbox(type, data) (stays sync, reads
   *     data_json directly)
   */
  private async computeBbox(
    it: { id: string; type: string; data: unknown },
    freshById: Map<string, [number, number, number, number] | null>,
  ): Promise<[number, number, number, number] | null> {
    if (it.type === 'data_layer') {
      const layers = readV3Layers(it.data);
      if (layers !== null) {
        const fromEngine = await this.dataLayerTables.aggregateBbox(
          it.id,
          layers,
        );
        if (fromEngine) return fromEngine;
      }
      return itemBbox(it.type as never, it.data);
    }
    if (it.type === 'map') {
      const refs = collectMapItemRefs(it.data);
      if (refs.length > 0) {
        const aggregated = await this.aggregateFromReferenced(
          refs,
          freshById,
        );
        if (aggregated) return aggregated;
      }
      return itemBbox(it.type as never, it.data);
    }
    if (it.type === 'editor' || it.type === 'web_app') {
      const refs = collectEditorItemRefs(it.data);
      if (refs.length > 0) {
        const aggregated = await this.aggregateFromReferenced(
          refs,
          freshById,
        );
        if (aggregated) return aggregated;
      }
      return null;
    }
    return itemBbox(it.type as never, it.data);
  }

  /**
   * Aggregate bboxes from a list of referenced item ids. Reads from
   * the in-memory freshById cache when present, falls back to the
   * DB row when the reference points at an item we haven't yet
   * recomputed in this pass.
   */
  private async aggregateFromReferenced(
    refs: string[],
    freshById: Map<string, [number, number, number, number] | null>,
  ): Promise<[number, number, number, number] | null> {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    let any = false;
    const missing: string[] = [];
    for (const id of refs) {
      const cached = freshById.has(id) ? freshById.get(id) : undefined;
      if (cached === undefined) {
        missing.push(id);
        continue;
      }
      if (!cached) continue;
      w = Math.min(w, cached[0]);
      s = Math.min(s, cached[1]);
      e = Math.max(e, cached[2]);
      n = Math.max(n, cached[3]);
      any = true;
    }
    if (missing.length > 0) {
      const rows = await this.prisma.item.findMany({
        where: { id: { in: missing }, deletedAt: null },
        select: { bbox: true },
      });
      for (const row of rows) {
        const b = row.bbox as number[] | null;
        if (Array.isArray(b) && b.length === 4) {
          w = Math.min(w, b[0]!);
          s = Math.min(s, b[1]!);
          e = Math.max(e, b[2]!);
          n = Math.max(n, b[3]!);
          any = true;
        }
      }
    }
    return any ? [w, s, e, n] : null;
  }

  /**
   * Find every item that forward-references the given id. Used to
   * walk reverse-dep chains during refresh. Limited to the spatial
   * referencer types because non-spatial items (folders, pick lists)
   * don't carry a bbox and don't need refreshing.
   */
  private async findReferencingItems(targetId: string): Promise<string[]> {
    const candidates = await this.prisma.item.findMany({
      where: {
        type: { in: ['map', 'editor', 'web_app', 'derived_layer'] },
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        data: true,
        publicGeoBoundaryId: true,
        orgGeoBoundaryId: true,
      },
    });
    const out: string[] = [];
    for (const c of candidates) {
      const deps = extractDependencies(c);
      if (deps.itemIds.includes(targetId)) out.push(c.id);
    }
    return out;
  }
}

function bboxEqual(
  a: number[] | null | undefined,
  b: [number, number, number, number] | null,
): boolean {
  if (!b) return !a || a.length === 0;
  if (!a || a.length !== 4) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Local copy of the helper from items.service so this module
 *  doesn't have to depend on the full ItemsService. Mirrors the
 *  v3 multi-layer schema accessor. */
function readV3Layers(data: unknown): DataLayerLayerShape[] | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as { version?: unknown }).version;
  if (v !== 3) return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  const out: DataLayerLayerShape[] = [];
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    // Same filters as every other copy of this helper. This one had
    // drifted: it accepted empty-string ids and cast unknown
    // geometry types straight through, both invisible to typecheck
    // because the output is already the typed shape (2026-08-24
    // review).
    if (typeof id !== 'string' || id.length === 0) continue;
    const gt = (l as { geometryType?: unknown }).geometryType;
    const geometryType: DataLayerLayerShape['geometryType'] =
      gt === 'point' || gt === 'line' || gt === 'polygon' ? gt : null;
    out.push({ id, geometryType });
  }
  return out;
}

/** Walk a map's data.layers[] and return the underlying portal
 *  item ids the layers reference. Mirrors the helper in
 *  housekeeping.service. */
function collectMapItemRefs(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return [];
  const out = new Set<string>();
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const src = (l as { source?: unknown }).source;
    if (!src || typeof src !== 'object') continue;
    const kind = (src as { kind?: unknown }).kind;
    if (kind === 'data-layer') {
      const id = (src as { itemId?: unknown }).itemId;
      if (typeof id === 'string') out.add(id);
    } else if (kind === 'arcgis-rest') {
      const id = (src as { sourceItemId?: unknown }).sourceItemId;
      if (typeof id === 'string') out.add(id);
    }
  }
  return Array.from(out);
}

/** Walk an editor (legacy `editor` or migrated `web_app`+template)
 *  data and return the runtime map id + each target's data_layer
 *  id. Both shapes are supported so an in-flight migration doesn't
 *  hide editors from the area filter. */
function collectEditorItemRefs(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const out = new Set<string>();
  let editor: Record<string, unknown> | null = null;
  const top = data as Record<string, unknown>;
  if (typeof top.mapId === 'string' || Array.isArray(top.targets)) {
    editor = top;
  } else if (
    top.template === 'editor' &&
    top.config &&
    typeof top.config === 'object'
  ) {
    const cfg = top.config as Record<string, unknown>;
    if (cfg.editor && typeof cfg.editor === 'object') {
      editor = cfg.editor as Record<string, unknown>;
    }
  }
  if (!editor) return [];
  const mapRef = editor.mapId;
  if (typeof mapRef === 'string' && mapRef.length > 0) out.add(mapRef);
  const targets = editor.targets;
  if (Array.isArray(targets)) {
    for (const t of targets) {
      if (!t || typeof t !== 'object') continue;
      const dl = (t as { dataLayerId?: unknown }).dataLayerId;
      if (typeof dl === 'string' && dl.length > 0) out.add(dl);
    }
  }
  return Array.from(out);
}
