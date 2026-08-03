// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  assertGridBudget,
  estimateGrid,
  gridCostModel,
} from './grid-estimate.js';

const model = {
  downloadMibPerSec: 100,
  secPerMillionPoints: 2,
  secPerMillionCells: 1,
  perChunkOverheadSec: 10,
  chunkCells: 64_000_000,
  ceilingSec: 10_000,
};

describe('estimateGrid', () => {
  it('sums download + per-pass points + cells + chunk overhead', () => {
    // 1 GiB download (10.24s), 100M points x 2 passes x 2s = 400s,
    // 200M cells x 1s/M = 200s, ceil(200M/64M)=4 chunks x 10s = 40s.
    const e = estimateGrid(
      {
        sizeBytes: 1024 ** 3,
        pointCount: 100_000_000,
        cells: 200_000_000,
        gridPasses: 2,
      },
      model,
    );
    expect(e.chunks).toBe(4);
    expect(e.estimatedSec).toBe(Math.ceil(1024 / 100 + 400 + 200 + 40));
    expect(e.overCeiling).toBe(false);
  });

  it('approximates missing pointCount from size, over-counting', () => {
    // 600 MB at ~6 bytes/point -> 100M points; real LAZ runs 7-10
    // bytes/point, so the estimate runs LONG (safe direction).
    const e = estimateGrid(
      { sizeBytes: 600_000_000, cells: 1_000_000, gridPasses: 1 },
      model,
    );
    expect(e.estimatedSec).toBeGreaterThanOrEqual(200);
  });

  it('the Elkins case fits the default budget at 1m', () => {
    // 1.88B points, ~414M cells, ~16GB source: the motivating build
    // the old cell cap refused must now pass the default gate.
    const e = estimateGrid({
      sizeBytes: 16 * 1024 ** 3,
      pointCount: 1_880_000_000,
      cells: 414_000_000,
      gridPasses: 1,
    });
    expect(e.overCeiling).toBe(false);
    expect(e.chunks).toBeGreaterThan(1);
  });
});

describe('assertGridBudget', () => {
  const bounds = [0, 0, 0, 30_700, 13_500, 100];

  it('returns the estimate for a build inside the budget', () => {
    const e = assertGridBudget(
      { bounds, pointCount: 1_880_000_000, sizeBytes: 16 * 1024 ** 3 },
      1.0,
      1,
    );
    expect(e).not.toBeNull();
    expect(e!.overCeiling).toBe(false);
    expect(e!.humanEstimate.length).toBeGreaterThan(0);
  });

  it('refuses a build beyond the ceiling with the number attached', () => {
    // 0.25m over the same extent = 16x the cells and the same
    // points twice (heightmap): far past the default ceiling.
    expect(() =>
      assertGridBudget(
        { bounds, pointCount: 60_000_000_000, sizeBytes: 400 * 1024 ** 3 },
        0.25,
        2,
      ),
    ).toThrow(BadRequestException);
  });

  it('passes items without bounds through un-estimated', () => {
    expect(assertGridBudget({ pointCount: 1 }, 1, 1)).toBeNull();
  });
});

describe('gridCostModel', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads env overrides and ignores junk', () => {
    process.env.GRID_SEC_PER_MILLION_POINTS = '9';
    process.env.GRID_TIME_CEILING_SEC = 'nope';
    const m = gridCostModel();
    expect(m.secPerMillionPoints).toBe(9);
    expect(m.ceilingSec).toBe(12_960);
  });
});
