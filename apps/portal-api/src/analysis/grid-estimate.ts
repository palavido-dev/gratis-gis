// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Env-configured time estimate for chunked point-cloud gridding
 * (#208), the #205 pattern: the single-raster cell cap is gone
 * (the worker grids any extent in bounded-memory chunks), so the
 * honest limit is TIME. Estimate it BEFORE queueing, refuse what
 * cannot finish inside the budget, and hand the user the number so
 * they commit with their eyes open.
 *
 * Every coefficient is env-tunable because the rates are hardware
 * truths. The worker logs a structured GRID_STATS line per gridding
 * pass (cells, chunks, points, grid_secs) so an operator can
 * re-derive them:
 *
 *   GRID_SEC_PER_MILLION_POINTS = grid_secs / (points / 1e6)
 *   GRID_SEC_PER_MILLION_CELLS  ~ downstream gdaldem/COG secs / (cells / 1e6)
 *
 * Defaults are rounded conservative (the Elkins 1.88B-point DTM
 * grid ran ~2 s per million points on the demo box; 4 doubles it):
 * estimates should run long, so a build that finishes early is a
 * pleasant surprise rather than a broken promise.
 */

import { BadRequestException } from '@nestjs/common';
import { formatRoughDuration } from '@gratis-gis/shared-types';

import { envNum } from '../util/env-num.js';

export interface GridCostCoefficients {
  downloadMibPerSec: number;
  secPerMillionPoints: number;
  secPerMillionCells: number;
  perChunkOverheadSec: number;
  /** Per-chunk cell budget; mirror of the worker's GRID_CHUNK_CELLS. */
  chunkCells: number;
  ceilingSec: number;
}

export function gridCostModel(): GridCostCoefficients {
  return {
    downloadMibPerSec: envNum('GRID_DOWNLOAD_MIB_PER_SEC', 60),
    secPerMillionPoints: envNum('GRID_SEC_PER_MILLION_POINTS', 4),
    secPerMillionCells: envNum('GRID_SEC_PER_MILLION_CELLS', 0.5),
    perChunkOverheadSec: envNum('GRID_PER_CHUNK_OVERHEAD_SEC', 5),
    chunkCells: envNum('GRID_CHUNK_CELLS', 64_000_000),
    // A TOTAL job budget, deliberately NOT derived from the
    // worker's ANALYSIS_TIMEOUT_SEC: that wall is per chunk now,
    // and a chunked job legitimately runs many chunks. 3.6h keeps
    // the demo box honest; bigger hardware raises it.
    ceilingSec: envNum('GRID_TIME_CEILING_SEC', 12_960),
  };
}

export interface GridEstimate {
  cells: number;
  chunks: number;
  estimatedSec: number;
  ceilingSec: number;
  overCeiling: boolean;
  humanEstimate: string;
}

export function estimateGrid(
  args: {
    sizeBytes?: number;
    pointCount?: number;
    cells: number;
    /** 1 for a single surface; 2 for height-above-ground (DSM+DTM). */
    gridPasses: number;
  },
  model: GridCostCoefficients = gridCostModel(),
): GridEstimate {
  const sizeBytes = args.sizeBytes ?? 0;
  // Older items may lack a stamped pointCount; approximate from
  // the compressed size at ~6 bytes/point. LAZ really runs 7-10,
  // so the approximation over-counts points and the estimate runs
  // LONG, which is the safe direction for a refusal gate.
  const points = args.pointCount ?? sizeBytes / 6;
  const chunks = Math.max(1, Math.ceil(args.cells / model.chunkCells));
  const estimatedSec = Math.ceil(
    sizeBytes / (1024 * 1024) / model.downloadMibPerSec +
      (args.gridPasses * (points / 1e6)) * model.secPerMillionPoints +
      (args.cells / 1e6) * model.secPerMillionCells +
      chunks * model.perChunkOverheadSec,
  );
  return {
    cells: args.cells,
    chunks,
    estimatedSec,
    ceilingSec: model.ceilingSec,
    overCeiling: estimatedSec > model.ceilingSec,
    humanEstimate: formatRoughDuration(estimatedSec),
  };
}

/**
 * The refusal gate the derive endpoints call where the cell cap
 * used to live. Returns the estimate (for the response payload) or
 * throws a plain-language 400 when the build cannot finish inside
 * the budget. Items without stamped bounds pass through un-estimated,
 * exactly like the old guard skipped them; the worker resolves
 * their extent from the COPC header at run time.
 */
export function assertGridBudget(
  data: {
    bounds?: number[] | null;
    pointCount?: number;
    sizeBytes?: number;
  },
  resolution: number,
  gridPasses: number,
): GridEstimate | null {
  const b = data.bounds;
  if (!Array.isArray(b) || b.length < 5) return null;
  const cellsX = Math.max(1, Math.ceil((Number(b[3]) - Number(b[0])) / resolution));
  const cellsY = Math.max(1, Math.ceil((Number(b[4]) - Number(b[1])) / resolution));
  const estimate = estimateGrid({
    ...(typeof data.sizeBytes === 'number' ? { sizeBytes: data.sizeBytes } : {}),
    ...(typeof data.pointCount === 'number'
      ? { pointCount: data.pointCount }
      : {}),
    cells: cellsX * cellsY,
    gridPasses,
  });
  if (estimate.overCeiling) {
    throw new BadRequestException(
      `Building this at ${resolution}m would take about ` +
        `${estimate.humanEstimate}, beyond what this server allows in ` +
        'one job. Pick a coarser resolution, or raise ' +
        'GRID_TIME_CEILING_SEC if this server can genuinely afford ' +
        'longer builds.',
    );
  }
  return estimate;
}
