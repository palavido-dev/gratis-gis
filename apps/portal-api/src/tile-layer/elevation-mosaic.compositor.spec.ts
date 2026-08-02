// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unit spec for the elevation-mosaic per-pixel compositor (#211).
 * Pure math against synthetic grids; no GDAL, no Postgres, runs in
 * every local + CI invocation.
 */
import {
  MOSAIC_MAX_STACK,
  bboxesIntersect,
  compositeInto,
  decodeTerrarium,
  encodeTerrarium,
  hasNodata,
  isAllNodata,
  parseStackParam,
  tileBbox3857,
  tileBboxWgs84,
} from './elevation-mosaic.compositor.js';

const HALF_WORLD = 20037508.342789244;

describe('tileBbox3857', () => {
  it('z0 covers the whole mercator world', () => {
    const bb = tileBbox3857(0, 0, 0);
    expect(bb.minX).toBeCloseTo(-HALF_WORLD, 3);
    expect(bb.maxX).toBeCloseTo(HALF_WORLD, 3);
    expect(bb.minY).toBeCloseTo(-HALF_WORLD, 3);
    expect(bb.maxY).toBeCloseTo(HALF_WORLD, 3);
  });

  it('z1 quadrants tile the world with XYZ y pointing down', () => {
    const nw = tileBbox3857(1, 0, 0);
    expect(nw.minX).toBeCloseTo(-HALF_WORLD, 3);
    expect(nw.maxX).toBeCloseTo(0, 3);
    expect(nw.minY).toBeCloseTo(0, 3);
    expect(nw.maxY).toBeCloseTo(HALF_WORLD, 3);
    const se = tileBbox3857(1, 1, 1);
    expect(se.minX).toBeCloseTo(0, 3);
    expect(se.maxY).toBeCloseTo(0, 3);
  });
});

describe('tileBboxWgs84', () => {
  it('z0 spans the mercator-valid latitudes', () => {
    const [w, s, e, n] = tileBboxWgs84(0, 0, 0);
    expect(w).toBeCloseTo(-180, 6);
    expect(e).toBeCloseTo(180, 6);
    expect(s).toBeCloseTo(-85.0511287798, 6);
    expect(n).toBeCloseTo(85.0511287798, 6);
  });

  it('adjacent tiles share an edge exactly', () => {
    const a = tileBboxWgs84(5, 8, 12);
    const b = tileBboxWgs84(5, 9, 12);
    expect(a[2]).toBeCloseTo(b[0], 10);
  });
});

describe('bboxesIntersect', () => {
  const wv: [number, number, number, number] = [-80.101, 38.722, -80.033, 38.767];
  const elkins: [number, number, number, number] = [-80.031, 38.847, -79.652, 39.012];

  it('the #211 motivating pair does NOT overlap', () => {
    // The property lidar and the Elkins DEM are disjoint; each must
    // be skippable for tiles that only touch the other.
    expect(bboxesIntersect(wv, elkins)).toBe(false);
  });

  it('overlap and containment count', () => {
    expect(bboxesIntersect(wv, [-80.2, 38.7, -80.05, 38.75])).toBe(true);
    expect(bboxesIntersect(wv, [-180, -85, 180, 85])).toBe(true);
  });

  it('touching edges count as intersecting', () => {
    expect(bboxesIntersect([0, 0, 1, 1], [1, 0, 2, 1])).toBe(true);
  });
});

describe('compositeInto (first entry wins per pixel)', () => {
  it('fills only nodata slots, preserving higher-priority data', () => {
    const dest = Float32Array.from([100, NaN, 300, NaN]);
    compositeInto(dest, Float32Array.from([1, 2, 3, NaN]));
    expect(Array.from(dest.slice(0, 3))).toEqual([100, 2, 300]);
    expect(Number.isNaN(dest[3]!)).toBe(true);
  });

  it('a coarse under-layer fills the footprint cliff of a bounded DEM', () => {
    // 4x1 strip: high-res lidar covers the left half, coarse
    // regional elevation covers everything. After the composite the
    // boundary column has coarse ground instead of a wall to zero.
    const lidar = Float32Array.from([900, 905, NaN, NaN]);
    const regional = Float32Array.from([880, 881, 882, 883]);
    const dest = new Float32Array(4).fill(NaN);
    compositeInto(dest, lidar);
    compositeInto(dest, regional);
    expect(Array.from(dest)).toEqual([900, 905, 882, 883]);
  });

  it('throws on grid size mismatch instead of silently misaligning', () => {
    expect(() =>
      compositeInto(new Float32Array(4), new Float32Array(9)),
    ).toThrow(/mismatch/);
  });
});

describe('hasNodata / isAllNodata', () => {
  it('classify partial, full, and empty coverage', () => {
    expect(hasNodata(Float32Array.from([1, NaN]))).toBe(true);
    expect(hasNodata(Float32Array.from([1, 2]))).toBe(false);
    expect(isAllNodata(Float32Array.from([NaN, NaN]))).toBe(true);
    expect(isAllNodata(Float32Array.from([NaN, 0]))).toBe(false);
  });
});

describe('encodeTerrarium', () => {
  it('encodes elevation 0 as (128, 0, 0)', () => {
    const { r, g, b } = encodeTerrarium(Float32Array.from([0]));
    expect([r[0], g[0], b[0]]).toEqual([128, 0, 0]);
  });

  it('round-trips real elevations within 1/256 m', () => {
    const values = [-431.5, -12.25, 0.5, 304.8, 1481.2, 8848.86];
    const { r, g, b } = encodeTerrarium(Float32Array.from(values));
    values.forEach((v, i) => {
      expect(decodeTerrarium(r[i]!, g[i]!, b[i]!)).toBeCloseTo(v, 2);
    });
  });

  it('encodes remaining nodata as elevation 0 (flat, not a pit)', () => {
    const { r, g, b } = encodeTerrarium(Float32Array.from([NaN]));
    expect(decodeTerrarium(r[0]!, g[0]!, b[0]!)).toBe(0);
  });

  it('clamps beyond-range values instead of wrapping', () => {
    const { r, g, b } = encodeTerrarium(
      Float32Array.from([-40000, 40000]),
    );
    expect(decodeTerrarium(r[0]!, g[0]!, b[0]!)).toBe(-32768);
    expect(decodeTerrarium(r[1]!, g[1]!, b[1]!)).toBeCloseTo(32768, 0);
  });
});

describe('parseStackParam', () => {
  const a = '11111111-2222-3333-4444-555555555555';
  const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('accepts ordered uuid lists and preserves priority order', () => {
    expect(parseStackParam(`${b},${a}`)).toEqual([b, a]);
    expect(parseStackParam(a)).toEqual([a]);
  });

  it('de-dupes while keeping the first occurrence', () => {
    expect(parseStackParam(`${a},${b},${a}`)).toEqual([a, b]);
  });

  it('rejects empty, malformed, and oversized stacks', () => {
    expect(parseStackParam('')).toBeNull();
    expect(parseStackParam(undefined)).toBeNull();
    expect(parseStackParam('not-a-uuid')).toBeNull();
    expect(parseStackParam(`${a},42`)).toBeNull();
    expect(parseStackParam(`${a};${b}`)).toBeNull();
    const many = Array.from(
      { length: MOSAIC_MAX_STACK + 1 },
      (_, i) => `${String(i).padStart(8, '0')}-2222-3333-4444-555555555555`,
    ).join(',');
    expect(parseStackParam(many)).toBeNull();
  });
});
