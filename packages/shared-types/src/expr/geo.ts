// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Geodesic measures on a sphere, matching PostGIS's
 * `ST_Area(geog, false)`, `ST_Length(geog, false)` and
 * `ST_Distance(geog, geog, false)`, which use a sphere of the WGS84
 * mean radius. The planar centroid matches `ST_Centroid(geometry)`.
 *
 * GeoJSON coordinates are [longitude, latitude] in degrees.
 */

export const EARTH_RADIUS_M = 6371008.771415;

type Pos = number[];
export interface Geometry {
  type: string;
  coordinates?: unknown;
  geometries?: Geometry[];
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversine(a: Pos, b: Pos): number {
  const dLat = rad(b[1]! - a[1]!);
  const dLon = rad(b[0]! - a[0]!);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1]!)) * Math.cos(rad(b[1]!)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords: Pos[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += haversine(coords[i - 1]!, coords[i]!);
  return total;
}

/** Signed spherical area of a ring in square meters. */
function ringArea(coords: Pos[]): number {
  const n = coords.length;
  if (n < 4) return 0;
  // Exact spherical excess, edge by edge: each edge contributes the
  // signed area of the triangle it forms with the pole.
  let total = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = coords[i]!;
    const p2 = coords[i + 1]!;
    const t1 = Math.tan(rad(p1[1]!) / 2);
    const t2 = Math.tan(rad(p2[1]!) / 2);
    const dl = rad(p2[0]! - p1[0]!);
    total += 2 * Math.atan2(Math.tan(dl / 2) * (t1 + t2), 1 + t1 * t2);
  }
  return total * EARTH_RADIUS_M * EARTH_RADIUS_M;
}

function polygonArea(rings: Pos[][]): number {
  if (rings.length === 0) return 0;
  let a = Math.abs(ringArea(rings[0]!));
  for (const hole of rings.slice(1)) a -= Math.abs(ringArea(hole));
  return a;
}

export function geodesicArea(g: Geometry | null): number {
  if (!g) return 0;
  switch (g.type) {
    case 'Polygon':
      return polygonArea(g.coordinates as Pos[][]);
    case 'MultiPolygon':
      return (g.coordinates as Pos[][][]).reduce((s, p) => s + polygonArea(p), 0);
    case 'GeometryCollection':
      return (g.geometries ?? []).reduce((s, x) => s + geodesicArea(x), 0);
    default:
      return 0;
  }
}

/** Line length, or perimeter for polygons; 0 for points. */
export function geodesicLength(g: Geometry | null): number {
  if (!g) return 0;
  switch (g.type) {
    case 'LineString':
      return lineLength(g.coordinates as Pos[]);
    case 'MultiLineString':
      return (g.coordinates as Pos[][]).reduce((s, l) => s + lineLength(l), 0);
    case 'Polygon':
      return (g.coordinates as Pos[][]).reduce((s, r) => s + lineLength(r), 0);
    case 'MultiPolygon':
      return (g.coordinates as Pos[][][]).reduce(
        (s, p) => s + p.reduce((t, r) => t + lineLength(r), 0),
        0,
      );
    case 'GeometryCollection':
      return (g.geometries ?? []).reduce((s, x) => s + geodesicLength(x), 0);
    default:
      return 0;
  }
}

/** Planar centroid in degrees, by the highest dimension present. */
export function centroid(g: Geometry | null): Pos | null {
  if (!g) return null;
  const polys: Pos[][][] = [];
  const lines: Pos[][] = [];
  const points: Pos[] = [];
  const collect = (x: Geometry) => {
    switch (x.type) {
      case 'Point':
        points.push(x.coordinates as Pos);
        break;
      case 'MultiPoint':
        points.push(...(x.coordinates as Pos[]));
        break;
      case 'LineString':
        lines.push(x.coordinates as Pos[]);
        break;
      case 'MultiLineString':
        lines.push(...(x.coordinates as Pos[][]));
        break;
      case 'Polygon':
        polys.push(x.coordinates as Pos[][]);
        break;
      case 'MultiPolygon':
        polys.push(...(x.coordinates as Pos[][][]));
        break;
      case 'GeometryCollection':
        (x.geometries ?? []).forEach(collect);
        break;
    }
  };
  collect(g);
  if (polys.length > 0) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (const poly of polys) {
      poly.forEach((ring, idx) => {
        // Shoelace on each ring; holes subtract by orientation.
        let ra = 0;
        let rx = 0;
        let ry = 0;
        for (let i = 0; i < ring.length - 1; i += 1) {
          const [x0, y0] = ring[i] as [number, number];
          const [x1, y1] = ring[i + 1] as [number, number];
          const f = x0 * y1 - x1 * y0;
          ra += f;
          rx += (x0 + x1) * f;
          ry += (y0 + y1) * f;
        }
        const sign = (idx === 0 ? 1 : -1) * Math.sign(ra || 1);
        a += sign * ra;
        cx += sign * rx;
        cy += sign * ry;
      });
    }
    if (a !== 0) return [cx / (3 * a), cy / (3 * a)];
  }
  if (lines.length > 0) {
    let len = 0;
    let cx = 0;
    let cy = 0;
    for (const line of lines) {
      for (let i = 1; i < line.length; i += 1) {
        const [x0, y0] = line[i - 1] as [number, number];
        const [x1, y1] = line[i] as [number, number];
        const l = Math.hypot(x1 - x0, y1 - y0);
        len += l;
        cx += ((x0 + x1) / 2) * l;
        cy += ((y0 + y1) / 2) * l;
      }
    }
    if (len > 0) return [cx / len, cy / len];
  }
  if (points.length > 0) {
    const sx = points.reduce((s, p) => s + p[0]!, 0);
    const sy = points.reduce((s, p) => s + p[1]!, 0);
    return [sx / points.length, sy / points.length];
  }
  return null;
}

export const LENGTH_UNITS: Record<string, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  'us-survey-feet': 1200 / 3937,
  yards: 0.9144,
  miles: 1609.344,
  'nautical-miles': 1852,
};

export const AREA_UNITS: Record<string, number> = {
  'square-meters': 1,
  'square-kilometers': 1e6,
  'square-feet': 0.09290304,
  'square-yards': 0.83612736,
  'square-miles': 2589988.110336,
  acres: 4046.8564224,
  hectares: 10000,
};

const LENGTH_ALIASES: Record<string, string> = {
  m: 'meters',
  meter: 'meters',
  metres: 'meters',
  km: 'kilometers',
  kilometer: 'kilometers',
  ft: 'feet',
  foot: 'feet',
  yd: 'yards',
  yard: 'yards',
  mi: 'miles',
  mile: 'miles',
  nm: 'nautical-miles',
};
const AREA_ALIASES: Record<string, string> = {
  'square-meter': 'square-meters',
  sqm: 'square-meters',
  'square-kilometer': 'square-kilometers',
  'square-foot': 'square-feet',
  sqft: 'square-feet',
  'square-mile': 'square-miles',
  acre: 'acres',
  ac: 'acres',
  hectare: 'hectares',
  ha: 'hectares',
};

export function lengthUnit(u: string): string | null {
  const k = u.trim().toLowerCase().replace(/[ _]/g, '-');
  const n = LENGTH_ALIASES[k] ?? k;
  return n in LENGTH_UNITS ? n : null;
}
export function areaUnit(u: string): string | null {
  const k = u.trim().toLowerCase().replace(/[ _]/g, '-');
  const n = AREA_ALIASES[k] ?? k;
  return n in AREA_UNITS ? n : null;
}
