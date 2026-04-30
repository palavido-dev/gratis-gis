import { Injectable, Logger } from '@nestjs/common';
import type { Item, Prisma } from '@prisma/client';
import {
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  type BufferParams,
  type DerivedLayerData,
  type LengthUnit,
  type ToolStep,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { padBboxByMeters } from './derived-layers.service.js';
import { getGeneratorForStep } from './tools/registry.js';

/**
 * Lazy-grow cache refresher for derived-layer recipes.
 *
 * The buffer tool's `field` mode caches the source's MAX(field) at
 * recipe-save time and trusts that cap thereafter. Inserting or
 * updating a row whose value exceeds the cap silently makes the
 * cached cap stale: the read path keeps returning rows but the bbox
 * pad is too small, so buffer halos near tile edges clip until the
 * derived layer is re-saved.
 *
 * `notifySourceWrite` is the cure: feature write paths call it after
 * a successful insert / update with the new properties payload, and
 * it walks every derived_layer that depends on the source AND
 * buffers on a key in the payload, comparing the row's value (in
 * meters) to the cached cap. When the row's value exceeds the cap,
 * the recipe's `cachedMaxMeters` and the derived layer's `bbox` are
 * recomputed and persisted.
 *
 * Three deliberate properties:
 * - **Grow only.** The hook never shrinks the cap. Over-padding is
 *   correctness-safe; under-padding produces clipped halos. A row
 *   write that lowers a value, or a delete that removes the global
 *   max, is therefore a no-op here. The cap stays slightly inflated
 *   until the derived layer is re-saved (full enrich runs MAX again).
 * - **Best-effort.** Errors are logged but not thrown. A staleness
 *   miss does not justify rolling back a successful feature write.
 * - **Narrow query.** Only buffer steps in `field` mode whose `field`
 *   key appears in the payload trigger a write. Recipes that use
 *   fixed-mode buffer (or any unrelated tool, once more land) are
 *   ignored without any further computation.
 */
@Injectable()
export class DerivedLayerCacheRefreshService {
  private readonly log = new Logger(DerivedLayerCacheRefreshService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Notify dependents that the source layer's rows have just been
   * written. `properties` is the array of full property maps that
   * were just persisted (not partial patches): for an UPDATE the
   * caller is responsible for merging the patch into the prior row
   * before passing it through, since field-mode buffer reads from
   * the absolute key, not the delta. `layerKey` is the v3 sublayer
   * the writes belong to, or `null` for v2 single-table sources.
   *
   * Returns when the refresh is complete. The caller should NOT
   * await the result on the hot path of a feature write; fire it
   * after the user-visible response is sent so a slow refresh
   * cannot delay the write's HTTP response. Inside this service
   * the work is one Postgres findMany + at most one update per
   * dependent, so the latency is small in practice.
   */
  async notifySourceWrite(
    sourceItemId: string,
    layerKey: string | null,
    properties: ReadonlyArray<Record<string, unknown> | undefined>,
  ): Promise<void> {
    if (properties.length === 0) return;
    try {
      const dependents = await this.findDependents(sourceItemId, layerKey);
      if (dependents.length === 0) return;
      // Source bbox is needed if we end up updating any dependent
      // (so we can repad). Loaded once and shared across all
      // matching dependents.
      let sourceBbox: number[] | null = null;
      for (const item of dependents) {
        const data = item.data as unknown as DerivedLayerData | null;
        if (!data || data.version !== 1) continue;
        const next = growCachedCaps(data, properties);
        if (!next) continue; // No buffer step in this recipe needed updating.
        // Recompute the bbox lazily (only when at least one cap grew).
        if (sourceBbox === null) {
          sourceBbox = await this.readSourceBbox(sourceItemId);
        }
        const totalReach = totalOutwardReach(next.pipeline);
        next.bbox = padBboxByMeters(sourceBbox ?? [], totalReach);
        await this.prisma.item.update({
          where: { id: item.id },
          data: {
            // Prisma's input shape rejects raw JsonValue (which
            // includes JS `null`) and wants Prisma.InputJsonValue,
            // so cast through unknown. The recipe is always a
            // populated object in this code path; never null.
            data: next as unknown as Prisma.InputJsonValue,
            bbox: next.bbox,
          },
        });
      }
    } catch (err) {
      // Log and swallow. A cache miss is correctness-safe; a thrown
      // error here would roll back the feature write that called us.
      this.log.warn(
        `cache refresh failed for source ${sourceItemId}${layerKey ? `/${layerKey}` : ''}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Pull every derived_layer that points at the source. Filters in
   * memory rather than via a JSON-path Prisma `where`, since the
   * dependent set is small (one row per derived layer in any org)
   * and the JSON-path predicate is awkward to write portably.
   *
   * For v3 sources the layerKey must match too: a write to a
   * sublayer `A` shouldn't refresh derived layers that read from
   * sublayer `B` of the same source item.
   */
  private async findDependents(
    sourceItemId: string,
    layerKey: string | null,
  ): Promise<Array<{ id: string; data: Item['data'] }>> {
    const rows = await this.prisma.item.findMany({
      where: {
        type: 'derived_layer',
        deletedAt: null,
      },
      select: { id: true, data: true },
    });
    return rows.filter((r) => {
      const d = r.data as unknown as DerivedLayerData | null;
      if (!d || !d.source || d.source.itemId !== sourceItemId) return false;
      const dependentLayerKey = d.source.layerKey ?? null;
      return dependentLayerKey === layerKey;
    });
  }

  /**
   * Read just the source's bbox column. Pulled into a method so the
   * notify path can avoid loading the full source row (the
   * cache-refresh write doesn't need the source's data blob, only
   * its spatial extent).
   */
  private async readSourceBbox(sourceItemId: string): Promise<number[]> {
    const src = await this.prisma.item.findUnique({
      where: { id: sourceItemId },
      select: { bbox: true },
    });
    return Array.isArray(src?.bbox) ? (src!.bbox as number[]) : [];
  }
}

/**
 * Walk a recipe's pipeline and grow any field-mode buffer caps that
 * are smaller than the largest relevant value found in `properties`.
 * Returns a cloned recipe when at least one cap grew, or `null` when
 * nothing needed updating (the most common case). Pure: no IO, no
 * Prisma access, easy to test.
 *
 * Exported for unit tests; production callers should go through the
 * service so write batching, dependent lookup, and bbox repadding
 * stay in one place.
 */
export function growCachedCaps(
  data: DerivedLayerData,
  properties: ReadonlyArray<Record<string, unknown> | undefined>,
): DerivedLayerData | null {
  let mutated = false;
  const nextPipeline: ToolStep[] = data.pipeline.map((step) => {
    if (step.tool !== 'buffer') return step;
    const params = step.params;
    if (params.mode !== 'field') return step;
    const candidate = largestRelevantValueMeters(
      params.field,
      params.unit,
      properties,
    );
    if (candidate <= params.cachedMaxMeters) return step;
    mutated = true;
    const grown: BufferParams = {
      mode: 'field',
      field: params.field,
      unit: params.unit,
      cachedMaxMeters: Math.min(candidate, MAX_BUFFER_DISTANCE_METERS),
    };
    return { tool: 'buffer', params: grown };
  });
  if (!mutated) return null;
  return { ...data, pipeline: nextPipeline };
}

/**
 * Walk the new properties payloads and find the largest numeric
 * value at `field`, converted to meters via `unit`. Skips entries
 * where the field is missing, null, or not coercible to a positive
 * number, so a row that doesn't carry the buffer field at all is a
 * no-op for that recipe. Returns 0 when no payload had a usable
 * value, which the caller compares against the cached cap (always
 * >= 0) and ignores.
 */
function largestRelevantValueMeters(
  field: string,
  unit: LengthUnit,
  properties: ReadonlyArray<Record<string, unknown> | undefined>,
): number {
  const factor = METERS_PER_UNIT[unit];
  let best = 0;
  for (const p of properties) {
    if (!p || !Object.prototype.hasOwnProperty.call(p, field)) continue;
    const raw = p[field];
    const numeric =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    const meters = numeric * factor;
    if (meters > best) best = meters;
  }
  return best;
}

/**
 * Sum each step's outward reach (meters) using the registered
 * generators. Mirrors what `validateAndEnrich` does at recipe save
 * time so the bbox repad here matches the bbox a fresh save would
 * produce. Generators run in pure mode (no DB, no IO).
 */
function totalOutwardReach(pipeline: ToolStep[]): number {
  let total = 0;
  for (const step of pipeline) {
    const generator = getGeneratorForStep(step);
    total += generator.outwardReachMeters(generator.validate(step.params));
  }
  return total;
}
