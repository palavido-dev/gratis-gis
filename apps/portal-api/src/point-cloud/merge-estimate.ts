// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Env-configured wrapper around the shared merge cost math (#205).
 *
 * The failure mode this exists to prevent is the classic tile-cache
 * one: kick off a huge job, wait hours, die at the timeout with
 * nothing to show. The worker's MERGE_TIMEOUT_SEC is the wall; this
 * estimates the time BEFORE anything is queued, refuses a merge that
 * clearly cannot finish, and gives the user a number so they commit
 * with their eyes open. The math lives in
 * @gratis-gis/shared-types (merge-cost.ts) so the panel's
 * pre-upload preview computes with the exact same formula.
 *
 * Every coefficient is env-tunable because the rates are hardware
 * truths. The worker logs a structured MERGE_STATS line per
 * completed merge (tiles, bytes, download_secs, untwine_secs)
 * exactly so an operator can re-derive them for their own box:
 *
 *   MERGE_UNTWINE_SEC_PER_GIB  = untwine_secs / (in_bytes / GiB)
 *   MERGE_DOWNLOAD_MIB_PER_SEC = in_bytes / MiB / download_secs
 *
 * Defaults are rounded conservative: estimates should run long, so a
 * merge that finishes early is a pleasant surprise rather than a
 * broken promise.
 */

import {
  estimateMergeSeconds,
  formatRoughDuration,
  type MergeCostCoefficients,
} from '@gratis-gis/shared-types';

import { envNum } from '../util/env-num.js';

export function mergeCostModel(): MergeCostCoefficients {
  // Mirror the worker's MERGE_TIMEOUT_SEC default (4h). The ceiling
  // sits at 90% of the wall so an estimate that lands right at the
  // limit is refused rather than gambled.
  const timeoutSec = envNum('MERGE_TIMEOUT_SEC', 14_400);
  return {
    downloadMibPerSec: envNum('MERGE_DOWNLOAD_MIB_PER_SEC', 60),
    untwineSecPerGib: envNum('MERGE_UNTWINE_SEC_PER_GIB', 300),
    perTileOverheadSec: envNum('MERGE_PER_TILE_OVERHEAD_SEC', 2),
    ceilingSec: envNum('MERGE_TIME_CEILING_SEC', Math.round(timeoutSec * 0.9)),
  };
}

export interface MergeEstimate {
  totalBytes: number;
  tileCount: number;
  estimatedSec: number;
  ceilingSec: number;
  /** True when the merge should be refused outright. */
  overCeiling: boolean;
  /** "about 20 minutes" / "roughly 3 hours" for user-facing copy. */
  humanEstimate: string;
}

export function estimateMerge(
  totalBytes: number,
  tileCount: number,
  model: MergeCostCoefficients = mergeCostModel(),
): MergeEstimate {
  const estimatedSec = estimateMergeSeconds(totalBytes, tileCount, model);
  return {
    totalBytes,
    tileCount,
    estimatedSec,
    ceilingSec: model.ceilingSec,
    overCeiling: estimatedSec > model.ceilingSec,
    humanEstimate: formatRoughDuration(estimatedSec),
  };
}
