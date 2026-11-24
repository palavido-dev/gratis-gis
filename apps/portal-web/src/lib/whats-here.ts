// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as maplibregl from 'maplibre-gl';

import { parseApiError } from '@/lib/api-error';
import { AreaExpiredError, fetchAggregate } from '@/lib/layer-aggregate';
import type { AreaUnit, DistanceUnit } from '@/lib/measure';

/**
 * What's Here (#796): pick an area, see what every layer has inside it.
 *
 * This module is the plumbing the panel and the app widget share: the
 * area registration, the per-layer screen, the unit maths and the CSV.
 * It holds no React so it can be tested on its own.
 */

/** The geometry family of a layer, which decides what gets measured. */
export type ScreenGeometry = 'point' | 'line' | 'polygon';

export interface ScreenLayer {
  /** MapLayer.id in the map, so results can point back at it. */
  mapLayerId: string;
  title: string;
  itemId: string;
  layerKey: string;
  geometry: ScreenGeometry | null;
  /** Fields a result can be broken down by. */
  categoryFields: Array<{ name: string; label: string }>;
  /** Number fields a result can add up. */
  numberFields: Array<{ name: string; label: string }>;
}

export interface ResolvedArea {
  id: string;
  geometry: GeoJSON.Geometry;
  squareMeters: number;
  bbox: [number, number, number, number];
}

/** One row of a screen: a whole layer, or one value of a breakdown. */
export interface ScreenRow {
  /** null for the whole-layer row and for a breakdown's empty value. */
  value: string | null;
  count: number;
  /** m² for polygons, m for lines, null for points. */
  measure: number | null;
  /** Field name to its total over the features that touch the area.
   *  Whole values: a feature half inside still adds all of its value. */
  sums?: Record<string, number | null>;
}

/** Number fields one layer's results add up, at most. */
export const MAX_SUM_FIELDS = 10;

/** Layers one PDF covers. Same as MAX_REPORT_LAYERS on the server. */
export const MAX_REPORT_LAYERS = 200;

export interface LayerScreen {
  total: ScreenRow;
  /** The number fields added up, in the order they were picked. */
  sumFields?: string[];
  /** Present when a breakdown field was asked for. */
  breakdown?: { field: string; rows: ScreenRow[]; truncated: boolean };
}

/** The user's measurement system, from their profile. */
export type UnitSystem = 'metric' | 'imperial';

/**
 * Distances offered as one tap, in the units the user thinks in. The
 * custom box takes any distance in any unit either way.
 */
export const DISTANCE_PRESETS: Record<UnitSystem, ReadonlyArray<{ key: string; meters: number }>> = {
  imperial: [
    { key: 'none', meters: 0 },
    { key: 'ft100', meters: 30.48 },
    { key: 'ft500', meters: 152.4 },
    { key: 'mi025', meters: 402.336 },
    { key: 'mi1', meters: 1609.344 },
  ],
  metric: [
    { key: 'none', meters: 0 },
    { key: 'm25', meters: 25 },
    { key: 'm100', meters: 100 },
    { key: 'm500', meters: 500 },
    { key: 'km1', meters: 1000 },
  ],
};

/**
 * What a bare point or address gets as its first distance: a point on
 * its own only finds what lies under it, which is rarely the question.
 */
export const POINT_DEFAULT_METERS: Record<UnitSystem, number> = {
  imperial: 152.4,
  metric: 150,
};

export interface ScreenUnits {
  areaUnit: AreaUnit;
  lengthUnit: DistanceUnit;
}

const UNIT_DEFAULTS: Record<UnitSystem, ScreenUnits> = {
  imperial: { areaUnit: 'acres', lengthUnit: 'feet' },
  metric: { areaUnit: 'hectares', lengthUnit: 'meters' },
};

/** Same profile key the map's area scale reads (lib/map-area-scale). */
const PROFILE_UNITS_KEY = 'gg-profile-units';
const STORED_UNITS_KEY = 'gg-whats-here-units';

const AREA_UNITS: readonly AreaUnit[] = [
  'square-meters',
  'hectares',
  'square-kilometers',
  'square-feet',
  'acres',
  'square-miles',
];
const LENGTH_UNITS: readonly DistanceUnit[] = ['meters', 'kilometers', 'feet', 'miles'];

