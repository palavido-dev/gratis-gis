// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * GeoParquet reader built on DuckDB (@duckdb/node-api).
 *
 * Why DuckDB and not GDAL: the bundled gdal-async prebuild is compiled
 * without the Parquet/Arrow driver, so `gdal.open('x.parquet')` fails
 * on every platform we ship. DuckDB reads Parquet natively and its
 * `spatial` extension gives us the same primitives the GDAL path
 * relies on (WKB decode, reprojection, GeoJSON serialization), with
 * prebuilt Node-API bindings for win32/darwin/linux on x64 and arm64.
 *
 * All DuckDB specifics live in this file. IngestService branches on
 * `isParquetPath()` and delegates here; the return shapes mirror the
 * GDAL code paths exactly so callers cannot tell which engine ran.
 *
 * Extension air-gap contract: prod must NEVER download extensions at
 * runtime. The portal-api Dockerfile calls `bakeSpatialExtension()`
 * at image build time (network is available there), which INSTALLs
 * the spatial extension into DUCKDB_EXTENSION_DIR inside the image.
 * At runtime `withSpatialConnection()` points extension_directory at
 * that baked dir, so INSTALL is a local no-op and LOAD reads straight
 * from disk. On dev machines the baked dir does not exist; DuckDB
 * falls back to its per-user extension dir and downloads once, which
 * is fine because dev hosts have network.
 */

/**
 * Single source of truth for where the prod image bakes DuckDB
 * extensions. The Dockerfile does not repeat this path: its bake step
 * requires the compiled dist/ingest/parquet-reader.js and calls
 * bakeSpatialExtension(), which reads this constant.
 */
export const DUCKDB_EXTENSION_DIR = '/opt/duckdb-extensions';

/**
 * How many rows we sample when the GeoParquet metadata does not
 * declare geometry_types and we have to look at actual geometries to
 * classify the layer. The GDAL path peeks a single feature; sampling
 * a small prefix is strictly more reliable and still O(1) on file
 * size because Parquet row-group pruning stops the scan early.
 */
const GEOMETRY_SAMPLE_ROWS = 100;

/**
 * Memory ceiling per DuckDB instance. DuckDB defaults to 80% of host
 * RAM; an import running next to portal-api, Postgres, and the tile
 * stack on a small prod box should not be allowed to claim that. The
 * streaming reads in this file only ever buffer one row group, so
 * this cap is generous.
 */
const DUCKDB_MAX_MEMORY = '512MB';

export type SimpleFieldType = 'string' | 'number' | 'boolean' | 'date';

export interface SimpleField {
  name: string;
  type: SimpleFieldType;
}

export type SimpleGeometryType = 'point' | 'line' | 'polygon';

/**
 * Thrown for problems the uploader can fix (wrong layer name, no
 * geometry column, malformed geo metadata). IngestService maps this
 * to a BadRequestException so the message reaches the user verbatim.
 * Kept Nest-free on purpose: the Dockerfile bake step requires this
 * module standalone, outside any Nest context.
 */
export class ParquetUserError extends Error {}

/**
 * Thrown when the DuckDB binding itself cannot load or the spatial
 * extension cannot be provisioned. IngestService maps this to an
 * InternalServerErrorException, mirroring how a missing gdal-async
 * prebuild is reported.
 */
export class DuckDbUnavailableError extends Error {}

/** Case-insensitive extension check shared by every ingest branch. */
export function isParquetPath(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.parquet') || lower.endsWith('.geoparquet');
}

/**
 * A Parquet file is always a single layer; we name it after the file
 * stem the same way GDAL names a standalone GeoJSON layer after its
 * file. The probe response and the later per-layer ingest both derive
 * the name from the on-disk path, so they agree by construction.
 */
export function parquetLayerName(filePath: string): string {
  return basename(filePath).replace(/\.(geo)?parquet$/i, '');
}

