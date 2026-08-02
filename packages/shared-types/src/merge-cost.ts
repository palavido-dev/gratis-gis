// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure math for the point-cloud merge cost model (#205), shared so
 * the panel's pre-upload estimate and the API's enforcement can
 * never disagree: the browser computes with coefficients it fetched
 * from `GET point-cloud/merge-limits`, the API computes with the
 * same function and the same coefficients from its environment.
 *
 * Deliberately model-dumb: download scales with bytes, untwine
 * scales with bytes, a constant per tile for round-trip overhead.
 * Rates are hardware truths, so they live in env on the API side and
 * the worker's MERGE_STATS log line exists to re-derive them per
 * deployment.
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export interface MergeCostCoefficients {
  /** Object-storage-local download throughput, MiB per second. */
  downloadMibPerSec: number;
  /** untwine's end-to-end rate, seconds per GiB of compressed input. */
  untwineSecPerGib: number;
  /** Presign/HEAD/bookkeeping cost per tile, seconds. */
  perTileOverheadSec: number;
  /** Estimates above this are refused outright. */
  ceilingSec: number;
}

export function estimateMergeSeconds(
  totalBytes: number,
  tileCount: number,
  model: MergeCostCoefficients,
): number {
  const downloadSec = totalBytes / MIB / model.downloadMibPerSec;
  const untwineSec = (totalBytes / GIB) * model.untwineSecPerGib;
  const overheadSec = tileCount * model.perTileOverheadSec;
  return Math.ceil(downloadSec + untwineSec + overheadSec);
}

/**
 * Round a duration up to copy a person can plan around. Always
 * hedged ("about", "roughly") and always rounded UP: an estimate
 * that gets beaten feels fine, the reverse is the ArcGIS tile-cache
 * experience this feature exists to avoid.
 */
export function formatRoughDuration(seconds: number): string {
  if (seconds < 90) return 'about a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 55) return `about ${Math.ceil(minutes / 5) * 5} minutes`;
  const halfHours = Math.ceil(seconds / 1800) / 2;
  if (halfHours <= 1) return 'about an hour';
  if (halfHours < 6) return `roughly ${halfHours} hours`;
  return `roughly ${Math.ceil(seconds / 3600)} hours`;
}
