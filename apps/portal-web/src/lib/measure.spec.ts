// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatAreaIn,
  formatLengthIn,
  lineLengthMeters,
  ringAreaSquareMeters,
  ringPerimeterMeters,
  terrainSurfaceAreaSquareMeters,
} from './measure';

const SQM_PER_ACRE = 4046.8564224;

/** Build an axis-aligned square ring of `acres` around (lng, lat). */
function squareRingAcres(
  lng: number,
  lat: number,
  acres: number,
): Array<[number, number]> {
  const sideM = Math.sqrt(acres * SQM_PER_ACRE);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const dLat = sideM / mPerDegLat;
  const dLng = sideM / mPerDegLng;
  return [
    [lng, lat],
    [lng + dLng, lat],
    [lng + dLng, lat + dLat],
    [lng, lat + dLat],
    [lng, lat],
  ];
}

describe('ringAreaSquareMeters', () => {
  it('returns 0 for degenerate rings', () => {
    expect(ringAreaSquareMeters([])).toBe(0);
    expect(ringAreaSquareMeters([[0, 0], [1, 1]])).toBe(0);
  });

  it('matches a known ~144-acre square in WV (user-report scale)', () => {
    const ring = squareRingAcres(-80.07, 38.75, 144);
    const acres = ringAreaSquareMeters(ring) / SQM_PER_ACRE;
    // Planar degree→meter approx vs spherical excess: within 1%.
    expect(acres).toBeGreaterThan(142);
    expect(acres).toBeLessThan(146);
  });

  it('matches a 1-acre square near the equator', () => {
    const ring = squareRingAcres(-80, 0.1, 1);
    const acres = ringAreaSquareMeters(ring) / SQM_PER_ACRE;
    expect(acres).toBeGreaterThan(0.99);
    expect(acres).toBeLessThan(1.01);
  });

  it('is stable whether or not the ring repeats the closing vertex', () => {
    const closed = squareRingAcres(-80.07, 38.75, 10);
    const open = closed.slice(0, -1);
    expect(ringAreaSquareMeters(open)).toBeCloseTo(
      ringAreaSquareMeters(closed),
      6,
    );
  });

  it('does not under-read by ~14× (the reported measure bug ratio)', () => {
    // If lng deltas were left in degrees (missing toRad), area blows
    // up by ~57×. If Earth radius were in km, area collapses by 1e6.
    // This guard locks the spherical-excess scaling that kept the
    // WV demo measure within a percent of PostGIS/turf-class checks.
    const ring = squareRingAcres(-80.07, 38.75, 144);
    const acres = ringAreaSquareMeters(ring) / SQM_PER_ACRE;
    expect(acres / 144).toBeGreaterThan(0.95);
    expect(acres / 144).toBeLessThan(1.05);
    // Explicitly reject the "shows ~10 ac for 144 ac" failure mode.
    expect(acres).not.toBeLessThan(20);
  });
});

describe('lineLengthMeters', () => {
  it('returns 0 for a single point', () => {
    expect(lineLengthMeters([[0, 0]])).toBe(0);
  });

  it('haversine-matches ~100 m east at mid-latitudes', () => {
    // 100 m east at lat 38.75 ≈ 100 / (111320 * cos(lat)) degrees.
    const lat = 38.75;
    const dLng = 100 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const meters = lineLengthMeters([
      [-80.07, lat],
      [-80.07 + dLng, lat],
    ]);
    expect(meters).toBeGreaterThan(99);
    expect(meters).toBeLessThan(101);
  });
});

describe('formatAreaIn / formatLengthIn', () => {
  it('formats acres with the international acre', () => {
    expect(formatAreaIn(SQM_PER_ACRE, 'acres')).toBe('1.00 ac');
    expect(formatAreaIn(144 * SQM_PER_ACRE, 'acres')).toBe('144.0 ac');
  });

  it('formats meters for the scale-bar sanity check', () => {
    expect(formatLengthIn(100, 'meters')).toBe('100.0 m');
    expect(formatLengthIn(98.52, 'meters')).toBe('98.52 m');
  });

  it('matches the reported WV readout (58.41 ac ↔ 236382.1 m²)', () => {
    // Locked to the screenshot numbers so a conversion/regression
    // cannot silently reopen the "under-read" report.
    expect(formatAreaIn(236_382.1, 'acres')).toBe('58.41 ac');
    expect(formatAreaIn(236_382.1, 'square-meters')).toBe('236382.1 m²');
  });
});

describe('ringPerimeterMeters', () => {
  it('equals four sides of a ~1-acre square near the equator', () => {
    const ring = squareRingAcres(-80, 0.1, 1);
    const side = Math.sqrt(SQM_PER_ACRE);
    const peri = ringPerimeterMeters(ring);
    expect(peri).toBeGreaterThan(4 * side * 0.98);
    expect(peri).toBeLessThan(4 * side * 1.02);
  });
});

describe('terrainSurfaceAreaSquareMeters', () => {
  it('matches planar area on a flat DEM', () => {
    const ring = squareRingAcres(-80.07, 38.75, 10);
    const planar = ringAreaSquareMeters(ring);
    const surface = terrainSurfaceAreaSquareMeters(ring, () => 800, 40);
    expect(surface).not.toBeNull();
    expect(surface! / planar).toBeGreaterThan(0.97);
    expect(surface! / planar).toBeLessThan(1.03);
  });

  it('is larger than planar on a uniform slope', () => {
    // z = grade * east_meters → surface/planar ≈ sqrt(1 + grade²).
    const ring = squareRingAcres(-80.07, 38.75, 10);
    const planar = ringAreaSquareMeters(ring);
    const grade = 1; // 45°
    const originLng = -80.07;
    const originLat = 38.75;
    const mPerDegLng = 111_320 * Math.cos((originLat * Math.PI) / 180);
    const surface = terrainSurfaceAreaSquareMeters(
      ring,
      (lng) => 800 + grade * (lng - originLng) * mPerDegLng,
      48,
    );
    expect(surface).not.toBeNull();
    const expectedRatio = Math.sqrt(1 + grade * grade);
    expect(surface! / planar).toBeGreaterThan(expectedRatio * 0.95);
    expect(surface! / planar).toBeLessThan(expectedRatio * 1.05);
  });

  it('returns null when elevation is unavailable', () => {
    const ring = squareRingAcres(-80.07, 38.75, 1);
    expect(terrainSurfaceAreaSquareMeters(ring, () => null)).toBeNull();
  });
});