type DuckDbModule = typeof import('@duckdb/node-api');
type DuckDBConnection = import('@duckdb/node-api').DuckDBConnection;
type DuckDBValue = import('@duckdb/node-api').DuckDBValue;

/**
 * Lazy-load the native binding the same way IngestService.loadGdal
 * defers gdal-async: an eager import would crash portal-api boot on
 * any platform whose prebuild is missing, and non-Parquet ingest
 * must keep working there.
 *
 * Exported so the GeoParquet export side (data-layer/geoparquet-
 * export.ts) can reach value-level module exports (timestampTZValue
 * and friends) without taking its own eager import and breaking the
 * lazy-load contract.
 */
export async function loadDuckDb(): Promise<DuckDbModule> {
  try {
    const mod = await import('@duckdb/node-api');
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DuckDbUnavailableError(
      `Server-side GeoParquet ingest is unavailable because the DuckDB binding failed to load: ${msg}`,
    );
  }
}

/**
 * Open a fresh in-memory DuckDB with the spatial extension loaded,
 * run `fn`, and always tear the instance down. One instance per
 * operation keeps failure domains small (a poisoned connection can
 * not leak into the next import) at a few milliseconds of setup cost,
 * which is noise next to reading a real file.
 *
 * Exported (with escapeSqlLiteral / quoteIdent below) so the export
 * path shares one lifecycle + extension-provisioning implementation
 * instead of growing a drift-prone copy.
 *
 * `opts.dbPath` swaps the `:memory:` instance for a file-backed
 * database. Readers never need it, but the GeoParquet export
 * stages every row in a table before COPY; on-disk staging lets
 * DuckDB page that table out under the memory cap, so exports
 * larger than DUCKDB_MAX_MEMORY still complete. The caller owns
 * the file's directory lifecycle (temp dir + cleanup).
 */
