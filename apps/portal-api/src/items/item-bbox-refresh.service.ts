// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { readV3Layers } from '../data-layer/read-v3-layers.js';
import { DataLayerTablesService } from '../data-layer/tables.service.js';
import { itemBbox } from './item-bbox.js';
import {
  envelopeOfGeometries,
  envelopeStrictlyInside,
  envelopesEqual,
  readStoredEnvelope,
  unionEnvelopes,
  type Envelope,
} from './geometry-envelope.js';

/**
 * What a feature write did to geometry, as the write path knows it.
 * Geometries are passed as `unknown` because both the request body
 * and the engine read-back type them loosely; the envelope helper
 * tolerates null and malformed values.
 *
 * - insert: the geometries that were actually written (a deduplicated
 *   retry contributes nothing, so callers filter those out).
 * - update: geometry before and after, position aligned. An
 *   attribute only edit passes the same geometry on both sides and
 *   is recognised as extent neutral without touching the database.
 * - delete: the geometries of the rows that were tombstoned.
 */
export type FeatureWriteNotice =
  | { kind: 'insert'; geometries: ReadonlyArray<unknown> }
  | {
      kind: 'update';
      before: ReadonlyArray<unknown>;
      after: ReadonlyArray<unknown>;
    }
  | { kind: 'delete'; geometries: ReadonlyArray<unknown> };

/**
 * Work owed to one item, accumulated between flushes. Only envelopes
 * are kept, never geometries, so a sustained edit session costs a
 * few numbers of memory per item no matter how many rows it writes.
 */
interface PendingWork {
  /** Union of every envelope written since the last flush. The new
   *  extent is at least `union(stored, grew)`, exactly. */
  grew: Envelope | null;
  /** Union of every envelope removed or moved away from since the
   *  last flush. Only when this reaches an edge of the stored bbox
   *  can the extent have shrunk. */
  removed: Envelope | null;
  /** Somebody asked for the full recompute irrespective of geometry. */
  recompute: boolean;
}

/**
 * Per-item bbox refresh (#85). Pre-engine-pivot, item.bbox was
 * stamped on every `data_json` save and that was enough: features
 * lived inline in the data blob. Post-pivot, feature writes go
 * through the observation log and don't touch data_json, so the
 * cached bbox stays whatever the item had at create time. Effect:
 * a data_layer with 10k features added still reads as bbox=null
 * for the area-filter, which silently filters it (and every map /
 * editor that references it) out of "in this area" search results.
 *
 * This service keeps `item.bbox` current for the written item and
 * walks the forward reference chain (data_layer -> map -> editor) so
 * every item whose bbox is derived from the affected layer picks up
 * the new extent.
 *
 * Two paths, chosen per flush from what the writes actually did:
 *
 * - Arithmetic. An insert can only grow the extent, and by exactly
 *   the envelope of what was inserted, so the new bbox is
 *   `union(stored, envelope(inserted))` and needs no scan. A delete
 *   or geometry change whose old envelope sits strictly inside the
 *   stored bbox cannot have moved any edge either. Both are exact,
 *   not approximations, and both cost one primary key read plus one
 *   update.
 * - Full recompute. Needed when the stored bbox is missing, or when
 *   a removed or moved geometry touched an edge of it, because the
 *   extent may have shrunk and only the observation table knows by
 *   how much. This is the `DISTINCT ON` collapse in
 *   `DataLayerTablesService.aggregateBbox`, which on a large layer
 *   is the most expensive query the write path can trigger.
 *
 * Writes are coalesced per item: the first write after a quiet
 * period flushes immediately, everything else inside the 60 s window
 * merges into the pending envelopes and flushes once when the window
 * closes. Nothing is dropped: the old leading-edge throttle silently
 * lost every write after the first, leaving the bbox stale until the
 * next quiet write or the housekeeping recompute. Each replica keeps
 * its own window, so prod's two replicas write at most twice per
 * item per minute.
 *
 * Fire-and-forget by design: a stamper failure must not break the
 * user's save, so every error is caught and logged, and the daily
 * housekeeping `recompute-extents` pass is the backstop for
 * anything lost to a crash mid window.
 */
