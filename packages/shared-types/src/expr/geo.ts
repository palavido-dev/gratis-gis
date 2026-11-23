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

// ---- Spatial predicates for the offline evaluator ------------------
//
// Planar tests in degrees, matching ST_Intersects / ST_Covers on
// EPSG:4326 geometry, and spherical distance matching
// ST_Distance(geography, geography, false). Written for the field
// app's offline cache, where a layer is at most tens of thousands of
// rows; there is no spatial index.

interface Parts {
  points: Pos[];
  segments: Array<[Pos, Pos]>;
  polygons: Pos[][][];
}

export function geometryParts(g: Geometry | null): Parts {
  const out: Parts = { points: [], segments: [], polygons: [] };
  const line = (cs: Pos[]) => {
    for (let i = 1; i < cs.length; i += 1) out.segments.push([cs[i - 1]!, cs[i]!]);
    if (cs.length === 1) out.points.push(cs[0]!);
  };
  const visit = (x: Geometry | null) => {
    if (!x) return;
    switch (x.type) {
      case 'Point':
        out.points.push(x.coordinates as Pos);
        break;
      case 'MultiPoint':
        out.points.push(...(x.coordinates as Pos[]));
        break;
      case 'LineString':
        line(x.coordinates as Pos[]);
        break;
      case 'MultiLineString':
        (x.coordinates as Pos[][]).forEach(line);
        break;
      case 'Polygon':
        out.polygons.push(x.coordinates as Pos[][]);
        (x.coordinates as Pos[][]).forEach(line);
        break;
      case 'MultiPolygon':
        for (const p of x.coordinates as Pos[][][]) {
          out.polygons.push(p);
          p.forEach(line);
        }
        break;
      case 'GeometryCollection':
        (x.geometries ?? []).forEach(visit);
        break;
    }
  };
  visit(g);
  return out;
}

function vertices(p: Parts): Pos[] {
  const vs = [...p.points];
  for (const [a, b] of p.segments) vs.push(a, b);
  return vs;
}

function bboxOf(p: Parts): [number, number, number, number] | null {
  const vs = vertices(p);
  if (vs.length === 0) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const v of vs) {
    x0 = Math.min(x0, v[0]!);
    y0 = Math.min(y0, v[1]!);
    x1 = Math.max(x1, v[0]!);
    y1 = Math.max(y1, v[1]!);
  }
  return [x0, y0, x1, y1];
}

const cross = (o: Pos, a: Pos, b: Pos) =>
  (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);

function onSegment(p: Pos, a: Pos, b: Pos): boolean {
  return (
    Math.abs(cross(a, b, p)) <= 1e-12 &&
    p[0]! >= Math.min(a[0]!, b[0]!) - 1e-12 &&
    p[0]! <= Math.max(a[0]!, b[0]!) + 1e-12 &&
    p[1]! >= Math.min(a[1]!, b[1]!) - 1e-12 &&
    p[1]! <= Math.max(a[1]!, b[1]!) + 1e-12
  );
}

/** Segments share any point. */
function segmentsTouch(a: Pos, b: Pos, c: Pos, d: Pos): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}

