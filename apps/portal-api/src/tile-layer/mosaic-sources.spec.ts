// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit spec for the imagery-mosaic source validation + cost model
 * (#199). Pure functions; no Nest module, no Postgres.
 */
import { BadRequestException } from '@nestjs/common';
import type { MergeCostCoefficients } from '@gratis-gis/shared-types';

import {
  MOSAIC_MAX_SOURCES,
  estimateMosaic,
  mosaicCostModel,
  validateMosaicSources,
} from './mosaic-sources.js';

const src = (n: number, over: Partial<{ storageKey: string; fileName: string; sizeBytes: number }> = {}) => ({
  storageKey: `item-tile-layer/${String(n).padStart(4, '0')}`,
  fileName: `tile-${n}.tif`,
  sizeBytes: 1024,
  ...over,
});

describe('validateMosaicSources', () => {
  it('normalizes a valid batch and stamps addedAt', () => {
    const out = validateMosaicSources([src(1), src(2)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.storageKey).toBe('item-tile-layer/0001');
    expect(out[0]!.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('pins the storage-key prefix (client-supplied body)', () => {
    expect(() =>
      validateMosaicSources([src(1, { storageKey: 'item-file/whatever' })]),
    ).toThrow(BadRequestException);
    expect(() =>
      validateMosaicSources([
        src(1, { storageKey: 'feature-attachment/x' }),
      ]),
    ).toThrow(/not an imagery upload/);
  });

  it('rejects empty batches, dupes, and oversized batches', () => {
    expect(() => validateMosaicSources([])).toThrow(/at least one/);
    expect(() => validateMosaicSources([src(1), src(1)])).toThrow(/twice/);
    const many = Array.from({ length: MOSAIC_MAX_SOURCES + 1 }, (_, i) =>
      src(i),
    );
    expect(() => validateMosaicSources(many)).toThrow(/smaller batches/);
  });

  it('rejects missing names and non-positive sizes', () => {
    expect(() => validateMosaicSources([src(1, { fileName: '' })])).toThrow(
      /fileName/,
    );
    expect(() => validateMosaicSources([src(1, { sizeBytes: 0 })])).toThrow(
      /invalid size/,
    );
    expect(() =>
      validateMosaicSources([src(1, { sizeBytes: Number.NaN })]),
    ).toThrow(/invalid size/);
  });
});

describe('estimateMosaic', () => {
  const model: MergeCostCoefficients = {
    downloadMibPerSec: 100,
    untwineSecPerGib: 100,
    perTileOverheadSec: 1,
    ceilingSec: 1000,
  };

  it('sums download + gdal + per-tile terms', () => {
    // 1 GiB, 10 tiles: 1024 MiB / 100 + 1 * 100 + 10 * 1 = 120.24 -> ceil
    const e = estimateMosaic(1024 ** 3, 10, model);
    expect(e.estimatedSec).toBe(121);
    expect(e.overCeiling).toBe(false);
    expect(e.humanEstimate.length).toBeGreaterThan(0);
  });

  it('flags builds beyond the ceiling', () => {
    const e = estimateMosaic(20 * 1024 ** 3, 400, model);
    expect(e.overCeiling).toBe(true);
  });
});

describe('mosaicCostModel', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads env overrides and ignores junk values', () => {
    process.env.MOSAIC_GDAL_SEC_PER_GIB = '90';
    process.env.MOSAIC_DOWNLOAD_MIB_PER_SEC = 'banana';
    const m = mosaicCostModel();
    expect(m.untwineSecPerGib).toBe(90);
    expect(m.downloadMibPerSec).toBe(60);
  });

  it('derives the ceiling from the timeout when unset', () => {
    process.env.MOSAIC_TIMEOUT_SEC = '1000';
    delete process.env.MOSAIC_TIME_CEILING_SEC;
    expect(mosaicCostModel().ceilingSec).toBe(900);
  });
});
