// SPDX-License-Identifier: AGPL-3.0-or-later
/** Feature tables, plus attribute (non-spatial) tables no extension
 *  claims as a whole. Attribute tables are a supported import target
 *  (a file geodatabase shows its tables), but extensions such as NGA
 *  styles register their own tables as attributes too, and
 *  gpkg_extensions names those. */
const FEATURES_AND_USER_TABLES = `
  SELECT table_name FROM gpkg_contents
  WHERE data_type = 'features'
     OR (data_type IN ('attributes', 'aspatial')
         AND table_name NOT IN (
           SELECT table_name FROM gpkg_extensions
           WHERE table_name IS NOT NULL AND column_name IS NULL
         ))
`;
/** Older files may have no gpkg_extensions table at all. */
const FEATURES_ONLY = `
  SELECT table_name FROM gpkg_contents WHERE data_type = 'features'
`;

/**
 * GPKG-specific filter: query `gpkg_contents` through gdal-async's
 * `executeSQL` hook to identify which tables are registered as
 * feature layers (data_type='features') or user attribute tables.
 * The data_layer wizard uses this to skip auxiliary tables (NGA style extension's
 * `nga_*` tables, gpkg internals, rtree spatial-index tables,
 * tile pyramids, etc.) that GDAL otherwise exposes as
 * zero-geometry layers.
 *
 * Returns a Set of allowed table names. If the catalog cannot be
 * read, returns null so the caller keeps every layer. An empty set
 * means the catalog was read and registered no feature tables.
 *
 * The cast is because gdal-async's TypeScript declarations don't
 * currently surface executeSQL; the method is available at runtime
 * on the Dataset object.
 */
export function readGpkgFeatureTables(ds: unknown): Set<string> | null {
  return queryTableNames(ds, FEATURES_AND_USER_TABLES) ?? queryTableNames(ds, FEATURES_ONLY);
}

function queryTableNames(ds: unknown, sql: string): Set<string> | null {
  const set = new Set<string>();
  try {
    const dataset = ds as {
      executeSQL: (sql: string) => {
        features: { forEach: (cb: (f: unknown) => void) => void };
      };
      releaseResultSet?: (layer: unknown) => void;
    };
    const result = dataset.executeSQL(sql);
    result.features.forEach((f) => {
      const feature = f as { fields: { get: (name: string) => unknown } };
      const tableName = feature.fields.get('table_name');
      if (typeof tableName === 'string' && tableName.length > 0) {
        set.add(tableName);
      }
    });
    if (typeof dataset.releaseResultSet === 'function') {
      try {
        dataset.releaseResultSet(result);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // No gpkg_contents, or this gdal-async build has no executeSQL.
    // An empty set would drop every layer and the file would look
    // empty. Null tells the caller to keep the layers GDAL listed.
    return null;
  }
  return set;
}