/** Segments cross at a point interior to both. */
function segmentsCross(a: Pos, b: Pos, c: Pos, d: Pos): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function inRing(p: Pos, ring: Pos[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > p[1]! !== yj > p[1]! && p[0]! < ((xj - xi) * (p[1]! - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function onRing(p: Pos, ring: Pos[]): boolean {
  for (let i = 1; i < ring.length; i += 1) if (onSegment(p, ring[i - 1]!, ring[i]!)) return true;
  return false;
}

/** 'in', 'on' (boundary) or 'out' for one polygon with holes. */
function pointInPolygon(p: Pos, poly: Pos[][]): 'in' | 'on' | 'out' {
  if (poly.length === 0) return 'out';
  if (onRing(p, poly[0]!)) return 'on';
  if (!inRing(p, poly[0]!)) return 'out';
  for (const hole of poly.slice(1)) {
    if (onRing(p, hole)) return 'on';
    if (inRing(p, hole)) return 'out';
  }
  return 'in';
}

function pointCoveredBy(p: Pos, parts: Parts): boolean {
  if (parts.polygons.some((poly) => pointInPolygon(p, poly) !== 'out')) return true;
  if (parts.segments.some(([a, b]) => onSegment(p, a, b))) return true;
  return parts.points.some((q) => q[0] === p[0] && q[1] === p[1]);
}

function boxesMeet(a: Parts, b: Parts): boolean {
  const x = bboxOf(a);
  const y = bboxOf(b);
  if (!x || !y) return false;
  return x[0] <= y[2] && y[0] <= x[2] && x[1] <= y[3] && y[1] <= x[3];
}

export function intersects(a: Geometry | null, b: Geometry | null): boolean {
  const pa = geometryParts(a);
  const pb = geometryParts(b);
  if (!boxesMeet(pa, pb)) return false;
  for (const [s, t] of pa.segments) {
    for (const [u, v] of pb.segments) if (segmentsTouch(s, t, u, v)) return true;
  }
  if (vertices(pa).some((p) => pointCoveredBy(p, pb))) return true;
  if (vertices(pb).some((p) => pointCoveredBy(p, pa))) return true;
  return false;
}

/** Every point of b lies in a (ST_Covers). */
export function covers(a: Geometry | null, b: Geometry | null): boolean {
  const pa = geometryParts(a);
  const pb = geometryParts(b);
  if (!boxesMeet(pa, pb)) return false;
  const vb = vertices(pb);
  if (vb.length === 0) return false;
  if (!vb.every((p) => pointCoveredBy(p, pa))) return false;
  if (pa.polygons.length === 0) {
    // A line or points can only cover what lies on them.
    return pb.segments.every(([s, t]) => pa.segments.some(([u, v]) => onSegment(s, u, v) && onSegment(t, u, v)));
  }
  // An edge of b leaving a crosses its boundary somewhere.
  for (const [s, t] of pb.segments) {
    for (const [u, v] of pa.segments) if (segmentsCross(s, t, u, v)) return false;
    const mid: Pos = [(s[0]! + t[0]!) / 2, (s[1]! + t[1]!) / 2];
    if (!pointCoveredBy(mid, pa)) return false;
  }
  return true;
}

/** Great-circle distance from p to segment a-b, in meters. */
function pointSegmentDistance(p: Pos, a: Pos, b: Pos): number {
  const toVec = (q: Pos) => {
    const lat = rad(q[1]!);
    const lon = rad(q[0]!);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)] as const;
  };
  const P = toVec(p);
  const A = toVec(a);
  const B = toVec(b);
  const n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const nl = Math.hypot(n[0]!, n[1]!, n[2]!);
  if (nl < 1e-15) return Math.min(haversine(p, a), haversine(p, b));
  const N = n.map((x) => x / nl) as [number, number, number];
  const dot = P[0] * N[0] + P[1] * N[1] + P[2] * N[2];
  // Closest point on the great circle, then check it lies between A and B.
  const C = [P[0] - dot * N[0], P[1] - dot * N[1], P[2] - dot * N[2]];
  const cl = Math.hypot(C[0]!, C[1]!, C[2]!);
  if (cl < 1e-15) return Math.min(haversine(p, a), haversine(p, b));
  const Cn = C.map((x) => x / cl) as [number, number, number];
  const ab = Math.acos(Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const ac = Math.acos(Math.min(1, A[0] * Cn[0] + A[1] * Cn[1] + A[2] * Cn[2]));
  const cb = Math.acos(Math.min(1, Cn[0] * B[0] + Cn[1] * B[1] + Cn[2] * B[2]));
  if (Math.abs(ac + cb - ab) < 1e-9) {
    return EARTH_RADIUS_M * Math.asin(Math.min(1, Math.abs(dot)));
  }
  return Math.min(haversine(p, a), haversine(p, b));
}

/** Shortest distance in meters on the sphere; 0 when they meet. */
export function geodesicDistance(a: Geometry | null, b: Geometry | null): number | null {
  const pa = geometryParts(a);
  const pb = geometryParts(b);
  const va = vertices(pa);
  const vb = vertices(pb);
  if (va.length === 0 || vb.length === 0) return null;
  if (intersects(a, b)) return 0;
  let best = Infinity;
  for (const p of va) {
    for (const q of pb.points) best = Math.min(best, haversine(p, q));
    for (const [s, t] of pb.segments) best = Math.min(best, pointSegmentDistance(p, s, t));
  }
  for (const p of vb) {
    for (const q of pa.points) best = Math.min(best, haversine(p, q));
    for (const [s, t] of pa.segments) best = Math.min(best, pointSegmentDistance(p, s, t));
  }
  return best;
}
