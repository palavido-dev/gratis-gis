// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-browser DuckDB (#175): the client-side analysis engine.
 *
 * Everything runs inside the visitor's browser in a WASM worker;
 * the server's only involvement is handing over the layer bytes
 * (the GeoParquet export endpoint, which also means the download
 * permission tier gates analysis for free). No query ever leaves
 * the machine, there is nothing to meter, and a busy analyst costs
 * the portal exactly zero compute.
 *
 * Air gap: the worker script and the .wasm binary are bundled from
 * the npm package via `new URL(..., import.meta.url)`, which the
 * bundler rewrites to self-hosted static assets. No CDN, ever.
 * We use the `eh` (exception-handling) build only; every browser
 * that can run the portal's map stack supports wasm exceptions.
 *
 * One database instance is shared process-wide and initialized
 * lazily on first use, so opening an Analyze panel costs the WASM
 * download once per session and nothing after.
 */
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';

let dbPromise: Promise<AsyncDuckDB> | null = null;

/**
 * Whether the spatial extension loaded for this session. Spatial SQL
 * (ST_Buffer, ST_Area, spatial joins...) and GEOMETRY-typed reads of
 * GeoParquet depend on it; attribute SQL works either way, so a
 * failed load degrades the workbench instead of breaking it. Mirrors
 * the deployment-tier philosophy: expose what the environment can
 * actually do.
 */
let spatialAvailable = false;
export function isSpatialAvailable(): boolean {
  return spatialAvailable;
}

/**
 * Load the spatial extension, preferring the portal's own mirror.
 *
 * Air gap: the Dockerfile bakes the extensions into
 * public/duckdb-ext/<core-version>/<platform>/, a byte-identical
 * mirror of the official repository layout, so production visitors
 * fetch them from OUR origin, never extensions.duckdb.org. Pointing
 * custom_extension_repository at the origin path is enough; the
 * engine appends its own version/platform segments. Note the mirror
 * carries MORE than spatial: the wasm build ships parquet/json/icu
 * as dynamically autoloaded extensions (they are static in native
 * DuckDB), and once the repository points at us, every autoload
 * resolves here, so a spatial-only mirror breaks read_parquet. On
 * dev hosts the baked files do not exist, so the second attempt
 * falls back to the official repository (dev machines have
 * internet). If both fail (offline dev), the panel runs
 * attribute-only.
 *
 * LOAD is engine-wide in DuckDB-WASM: once loaded here, spatial
 * functions are available to every later connection on the shared
 * instance.
 */
async function loadSpatial(db: AsyncDuckDB): Promise<void> {
  const conn = await db.connect();
  try {
    try {
      await conn.query(
        `SET custom_extension_repository = '${window.location.origin}/duckdb-ext'`,
      );
      await conn.query('INSTALL spatial');
    } catch {
      await conn.query('RESET custom_extension_repository');
      await conn.query('INSTALL spatial');
    }
    await conn.query('LOAD spatial');
    spatialAvailable = true;
  } catch {
    spatialAvailable = false;
  } finally {
    await conn.close();
  }
}

async function createDb(): Promise<AsyncDuckDB> {
  const duckdb = await import('@duckdb/duckdb-wasm');
  const worker = new Worker(
    new URL(
      '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js',
      import.meta.url,
    ),
  );
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(
    new URL('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', import.meta.url).toString(),
  );
  await loadSpatial(db);
  return db;
}

/** Lazy shared instance. A failed boot clears the memo so a retry
 *  (next panel open) starts clean instead of replaying the same
 *  rejected promise forever. */
export function getDuckDb(): Promise<AsyncDuckDB> {
  if (!dbPromise) {
    dbPromise = createDb().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Files already registered with the instance this session, keyed
 *  by virtual filename; lets a re-opened panel skip the re-fetch
 *  AND the re-register. */
const registeredFiles = new Set<string>();

/**
 * Register a Parquet buffer under a stable virtual filename and
 * expose it as a view. Idempotent per session: the buffer is only
 * registered once, the view is CREATE OR REPLACE'd every call
 * (cheap, and it heals a view dropped by user SQL).
 *
 * The view name is derived from the layer's table name, which the
 * schema validator restricts to [a-z0-9_]; we still quote it and
 * belt-and-braces sanitize here because this module cannot see
 * that validator.
 */
export async function registerParquetView(args: {
  fileName: string;
  viewName: string;
  bytes: () => Promise<Uint8Array>;
}): Promise<AsyncDuckDBConnection> {
  const db = await getDuckDb();
  if (!registeredFiles.has(args.fileName)) {
    await db.registerFileBuffer(args.fileName, await args.bytes());
    registeredFiles.add(args.fileName);
  }
  const conn = await db.connect();
  const view = sanitizeIdent(args.viewName);
  await conn.query(
    `CREATE OR REPLACE VIEW "${view}" AS SELECT * FROM read_parquet('${args.fileName.replace(/'/g, "''")}')`,
  );
  return conn;
}

function sanitizeIdent(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return cleaned.length > 0 ? cleaned : 'layer';
}

export interface QueryResultTable {
  columns: string[];
  /** Row-major cell values, already converted to display-safe JS
   *  values (string | number | boolean | null). */
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  elapsedMs: number;
}

/** Cap on rows materialized into the result grid. Analysis outputs
 *  are usually aggregates; anyone selecting a raw million-row table
 *  gets the first page and a truncation flag instead of a frozen
 *  tab. */
export const RESULT_ROW_CAP = 1000;

/**
 * Run one SQL statement and shape the Arrow result for a plain
 * table renderer. BigInts within safe-integer range become numbers
 * (DuckDB counts are BIGINT; rendering "3n" would be absurd),
 * binary columns (WKB geometry) render as a size placeholder, and
 * temporal / nested values fall back to their string forms.
 */
export async function runQuery(
  conn: AsyncDuckDBConnection,
  sql: string,
): Promise<QueryResultTable & { truncated: boolean }> {
  const started = performance.now();
  const table = await conn.query(sql);
  const elapsedMs = Math.round(performance.now() - started);
  const columns = table.schema.fields.map((f) => f.name);
  const rowCount = table.numRows;
  const rows: QueryResultTable['rows'] = [];
  const limit = Math.min(rowCount, RESULT_ROW_CAP);
  for (let i = 0; i < limit; i += 1) {
    const row = table.get(i);
    if (row === null) continue;
    const cells: Array<string | number | boolean | null> = [];
    for (const col of columns) {
      cells.push(toDisplayValue(row[col]));
    }
    rows.push(cells);
  }
  return { columns, rows, rowCount, elapsedMs, truncated: rowCount > limit };
}

function toDisplayValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'number':
    case 'boolean':
    case 'string':
      return v;
    case 'bigint': {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : v.toString();
    }
    case 'object': {
      if (v instanceof Uint8Array) return `<binary ${v.byteLength} B>`;
      if (v instanceof Date) return v.toISOString();
      // Arrow structs / lists stringify through their own toString,
      // which is JSON-ish and good enough for a result grid.
      return String(v);
    }
    default:
      return String(v);
  }
}
