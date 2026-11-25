// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * GeoJSON to Esri JSON geometry, for query responses, and Esri JSON to
 * a GeoJSON filter geometry, for the `geometry` query parameter.
 */

type Pos = number[];

export type EsriGeometryType =
  | 'esriGeometryPoint'
  | 'esriGeometryMultipoint'
  | 'esriGeometryPolyline'
  | 'esriGeometryPolygon';

/** The Esri geometry type of a layer, or null for a table. */
export function esriGeometryType(layerGeometry: unknown): EsriGeometryType | null {
  switch (layerGeometry) {
    case 'point':
      return 'esriGeometryPoint';
    case 'line':
      return 'esriGeometryPolyline';
    case 'polygon':
      return 'esriGeometryPolygon';
    case null:
      return null;
    default:
      // A layer missing its geometry type is spatial, as everywhere
      // else in the portal. Polygon is the widest guess for drawing.
      return 'esriGeometryPolygon';
  }
}

/** Twice the signed area: positive when the ring runs counterclockwise. */
function signedArea2(ring: Pos[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return a;
}

/** Esri wants outer rings clockwise and holes counterclockwise; GeoJSON is the reverse. */
function orient(ring: Pos[], clockwise: boolean): Pos[] {
  const ccw = signedArea2(ring) > 0;
  return ccw === clockwise ? [...ring].reverse() : ring;
}

function polygonRings(rings: Pos[][]): Pos[][] {
  return rings.map((r, i) => orient(r, i === 0));
}

function xy(p: Pos): Pos {
  return p.length > 2 ? [p[0]!, p[1]!] : p;
}

/**
 * Convert a GeoJSON geometry to Esri JSON for a layer of `type`. A
 * geometry that cannot be shown as that type comes back null rather
 * than as a shape the client would misread.
 */
export function geojsonToEsri(
  g: { type?: string; coordinates?: unknown; geometries?: unknown } | null | undefined,
  type: EsriGeometryType,
): Record<string, unknown> | null {
  if (!g || typeof g.type !== 'string') return null;
  const c = g.coordinates as never;
  switch (type) {
    case 'esriGeometryPoint': {
      if (g.type === 'Point') {
        const p = c as Pos;
        return { x: p[0], y: p[1] };
      }
      // A point layer holding a multipoint shows its first point.
      if (g.type === 'MultiPoint' && (c as Pos[]).length > 0) {
        const p = (c as Pos[])[0]!;
        return { x: p[0], y: p[1] };
      }
      return null;
    }
    case 'esriGeometryMultipoint': {
      if (g.type === 'Point') return { points: [xy(c as Pos)] };
      if (g.type === 'MultiPoint') return { points: (c as Pos[]).map(xy) };
      return null;
    }
    case 'esriGeometryPolyline': {
      if (g.type === 'LineString') return { paths: [(c as Pos[]).map(xy)] };
      if (g.type === 'MultiLineString') return { paths: (c as Pos[][]).map((l) => l.map(xy)) };
      return null;
    }
    case 'esriGeometryPolygon': {
      if (g.type === 'Polygon') return { rings: polygonRings((c as Pos[][]).map((r) => r.map(xy))) };
      if (g.type === 'MultiPolygon') {
        return {
          rings: (c as Pos[][][]).flatMap((poly) => polygonRings(poly.map((r) => r.map(xy)))),
        };
      }
      return null;
    }
  }
}

/** Most vertices accepted in a filter geometry. */
export const MAX_FILTER_VERTICES = 50_000;

export interface FilterGeometry {
  /** GeoJSON text in the filter's own spatial reference. */
  geojson: string;
  /** Rings that still need ST_BuildArea to become a polygon. */
  rings: boolean;
  /** Spatial reference named inside the geometry, when it names one. */
  wkid: number | null;
}

function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

function nums(a: unknown, what: string): number[] {
  if (!Array.isArray(a) || a.length < 2 || !a.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw bad(`The ${what} in the geometry is not a list of numbers.`);
  }
  return [a[0] as number, a[1] as number];
}

function srOf(g: { spatialReference?: unknown }): number | null {
  const sr = g.spatialReference as { wkid?: unknown; latestWkid?: unknown } | undefined;
  const w = sr?.latestWkid ?? sr?.wkid;
  return typeof w === 'number' ? w : null;
}

/**
 * Parse the `geometry` query parameter: Esri JSON, or the short forms
 * `xmin,ymin,xmax,ymax` (an envelope) and `x,y` (a point).
 */
export function parseFilterGeometry(raw: string, geometryType: string | undefined): FilterGeometry {
  const text = raw.trim();
  const type = geometryType?.trim() || 'esriGeometryEnvelope';
  if (/^-?[\d.eE+-]+(\s*,\s*-?[\d.eE+-]+)+$/.test(text)) {
    const n = text.split(',').map((s) => Number(s.trim()));
    if (n.some((v) => !Number.isFinite(v))) throw bad('The geometry is not a list of numbers.');
    if (n.length === 4) return envelope(n[0]!, n[1]!, n[2]!, n[3]!, null);
    if (n.length === 2) return { geojson: JSON.stringify({ type: 'Point', coordinates: n }), rings: false, wkid: null };
    throw bad('A short geometry is "xmin,ymin,xmax,ymax" or "x,y".');
  }
  let g: Record<string, unknown>;
  try {
    g = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw bad('The geometry is not valid JSON.');
  }
  if (!g || typeof g !== 'object') throw bad('The geometry is not an object.');
  const wkid = srOf(g);
  let vertices = 0;
  const count = (n: number): void => {
    vertices += n;
    if (vertices > MAX_FILTER_VERTICES) {
      throw bad(`The geometry has more than ${MAX_FILTER_VERTICES} vertices.`);
    }
  };
  switch (type) {
    case 'esriGeometryEnvelope': {
      const { xmin, ymin, xmax, ymax } = g as Record<string, unknown>;
      if (![xmin, ymin, xmax, ymax].every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw bad('An envelope needs numeric xmin, ymin, xmax and ymax.');
      }
      return envelope(xmin as number, ymin as number, xmax as number, ymax as number, wkid);
    }
    case 'esriGeometryPoint': {
      const p = nums([g.x, g.y], 'point');
      return { geojson: JSON.stringify({ type: 'Point', coordinates: p }), rings: false, wkid };
    }
    case 'esriGeometryMultipoint': {
      const pts = Array.isArray(g.points) ? g.points : [];
      if (pts.length === 0) throw bad('A multipoint needs points.');
      count(pts.length);
      return {
        geojson: JSON.stringify({ type: 'MultiPoint', coordinates: pts.map((p) => nums(p, 'point')) }),
        rings: false,
        wkid,
      };
    }
    case 'esriGeometryPolyline':
    case 'esriGeometryPolygon': {
      const key = type === 'esriGeometryPolyline' ? 'paths' : 'rings';
      const parts = Array.isArray(g[key]) ? (g[key] as unknown[]) : [];
      if (parts.length === 0) throw bad(`A ${key === 'paths' ? 'polyline' : 'polygon'} needs ${key}.`);
      const lines = parts.map((part) => {
        if (!Array.isArray(part) || part.length < 2) throw bad(`Each of the ${key} needs two or more points.`);
        count(part.length);
        return part.map((p) => nums(p, 'point'));
      });
      // Rings become one MultiLineString; ST_BuildArea turns it into
      // polygons with their holes, whichever way each ring runs.
      return {
        geojson: JSON.stringify({ type: 'MultiLineString', coordinates: lines }),
        rings: key === 'rings',
        wkid,
      };
    }
    default:
      throw bad(`geometryType ${type} is not supported.`);
  }
}

function envelope(xmin: number, ymin: number, xmax: number, ymax: number, wkid: number | null): FilterGeometry {
  const [x0, x1] = xmin <= xmax ? [xmin, xmax] : [xmax, xmin];
  const [y0, y1] = ymin <= ymax ? [ymin, ymax] : [ymax, ymin];
  return {
    geojson: JSON.stringify({
      type: 'Polygon',
      coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    }),
    rings: false,
    wkid,
  };
}
