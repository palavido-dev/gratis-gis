// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  OSM_QUERY_DEFAULT_FEATURES,
  OSM_QUERY_MAX_BBOX_AREA_DEG2,
  OSM_QUERY_MAX_FEATURES,
  validateOsmQueryBounds,
} from './osm-query.limits.js';

describe('validateOsmQueryBounds', () => {
  it('accepts a small bbox and defaults the feature cap', () => {
    const out = validateOsmQueryBounds({
      bbox: [-81.7, 38.3, -81.5, 38.4],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.maxFeatures).toBe(OSM_QUERY_DEFAULT_FEATURES);
    expect(out.bbox).toEqual([-81.7, 38.3, -81.5, 38.4]);
    expect(out.areaDeg2).toBeCloseTo(0.02, 5);
  });

  it('parses a comma-separated bbox string', () => {
    const out = validateOsmQueryBounds({
      bbox: '-81.7,38.3,-81.5,38.4',
      limit: '250',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.maxFeatures).toBe(250);
  });

  it('refuses a missing bbox (unbounded)', () => {
    const out = validateOsmQueryBounds({ bbox: undefined });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/bbox is required/i);
  });

  it('refuses a bbox larger than the area cap', () => {
    // 2° × 2° = 4 deg² > 1
    const out = validateOsmQueryBounds({
      bbox: [-82, 37, -80, 39],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(
      new RegExp(`maximum is ${OSM_QUERY_MAX_BBOX_AREA_DEG2}`),
    );
  });

  it('accepts a bbox at exactly the area cap', () => {
    const out = validateOsmQueryBounds({
      bbox: [0, 0, 1, 1],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.areaDeg2).toBe(OSM_QUERY_MAX_BBOX_AREA_DEG2);
  });

  it('refuses a feature limit above the hard cap', () => {
    const out = validateOsmQueryBounds({
      bbox: [0, 0, 0.1, 0.1],
      limit: OSM_QUERY_MAX_FEATURES + 1,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/exceeds the maximum/);
  });

  it('refuses a degenerate bbox', () => {
    const out = validateOsmQueryBounds({
      bbox: [1, 0, 0, 1],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/degenerate/i);
  });
});