export async function withSpatialConnection<T>(
  fn: (connection: DuckDBConnection, duckdb: DuckDbModule) => Promise<T>,
  opts: { dbPath?: string } = {},
): Promise<T> {
  const duckdb = await loadDuckDb();
  const instance = await duckdb.DuckDBInstance.create(opts.dbPath ?? ':memory:', {
    max_memory: DUCKDB_MAX_MEMORY,
  });
  const connection = await instance.connect();
  try {
    try {
      // Prod image: the baked dir exists, so INSTALL is a local
      // no-op and LOAD reads from disk with no network. Dev host:
      // the dir does not exist, DuckDB uses its default per-user
      // extension dir and downloads spatial once.
      if (existsSync(DUCKDB_EXTENSION_DIR)) {
        await connection.run(
          `SET extension_directory = '${escapeSqlLiteral(DUCKDB_EXTENSION_DIR)}'`,
        );
      }
      await connection.run('INSTALL spatial');
      await connection.run('LOAD spatial');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DuckDbUnavailableError(
        `DuckDB spatial extension could not be loaded: ${msg}`,
      );
    }
    // The loaded module rides along so callbacks can reach value
    // classes (instanceof checks in duckValueToJson) and value
    // factories without a second dynamic import.
    return await fn(connection, duckdb);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * Image-build hook: install the spatial extension into
 * DUCKDB_EXTENSION_DIR and load it once as a smoke test, so a broken
 * extension download fails the docker build instead of the first
 * import in prod. Runs as root during the build; at runtime the app
 * user only needs read access to the baked files.
 */
export async function bakeSpatialExtension(): Promise<string> {
  const duckdb = await loadDuckDb();
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(
      `SET extension_directory = '${escapeSqlLiteral(DUCKDB_EXTENSION_DIR)}'`,
    );
    await connection.run('INSTALL spatial');
    await connection.run('LOAD spatial');
    // Exercise a spatial function so a corrupt download cannot pass.
    await connection.runAndReadAll('SELECT ST_AsGeoJSON(ST_Point(0, 0))');
    return DUCKDB_EXTENSION_DIR;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Parsed subset of the GeoParquet `geo` file metadata we act on. */
interface GeoParquetColumnMeta {
  encoding?: unknown;
  geometry_types?: unknown;
  crs?: unknown;
}

interface GeoParquetMeta {
  primary_column?: unknown;
  columns?: Record<string, GeoParquetColumnMeta>;
}

/** Everything downstream SQL generation needs to know about a file. */
interface ParquetSource {
  /** Name of the geometry column we will serialize. */
  geometryColumn: string;
  /** SQL expression producing a GEOMETRY value from that column. */
  geometryExpr: string;
  /** Non-geometry columns, in file order. */
  propertyColumns: Array<{ name: string; type: string }>;
  fields: SimpleField[];
  geometryType: SimpleGeometryType | null;
  /** Auth:code string for provenance, or null when nothing declared. */
  sourceSrs: string | null;
  /**
   * ST_Transform source argument when the declared CRS is not
   * lon/lat WGS84, else null (no reprojection needed). Either an
   * "AUTH:CODE" string or a full PROJJSON document for CRSes that
   * carry no authority id.
   */
  transformSource: string | null;
}

/**
 * Inspect a Parquet file: DESCRIBE the columns, parse the GeoParquet
 * `geo` metadata, resolve the geometry column and CRS, and classify
 * the geometry family. Shared by probe, stream, and collect so the
 * three surfaces can never disagree about a file.
 */
async function describeSource(
  connection: DuckDBConnection,
  filePath: string,
): Promise<ParquetSource> {
  const pathLit = escapeSqlLiteral(filePath);

  // File-level key/value metadata. The value is a BLOB; decode() is
  // the real UTF-8 conversion (a VARCHAR cast would render bytes as
  // \xNN escapes and corrupt the JSON).
  const kvReader = await connection.runAndReadAll(
    `SELECT decode(value) AS geo FROM parquet_kv_metadata('${pathLit}') WHERE key = encode('geo')`,
  );
  const geoValue = kvReader.getRows()[0]?.[0];
  let geoMeta: GeoParquetMeta | null = null;
  if (typeof geoValue === 'string') {
    try {
      geoMeta = JSON.parse(geoValue) as GeoParquetMeta;
    } catch {
      throw new ParquetUserError(
        'The GeoParquet "geo" file metadata is not valid JSON.',
      );
    }
  }

  const descReader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM read_parquet('${pathLit}')`,
  );
  const columns = descReader.getRowObjects().map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));

  // Resolve the geometry column. Priority: the geo metadata's
  // primary_column (the GeoParquet source of truth); then any column
  // DuckDB already typed as GEOMETRY (spatial does that when geo
  // metadata is present); then a conventionally named WKB blob for
  // parquet-with-geometry files written before GeoParquet existed.
  let geometryColumn: string | null = null;
  const primary =
    typeof geoMeta?.primary_column === 'string' ? geoMeta.primary_column : null;
  if (primary !== null) {
    if (!columns.some((c) => c.name === primary)) {
      throw new ParquetUserError(
        `The GeoParquet metadata names "${primary}" as the primary geometry column, but the file has no such column.`,
      );
    }
    geometryColumn = primary;
  } else {
    const typed = columns.find((c) => isGeometryType(c.type));
    if (typed) {
      geometryColumn = typed.name;
    } else {
      const conventional = columns.find(
        (c) =>
          baseType(c.type) === 'BLOB' &&
          ['geometry', 'geom', 'wkb_geometry'].includes(c.name.toLowerCase()),
      );
      geometryColumn = conventional?.name ?? null;
    }
  }
  if (geometryColumn === null) {
    throw new ParquetUserError(
      'The file has no geometry column we can import. Only GeoParquet (or Parquet with a WKB "geometry" column) is supported.',
    );
  }

  const geomColType =
    columns.find((c) => c.name === geometryColumn)?.type ?? 'BLOB';
  const columnMeta = geoMeta?.columns?.[geometryColumn];

  // GeoParquet 1.1 allows GeoArrow-native encodings. When DuckDB has
  // already converted the column to GEOMETRY we do not care how it
  // was encoded on disk; when it has not (plain BLOB) we can only
  // decode WKB, so reject other encodings loudly instead of feeding
  // arbitrary bytes to ST_GeomFromWKB.
  if (!isGeometryType(geomColType)) {
    const encoding =
      typeof columnMeta?.encoding === 'string' ? columnMeta.encoding : null;
    if (encoding !== null && encoding.toUpperCase() !== 'WKB') {
      throw new ParquetUserError(
        `Unsupported GeoParquet geometry encoding "${encoding}". Only WKB-encoded geometry columns are supported.`,
      );
    }
    if (baseType(geomColType) !== 'BLOB') {
      throw new ParquetUserError(
        `Geometry column "${geometryColumn}" has type ${geomColType}, which we cannot decode as WKB.`,
      );
    }
  }
  const geometryExpr = isGeometryType(geomColType)
    ? quoteIdent(geometryColumn)
    : `ST_GeomFromWKB(${quoteIdent(geometryColumn)})`;

  const { sourceSrs, transformSource } = resolveCrs(geoMeta, columnMeta);

  // Properties are every column that is not geometry. Secondary
  // geometry columns (multi-geometry GeoParquet) are skipped: the
  // simple field model has exactly one geometry per layer, and a
  // WKB blob rendered as a string attribute would just be noise.
  const propertyColumns = columns.filter(
    (c) =>
      c.name !== geometryColumn &&
      !isGeometryType(c.type) &&
      !(geoMeta?.columns && c.name in geoMeta.columns),
  );
  const fields: SimpleField[] = propertyColumns.map((c) => ({
    name: c.name,
    type: duckdbTypeToSimple(c.type),
  }));

  const declaredTypes = Array.isArray(columnMeta?.geometry_types)
    ? columnMeta.geometry_types.filter((t): t is string => typeof t === 'string')
    : [];
  let geometryType = classifyGeometryNames(declaredTypes);
  if (geometryType === null) {
    geometryType = await sampleGeometryType(connection, pathLit, geometryExpr, geometryColumn);
  }

  return {
    geometryColumn,
    geometryExpr,
    propertyColumns,
    fields,
    geometryType,
    sourceSrs,
    transformSource,
  };
}

/**
 * Turn the GeoParquet crs declaration into a provenance string plus
 * an ST_Transform source argument. Per spec, a missing crs member
 * means OGC:CRS84 (lon/lat WGS84), which is what GeoJSON and our
 * PostGIS storage already use, so no transform. A file with no geo
 * metadata at all declared nothing; we assume 4326 the same way the
 * GDAL path treats a layer with no SRS.
 */
function resolveCrs(
  geoMeta: GeoParquetMeta | null,
  columnMeta: GeoParquetColumnMeta | undefined,
): { sourceSrs: string | null; transformSource: string | null } {
  if (geoMeta === null) {
    return { sourceSrs: null, transformSource: null };
  }
  const crs = columnMeta?.crs;
  if (crs === undefined || crs === null) {
    return { sourceSrs: 'OGC:CRS84', transformSource: null };
  }
  // Out-of-spec but seen in the wild: a bare "EPSG:4326"-style string
  // instead of a PROJJSON object. proj accepts these directly.
  if (typeof crs === 'string') {
    const trimmed = crs.trim();
    return {
      sourceSrs: trimmed,
      transformSource: isLonLatWgs84(trimmed) ? null : trimmed,
    };
  }
  if (typeof crs === 'object') {
    const id = (crs as { id?: { authority?: unknown; code?: unknown } }).id;
    const authority =
      typeof id?.authority === 'string' ? id.authority : null;
    const code =
      typeof id?.code === 'string' || typeof id?.code === 'number'
        ? String(id.code)
        : null;
    if (authority !== null && code !== null) {
      const authCode = `${authority}:${code}`;
      return {
        sourceSrs: authCode,
        transformSource: isLonLatWgs84(authCode) ? null : authCode,
      };
    }
    // PROJJSON without an authority id: proj consumes the document
    // itself, so pass it through verbatim. Provenance falls back to
    // the same placeholder srsAuthCode() uses for authority-less SRS.
    return { sourceSrs: 'CRS:unknown', transformSource: JSON.stringify(crs) };
  }
  return { sourceSrs: 'CRS:unknown', transformSource: null };
}

/** CRS strings that already mean lon/lat WGS84, i.e. no reprojection. */
function isLonLatWgs84(authCode: string): boolean {
  const u = authCode.toUpperCase();
  return u === 'OGC:CRS84' || u === 'EPSG:4326' || u === 'CRS84' || u === 'WGS84';
}

/**
 * Classify declared GeoParquet geometry_types ("Point", "MultiPolygon
 * Z", ...) into the tri-state the builder exposes. Mirrors the string
 * branch of gdalGeomToSimple. When the declared types span multiple
 * families we keep the first entry's family, matching the GDAL path's
 * peek-the-first-feature behavior for unknown-typed layers.
 */
function classifyGeometryNames(
  names: string[],
): SimpleGeometryType | null {
  for (const name of names) {
    const family = geometryNameToSimple(name);
    if (family !== null) return family;
  }
  return null;
}

function geometryNameToSimple(name: string): SimpleGeometryType | null {
  const s = name.toLowerCase();
  if (s.includes('point')) return 'point';
  if (s.includes('line') || s.includes('curve')) return 'line';
  if (s.includes('polygon') || s.includes('surface')) return 'polygon';
  return null;
}

/**
 * Fallback classification when geometry_types is absent or empty:
 * look at a bounded sample of real geometries. Bounded so a probe on
 * a multi-GB file stays fast.
 */
async function sampleGeometryType(
  connection: DuckDBConnection,
  pathLit: string,
  geometryExpr: string,
  geometryColumn: string,
): Promise<SimpleGeometryType | null> {
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT ST_GeometryType(${geometryExpr})::VARCHAR AS t ` +
      `FROM (SELECT ${quoteIdent(geometryColumn)} FROM read_parquet('${pathLit}') ` +
      `WHERE ${quoteIdent(geometryColumn)} IS NOT NULL LIMIT ${GEOMETRY_SAMPLE_ROWS}) s`,
  );
  const names = reader
    .getRows()
    .map((row) => (typeof row[0] === 'string' ? row[0] : ''))
    .filter((t) => t.length > 0);
  return classifyGeometryNames(names);
}

async function countRows(
  connection: DuckDBConnection,
  filePath: string,
): Promise<number> {
  const reader = await connection.runAndReadAll(
    `SELECT count(*) FROM read_parquet('${escapeSqlLiteral(filePath)}')`,
  );
  const value = reader.getRows()[0]?.[0];
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

/**
 * Probe: same shape as IngestService.probeFileFromPath's GDAL branch.
 * Always exactly one layer, named after the file stem.
 */
export async function probeParquetFromPath(filePath: string): Promise<{
  driver: string;
  layers: Array<{
    name: string;
    geometryType: SimpleGeometryType | null;
    fields: SimpleField[];
    featureCount: number;
  }>;
}> {
  return withSpatialConnection(async (connection) => {
    const source = await describeSource(connection, filePath);
    const featureCount = await countRows(connection, filePath);
    return {
      driver: 'Parquet',
      layers: [
        {
          name: parquetLayerName(filePath),
          geometryType: source.geometryType,
          fields: source.fields,
          featureCount,
        },
      ],
    };
  });
}

/**
 * Streaming read: emits { geometry, properties } batches with the
 * exact contract of the GDAL branch in streamLayerFromPath. Geometry
 * is a parsed GeoJSON object in EPSG:4326; rows whose geometry is
 * NULL are counted in `processed` but not emitted, mirroring how the
 * GDAL path skips undecodable geometries.
 *
 * Memory stays bounded because DuckDB's streaming result hands us
 * one vector-sized chunk (~2k rows) at a time; we never materialize
 * the query. `await onBatch` between flushes provides the same
 * DB-backpressure throttling as the GDAL path, and every fetchChunk
 * is a real async hop, so the event loop is never starved the way a
 * synchronous GDAL pump would.
 */
export async function streamParquetFromPath(
  filePath: string,
  sourceLayer: string | undefined,
  onBatch: (
    batch: Array<{ geometry: unknown; properties: Record<string, unknown> }>,
    progress: { processed: number; total: number },
  ) => Promise<void>,
  opts: { batchSize?: number } = {},
): Promise<{
  fields: SimpleField[];
  driver: string;
  layerName: string;
  sourceSrs: string | null;
  total: number;
}> {
  const batchSize = Math.max(1, opts.batchSize ?? 5000);
  const layerName = parquetLayerName(filePath);
  if (sourceLayer !== undefined && sourceLayer !== layerName) {
    throw new ParquetUserError(`File has no layer named "${sourceLayer}".`);
  }
  return withSpatialConnection(async (connection, duckdb) => {
    const source = await describeSource(connection, filePath);
    const total = await countRows(connection, filePath);

    const geomOut =
      source.transformSource === null
        ? source.geometryExpr
        : `ST_Transform(${source.geometryExpr}, ` +
          `'${escapeSqlLiteral(source.transformSource)}', 'EPSG:4326', always_xy := true)`;
    // Geometry first, then properties in file order. Positional
    // access below keeps us safe from any alias collision with a
    // property column that happens to be named "geojson".
    const selectList = [
      `ST_AsGeoJSON(${geomOut}) AS geojson`,
      ...source.propertyColumns.map((c) => quoteIdent(c.name)),
    ].join(', ');
    const result = await connection.stream(
      `SELECT ${selectList} FROM read_parquet('${escapeSqlLiteral(filePath)}')`,
    );

    let batch: Array<{
      geometry: unknown;
      properties: Record<string, unknown>;
    }> = [];
    let processed = 0;
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      for (const row of chunk.getRows()) {
        processed += 1;
        const geoJsonText = row[0];
        if (typeof geoJsonText !== 'string') continue;
        const properties: Record<string, unknown> = {};
        for (let i = 0; i < source.propertyColumns.length; i += 1) {
          const column = source.propertyColumns[i];
          if (!column) continue;
          properties[column.name] = duckValueToJson(row[i + 1] ?? null, duckdb);
        }
        batch.push({ geometry: JSON.parse(geoJsonText), properties });
        if (batch.length >= batchSize) {
          await onBatch(batch, { processed, total });
          batch = [];
        }
      }
    }
    if (batch.length > 0) {
      await onBatch(batch, { processed, total });
    }

    return {
      fields: source.fields,
      driver: 'Parquet',
      layerName,
      sourceSrs: source.sourceSrs,
      total,
    };
  });
}

/**
 * Collect the whole file into a FeatureCollection. Serves the legacy
 * v1/v2 ingest and the to-geojson endpoint, which buffer the full
 * dataset by design. Built on the streaming reader so there is one
 * SQL/typing path to maintain.
 */
export async function collectParquetFromPath(
  filePath: string,
  sourceLayer: string | undefined,
): Promise<{
  geojson: { type: 'FeatureCollection'; features: unknown[] };
  fields: SimpleField[];
  driver: string;
  layerName: string;
  sourceSrs: string | null;
}> {
  const features: unknown[] = [];
  const meta = await streamParquetFromPath(
    filePath,
    sourceLayer,
    async (batch) => {
      for (const row of batch) {
        features.push({
          type: 'Feature',
          geometry: row.geometry,
          properties: row.properties,
        });
      }
    },
  );
  return {
    geojson: { type: 'FeatureCollection', features },
    fields: meta.fields,
    driver: meta.driver,
    layerName: meta.layerName,
    sourceSrs: meta.sourceSrs,
  };
}

/**
 * Map a DuckDB column type to the simple field vocabulary the GDAL
 * path produces (gdalTypeToSimple semantics). Token-based on purpose:
 * a substring check like the GDAL helper uses would misfile INTERVAL
 * as a number because it contains "int".
 */
const NUMERIC_BASE_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'FLOAT',
  'DOUBLE',
  'REAL',
  'DECIMAL',
  'NUMERIC',
  'VARINT',
  'BIGNUM',
]);

