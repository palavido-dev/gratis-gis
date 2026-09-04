// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side layer export helpers (#107).
 *
 * Pure browser-side conversion of a feature collection into a
 * downloadable CSV or XLSX file.  We deliberately stay client-side
 * for v1: the features endpoint already streams up to 5k rows, and
 * an in-browser transform avoids a new server endpoint AND lets the
 * user trigger the download immediately from any page (data_layer
 * detail, attribute table, custom-app attribute-table widget).
 *
 * Bundle export (related tables + attachments) is the bigger
 * follow-up tracked alongside this -- see
 * `docs/handoff/reference/bundle-export-notes.md`.  That one needs
 * server-side ZIP streaming.
 *
 * Column order: we prefer the layer's declared schema field order
 * when it's available; falling back to "first-seen" across the
 * union of all row properties.  That keeps related/derived
 * exports stable across runs.
 *
 * Geometry: stripped on CSV (text-only by convention) and dumped
 * as WKT in an extra `geometry_wkt` column on XLSX so the user can
 * round-trip into desktop GIS tools.  Bundle export will swap in
 * proper geometry handling when it lands.
 */

import { writeXlsx } from './xlsx';

export interface ExportFeature {
  id?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

export interface ExportFieldHint {
  /** Stable column id (also used as the row key in properties). */
  name: string;
  /** Optional friendlier header.  Falls back to `name`. */
  label?: string;
}

export type ExportFormat = 'csv' | 'xlsx' | 'geojson' | 'geoparquet';

/**
 * The subset of formats built in the browser from already-loaded
 * features. GeoParquet is the exception: it is produced server-side
 * (DuckDB writes the file from the FULL layer, not just the rows the
 * table happens to have loaded) and downloaded via
 * `exportLayerGeoParquet`, so `exportFeatures` deliberately does not
 * accept it and the type system pushes callers to the right helper.
 */
export type ClientExportFormat = Exclude<ExportFormat, 'geoparquet'>;

/** Human names for the formats, for confirmation messages. Keyed on
 *  ExportFormat so a new format cannot be added without naming it. */
export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  geojson: 'GeoJSON',
  geoparquet: 'GeoParquet',
};

interface ExportOptions {
  /** Filename root without extension. */
  filename: string;
  /** Schema-declared field order; used when present so columns
   *  match the layer designer's intent rather than property-iteration
   *  order. */
  fields?: ExportFieldHint[];
  /** When true, include a geometry_wkt column derived from each
   *  feature's GeoJSON geometry.  XLSX only -- CSV stays text-only
   *  by default. */
  includeGeometryWkt?: boolean;
}

/**
 * Build a 2D row array (header row + data rows) from features.
 * Used by both CSV and XLSX emitters so they agree on column order
 * and value coercion.
 */
function buildRows(
  features: ExportFeature[],
  opts: ExportOptions,
): { headers: string[]; data: (string | number | boolean | null)[][] } {
  // Resolve column order.  Schema fields win when declared; otherwise
  // we union property keys in first-seen order so the export is
  // deterministic between runs.
  const headers: string[] = [];
  const seen = new Set<string>();
  if (opts.fields && opts.fields.length > 0) {
    for (const f of opts.fields) {
      if (seen.has(f.name)) continue;
      headers.push(f.label?.trim() || f.name);
      seen.add(f.name);
    }
  } else {
    for (const feat of features) {
      const props = feat.properties ?? {};
      for (const k of Object.keys(props)) {
        if (seen.has(k)) continue;
        headers.push(k);
        seen.add(k);
      }
    }
  }
  // Track the underlying property key order parallel to the headers
  // so label != name still pulls the right value.
  const propKeys: string[] = [];
  if (opts.fields && opts.fields.length > 0) {
    for (const f of opts.fields) propKeys.push(f.name);
  } else {
    propKeys.push(...headers);
  }
  if (opts.includeGeometryWkt) {
    headers.push('geometry_wkt');
    propKeys.push('__geometry_wkt');
  }
  const data: (string | number | boolean | null)[][] = [];
  for (const feat of features) {
    const row: (string | number | boolean | null)[] = [];
    const props = feat.properties ?? {};
    for (const k of propKeys) {
      if (k === '__geometry_wkt') {
        row.push(geometryToWkt(feat.geometry));
        continue;
      }
      row.push(coerceCell(props[k]));
    }
    data.push(row);
  }
  return { headers, data };
}

