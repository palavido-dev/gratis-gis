// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * TypeScript counterpart of `stamp_target_failed` in
 * tools/pointcloud-worker/runner.py (the failed-husk fix): when an
 * analysis job dies without its worker, the item that was
 * pre-created for its output must not stay a stateless husk behind
 * an eternal spinner. Both sides write the same patch, a jsonb
 * merge of processingState 'failed' plus a plain-language
 * processingError, so concurrent API writes to the item survive.
 * Keep the two implementations in sync.
 *
 * This one exists for the paths the python worker cannot cover
 * because it is not running: a queued job cancelled before any
 * worker claimed it, and the reclaim sweep failing a job whose
 * worker stopped beating.
 *
 * Kind coverage mirrors the python side, with one addition:
 *   - raster kinds own a tile_layer stub only the worker fills in;
 *   - copc-build's "target" is the point_cloud item itself, left in
 *     processingState 'building' while a merge runs (the python
 *     handler stamps it in its own except path, but a dead worker
 *     has no except path, so the API side must cover it too);
 *   - contours' data_layer is settled by the analysis bridge and
 *     carries no processingState, and sam-embed has no target item,
 *     so both are skipped, matching the worker's failure behavior.
 */
const RASTER_TARGET_KINDS = new Set([
  'hillshade',
  'elevation',
  'viewshed',
  'steepness',
  'heightmap',
]);

export interface AnalysisTargetRef {
  kind: string;
  targetItemId: string | null;
  sourceItemId: string;
}

export async function stampAnalysisTargetFailed(
  prisma: PrismaService,
  job: AnalysisTargetRef,
  message: string,
): Promise<void> {
  let itemId: string | null = null;
  if (RASTER_TARGET_KINDS.has(job.kind)) {
    itemId = job.targetItemId;
  } else if (job.kind === 'copc-build' || job.kind === 'imagery-mosaic') {
    // Same shape as copc-build: enqueueMosaic sets the tile_layer item
    // to processingState 'building', and a dead worker has no except
    // path, so without this the item stays 'building' forever after a
    // reclaim fails the job.
    itemId = job.targetItemId ?? job.sourceItemId;
  }
  if (!itemId) return;
  // Same 400-char cap as the python stamp: processingError is user
  // copy on the item page, not a log sink.
  const patch = JSON.stringify({
    processingState: 'failed',
    processingError: message.slice(0, 400),
  });
  try {
    await prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = "data_json" || ${patch}::jsonb,
          "updated_at" = now()
      WHERE "id" = ${itemId}::uuid
    `;
  } catch {
    // Best effort: the job row already carries the authoritative
    // error, so losing the item-page hint must not fail the caller
    // (which may be mid-sweep over other rows).
  }
}
