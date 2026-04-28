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