/**
 * Coerce a property value into a CSV/XLSX-friendly primitive.
 * Booleans + numbers + strings pass through; null / undefined
 * become empty string; everything else (arrays, objects) is
 * JSON-stringified so the user sees the structure rather than
 * "[object Object]".
 */
function coerceCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Convert a GeoJSON-ish geometry to a minimal WKT string.  Covers
 * the common types (Point, LineString, Polygon, plus the Multi*
 * variants) and falls back to JSON for anything weirder so the
 * column is never blank.  Imperfect but recognizable to QGIS /
 * ArcGIS Pro / pgAdmin importers.
 */
function geometryToWkt(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const geom = g as { type?: string; coordinates?: unknown };
  if (!geom.type || !geom.coordinates) return '';
  const c = geom.coordinates;
  const pt = (p: number[]) => `${p[0]} ${p[1]}${p[2] !== undefined ? ' ' + p[2] : ''}`;
  const ring = (r: number[][]) => `(${r.map(pt).join(', ')})`;
  const polygon = (p: number[][][]) => `(${p.map(ring).join(', ')})`;
  try {
    switch (geom.type) {
      case 'Point':
        return `POINT(${pt(c as number[])})`;
      case 'LineString':
        return `LINESTRING(${(c as number[][]).map(pt).join(', ')})`;
      case 'Polygon':
        return `POLYGON${polygon(c as number[][][])}`;
      case 'MultiPoint':
        return `MULTIPOINT(${(c as number[][]).map(pt).join(', ')})`;
      case 'MultiLineString':
        return `MULTILINESTRING(${(c as number[][][])
          .map((l) => `(${l.map(pt).join(', ')})`)
          .join(', ')})`;
      case 'MultiPolygon':
        return `MULTIPOLYGON(${(c as number[][][][])
          .map(polygon)
          .join(', ')})`;
      default:
        return JSON.stringify(g);
    }
  } catch {
    return JSON.stringify(g);
  }
}

