// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  OFFLINE_PACKAGE_MAX_TILES,
  OFFLINE_PACKAGE_MAX_ZOOM,
  estimateTileCount,
  validateOfflineArea,
  type OfflineArea,
} from './offline-package';

/** Area used for every real measurement in the offline work. */
const TRAILS_BBOX: [number, number, number, number] = [
  -80.14921, 38.45361, -79.35496, 39.00595,
];

function area(over: Partial<OfflineArea> = {}): OfflineArea {
  return {
    id: 'a1',
    name: 'Trails',
    bbox: TRAILS_BBOX,
    minZoom: 0,
    maxZoom: 14,
    ...over,
  };
}

describe('estimateTileCount', () => {
  it('counts a single tile at zoom 0', () => {
    expect(estimateTileCount([-180, -85, 180, 85], 0, 0)).toBe(1);
  });

  it('counts the full grid at a given zoom', () => {
    // z2 is a 4x4 grid, and the whole world covers all of it.
    expect(estimateTileCount([-180, -85, 180, 85], 2, 2)).toBe(16);
  });

  it('accumulates across a zoom range', () => {
    // 1 + 4 + 16 for z0..z2.
    expect(estimateTileCount([-180, -85, 180, 85], 0, 2)).toBe(21);
  });

  it('is an upper bound on what the real extract needs', () => {
    // `pmtiles extract --dry-run` reports 1,683 tiles for this area
    // at z0-14. The estimate counts the bbox rectangle without
    // knowing which tiles the upstream archive actually holds, so it
    // must be at least the real figure. If it ever came in UNDER,
    // the authoring UI would wave through areas the builder then
    // refuses, which is the failure worth pinning. (Here the two are
    // equal, because the area is inland and every tile in it has
    // data. Over ocean they would diverge, which is exactly why the
    // builder re-counts for real before downloading anything.)
    const estimate = estimateTileCount(TRAILS_BBOX, 0, 14);
    expect(estimate).toBeGreaterThanOrEqual(1683);
  });

  it('grows about fourfold per extra zoom level', () => {
    // Measured at z13-14 rather than lower down: each level splits
    // every tile in four, but the ratio only approaches 4 once the
    // box spans many tiles. At z10 it covers 3 by 3 and rounding to
    // tile edges dominates, giving 2.25. This quadrupling is the
    // whole reason a zoom-19 raster prefetch of this same area was
    // 1.6 million tiles with 75% of them at the last level.
    const z13 = estimateTileCount(TRAILS_BBOX, 13, 13);
    const z14 = estimateTileCount(TRAILS_BBOX, 14, 14);
    expect(z14 / z13).toBeGreaterThan(3.5);
    expect(z14 / z13).toBeLessThan(4.5);
  });

  it('is dominated by the deepest zoom level', () => {
    // Sanity check on the same property from the other side: the
    // last level alone is most of the archive, which is why lowering
    // the ceiling by one is the first thing to suggest to an author
    // whose area is over the cap.
    const all = estimateTileCount(TRAILS_BBOX, 0, 14);
    const deepest = estimateTileCount(TRAILS_BBOX, 14, 14);
    expect(deepest / all).toBeGreaterThan(0.65);
  });

  it('clamps latitudes past the Web Mercator limit', () => {
    // Asking for the poles must not produce Infinity or NaN.
    const n = estimateTileCount([-180, -90, 180, 90], 0, 4);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBe(estimateTileCount([-180, -85.0511, 180, 85.0511], 0, 4));
  });

  it('returns zero for an empty extent', () => {
    expect(estimateTileCount([10, 10, 10, 20], 0, 5)).toBe(0);
    expect(estimateTileCount([10, 20, 20, 10], 0, 5)).toBe(0);
  });

  it('puts a continent-sized area over the cap', () => {
    // Africa at z14. The point of the cap is that an author who
    // drags a box this big is told so rather than filling a disk.
    const n = estimateTileCount([-18, -35, 52, 38], 0, 14);
    expect(n).toBeGreaterThan(OFFLINE_PACKAGE_MAX_TILES);
  });
});

describe('validateOfflineArea', () => {
  it('accepts a well-formed area', () => {
    expect(validateOfflineArea(area())).toBeNull();
  });

  it('rejects a blank name', () => {
    expect(validateOfflineArea(area({ name: '   ' }))).toMatch(/name/i);
  });

  it('rejects an inverted extent', () => {
    expect(
      validateOfflineArea(area({ bbox: [-79, 39, -80, 38] })),
    ).toMatch(/empty/i);
  });

  it('rejects an extent outside the world', () => {
    expect(
      validateOfflineArea(area({ bbox: [-181, 38, -79, 39] })),
    ).toMatch(/world/i);
  });

  it('rejects a zoom above what the upstream archive holds', () => {
    expect(
      validateOfflineArea(area({ maxZoom: OFFLINE_PACKAGE_MAX_ZOOM + 1 })),
    ).toMatch(/detail level/i);
  });

  it('rejects a max below the min', () => {
    expect(validateOfflineArea(area({ minZoom: 10, maxZoom: 5 }))).toMatch(
      /at least/i,
    );
  });

  it('accepts an omitted refresh interval but rejects a nonsense one', () => {
    expect(validateOfflineArea(area())).toBeNull();
    expect(validateOfflineArea(area({ refreshDays: 7 }))).toBeNull();
    expect(validateOfflineArea(area({ refreshDays: 0 }))).toMatch(/rebuild/i);
  });

  it('rejects a non-numeric extent', () => {
    const bad = area();
    // Deliberately not through the type: this is the shape that
    // arrives from a JSON body, where nothing has been checked yet.
    (bad as unknown as { bbox: unknown[] }).bbox = [-80, 38, 'x', 39];
    expect(validateOfflineArea(bad)).toMatch(/coordinates/i);
  });
});
