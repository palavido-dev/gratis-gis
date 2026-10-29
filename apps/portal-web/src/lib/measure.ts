// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Geographic distance + area helpers for the editor's measure tool
 * (#122). Small enough to avoid pulling in turf for one feature
 * (per the no-deps-for-helpers rule). Accurate to within a percent
 * or two for any polygon up to mid-continental scale, which is
 * plenty for a "sketch a shape and see its size" workflow.
 *
 * Coordinates are GeoJSON [lng, lat] tuples in degrees.
 */

const EARTH_RADIUS_M = 6_378_137; // WGS84 semi-major

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine great-circle distance in meters between two points.
 */
function haversineMeters(
  a: [number, number],
  b: [number, number],
): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const lat1r = toRad(lat1);
  const lat2r = toRad(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Cumulative haversine length of a LineString-shaped coordinate
 * array, in meters. Returns 0 for fewer than two points.
 */
export function lineLengthMeters(coords: Array<[number, number]>): number {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

/**
 * Spherical-excess area for a Polygon's outer ring (one-ring only;
 * inner rings ignored, which is fine for measurement of sketched
 * polygons). In square meters. Returns 0 for fewer than three
 * points or for a degenerate ring.
 *
 * Formula: A = |sum_{i} (lng_{i+1} - lng_{i-1}) * sin(lat_i)| * R^2 / 2.
 * Standard spherical-polygon area; works at any scale where the
 * sphere approximation is acceptable (i.e. always, for a measure
 * tool).
 */
export function ringAreaSquareMeters(
  ring: Array<[number, number]>,
): number {
  if (!ring || ring.length < 3) return 0;
  // Drop the closing repeated point if present so the wrap below
  // doesn't double-count it.
  const points =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring;
  if (points.length < 3) return 0;

  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n]!;
    const next = points[(i + 1) % n]!;
    const cur = points[i]!;
    const dLng = toRad(next[0] - prev[0]);
    total += dLng * Math.sin(toRad(cur[1]));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/**
 * Approximate 3D surface area on a DEM for a polygon outer ring.
 *
 * Samples a lng/lat grid of cells whose centers fall inside the
 * ring, lifts each cell's four corners with `elevationAt`, and sums
 * the two triangles per cell in a local east-north-up frame. Returns
 * `null` when every sample lacks elevation (terrain not ready) so
 * the UI can hide the surface readout rather than show 0.
 *
 * This is the "slope surface" number users sometimes want on pitched
 * 3D maps. It is larger than {@link ringAreaSquareMeters} on relief
 * and equal (within grid error) on flat ground. Not a substitute for
 * survey-grade TIN area — good enough for a sketch tool.
 */
export function terrainSurfaceAreaSquareMeters(
  ring: Array<[number, number]>,
  elevationAt: (lng: number, lat: number) => number | null | undefined,
  gridSize = 32,
): number | null {
  if (!ring || ring.length < 3) return null;
  const points =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring;
  if (points.length < 3) return null;

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (!(maxLng > minLng) || !(maxLat > minLat)) return null;

  const midLng = (minLng + maxLng) / 2;
  const midLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(toRad(midLat));

  const inside = (lng: number, lat: number): boolean => {
    let odd = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!;
      const [xj, yj] = points[j]!;
      if (
        (yi > lat) !== (yj > lat) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        odd = !odd;
      }
    }
    return odd;
  };

  const toEnu = (lng: number, lat: number, z: number): [number, number, number] => [
    (lng - midLng) * mPerDegLng,
    (lat - midLat) * mPerDegLat,
    z,
  ];

  const triArea = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): number => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    const cx = ab[1] * ac[2] - ab[2] * ac[1];
    const cy = ab[2] * ac[0] - ab[0] * ac[2];
    const cz = ab[0] * ac[1] - ab[1] * ac[0];
    return 0.5 * Math.hypot(cx, cy, cz);
  };

  const n = Math.max(4, Math.min(64, Math.floor(gridSize)));
  let area = 0;
  let samples = 0;
  for (let iy = 0; iy < n; iy += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const lng0 = minLng + ((maxLng - minLng) * ix) / n;
      const lng1 = minLng + ((maxLng - minLng) * (ix + 1)) / n;
      const lat0 = minLat + ((maxLat - minLat) * iy) / n;
      const lat1 = minLat + ((maxLat - minLat) * (iy + 1)) / n;
      const cLng = (lng0 + lng1) / 2;
      const cLat = (lat0 + lat1) / 2;
      if (!inside(cLng, cLat)) continue;
      const corners: Array<[number, number]> = [
        [lng0, lat0],
        [lng1, lat0],
        [lng1, lat1],
        [lng0, lat1],
      ];
      const zs: number[] = [];
      let missing = false;
      for (const [lng, lat] of corners) {
        const z = elevationAt(lng, lat);
        if (z == null || !Number.isFinite(z)) {
          missing = true;
          break;
        }
        zs.push(z);
      }
      if (missing) continue;
      const p = corners.map(([lng, lat], i) => toEnu(lng, lat, zs[i]!));
      area += triArea(p[0]!, p[1]!, p[2]!) + triArea(p[0]!, p[2]!, p[3]!);
      samples += 1;
    }
  }
  if (samples === 0) return null;
  return area;
}

