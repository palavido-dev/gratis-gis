// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';

// Type-only: fully erased at compile time, so this cannot defeat
// the lazy-load contract on the native binding (see loadDuckDb).
import type { DuckDBAppender } from '@duckdb/node-api';
import type { FeatureField } from '@gratis-gis/shared-types';

import {
  loadDuckDb,
  quoteIdent,
  escapeSqlLiteral,
  withSpatialConnection,
} from '../ingest/parquet-reader.js';

/**
 * GeoParquet writer for data_layer exports (#174, export side).
 *
 * Same engine choice as the import side (see parquet-reader.ts):
 * the bundled gdal-async prebuild has no Parquet driver, DuckDB's
 * spatial extension does the whole job. Rows stream in as batches
 * from the engine's keyset iterator, land in a staging table via
 * the native appender (bulk chunked inserts, not per-row SQL), and
 * a single `COPY (SELECT ...) TO ... (FORMAT PARQUET)` with the
 * spatial extension loaded produces the file. DuckDB writes the
 * GeoParquet `geo` file metadata itself when the copied relation
 * contains a GEOMETRY column, which is what makes the output real
 * GeoParquet instead of parquet-with-a-blob; the export spec
 * asserts that metadata on every run.
 *
 * The staging database is file-backed (not `:memory:`) on purpose:
 * an export the size of a county parcel layer would otherwise have
 * to fit inside the 512MB per-instance memory cap. With an on-disk
 * database DuckDB pages the staging table out under memory
 * pressure and the cap bounds working memory rather than dataset
 * size.
 *
 * Kept Nest-free like the reader so tests and the smoke script can
 * exercise it standalone.
 */

/** Minimal feature shape the writer consumes. Structurally matches
 *  the engine's DataLayerFeature so controller code can pass engine
 *  batches straight through without mapping. */
