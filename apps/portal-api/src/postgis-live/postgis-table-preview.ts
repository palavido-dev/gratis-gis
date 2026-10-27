// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Capped geometry-table inventory for the PostGIS connect wizard.
 * Kept free of Nest imports so unit tests can run without pulling
 * the ESM-only `@nestjs/common` package into Jest.
 */

/** Cap on geometry tables returned by test-connection so a huge
 *  schema can't overwhelm the connect wizard. Probe-on-save still
 *  registers every geometry table in the default schema. */
export const MAX_TEST_CONNECTION_TABLES = 50;

/** One geometry-table row shown in the connect wizard after a
 *  successful test-connection. Row estimate comes from
 *  `pg_class.reltuples` (planner statistic; may be -1 / 0 when
 *  ANALYZE has never run). */
export interface PostgisTablePreview {
  name: string;
  geometryColumn: string;
  geometryKind: string;
  srid: number;
  rowEstimate: number | null;
}

/**
 * Geometry-table inventory for the connect wizard. Geometry tables
 * only (via `geometry_columns`), capped at `limit`, with a cheap
 * `pg_class.reltuples` row estimate.
 */
export async function listGeometryTablesPreview(
  client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  },
  schema: string,
  limit: number,
): Promise<{ tables: PostgisTablePreview[]; truncated: boolean; total: number }> {
  const countRes = await client.query(
    `SELECT COUNT(*)::text AS n
     FROM geometry_columns
     WHERE f_table_schema = $1`,
    [schema],
  );
  const total =
    Number.parseInt(String(countRes.rows[0]?.n ?? '0'), 10) || 0;
  const geomRows = await client.query(
    `SELECT g.f_table_schema, g.f_table_name, g.f_geometry_column,
            g.srid, g.type,
            CASE
              WHEN c.reltuples IS NULL OR c.reltuples < 0 THEN NULL
              ELSE ROUND(c.reltuples)::text
            END AS row_estimate
     FROM geometry_columns g
     LEFT JOIN pg_namespace n
       ON n.nspname = g.f_table_schema
     LEFT JOIN pg_class c
       ON c.relnamespace = n.oid AND c.relname = g.f_table_name
     WHERE g.f_table_schema = $1
     ORDER BY g.f_table_name, g.f_geometry_column
     LIMIT $2`,
    [schema, limit],
  );
  return {
    tables: geomRows.rows.map((row) => {
      const estimateRaw = row.row_estimate;
      const parsed =
        estimateRaw == null
          ? NaN
          : Number.parseInt(String(estimateRaw), 10);
      return {
        name: `${String(row.f_table_schema)}.${String(row.f_table_name)}`,
        geometryColumn: String(row.f_geometry_column),
        geometryKind: String(row.type),
        srid: Number(row.srid),
        rowEstimate: Number.isFinite(parsed) ? parsed : null,
      };
    }),
    truncated: total > limit,
    total,
  };
}
