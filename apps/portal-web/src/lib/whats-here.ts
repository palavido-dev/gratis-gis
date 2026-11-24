// SPDX-License-Identifier: AGPL-3.0-or-later
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
}

export interface LayerScreen {
  total: ScreenRow;
  /** Present when a breakdown field was asked for. */
  breakdown?: { field: string; rows: ScreenRow[]; truncated: boolean };
}

/** Distances offered as one tap. Feet and miles because most users
 *  think in them; the custom box takes any unit. */
export const DISTANCE_PRESETS: ReadonlyArray<{ key: string; meters: number }> = [
  { key: 'none', meters: 0 },
  { key: 'ft100', meters: 30.48 },
  { key: 'ft500', meters: 152.4 },
  { key: 'mi025', meters: 402.336 },
  { key: 'mi1', meters: 1609.344 },
];

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
): ScreenRow {
  return {
    value,
    count: values.count ?? 0,
    measure: op ? (values[op] ?? 0) : null,
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
  signal?: AbortSignal;
}): Promise<LayerScreen> {
  const op = measureOpFor(args.layer.geometry);
  const aggs: Array<{ op: 'count' | 'area' | 'length' }> = [{ op: 'count' }];
  if (op) aggs.push({ op });
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
  const total = rowFrom(whole.groups[0]?.values ?? {}, op, null);
  if (!field || !grouped) return { total };
  return {
    total,
    breakdown: {
      field,
      truncated: grouped.truncated,
      rows: grouped.groups
        .map((g) => rowFrom(g.values, op, g.key[field] ?? null))
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
  };
}): string {
  const lengthPer = METERS_PER[args.lengthUnit];
  const fmt = (n: number) => Number(n.toFixed(4));
  const lines: string[] = [];
  lines.push(
    [
      args.headers.layer,
      args.headers.category,
      args.headers.count,
      `${args.headers.area} (${args.areaUnit})`,
      `${args.headers.length} (${args.lengthUnit})`,
      args.headers.percent,
    ]
      .map(csvCell)
      .join(','),
  );
  const rowLine = (
    title: string,
    category: string | null,
    row: ScreenRow,
    geometry: ScreenGeometry | null,
  ) => {
    const pct = percentOfArea(row.measure, args.area.squareMeters, geometry);
    return [
      title,
      category,
      row.count,
      geometry === 'polygon' && row.measure !== null
        ? fmt(row.measure / args.areaPerUnit)
        : null,
      geometry === 'line' && row.measure !== null ? fmt(row.measure / lengthPer) : null,
      pct === null ? null : fmt(pct),
    ]
      .map(csvCell)
      .join(',');
  };
  for (const { layer, screen } of args.layers) {
    lines.push(rowLine(layer.title, null, screen.total, layer.geometry));
    for (const r of screen.breakdown?.rows ?? []) {
      lines.push(rowLine(layer.title, r.value ?? '', r, layer.geometry));
    }
  }
  // CRLF and a BOM: Excel on Windows opens UTF-8 CSV correctly only
  // with the BOM, and names with accents are common in this data.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