/**
 * Closed-ring perimeter in meters (haversine). Drops a repeated
 * closing vertex so it is not double-counted.
 */
export function ringPerimeterMeters(ring: Array<[number, number]>): number {
  if (!ring || ring.length < 2) return 0;
  const points =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring;
  if (points.length < 2) return 0;
  return lineLengthMeters([...points, points[0]!]);
}

/**
 * Format a length in meters into a human-friendly string.
 * Switches to km above 1000m. One decimal of precision is enough
 * for a measure tool; users who need more can read the raw
 * number-of-meters value.
 */
export function formatLength(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${meters.toFixed(1)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/**
 * Format an area in square meters into a human-friendly string.
 * Tiers: m² below 1 ha, ha (10_000 m²) below 1 km², km² above.
 * Hectares are the right middle unit for parcel- / field-scale
 * sketching; meters and km² cover the extremes.
 */
export function formatArea(sqMeters: number): string {
  if (!Number.isFinite(sqMeters) || sqMeters <= 0) return '0 m²';
  if (sqMeters < 10_000) return `${sqMeters.toFixed(1)} m²`;
  if (sqMeters < 1_000_000) {
    return `${(sqMeters / 10_000).toFixed(2)} ha`;
  }
  return `${(sqMeters / 1_000_000).toFixed(2)} km²`;
}

// Distance unit catalogue for the measure pane. The user picks one;
// the readout converts the raw meters into the chosen unit.
export type DistanceUnit = 'meters' | 'kilometers' | 'feet' | 'miles';
export const DISTANCE_UNIT_LABELS: Record<DistanceUnit, string> = {
  meters: 'Meters',
  kilometers: 'Kilometers',
  feet: 'Feet',
  miles: 'Miles',
};
const DISTANCE_UNIT_SUFFIX: Record<DistanceUnit, string> = {
  meters: 'm',
  kilometers: 'km',
  feet: 'ft',
  miles: 'mi',
};

// Area unit catalogue for the measure pane. Acres + sq mi cover the
// US imperial side; sq m / ha / sq km cover metric. Sq ft is rare
// at portal scales but cheap to include.
export type AreaUnit =
  | 'square-meters'
  | 'hectares'
  | 'square-kilometers'
  | 'square-feet'
  | 'acres'
  | 'square-miles';
export const AREA_UNIT_LABELS: Record<AreaUnit, string> = {
  'square-meters': 'Square meters',
  hectares: 'Hectares',
  'square-kilometers': 'Square kilometers',
  'square-feet': 'Square feet',
  acres: 'Acres',
  'square-miles': 'Square miles',
};
const AREA_UNIT_SUFFIX: Record<AreaUnit, string> = {
  'square-meters': 'm²',
  hectares: 'ha',
  'square-kilometers': 'km²',
  'square-feet': 'ft²',
  acres: 'ac',
  'square-miles': 'mi²',
};

const METERS_PER_FOOT = 0.3048;
const METERS_PER_MILE = 1609.344;
const SQM_PER_SQFT = METERS_PER_FOOT * METERS_PER_FOOT; // 0.09290304
const SQM_PER_ACRE = 4046.8564224;
const SQM_PER_SQMI = METERS_PER_MILE * METERS_PER_MILE; // 2_589_988.110336

/**
 * Convert + format a length (in meters) into the requested unit.
 * Number of decimals adjusts with magnitude so big values stay
 * readable and small ones don't lose precision.
 */
export function formatLengthIn(meters: number, unit: DistanceUnit): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return `0 ${DISTANCE_UNIT_SUFFIX[unit]}`;
  }
  let value: number;
  switch (unit) {
    case 'meters':
      value = meters;
      break;
    case 'kilometers':
      value = meters / 1000;
      break;
    case 'feet':
      value = meters / METERS_PER_FOOT;
      break;
    case 'miles':
      value = meters / METERS_PER_MILE;
      break;
  }
  const decimals = value < 1 ? 3 : value < 100 ? 2 : 1;
  return `${value.toFixed(decimals)} ${DISTANCE_UNIT_SUFFIX[unit]}`;
}

/**
 * Convert + format an area (in square meters) into the requested
 * unit. Same magnitude-aware decimals tuning as formatLengthIn.
 */
export function formatAreaIn(sqMeters: number, unit: AreaUnit): string {
  if (!Number.isFinite(sqMeters) || sqMeters < 0) {
    return `0 ${AREA_UNIT_SUFFIX[unit]}`;
  }
  let value: number;
  switch (unit) {
    case 'square-meters':
      value = sqMeters;
      break;
    case 'hectares':
      value = sqMeters / 10_000;
      break;
    case 'square-kilometers':
      value = sqMeters / 1_000_000;
      break;
    case 'square-feet':
      value = sqMeters / SQM_PER_SQFT;
      break;
    case 'acres':
      value = sqMeters / SQM_PER_ACRE;
      break;
    case 'square-miles':
      value = sqMeters / SQM_PER_SQMI;
      break;
  }
  const decimals = value < 1 ? 3 : value < 100 ? 2 : 1;
  return `${value.toFixed(decimals)} ${AREA_UNIT_SUFFIX[unit]}`;
}
