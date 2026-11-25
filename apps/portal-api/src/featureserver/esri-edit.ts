// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GeoJsonGeometry } from '@gratis-gis/engine';

import type { EsriLayerSchema } from './esri-fields.js';
import type { EsriGeometryType } from './esri-geometry.js';

/**
 * Esri edits (applyEdits, addFeatures, updateFeatures) as GeoJSON and
 * stored attributes. A problem with one feature throws EditError with
 * Esri's error code, so the caller can fail that feature alone.
 */

export class EditError extends Error {
  constructor(
    message: string,
    readonly code = 1000,
  ) {
    super(message);
  }
}

type Pos = [number, number];

function pos(p: unknown): Pos {
  if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
    throw new EditError('The geometry has a point that is not two numbers.');
  }
  return [p[0], p[1]];
}

/** Twice the signed area; positive when counterclockwise (y up). */
function area2(r: Pos[]): number {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1];
  return a;
}

function closed(r: Pos[]): Pos[] {
  const a = r[0]!;
  const b = r[r.length - 1]!;
  return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
}

function inside(p: Pos, ring: Pos[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Esri rings to GeoJSON polygons. Esri draws outer rings clockwise and
 * holes counterclockwise; each hole joins the outer ring that holds it.
 * GeoJSON wants the opposite winding, so every ring is turned over.
 */
function ringsToGeojson(rings: Pos[][]): GeoJsonGeometry {
  const outers: Pos[][][] = [];
  const holes: Pos[][] = [];
  for (const raw of rings) {
    const r = closed(raw);
    if (r.length < 4) throw new EditError('A polygon ring needs at least three points.');
    if (area2(r) < 0) outers.push([[...r].reverse()]);
    else holes.push(r);
  }
  if (outers.length === 0) {
    // Every ring runs counterclockwise: a client that ignores Esri's
    // winding. Read each ring as an outer ring.
    for (const h of holes.splice(0)) outers.push([h]);
  }
  for (const h of holes) {
    const home = outers.find((o) => inside(h[0]!, o[0]!)) ?? outers[0]!;
    home.push([...h].reverse());
  }
  return outers.length === 1
    ? ({ type: 'Polygon', coordinates: outers[0]! } as GeoJsonGeometry)
    : ({ type: 'MultiPolygon', coordinates: outers } as GeoJsonGeometry);
}

/** An Esri geometry as GeoJSON, for a layer of `type`. Null stays null. */
export function esriToGeojson(g: unknown, type: EsriGeometryType): GeoJsonGeometry | null {
  if (g === null || g === undefined) return null;
  if (typeof g !== 'object') throw new EditError('The geometry is not an object.');
  const o = g as Record<string, unknown>;
  if (o.isEmpty === true) return null;
  if (typeof o.x === 'number') {
    if (o.x !== o.x || typeof o.y !== 'number') return null; // NaN: Esri's empty point
    return { type: 'Point', coordinates: pos([o.x, o.y]) } as GeoJsonGeometry;
  }
  if (Array.isArray(o.points)) {
    const pts = o.points.map(pos);
    if (pts.length === 0) return null;
    return (type === 'esriGeometryPoint' && pts.length === 1
      ? { type: 'Point', coordinates: pts[0]! }
      : { type: 'MultiPoint', coordinates: pts }) as GeoJsonGeometry;
  }
  if (Array.isArray(o.paths)) {
    const paths = o.paths.map((p) => {
      if (!Array.isArray(p) || p.length < 2) throw new EditError('A line needs two or more points.');
      return p.map(pos);
    });
    if (paths.length === 0) return null;
    return (paths.length === 1
      ? { type: 'LineString', coordinates: paths[0]! }
      : { type: 'MultiLineString', coordinates: paths }) as GeoJsonGeometry;
  }
  if (Array.isArray(o.rings)) {
    const rings = o.rings.map((r) => {
      if (!Array.isArray(r)) throw new EditError('A polygon ring is not a list of points.');
      return r.map(pos);
    });
    if (rings.length === 0) return null;
    return ringsToGeojson(rings);
  }
  if (o.curvePaths || o.curveRings) throw new EditError('Curved geometry is not supported. Densify it first.');
  throw new EditError('The geometry is not a point, multipoint, polyline or polygon.');
}

/** The spatial reference named on an edit's geometry, as an EPSG code. */
export function geometryWkid(g: unknown): number | null {
  const sr = (g as { spatialReference?: { wkid?: unknown; latestWkid?: unknown } } | null)?.spatialReference;
  const w = sr?.latestWkid ?? sr?.wkid;
  if (typeof w !== 'number') return null;
  return w === 102100 || w === 102113 || w === 900913 ? 3857 : w;
}

/**
 * Esri attributes to stored properties. The ObjectID and GlobalID are
 * read by the caller, not stored. A field the layer does not have is
 * an error: silently dropping it would lose what the user typed.
 */
export function fromEsriAttributes(schema: EsriLayerSchema, attrs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (attrs === null || attrs === undefined) return out;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) throw new EditError('attributes must be an object.');
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    const f = schema.byLower.get(k.toLowerCase());
    if (!f) throw new EditError(`The layer has no field named "${k}".`);
    if (f.kind === 'oid' || f.kind === 'globalid') continue;
    const key = f.attr!;
    if (v === null || v === undefined) {
      out[key] = null;
      continue;
    }
    switch (f.kind) {
      case 'integer':
      case 'double': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(n)) throw new EditError(`${f.name} is a number field; "${String(v)}" is not a number.`);
        out[key] = n;
        break;
      }
      case 'boolean':
        if (v === 1 || v === true || v === '1' || v === 'true') out[key] = true;
        else if (v === 0 || v === false || v === '0' || v === 'false') out[key] = false;
        else throw new EditError(`${f.name} takes 0 or 1.`);
        break;
      case 'date': {
        const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
        if (!Number.isFinite(ms)) throw new EditError(`${f.name} is a date field; "${String(v)}" is not a date.`);
        out[key] = new Date(ms).toISOString();
        break;
      }
      case 'multi':
        out[key] = Array.isArray(v)
          ? v.map((x) => String(x))
          : String(v).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        break;
      default:
        out[key] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return out;
}

/** Read an edit list parameter: JSON text or an already parsed array. */
export function editList(raw: unknown, name: string): unknown[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new EditError(`${name} is not valid JSON.`, 400);
    }
  }
  if (!Array.isArray(v)) throw new EditError(`${name} must be a list.`, 400);
  return v;
}