/** Trigger a browser download of a Blob with the given filename. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Slight delay before revoking the object URL: Safari needs the
  // anchor to actually trigger the navigation before we tear down
  // the blob backing.  60ms is overkill on Chrome/Firefox but
  // harmless.
  setTimeout(() => URL.revokeObjectURL(url), 60);
}

/** Quote a CSV cell.  Doubles internal quotes per RFC 4180. */
function csvQuote(v: string | number | boolean | null): string {
  const s = v === null ? '' : String(v);
  if (s.length === 0) return '';
  // Quote when the value contains a comma, quote, or newline.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a CSV file from features and trigger a download. */
export function exportFeaturesToCsv(
  features: ExportFeature[],
  opts: ExportOptions,
): void {
  const { headers, data } = buildRows(features, opts);
  const lines: string[] = [];
  lines.push(headers.map(csvQuote).join(','));
  for (const row of data) {
    lines.push(row.map(csvQuote).join(','));
  }
  // BOM so Excel correctly opens UTF-8 files.  Without it, accented
  // characters and curly quotes come out garbled in Excel for Windows.
  const blob = new Blob(['﻿' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  downloadBlob(blob, `${opts.filename}.csv`);
}

/** Build an XLSX file from features and trigger a download. */
export async function exportFeaturesToXlsx(
  features: ExportFeature[],
  opts: ExportOptions,
): Promise<void> {
  const { headers, data } = buildRows(features, opts);
  // Sheet names are limited to 31 chars by the XLSX spec. Truncate
  // gracefully so a 50-char layer name doesn't blow up the writer.
  const sheetName = sanitizeSheetName(opts.filename.slice(0, 31)) || 'Sheet1';
  const blob = await writeXlsx([
    { name: sheetName, rows: [headers, ...data] },
  ]);
  downloadBlob(blob, `${opts.filename}.xlsx`);
}

/** Excel reserves a handful of characters in sheet names. The
 *  vendored writer (#51) is strict about this where SheetJS was
 *  lenient -- strip the forbidden chars rather than emitting an
 *  invalid file that Excel would refuse to open. */
function sanitizeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, '_');
}

/**
 * GeoJSON export. Round-trips full geometry (unlike CSV / XLSX,
 * which strip or WKT-encode it). The natural download format for
 * spatial features: opens directly in QGIS, ArcGIS Pro, GitHub,
 * Geojson.io, leaflet, etc.
 *
 * Strips the synthetic id (it's stable within the source but not
 * meaningful outside) only when it's missing or numeric;
 * string-shaped ids (e.g. OSM osm:hash) are preserved as `id`.
 * Properties go through unchanged.
 */
export function exportFeaturesToGeoJson(
  features: ExportFeature[],
  opts: ExportOptions,
): void {
  const fc = {
    type: 'FeatureCollection' as const,
    features: features.map((f) => {
      // The GeoJSON Feature type requires `geometry: Geometry` (not
      // null), but features with null geometry are valid per the
      // GeoJSON spec and we may encounter them in attribute-only
      // tables. Build the object first and let JSON.stringify emit
      // `null` when the geometry is absent; the runtime shape is
      // what consumers actually parse.
      const out: Record<string, unknown> = {
        type: 'Feature',
        geometry: (f.geometry as GeoJSON.Geometry | null) ?? null,
        properties: f.properties ?? null,
      };
      if (typeof f.id === 'string' && f.id.length > 0) out.id = f.id;
      return out;
    }),
  };
  const blob = new Blob([JSON.stringify(fc, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${opts.filename}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so Chrome / Firefox have a moment to
  // actually kick off the save dialog before the URL gets torn down.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Dispatch to the right writer based on format. Returns a
 *  promise because the XLSX writer is async (#51); CSV and GeoJSON
 *  complete synchronously inside the same call so callers that
 *  fire-and-forget can still ignore the promise. */
export function exportFeatures(
  features: ExportFeature[],
  format: ClientExportFormat,
  opts: ExportOptions,
): Promise<void> {
  if (format === 'csv') {
    exportFeaturesToCsv(features, opts);
    return Promise.resolve();
  }
  if (format === 'geojson') {
    exportFeaturesToGeoJson(features, opts);
    return Promise.resolve();
  }
  return exportFeaturesToXlsx(features, opts);
}

/**
 * GeoParquet export. Server-side, unlike every other format here:
 * the portal's /geoparquet endpoint walks the WHOLE layer (no 5k
 * table cap) and writes a real GeoParquet file (typed columns,
 * geometry column, `geo` metadata) via DuckDB, which a browser-side
 * transform of the loaded rows could not produce.
 *
 * Throws with the server's message on failure so callers can
 * surface it; the important case is 403 when the caller's share
 * lacks the download permission.
 */
export async function exportLayerGeoParquet(args: {
  itemId: string;
  layerId: string;
  /** Fallback filename root (no extension) used only when the
   *  server's Content-Disposition is missing or unparseable. */
  filename: string;
}): Promise<void> {
  const res = await fetch(
    `/api/portal/items/${args.itemId}/layers/${args.layerId}/geoparquet`,
  );
  if (!res.ok) {
    let message = `Export failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      const m = Array.isArray(body.message) ? body.message[0] : body.message;
      if (m) message = m;
    } catch {
      // Non-JSON error body; keep the status-based message.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const filename =
    filenameFromContentDisposition(res.headers.get('content-disposition')) ??
    `${args.filename}.parquet`;
  downloadBlob(blob, filename);
}

/** Pull `filename="..."` (or an unquoted token) out of a
 *  Content-Disposition header. The server sanitizes the name to
 *  ASCII word characters, so the simple grammar below covers every
 *  value it can actually send; anything else returns null and the
 *  caller falls back to its own name. */
function filenameFromContentDisposition(
  header: string | null,
): string | null {
  if (!header) return null;
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename=([^;\s]+)/i.exec(header);
  return bare?.[1] ?? null;
}