/** The profile's metric/imperial choice. Unset reads as imperial,
 *  matching the map's scale bar. */
export function profileUnitSystem(): UnitSystem {
  try {
    return window.localStorage.getItem(PROFILE_UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
  } catch {
    return 'imperial';
  }
}

/**
 * The units a screen opens with. In order: what this user last picked
 * here, what the author set for this app, the profile's system.
 */
export function initialUnits(args: {
  system: UnitSystem;
  author?: { areaUnit?: AreaUnit | undefined; lengthUnit?: DistanceUnit | undefined };
}): ScreenUnits {
  const fallback = UNIT_DEFAULTS[args.system];
  const base: ScreenUnits = {
    areaUnit: args.author?.areaUnit ?? fallback.areaUnit,
    lengthUnit: args.author?.lengthUnit ?? fallback.lengthUnit,
  };
  try {
    const raw = window.localStorage.getItem(STORED_UNITS_KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Partial<Record<keyof ScreenUnits, unknown>>;
    return {
      areaUnit: AREA_UNITS.includes(stored.areaUnit as AreaUnit)
        ? (stored.areaUnit as AreaUnit)
        : base.areaUnit,
      lengthUnit: LENGTH_UNITS.includes(stored.lengthUnit as DistanceUnit)
        ? (stored.lengthUnit as DistanceUnit)
        : base.lengthUnit,
    };
  } catch {
    return base;
  }
}

export function rememberUnits(units: ScreenUnits): void {
  try {
    window.localStorage.setItem(STORED_UNITS_KEY, JSON.stringify(units));
  } catch {
    /* private mode: the choice lasts for this visit only */
  }
}

const METERS_PER: Record<DistanceUnit, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  miles: 1609.344,
};

/** Must match MAX_DISTANCE_METERS on the server (area-input.ts). */
export const MAX_DISTANCE_METERS = 100_000;

export function toMeters(value: number, unit: DistanceUnit): number {
  return value * METERS_PER[unit];
}

/** What the layer's measure means, or null when there is none. */
export function measureOpFor(geometry: ScreenGeometry | null): 'area' | 'length' | null {
  if (geometry === 'polygon') return 'area';
  if (geometry === 'line') return 'length';
  return null;
}

/**
 * Share of the area of interest a layer covers, 0 to 100. Null when
 * there is nothing sensible to divide by: a line layer, or an area
 * with no extent (a point with no distance).
 */
export function percentOfArea(
  measureSqm: number | null,
  areaSqm: number,
  geometry: ScreenGeometry | null,
): number | null {
  if (geometry !== 'polygon' || measureSqm === null || areaSqm <= 0) return null;
  // Overlapping features in one layer can sum past the area itself.
  // Cap it: "over 100% of the site is wetland" is never what is meant.
  return Math.min(100, (measureSqm / areaSqm) * 100);
}

/**
 * Join picked shapes into one geometry for registration. The server
 * unions them, so overlaps count once.
 */
export function pickedAreaGeometry(shapes: GeoJSON.Geometry[]): GeoJSON.Geometry | null {
  if (shapes.length === 0) return null;
  if (shapes.length === 1) return shapes[0]!;
  return { type: 'GeometryCollection', geometries: shapes };
}

export async function registerArea(
  geometry: GeoJSON.Geometry,
  distanceMeters: number,
  failure: string,
  signal?: AbortSignal,
): Promise<ResolvedArea> {
  const res = await fetch('/api/portal/areas-of-interest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ geometry, distanceMeters }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await parseApiError(res, failure));
  return (await res.json()) as ResolvedArea;
}

function rowFrom(
  values: Record<string, number | null>,
  op: 'area' | 'length' | null,
  value: string | null,
  sumFields: string[],
): ScreenRow {
  return {
    value,
    count: values.count ?? 0,
    measure: op ? (values[op] ?? 0) : null,
    ...(sumFields.length > 0
      ? { sums: Object.fromEntries(sumFields.map((f) => [f, values[`sum:${f}`] ?? null])) }
      : {}),
  };
}

/**
 * Screen one layer against an area. One request for the totals, and
 * one more when a breakdown is asked for. Throws AreaExpiredError when
 * the server no longer holds the area, so the caller can register the
 * shape again and retry.
 */
export async function screenLayer(args: {
  layer: ScreenLayer;
  areaId: string;
  breakdownField?: string | null;
  /** Number fields to add up. Names not on the layer are dropped. */
  sumFields?: string[];
  signal?: AbortSignal;
}): Promise<LayerScreen> {
  const op = measureOpFor(args.layer.geometry);
  const known = new Set(args.layer.numberFields.map((f) => f.name));
  const sumFields = (args.sumFields ?? []).filter((f) => known.has(f)).slice(0, MAX_SUM_FIELDS);
  const aggs: Array<{ op: 'count' | 'area' | 'length' | 'sum'; field?: string }> = [{ op: 'count' }];
  if (op) aggs.push({ op });
  for (const field of sumFields) aggs.push({ op: 'sum', field });
  const base = {
    itemId: args.layer.itemId,
    layerId: args.layer.layerKey,
    areaId: args.areaId,
    aggs,
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const field = args.breakdownField ?? null;
  const [whole, grouped] = await Promise.all([
    fetchAggregate(base),
    field ? fetchAggregate({ ...base, groupBy: [field], limit: 50 }) : null,
  ]);
  const total = rowFrom(whole.groups[0]?.values ?? {}, op, null, sumFields);
  const sumPart = sumFields.length > 0 ? { sumFields } : {};
  if (!field || !grouped) return { total, ...sumPart };
  return {
    total,
    ...sumPart,
    breakdown: {
      field,
      truncated: grouped.truncated,
      rows: grouped.groups
        .map((g) => rowFrom(g.values, op, g.key[field] ?? null, sumFields))
        // Biggest share first: the server orders by count, but for a
        // screen the acreage is the answer.
        .sort((a, b) => (b.measure ?? b.count) - (a.measure ?? a.count)),
    },
  };
}

export { AreaExpiredError };

function csvCell(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  // Quote anything with a delimiter, quote or line break, and anything
  // a spreadsheet would read as a formula. A value like =HYPERLINK()
  // from someone's data must stay text when the user opens the file.
  const formula = /^[=+\-@\t\r]/.test(s) && typeof v === 'string';
  if (formula || /[",\r\n]/.test(s)) {
    return `"${(formula ? `'${s}` : s).replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * The screen as a spreadsheet. One row per layer, then one per
 * breakdown value under it, with the measure in the units on screen
 * so the file matches what the user read.
 */
export function screenCsv(args: {
  area: { squareMeters: number; distanceMeters: number };
  layers: Array<{ layer: ScreenLayer; screen: LayerScreen }>;
  areaUnit: AreaUnit;
  lengthUnit: DistanceUnit;
  areaPerUnit: number;
  headers: {
    layer: string;
    category: string;
    count: string;
    area: string;
    length: string;
    percent: string;
    /** "Total {field}" for an added-up field's column. */
    sum: (label: string) => string;
  };
}): string {
  const lengthPer = METERS_PER[args.lengthUnit];
  const fmt = (n: number) => Number(n.toFixed(4));
  // One column per added-up field label, across every layer: layers
  // that share a field name (acres, population) share a column.
  const sumLabels: string[] = [];
  for (const { layer, screen } of args.layers) {
    for (const f of screen.sumFields ?? []) {
      const label = layer.numberFields.find((n) => n.name === f)?.label ?? f;
      if (!sumLabels.includes(label)) sumLabels.push(label);
    }
  }
  const lines: string[] = [];
  lines.push(
    [
      args.headers.layer,
      args.headers.category,
      args.headers.count,
      `${args.headers.area} (${args.areaUnit})`,
      `${args.headers.length} (${args.lengthUnit})`,
      args.headers.percent,
      ...sumLabels.map(args.headers.sum),
    ]
      .map(csvCell)
      .join(','),
  );
  const rowLine = (
    title: string,
    category: string | null,
    row: ScreenRow,
    geometry: ScreenGeometry | null,
    layer: ScreenLayer,
  ) => {
    const pct = percentOfArea(row.measure, args.area.squareMeters, geometry);
    const sumCells = sumLabels.map((label) => {
      const field = layer.numberFields.find((n) => n.label === label)?.name ?? label;
      const v = row.sums?.[field];
      return v === undefined || v === null ? null : fmt(v);
    });
    return [
      title,
      category,
      row.count,
      geometry === 'polygon' && row.measure !== null
        ? fmt(row.measure / args.areaPerUnit)
        : null,
      geometry === 'line' && row.measure !== null ? fmt(row.measure / lengthPer) : null,
      pct === null ? null : fmt(pct),
      ...sumCells,
    ]
      .map(csvCell)
      .join(',');
  };
  for (const { layer, screen } of args.layers) {
    lines.push(rowLine(layer.title, null, screen.total, layer.geometry, layer));
    for (const r of screen.breakdown?.rows ?? []) {
      lines.push(rowLine(layer.title, r.value ?? '', r, layer.geometry, layer));
    }
  }
  // CRLF and a BOM: Excel on Windows opens UTF-8 CSV correctly only
  // with the BOM, and names with accents are common in this data.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** What the report needs that the panel already knows. */
export interface ReportBody {
  areaId: string;
  distanceMeters: number;
  layers: Array<{
    itemId: string;
    layerKey: string;
    title: string;
    breakdownField?: string;
    sumFields?: string[];
  }>;
  areaUnit: AreaUnit;
  lengthUnit: DistanceUnit;
  paper: 'letter' | 'a4';
  locale: string;
  timeZone: string;
  labels: Record<string, string>;
  place?: string;
  picked: string[];
  mapImage?: string;
}

/**
 * Ask the server for the PDF. The server reads every layer again under
 * the caller's own access, so the body carries what to report on and
 * never a number. Throws AreaExpiredError when the area has lapsed.
 */
export async function requestReport(body: ReportBody, failure: string): Promise<Blob> {
  const res = await fetch('/api/portal/whats-here/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 410) throw new AreaExpiredError('This area has expired.');
  if (!res.ok) throw new Error(await parseApiError(res, failure));
  return res.blob();
}

/**
 * A picture of the map for the report, framed on the area. The camera
 * moves only when the area is not already in view, and goes back
 * after. Null when the canvas cannot be read (a basemap served without
 * CORS taints it): the report then goes out without a map.
 */
export async function snapshotMap(
  map: maplibregl.Map,
  bbox: [number, number, number, number],
): Promise<string | null> {
  const [w, s, e, n] = bbox;
  const view = map.getBounds();
  const inView = view.contains([w, s]) && view.contains([e, n]);
  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
  const settle = (event: 'idle' | 'render') =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 8000);
      map.once(event, () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  try {
    if (!inView) {
      const idle = settle('idle');
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 40, maxZoom: 18, duration: 0 },
      );
      await idle;
    }
    const rendered = settle('render');
    map.triggerRepaint();
    await rendered;
    return map.getCanvas().toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  } finally {
    if (!inView) map.jumpTo(camera);
  }
}

// ---- Share links ------------------------------------------------------

/** What a share link carries: the area as made, before the distance. */
export interface SharedArea {
  geometry: GeoJSON.Geometry;
  distanceMeters: number;
  place?: string;
  /** Map layer id to the field its results were broken down by. */
  breakdowns?: Record<string, string>;
  /** Map layer id to the number fields its results add up. */
  sums?: Record<string, string[]>;
}

/** The hash key: `#wh=<code>`. */
export const SHARE_HASH_KEY = 'wh';
/** Past this a link is cut off by chat apps and mail clients. */
const MAX_LINK_CODE = 32_000;
/** Largest decoded payload a link may carry. */
const MAX_DECODED = 2 * 1024 * 1024;

function roundCoords(value: unknown, digits: number): unknown {
  if (typeof value === 'number') return Number(value.toFixed(digits));
  if (Array.isArray(value)) return value.map((v) => roundCoords(v, digits));
  return value;
}

function roundGeometry(g: GeoJSON.Geometry, digits: number): GeoJSON.Geometry {
  if (g.type === 'GeometryCollection') {
    return { type: 'GeometryCollection', geometries: g.geometries.map((x) => roundGeometry(x, digits)) };
  }
  return { ...g, coordinates: roundCoords(g.coordinates, digits) } as GeoJSON.Geometry;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): Uint8Array {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const out = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const canCompress = () => typeof CompressionStream !== 'undefined';

/**
 * The area as a link code. Compressed where the browser can (`z`
 * prefix), plain otherwise (`j`). Coordinates are rounded to about
 * 10 cm, then 1 m if the link is still long. Null when even that is
 * too long to share as a link.
 */
export async function encodeSharedArea(area: SharedArea): Promise<string | null> {
  for (const digits of [6, 5]) {
    const json = JSON.stringify({
      v: 1,
      g: roundGeometry(area.geometry, digits),
      d: Math.round(area.distanceMeters * 100) / 100,
      ...(area.place ? { p: area.place } : {}),
      ...(area.breakdowns && Object.keys(area.breakdowns).length > 0 ? { b: area.breakdowns } : {}),
      ...(area.sums && Object.keys(area.sums).length > 0 ? { s: area.sums } : {}),
    });
    const bytes = new TextEncoder().encode(json);
    const code = canCompress()
      ? `z${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`
      : `j${toBase64Url(bytes)}`;
    if (code.length <= MAX_LINK_CODE) return code;
  }
  return null;
}

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

/** A link code back to an area, or null for anything malformed. The
 *  server checks the shape again when the area is registered. */
export async function decodeSharedArea(code: string): Promise<SharedArea | null> {
  try {
    if (code.length > MAX_LINK_CODE + 1) return null;
    const kind = code[0];
    const raw = fromBase64Url(code.slice(1));
    let bytes: Uint8Array;
    if (kind === 'z' && canCompress()) bytes = await pipe(raw, new DecompressionStream('deflate-raw'));
    else if (kind === 'j') bytes = raw;
    else return null;
    if (bytes.length > MAX_DECODED) return null;
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const g = v.g as GeoJSON.Geometry | undefined;
    if (v.v !== 1 || !g || typeof g !== 'object' || !GEOMETRY_TYPES.has(g.type)) return null;
    const d = typeof v.d === 'number' && Number.isFinite(v.d) && v.d >= 0 ? v.d : 0;
    const out: SharedArea = { geometry: g, distanceMeters: d };
    if (typeof v.p === 'string' && v.p.length <= 500) out.place = v.p;
    if (v.b && typeof v.b === 'object' && !Array.isArray(v.b)) {
      const b = Object.fromEntries(
        Object.entries(v.b as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 100,
        ),
      );
      if (Object.keys(b).length > 0) out.breakdowns = b;
    }
    if (v.s && typeof v.s === 'object' && !Array.isArray(v.s)) {
      // Built with fromEntries, never by assigning a key from the link,
      // so a crafted key such as __proto__ cannot reach a prototype.
      const sums = Object.fromEntries(
        Object.entries(v.s as Record<string, unknown>)
          .map(([k, fields]): [string, string[]] => [
            k,
            Array.isArray(fields)
              ? fields
                  .filter((f): f is string => typeof f === 'string' && f.length <= 100)
                  .slice(0, MAX_SUM_FIELDS)
              : [],
          ])
          .filter(([, fields]) => fields.length > 0),
      );
      if (Object.keys(sums).length > 0) out.sums = sums;
    }
    return out;
  } catch {
    return null;
  }
}

/** The code in the page's `#wh=` hash, if any. */
export function readShareHash(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get(SHARE_HASH_KEY);
}

/** Drop `#wh=` once applied, so the address bar stops claiming an area
 *  the user may since have changed. Other hash parts stay. */
export function clearShareHash(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has(SHARE_HASH_KEY)) return;
  params.delete(SHARE_HASH_KEY);
  const rest = params.toString();
  const url = `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

/** A share link for the current page. */
export function shareUrl(code: string): string {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set(SHARE_HASH_KEY, code);
  return `${window.location.origin}${window.location.pathname}${window.location.search}#${params.toString()}`;
}