@Injectable()
export class ItemBboxRefreshService {
  private static readonly REFRESH_THROTTLE_MS = 60_000;
  private static readonly MAX_REVERSE_HOPS = 2;

  private readonly log = new Logger(ItemBboxRefreshService.name);
  private readonly pending = new Map<string, PendingWork>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastFlushAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLayerTables: DataLayerTablesService,
  ) {}

  /**
   * Record what a feature write did to geometry and schedule the
   * cheapest exact bbox update for it. Synchronous and allocation
   * light on purpose: this runs inline on every feature mutation.
   */
  noteFeatureWrite(itemId: string, notice: FeatureWriteNotice): void {
    let grew: Envelope | null = null;
    let removed: Envelope | null = null;
    switch (notice.kind) {
      case 'insert':
        grew = envelopeOfGeometries(notice.geometries);
        break;
      case 'delete':
        removed = envelopeOfGeometries(notice.geometries);
        break;
      case 'update': {
        const before = envelopeOfGeometries(notice.before);
        const after = envelopeOfGeometries(notice.after);
        // The extent is a function of envelopes only, so a reshape
        // that keeps the same envelope, and every attribute only
        // edit, is extent neutral. Calculate Field on 10k rows lands
        // here and costs nothing.
        if (envelopesEqual(before, after)) return;
        grew = after;
        removed = before;
        break;
      }
    }
    // Rows without geometry (tables, null geometry features) never
    // touch the extent.
    if (grew === null && removed === null) return;
    this.enqueue(itemId, { grew, removed, recompute: false });
  }

  /**
   * Ask for the full recompute of one item and its dependents,
   * subject to the same coalescing window. For callers that changed
   * rows without knowing which geometries they touched.
   */
  refreshItemBbox(itemId: string): void {
    this.enqueue(itemId, { grew: null, removed: null, recompute: true });
  }

  /**
   * Apply whatever is pending for `itemId` right now, cancelling any
   * scheduled flush. Public so tests and shutdown hooks can drain
   * the queue without waiting out the window.
   */
  async flushPending(itemId: string): Promise<void> {
    const timer = this.timers.get(itemId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(itemId);
    }
    // One flush at a time per item. An arithmetic union and a full
    // recompute racing each other on the same replica could otherwise
    // land in either order, and the union would then overwrite the
    // fresher recompute with a stale base.
    const running = this.inFlight.get(itemId);
    if (running !== undefined) await running;

    const work = this.pending.get(itemId);
    if (work === undefined) return;
    this.pending.delete(itemId);
    // Stamped before the async work so writes arriving while it runs
    // start a fresh window instead of flushing on top of it.
    this.lastFlushAt.set(itemId, Date.now());
    const run = this.apply(itemId, work)
      .catch((err: unknown) => {
        this.log.warn(
          `bbox refresh failed for item=${itemId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      })
      .finally(() => {
        if (this.inFlight.get(itemId) === run) this.inFlight.delete(itemId);
      });
    this.inFlight.set(itemId, run);
    await run;
  }

  /** True while a flush is scheduled or work is waiting. */
  hasPending(itemId: string): boolean {
    return this.pending.has(itemId);
  }

  private enqueue(itemId: string, work: PendingWork): void {
    const existing = this.pending.get(itemId);
    if (existing === undefined) {
      this.pending.set(itemId, work);
    } else {
      existing.grew = unionEnvelopes(existing.grew, work.grew);
      existing.removed = unionEnvelopes(existing.removed, work.removed);
      existing.recompute = existing.recompute || work.recompute;
    }
    this.schedule(itemId);
  }

  private schedule(itemId: string): void {
    if (this.timers.has(itemId)) return;
    const last = this.lastFlushAt.get(itemId) ?? 0;
    const wait = last + ItemBboxRefreshService.REFRESH_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      void this.flushPending(itemId);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(itemId);
      void this.flushPending(itemId);
    }, wait);
    // A pending bbox write must not keep a shutting down process (or
    // a jest worker) alive.
    timer.unref();
    this.timers.set(itemId, timer);
  }

  /**
   * Decide between the arithmetic update and the full recompute from
   * the stored bbox and what the window accumulated. The stored bbox
   * is read here, at flush time, not when the writes happened: the
   * "removed envelope strictly inside" test stays exact against
   * either the pre-removal extent or a fresher one another replica
   * already wrote, because an envelope that reached an edge of the
   * old extent cannot lie strictly inside the shrunken one.
   */
  private async apply(itemId: string, work: PendingWork): Promise<void> {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { bbox: true },
    });
    // Item purged between the write and the flush: nothing to stamp.
    if (!row) return;
    const stored = readStoredEnvelope(row.bbox);

    if (work.recompute || stored === null) {
      await this.runRefresh(itemId, null);
      return;
    }
    if (work.removed !== null && !envelopeStrictlyInside(work.removed, stored)) {
      await this.runRefresh(itemId, null);
      return;
    }
    if (work.grew === null) return;
    const next = unionEnvelopes(stored, work.grew)!;
    if (envelopesEqual(next, stored)) return;
    await this.runRefresh(itemId, next);
  }

  /**
   * Stamp the seed and walk reverse deps so maps + editors that
   * reference it pick up the new extent. With `seedBbox` the seed's
   * extent is already known exactly and is written as is; without it
   * the seed is recomputed from the observation table. Dependents are
   * always recomputed, which for maps and editors is a union over
   * referenced items' stored bboxes and never touches the observation
   * table.
   *
   * Breadth first, one `findMany` per level and one reverse reference
   * query per level. data_layer (hop 0) -> map (hop 1) -> editor (hop
   * 2) covers every shipped referencing chain today; deeper paths are
   * caught by the housekeeping cron.
   */
  private async runRefresh(
    seedId: string,
    seedBbox: Envelope | null,
  ): Promise<void> {
    const freshById = new Map<string, Envelope | null>();
    const seen = new Set<string>([seedId]);

    if (seedBbox !== null) {
      await this.prisma.item.update({
        where: { id: seedId },
        data: { bbox: seedBbox },
      });
      freshById.set(seedId, seedBbox);
    } else {
      const seed = await this.prisma.item.findUnique({
        where: { id: seedId },
        select: { id: true, type: true, data: true, bbox: true },
      });
      if (!seed) return;
      await this.recomputeAndStore(seed, freshById);
    }

    let frontier = [seedId];
    for (
      let hop = 1;
      hop <= ItemBboxRefreshService.MAX_REVERSE_HOPS && frontier.length > 0;
      hop++
    ) {
      const referencing = await this.findReferencingItems(frontier);
      const nextIds = referencing.filter((id) => !seen.has(id));
      if (nextIds.length === 0) break;
      for (const id of nextIds) seen.add(id);
      const rows = await this.prisma.item.findMany({
        where: { id: { in: nextIds } },
        select: { id: true, type: true, data: true, bbox: true },
      });
      for (const row of rows) {
        await this.recomputeAndStore(row, freshById);
      }
      frontier = rows.map((r) => r.id);
    }
  }

  private async recomputeAndStore(
    row: { id: string; type: string; data: unknown; bbox: unknown },
    freshById: Map<string, Envelope | null>,
  ): Promise<void> {
    const next = await this.computeBbox(row, freshById);
    freshById.set(row.id, next);
    if (!envelopesEqual(readStoredEnvelope(row.bbox), next)) {
      await this.prisma.item.update({
        where: { id: row.id },
        data: { bbox: next ?? [] },
      });
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
    freshById: Map<string, Envelope | null>,
  ): Promise<Envelope | null> {
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
    freshById: Map<string, Envelope | null>,
  ): Promise<Envelope | null> {
    let out: Envelope | null = null;
    const missing: string[] = [];
    for (const id of refs) {
      if (!freshById.has(id)) {
        missing.push(id);
        continue;
      }
      out = unionEnvelopes(out, freshById.get(id) ?? null);
    }
    if (missing.length > 0) {
      const rows = await this.prisma.item.findMany({
        where: { id: { in: missing }, deletedAt: null },
        select: { bbox: true },
      });
      for (const row of rows) {
        out = unionEnvelopes(out, readStoredEnvelope(row.bbox));
      }
    }
    return out;
  }

  /**
   * Every live item whose bbox is DERIVED from one of `targetIds`,
   * found by JSONB containment in Postgres so only matching ids come
   * back and no unrelated data_json is ever transferred. The
   * predicates are indexed by `item_data_gin` (jsonb_path_ops, made
   * for `@>`), so this is an index probe per shape, not a scan.
   *
   * The shapes are exactly the references `computeBbox` reads back
   * through `collectMapItemRefs` and `collectEditorItemRefs`, plus
   * a derived_layer's source, which the cascade has always visited.
   * The previous implementation matched on `extractDependencies`,
   * which also follows basemaps, boundaries, terrain, custom app
   * widgets and print templates; none of those feed a bbox, so
   * refreshing them recomputed the same value from the same inputs.
   * Matching only bbox bearing references drops that wasted work
   * without changing any stored result.
   *
   * Two spellings on purpose: the `type` column holds the Prisma
   * `@map` kebab form, so raw SQL must say 'web-app' and
   * 'derived-layer' where TypeScript says web_app / derived_layer.
   */
  private async findReferencingItems(targetIds: string[]): Promise<string[]> {
    if (targetIds.length === 0) return [];
    const contains = (shape: unknown): Prisma.Sql =>
      Prisma.sql`data_json @> ${JSON.stringify(shape)}::jsonb`;
    const anyOf = (shapes: unknown[]): Prisma.Sql =>
      Prisma.sql`(${Prisma.join(shapes.map(contains), ' OR ')})`;

    // Map layers: a portal data_layer by itemId, or an ArcGIS REST
    // layer added from a service item by sourceItemId.
    const mapShapes = targetIds.flatMap((id) => [
      { layers: [{ source: { kind: 'data-layer', itemId: id } }] },
      { layers: [{ source: { kind: 'arcgis-rest', sourceItemId: id } }] },
    ]);
    // Editor data, either as the whole blob (legacy `editor` type and
    // the unwrapped web_app tolerance shape) or wrapped under
    // config.editor on a web_app with template 'editor'.
    const editorShapes = targetIds.flatMap((id) => [
      { mapId: id },
      { targets: [{ dataLayerId: id }] },
    ]);
    const wrappedEditorShapes = targetIds.flatMap((id) => [
      { template: 'editor', config: { editor: { mapId: id } } },
      { template: 'editor', config: { editor: { targets: [{ dataLayerId: id }] } } },
    ]);
    const derivedShapes = targetIds.map((id) => ({ source: { itemId: id } }));

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "item"
      WHERE deleted_at IS NULL
        AND (
          (type = 'map'::"ItemType" AND ${anyOf(mapShapes)})
          OR (type IN ('editor'::"ItemType", 'web-app'::"ItemType") AND ${anyOf(editorShapes)})
          OR (type = 'web-app'::"ItemType" AND ${anyOf(wrappedEditorShapes)})
          OR (type = 'derived-layer'::"ItemType" AND ${anyOf(derivedShapes)})
        )
    `);
    return rows.map((r) => r.id);
  }
}

/** Walk a map's data.layers[] and return the underlying portal
 *  item ids the layers reference. Mirrors the helper in
 *  housekeeping.service. The JSONB shapes in `findReferencingItems`
 *  must match what this reads; change both together. */
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
 *  hide editors from the area filter. The JSONB shapes in
 *  `findReferencingItems` must match what this reads; change both
 *  together. */
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
