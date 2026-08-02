// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatRoughDuration } from '@gratis-gis/shared-types';
import type { MergeCostCoefficients } from '@gratis-gis/shared-types';
import { estimateMerge } from './merge-estimate.js';

const GIB = 1024 ** 3;

// Fixed model so the spec never depends on env or on retuned
// defaults: 100 MiB/s download, 300 s/GiB untwine, 2 s/tile, 4h*0.9
// ceiling. The real defaults live in mergeCostModel() and are
// operator-tunable by design.
const model: MergeCostCoefficients = {
  downloadMibPerSec: 100,
  untwineSecPerGib: 300,
  perTileOverheadSec: 2,
  ceilingSec: 12_960,
};

describe('estimateMerge', () => {
  it('scales with bytes and tiles and stays under the ceiling for a county-sample merge', () => {
    // The real Randolph batch shape: ~300 tiles, ~16 GiB.
    const est = estimateMerge(16 * GIB, 303, model);
    // 16 GiB: download ~164s, untwine 4800s, overhead 606s.
    expect(est.estimatedSec).toBeGreaterThan(5000);
    expect(est.estimatedSec).toBeLessThan(7000);
    expect(est.overCeiling).toBe(false);
    expect(est.humanEstimate).toMatch(/^roughly|^about/);
  });

  it('refuses a merge whose estimate blows the ceiling', () => {
    // ~48 GiB pushes untwine alone past 4h * 0.9.
    const est = estimateMerge(48 * GIB, 900, model);
    expect(est.overCeiling).toBe(true);
    expect(est.estimatedSec).toBeGreaterThan(model.ceilingSec);
  });

  it('a single small tile is minutes, not hours', () => {
    const est = estimateMerge(200 * 1024 ** 2, 1, model);
    expect(est.estimatedSec).toBeLessThan(120);
    expect(est.overCeiling).toBe(false);
  });
});

describe('formatRoughDuration', () => {
  it('rounds up and hedges', () => {
    expect(formatRoughDuration(30)).toBe('about a minute');
    expect(formatRoughDuration(600)).toBe('about 10 minutes');
    // 11 minutes rounds UP to the next 5-minute step.
    expect(formatRoughDuration(660)).toBe('about 15 minutes');
    expect(formatRoughDuration(3300)).toBe('about an hour');
    expect(formatRoughDuration(5400)).toBe('roughly 1.5 hours');
    expect(formatRoughDuration(9000)).toBe('roughly 2.5 hours');
    expect(formatRoughDuration(8 * 3600)).toBe('roughly 8 hours');
  });
});