export interface GeoParquetFeature {
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

export interface GeoParquetExportArgs {
  /** Working directory for the output file and the staging
   *  database. The caller owns creation (mkdtemp) and cleanup. */
  workDir: string;
  /** Layer schema in declared order; becomes the property columns. */
  fields: FeatureField[];
  /** Feature batches, e.g. from DataLayerEngine.iterateFeatures. */
  batches: AsyncIterable<GeoParquetFeature[]>;
  /** False for table-mode sublayers: the output is then plain
   *  parquet with property columns only, mirroring how the CSV
   *  export omits geometry columns for tables. */
  includeGeometry: boolean;
}

/** Name of the staging table inside the scratch DuckDB database. */
const STAGING_TABLE = 'export_rows';

/**
 * Write the export and return the produced path plus row count.
 * The parquet file lands at `<workDir>/export.parquet`; callers
 * pick the user-facing filename via Content-Disposition, so the
 * on-disk name stays constant.
 */
export async function writeGeoParquetExport(
  args: GeoParquetExportArgs,
): Promise<{ path: string; rows: number }> {
  const outPath = join(args.workDir, 'export.parquet');
  const stagingDbPath = join(args.workDir, 'staging.duckdb');

  // Reserve output column names against the user's field names.
  // Parquet forbids duplicate column names, and a layer author is
  // free to declare a field literally called "geometry"; rather
  // than mangling THEIR column we shift OUR synthetic ones to the
  // first non-colliding candidate. The geo metadata's
  // primary_column follows whatever name wins, so readers (ours
  // included) still resolve the geometry column correctly.
  const taken = new Set(args.fields.map((f) => f.name));
  const geometryColumn = pickFreeName(['geometry', '_geometry', '__geometry'], taken);
  taken.add(geometryColumn);
  const stagingGeoJsonColumn = pickFreeName(
    ['__geojson', '__geojson_1', '__geojson_2'],
    taken,
  );

  const duckdb = await loadDuckDb();

  return withSpatialConnection(
    async (connection) => {
      const columnDefs = args.fields.map(
        (f) => `${quoteIdent(f.name)} ${duckdbColumnType(f.type)}`,
      );
      if (args.includeGeometry) {
        // GeoJSON text, converted to GEOMETRY in the COPY SELECT.
        // The appender cannot append GEOMETRY values directly, and
        // routing the conversion through ST_GeomFromGeoJSON keeps
        // the parse inside DuckDB where it is vectorized.
        columnDefs.push(`${quoteIdent(stagingGeoJsonColumn)} VARCHAR`);
      }
      await connection.run(
        `CREATE TABLE ${STAGING_TABLE} (${columnDefs.join(', ')})`,
      );

      let rows = 0;
      const appender = await connection.createAppender(STAGING_TABLE);
      try {
        for await (const batch of args.batches) {
          for (const feature of batch) {
            const props = feature.properties ?? {};
            for (const field of args.fields) {
              appendFieldValue(appender, duckdb, field, props[field.name]);
            }
            if (args.includeGeometry) {
              const geom = feature.geometry;
              if (geom === null || geom === undefined) {
                appender.appendNull();
              } else {
                appender.appendVarchar(JSON.stringify(geom));
              }
            }
            appender.endRow();
            rows += 1;
          }
          // Push each batch through to the staging table so the
          // native-side append buffer stays batch-sized regardless
          // of layer size.
          appender.flushSync();
        }
      } finally {
        appender.closeSync();
      }

      // Property columns first, geometry last: matches the CSV
      // export's column convention and the common GeoParquet
      // writer layout. ST_GeomFromGeoJSON propagates NULL, so
      // geometry-less rows survive as NULL geometry (verified by
      // the export spec).
      const selectCols = args.fields.map((f) => quoteIdent(f.name));
      if (args.includeGeometry) {
        selectCols.push(
          `ST_GeomFromGeoJSON(${quoteIdent(stagingGeoJsonColumn)}) AS ${quoteIdent(geometryColumn)}`,
        );
      }
      await connection.run(
        `COPY (SELECT ${selectCols.join(', ')} FROM ${STAGING_TABLE}) ` +
          `TO '${escapeSqlLiteral(outPath)}' (FORMAT PARQUET)`,
      );
      return { path: outPath, rows };
    },
    { dbPath: stagingDbPath },
  );
}

/** First candidate not colliding with an existing column name. The
 *  candidate lists are long enough that exhaustion is impossible in
 *  practice; throw loudly rather than emit a broken file if that
 *  ever changes. */
function pickFreeName(candidates: string[], taken: ReadonlySet<string>): string {
  for (const c of candidates) {
    if (!taken.has(c)) return c;
  }
  throw new Error(
    `Could not pick a free column name from [${candidates.join(', ')}]`,
  );
}

/**
 * Schema type to DuckDB column type. The inverse of the reader's
 * duckdbTypeToSimple: number/boolean/date round-trip through our
 * own importer back to the same simple type, and land as native
 * types in QGIS / GDAL / pandas. multi_select flattens to the
 * comma-joined text shape featuresToCsv established as the export
 * boundary convention (#107), so every export surface agrees.
 */
function duckdbColumnType(type: FeatureField['type']): string {
  switch (type) {
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'string':
    case 'multi_select':
      return 'VARCHAR';
    default:
      // Future field types default to text: lossless, if untyped.
      return 'VARCHAR';
  }
}

type DuckDbModule = Awaited<ReturnType<typeof loadDuckDb>>;

/**
 * Append one attribute value under its declared schema type.
 *
 * Attrs live in JSONB with no storage-level typing, so a value can
 * disagree with its declared type (a "number" field holding "n/a").
 * The rules below mirror the conventions the other boundaries
 * already use: parse the value into the declared type when it
 * honestly is one (including numeric strings, "true"/"false", ISO
 * date strings), otherwise write NULL. That matches what the MVT
 * projection's ::numeric cast and GDAL's typed exporters do with
 * out-of-contract values; smuggling the raw text into a typed
 * column is not representable in parquet.
 */
function appendFieldValue(
  appender: DuckDBAppender,
  duckdb: DuckDbModule,
  field: FeatureField,
  raw: unknown,
): void {
  if (raw === null || raw === undefined) {
    appender.appendNull();
    return;
  }
  switch (field.type) {
    case 'number': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (Number.isFinite(n)) appender.appendDouble(n);
      else appender.appendNull();
      return;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') {
        appender.appendBoolean(raw);
      } else if (typeof raw === 'number') {
        appender.appendBoolean(raw !== 0);
      } else if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true') appender.appendBoolean(true);
        else if (s === 'false') appender.appendBoolean(false);
        else appender.appendNull();
      } else {
        appender.appendNull();
      }
      return;
    }
    case 'date': {
      // Stored contract is an ISO-8601 string; Date instances and
      // epoch numbers are accepted for robustness. TIMESTAMPTZ is
      // microseconds since epoch.
      const ms =
        raw instanceof Date
          ? raw.getTime()
          : typeof raw === 'string' || typeof raw === 'number'
            ? new Date(raw).getTime()
            : NaN;
      if (Number.isFinite(ms)) {
        appender.appendTimestampTZ(
          duckdb.timestampTZValue(BigInt(Math.round(ms)) * 1000n),
        );
      } else {
        appender.appendNull();
      }
      return;
    }
    case 'multi_select': {
      // Canonical storage is a JSON array of pick-list codes; the
      // export boundary flattens to the comma-joined string AGO
      // consumers expect, exactly like featuresToCsv (#107).
      if (Array.isArray(raw)) {
        const joined = raw
          .filter((x) => x !== null && x !== undefined)
          .map((x) => String(x))
          .join(',');
        appender.appendVarchar(joined);
      } else {
        appender.appendVarchar(String(raw));
      }
      return;
    }
    case 'string':
    default: {
      // Scalars stringify plainly; nested structures (matrix
      // responses etc.) JSON-stringify so the cell stays lossless,
      // mirroring the CSV exporter's catch-all.
      if (typeof raw === 'object') {
        appender.appendVarchar(JSON.stringify(raw));
      } else {
        appender.appendVarchar(String(raw));
      }
      return;
    }
  }
}
