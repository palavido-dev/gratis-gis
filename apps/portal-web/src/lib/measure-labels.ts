// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Measurement labels for a sketched or saved shape: a length on each
 * segment and the area in the middle. Shared by the Measure tool
 * (live, while drawing and dragging) and the markup overlay (saved
 * shapes with `dimensions` set), so both show the same numbers.
 *
 * Everything here is pure. Lengths and areas are geodesic, the same
 * basis as the Measure panel readout.
 */
import {
  formatAreaIn,
  formatLengthIn,
  lineLengthMeters,
  ringAreaSquareMeters,
  type AreaUnit,
  type DistanceUnit,
} from './measure';

type Pos = [number, number];

export interface DimensionLabelOptions {
  lengths: boolean;
  area: boolean;
  lengthUnit: DistanceUnit;
  areaUnit: AreaUnit;
}

export interface DimensionLabelProps {
  /** `segment` for a side length, `area` for the polygon's area, `total` for a line's whole length. */
  role: 'segment' | 'area' | 'total';
  text: string;
  /** Degrees for MapLibre `text-rotate`, so a side label runs along its side and stays upright. */
  rotate: number;
  /** Lower sorts first: the area and total win a collision with a side label. */
  sort: number;
}

const FEET_PER_METER = 3.280839895;

/**
 * A side length in the chosen unit, dropping to the small unit when
 * the big one would read as a small fraction: under half a mile a
 * side reads in feet ("1220.0 ft", not "0.231 mi"), and under a
 * kilometer in meters.
 */
export function formatSegmentLength(meters: number, unit: DistanceUnit): string {
  if (unit === 'miles' && meters * FEET_PER_METER < 2640) return formatLengthIn(meters, 'feet');
  if (unit === 'kilometers' && meters < 1000) return formatLengthIn(meters, 'meters');
  return formatLengthIn(meters, unit);
}

function isPos(p: unknown): p is Pos {
  return (
    Array.isArray(p) &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  );
}

const RAD = Math.PI / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/**
 * Rotation that lays text along the segment a-b on a north-up Web
 * Mercator map, kept within -90..90 so it never reads upside down.
 */
export function segmentTextRotation(a: Pos, b: Pos): number {
  // Screen angle of the segment, clockwise from east.
  let deg = Math.atan2(-(mercY(b[1]) - mercY(a[1])), (b[0] - a[0]) * RAD) / RAD;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  return deg;
}

/** Average of a ring's distinct vertices. Good enough to seat a label. */
export function ringLabelPoint(ring: Pos[]): Pos | null {
  const pts = openRing(ring);
  if (pts.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function openRing(ring: Pos[]): Pos[] {
  if (ring.length > 1) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  }
  return ring;
}

function segmentLabels(coords: Pos[], unit: DistanceUnit): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const meters = lineLengthMeters([a, b]);
    if (!(meters > 0)) continue;
    const props: DimensionLabelProps = {
      role: 'segment',
      text: formatSegmentLength(meters, unit),
      rotate: segmentTextRotation(a, b),
      sort: 1,
    };
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
      properties: props,
    });
  }
  return out;
}

/**
 * Label points for one LineString or Polygon. Other geometry types,
 * and shapes with too few points to measure, give no labels.
 */
export function dimensionLabelFeatures(
  geometry: unknown,
  options: DimensionLabelOptions,
): GeoJSON.Feature[] {
  if (!geometry || typeof geometry !== 'object') return [];
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
    const coords = (g.coordinates as unknown[]).filter(isPos);
    if (coords.length < 2 || !options.lengths) return [];
    const out = segmentLabels(coords, options.lengthUnit);
    // A total at the end of a line with more than one segment.
    if (out.length > 1) {
      const props: DimensionLabelProps = {
        role: 'total',
        text: formatSegmentLength(lineLengthMeters(coords), options.lengthUnit),
        rotate: 0,
        sort: 0,
      };
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords[coords.length - 1]! },
        properties: props,
      });
    }
    return out;
  }
  if (g.type === 'Polygon' && Array.isArray(g.coordinates) && Array.isArray(g.coordinates[0])) {
    const ring = (g.coordinates[0] as unknown[]).filter(isPos);
    const out: GeoJSON.Feature[] = [];
    if (options.lengths && ring.length >= 2) {
      // While a polygon is still being drawn the ring is not closed
      // yet; label the sides that exist.
      out.push(...segmentLabels(ring, options.lengthUnit));
    }
    if (options.area && openRing(ring).length >= 3) {
      const at = ringLabelPoint(ring);
      const sqm = ringAreaSquareMeters(ring);
      if (at && sqm > 0) {
        const props: DimensionLabelProps = {
          role: 'area',
          text: formatAreaIn(sqm, options.areaUnit),
          rotate: 0,
          sort: 0,
        };
        out.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: at },
          properties: props,
        });
      }
    }
    return out;
  }
  return [];
}

/**
 * Scale a ring about its middle so its geodesic area becomes
 * `targetSqm`, keeping its shape and position. One pass gets close;
 * it repeats a few times because the geodesic area of a scaled ring
 * is not exactly the square of the factor. Returns null when the
 * ring has no area to scale.
 */
export function scaleRingToArea(ring: Pos[], targetSqm: number): Pos[] | null {
  if (!(targetSqm > 0) || !Number.isFinite(targetSqm)) return null;
  const closed =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1];
  const pts = openRing(ring);
  if (pts.length < 3) return null;
  const c = ringLabelPoint(pts);
  if (!c) return null;
  const close = (open: Pos[]): Pos[] => [...open, open[0]!];
  // The same factor on both axes keeps the shape in the local flat
  // projection around the middle (the cos(latitude) term cancels).
  const scaleBy = (from: Pos[], k: number): Pos[] =>
    from.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  let current = pts;
  for (let i = 0; i < 4; i++) {
    const area = ringAreaSquareMeters(close(current));
    if (!(area > 0)) return null;
    const k = Math.sqrt(targetSqm / area);
    if (Math.abs(k - 1) < 1e-9) break;
    current = scaleBy(current, k);
    if (current.some((p) => Math.abs(p[1]) > 89 || Math.abs(p[0]) > 180)) return null;
  }
  return closed ? close(current) : current;
}
