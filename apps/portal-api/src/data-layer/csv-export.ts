// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField, FeatureRecord } from '@gratis-gis/shared-types';

/**
 * RFC-4180 CSV exporter for data_layer features.
 *
 * The shape we emit is round-trip compatible with AGO / Survey123 /
 * Excel: one header row of field labels (or names), one feature per
 * row, fields in the schema's declared order. Geometry columns are
 * emitted alongside the attribute columns when the layer is spatial:
 * `geometry_wkt` for any geometry, `geometry_lon` + `geometry_lat`
 * for point layers (more useful for spreadsheet pivots than WKT).
 *
 * multi_select fields are the load-bearing reason this exists. Our
 * canonical storage shape is a JSON array of pick-list codes; AGO
 * stores the same data as a comma-separated string in a single text
 * field. We write the AGO-shaped string at the export boundary so
 * downstream consumers (Esri Field Calculator, Survey123 Connect,
 * arcgis-python-api) see the format they expect, without polluting
 * our internal storage.
 *
 * Quoting follows RFC-4180:
 *   - cells containing comma, double-quote, CR, or LF are wrapped
 *     in double quotes
 *   - inner double quotes are escaped by doubling them
 *   - newline separator is CRLF (Excel-friendly; portable readers
 *     accept both)
 */

export interface CsvExportOptions {
  /** Whether to include geometry columns. Defaults to true; pass
   *  false for table-mode sublayers (geometry would be all empty)
   *  or when the consumer explicitly only wants attributes. */
  includeGeometry?: boolean;
  /** When set, emit a single `geometry_wkt` column with PostGIS-
   *  style Well-Known Text. Defaults to true for non-point layers
   *  and false for point layers (which use lon/lat instead). */
  emitWkt?: boolean;
  /** When set on a point layer, emit `geometry_lon` and
   *  `geometry_lat` columns. Defaults to true for points. */
  emitLonLat?: boolean;
}

/** The resolved column shape for one export, computed once up front so
 *  the header and every row agree without re-deciding per feature. */
export interface CsvColumnPlan {
  fields: FeatureField[];
  includeGeometry: boolean;
  emitWkt: boolean;
  emitLonLat: boolean;
}

/**
 * Decide the columns for an export.
 *
 * `isPoint` selects lon/lat vs WKT for `auto` geometry. For a streaming
 * export it comes from the layer's declared geometry type (there is no
 * first feature to sniff); the batch `featuresToCsv` sniffs it instead.
 */
export function csvColumnPlan(
  fields: FeatureField[],
  opts: CsvExportOptions = {},
  isPoint = false,
): CsvColumnPlan {
  const includeGeometry = opts.includeGeometry !== false;
  return {
    fields,
    includeGeometry,
    emitWkt: opts.emitWkt ?? !isPoint,
    emitLonLat: opts.emitLonLat ?? isPoint,
  };
}

/** The header row (no trailing newline) for a column plan. */
export function csvHeaderRow(plan: CsvColumnPlan): string {
  const headers: string[] = plan.fields.map((f) => f.label || f.name);
  if (plan.includeGeometry) {
    if (plan.emitLonLat) headers.push('geometry_lon', 'geometry_lat');
    if (plan.emitWkt) headers.push('geometry_wkt');
  }
  return headers.map(csvEscape).join(',');
}

/** One feature's row (no trailing newline) for a column plan. */
export function csvFeatureRow(
  feat: FeatureRecord,
  plan: CsvColumnPlan,
): string {
  const props = (feat.properties ?? {}) as Record<string, unknown>;
  const cells: string[] = [];
  for (const field of plan.fields) {
    cells.push(formatField(props[field.name], field));
  }
  if (plan.includeGeometry) {
    if (plan.emitLonLat) {
      const pt = pointCoords(feat.geometry);
      cells.push(pt ? csvEscape(String(pt[0])) : '');
      cells.push(pt ? csvEscape(String(pt[1])) : '');
    }
    if (plan.emitWkt) {
      const wkt = geometryToWkt(feat.geometry);
      cells.push(wkt ? csvEscape(wkt) : '');
    }
  }
  return cells.join(',');
}

/**
 * Build the CSV body as a single string. Convenience for callers that
 * already hold the whole feature array in memory (small layers, tests).
 * The export endpoint streams instead, via csvColumnPlan +
 * csvHeaderRow + csvFeatureRow over the keyset iterator, so it is not
 * bounded by a row cap or the heap.
 */
