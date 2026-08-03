// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Imagery-mosaic source validation + cost model (#199). Pure
 * functions, mirrors the point-cloud merge's #205 shape: estimate
 * BEFORE queueing, refuse what cannot finish inside the worker's
 * wall, and keep the math in shared-types so the client preview
 * computes with the same formula.
 *
 * Every coefficient is env-tunable because the rates are hardware
 * truths. The worker logs a structured MOSAIC_STATS line per
 * completed build (tiles, bytes, download_secs, gdal_secs) so an
 * operator can re-derive them for their own box:
 *
 *   MOSAIC_GDAL_SEC_PER_GIB    = gdal_secs / (in_bytes / GiB)
 *   MOSAIC_DOWNLOAD_MIB_PER_SEC = in_bytes / MiB / download_secs
 *
 * Defaults are rounded conservative: estimates should run long, so
 * a build that finishes early is a pleasant surprise rather than a
 * broken promise.
 */

import { BadRequestException } from '@nestjs/common';
import {
  estimateMergeSeconds,
  formatRoughDuration,
  type ISODateString,
  type MergeCostCoefficients,
  type TileLayerSource,
} from '@gratis-gis/shared-types';

import { envNum } from '../util/env-num.js';

/** Same batch cap as the point-cloud merge; beyond this the right
 *  answer is separate mosaics, not one heroic job. */
export const MOSAIC_MAX_SOURCES = 500;

/** Storage-key prefix every client-supplied source must sit under
 *  (the body is client-supplied; an unpinned key would let the
 *  worker read arbitrary MinIO objects with its credentials). */
export const MOSAIC_SOURCE_PREFIX = 'item-tile-layer/';

export function mosaicCostModel(): MergeCostCoefficients {
  // Mirror the worker's MOSAIC_TIMEOUT_SEC default (4h); ceiling at
  // 90% of the wall so a borderline estimate is refused, not
  // gambled.
  const timeoutSec = envNum('MOSAIC_TIMEOUT_SEC', 14_400);
  return {
    downloadMibPerSec: envNum('MOSAIC_DOWNLOAD_MIB_PER_SEC', 60),
    // Covers the whole GDAL half: per-source warp to 3857 plus the
    // VRT->COG encode with overviews. Conservative for JPEG COGs,
    // roughly right for DEFLATE.
    untwineSecPerGib: envNum('MOSAIC_GDAL_SEC_PER_GIB', 180),
    perTileOverheadSec: envNum('MOSAIC_PER_TILE_OVERHEAD_SEC', 2),
    ceilingSec: envNum(
      'MOSAIC_TIME_CEILING_SEC',
      Math.round(timeoutSec * 0.9),
    ),
  };
}

export interface MosaicEstimate {
  totalBytes: number;
  tileCount: number;
  estimatedSec: number;
  ceilingSec: number;
  /** True when the build should be refused outright. */
  overCeiling: boolean;
  /** "about 20 minutes" / "roughly 3 hours" for user-facing copy. */
  humanEstimate: string;
}

export function estimateMosaic(
  totalBytes: number,
  tileCount: number,
  model: MergeCostCoefficients = mosaicCostModel(),
): MosaicEstimate {
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

/**
 * Validate a client-supplied batch of uploaded source rasters and
 * normalize to TileLayerSource records. Mirrors the point-cloud
 * validateSources rules: prefix pin, count cap, no dupes, sane
 * names and sizes.
 */
export function validateMosaicSources(
  sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>,
): TileLayerSource[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new BadRequestException('Add at least one image.');
  }
  if (sources.length > MOSAIC_MAX_SOURCES) {
    throw new BadRequestException(
      `That is more than ${MOSAIC_MAX_SOURCES} images in one go. ` +
        'Split it into smaller batches.',
    );
  }
  const now = new Date().toISOString() as ISODateString;
  const seen = new Set<string>();
  return sources.map((s) => {
    if (typeof s.storageKey !== 'string' || s.storageKey.length === 0) {
      throw new BadRequestException('A source image is missing its storageKey.');
    }
    if (!s.storageKey.startsWith(MOSAIC_SOURCE_PREFIX)) {
      throw new BadRequestException('A source image is not an imagery upload.');
    }
    if (seen.has(s.storageKey)) {
      throw new BadRequestException('The same image was added twice.');
    }
    seen.add(s.storageKey);
    if (typeof s.fileName !== 'string' || s.fileName.length === 0) {
      throw new BadRequestException('A source image is missing its fileName.');
    }
    if (
      typeof s.sizeBytes !== 'number' ||
      !Number.isFinite(s.sizeBytes) ||
      s.sizeBytes <= 0
    ) {
      throw new BadRequestException('A source image has an invalid size.');
    }
    return {
      storageKey: s.storageKey,
      fileName: s.fileName,
      sizeBytes: s.sizeBytes,
      addedAt: now,
    };
  });
}