function duckdbTypeToSimple(t: string): SimpleFieldType {
  const base = baseType(t);
  if (NUMERIC_BASE_TYPES.has(base)) return 'number';
  if (base === 'BOOLEAN' || base === 'BOOL') return 'boolean';
  if (
    base === 'DATE' ||
    base.startsWith('TIMESTAMP') ||
    base.startsWith('TIME')
  ) {
    return 'date';
  }
  return 'string';
}

/** "DECIMAL(10,2)" to "DECIMAL", "GEOMETRY('OGC:CRS84')" to "GEOMETRY". */
function baseType(t: string): string {
  return t.trim().toUpperCase().replace(/\(.*$/, '').trim();
}

function isGeometryType(t: string): boolean {
  return baseType(t) === 'GEOMETRY';
}

/**
 * Convert a DuckDBValue into something JSON.stringify-safe that also
 * matches the simple field type we advertised for the column:
 * numbers stay numbers (including DECIMAL via toDouble and BIGINT
 * when it fits a JS number), temporal values become their canonical
 * string forms (same as GDAL's string dates), blobs become base64,
 * and nested types fall back to their DuckDB text rendering.
 *
 * TIMESTAMPTZ is the one temporal type that must NOT go through
 * String(value): the binding renders it in the session time zone,
 * so the same file would import different attribute strings on
 * hosts in different time zones. We convert its epoch micros to
 * ISO-8601 UTC ourselves, which is deterministic everywhere and
 * matches the app's stored date contract. Naive TIMESTAMP and DATE
 * have no zone to shift through, so their text forms are already
 * deterministic.
 */
function duckValueToJson(value: DuckDBValue, duckdb: DuckDbModule): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint': {
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    case 'object': {
      if (value instanceof duckdb.DuckDBTimestampTZValue) {
        return timestampTzMicrosToIso(value.micros);
      }
      const wrapped = value as {
        toDouble?: () => number;
        bytes?: unknown;
      };
      if (typeof wrapped.toDouble === 'function') return wrapped.toDouble();
      if (wrapped.bytes instanceof Uint8Array) {
        return Buffer.from(wrapped.bytes).toString('base64');
      }
      return String(value);
    }
    default:
      return String(value);
  }
}

/**
 * Epoch microseconds to ISO-8601 UTC. Sub-millisecond digits are
 * appended when present so a microsecond-precision source column
 * loses nothing; floor division keeps pre-1970 instants correct
 * (bigint / truncates toward zero, which would pair a too-high
 * millisecond with a negative remainder).
 */
function timestampTzMicrosToIso(micros: bigint): string {
  let ms = micros / 1000n;
  let subMsMicros = micros % 1000n;
  if (subMsMicros < 0n) {
    subMsMicros += 1000n;
    ms -= 1n;
  }
  const iso = new Date(Number(ms)).toISOString();
  if (subMsMicros === 0n) return iso;
  return iso.replace('Z', `${subMsMicros.toString().padStart(3, '0')}Z`);
}

export function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