export function featuresToCsv(
  features: FeatureRecord[],
  fields: FeatureField[],
  opts: CsvExportOptions = {},
): string {
  let isPoint = false;
  if (opts.includeGeometry !== false) {
    for (const f of features) {
      const g = (f.geometry as { type?: string } | null) ?? null;
      if (g && typeof g.type === 'string') {
        isPoint = g.type === 'Point';
        break;
      }
    }
  }
  const plan = csvColumnPlan(fields, opts, isPoint);
  const lines: string[] = [csvHeaderRow(plan)];
  for (const feat of features) lines.push(csvFeatureRow(feat, plan));
  // RFC-4180 says CRLF; Excel insists on it for the import dialog to
  // skip the per-language locale prompt. Most modern readers accept LF.
  return lines.join('\r\n');
}

/**
 * Serialize a single attribute value into its CSV cell representation,
 * already RFC-4180 escaped and ready to drop into the row.
 *
 * The interesting case is `multi_select`: the canonical storage is
 * a JSON array of codes. We join with `,` (the AGO convention) and
 * then RFC-4180 quote the whole thing so the inner commas don't
 * break the row's column count. A consumer that splits the cell
 * back to an array for ingest reverses this in csv-import.ts (#108).
 */
function formatField(raw: unknown, field: FeatureField): string {
  if (raw === null || raw === undefined) return '';
  if (field.type === 'multi_select') {
    if (Array.isArray(raw)) {
      const joined = raw
        .filter((x) => x !== null && x !== undefined)
        .map((x) => String(x))
        .join(',');
      return csvEscape(joined);
    }
    // Legacy non-array value: stringify whatever's there.
    return csvEscape(String(raw));
  }
  if (field.type === 'boolean') {
    return raw ? 'true' : 'false';
  }
  if (field.type === 'date' && raw instanceof Date) {
    return csvEscape(raw.toISOString());
  }
  if (typeof raw === 'object') {
    // Catch-all for nested JSON we don't have a typed mapping for
    // (matrix responses, etc.). JSON-stringify and quote so the
    // cell stays well-formed; downstream consumers that care about
    // the structure can re-parse.
    return csvEscape(JSON.stringify(raw));
  }
  return csvEscape(String(raw));
}

/**
 * Wrap a cell in double quotes when the value contains a CSV-meta
 * character (comma, double-quote, CR, LF), and escape any inner
 * double-quotes per RFC-4180. Plain values pass through untouched.
 */
function csvEscape(s: string): string {
  if (s === '') return '';
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Extract [lon, lat] from a Point GeoJSON; null otherwise. */
function pointCoords(g: unknown): [number, number] | null {
  if (!g || typeof g !== 'object') return null;
  const obj = g as { type?: string; coordinates?: unknown };
  if (obj.type !== 'Point') return null;
  if (
    Array.isArray(obj.coordinates) &&
    obj.coordinates.length >= 2 &&
    typeof obj.coordinates[0] === 'number' &&
    typeof obj.coordinates[1] === 'number'
  ) {
    return [obj.coordinates[0], obj.coordinates[1]];
  }
  return null;
}

/**
 * Convert a GeoJSON geometry to a Well-Known Text representation.
 * Hand-rolled because we don't want a runtime dep on a full WKT
 * lib for the export path; supports the geometry types our
 * data_layer surface produces (Point, LineString, Polygon, and
 * their Multi- variants). Unknown types fall back to JSON, which
 * is at least non-lossy in a CSV cell.
 */
function geometryToWkt(g: unknown): string | null {
  if (!g || typeof g !== 'object') return null;
  const obj = g as { type?: string; coordinates?: unknown };
  const t = obj.type;
  const c = obj.coordinates;
  if (!t || c === undefined) return null;
  switch (t) {
    case 'Point':
      return `POINT (${pointToWkt(c)})`;
    case 'LineString':
      return `LINESTRING (${ringToWkt(c)})`;
    case 'Polygon':
      return `POLYGON (${polygonRingsToWkt(c)})`;
    case 'MultiPoint':
      return `MULTIPOINT (${ringToWkt(c)})`;
    case 'MultiLineString':
      return `MULTILINESTRING (${multiLineToWkt(c)})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON (${multiPolygonToWkt(c)})`;
    default:
      return JSON.stringify(g);
  }
}

function pointToWkt(c: unknown): string {
  if (Array.isArray(c) && c.length >= 2) {
    return `${c[0]} ${c[1]}`;
  }
  return '';
}
function ringToWkt(c: unknown): string {
  if (!Array.isArray(c)) return '';
  return c.map((p) => pointToWkt(p)).join(', ');
}
function polygonRingsToWkt(c: unknown): string {
  if (!Array.isArray(c)) return '';
  return c.map((ring) => `(${ringToWkt(ring)})`).join(', ');
}
function multiLineToWkt(c: unknown): string {
  if (!Array.isArray(c)) return '';
  return c.map((line) => `(${ringToWkt(line)})`).join(', ');
}
function multiPolygonToWkt(c: unknown): string {
  if (!Array.isArray(c)) return '';
  return c.map((poly) => `(${polygonRingsToWkt(poly)})`).join(', ');
}
