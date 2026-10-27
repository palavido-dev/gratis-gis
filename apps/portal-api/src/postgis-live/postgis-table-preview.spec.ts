// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  listGeometryTablesPreview,
  MAX_TEST_CONNECTION_TABLES,
} from './postgis-table-preview.js';

describe('listGeometryTablesPreview (R4-postgis-help-schema-browser)', () => {
  it('exports a positive table preview cap', () => {
    expect(MAX_TEST_CONNECTION_TABLES).toBeGreaterThan(0);
    expect(MAX_TEST_CONNECTION_TABLES).toBeLessThanOrEqual(200);
  });

  it('maps geometry_columns rows and flags truncation', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push(params === undefined ? { sql } : { sql, params });
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ n: '3' }] };
        }
        return {
          rows: [
            {
              f_table_schema: 'public',
              f_table_name: 'parcels',
              f_geometry_column: 'geom',
              srid: 4326,
              type: 'MULTIPOLYGON',
              row_estimate: '1200',
            },
            {
              f_table_schema: 'public',
              f_table_name: 'roads',
              f_geometry_column: 'shape',
              srid: 3857,
              type: 'LINESTRING',
              row_estimate: null,
            },
          ],
        };
      },
    };

    const out = await listGeometryTablesPreview(client, 'public', 2);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.tables).toEqual([
      {
        name: 'public.parcels',
        geometryColumn: 'geom',
        geometryKind: 'MULTIPOLYGON',
        srid: 4326,
        rowEstimate: 1200,
      },
      {
        name: 'public.roads',
        geometryColumn: 'shape',
        geometryKind: 'LINESTRING',
        srid: 3857,
        rowEstimate: null,
      },
    ]);
    expect(calls[0]?.params).toEqual(['public']);
    expect(calls[1]?.params).toEqual(['public', 2]);
  });

  it('treats missing reltuples as unknown', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return { rows: [{ n: '1' }] };
        }
        return {
          rows: [
            {
              f_table_schema: 'gis',
              f_table_name: 'fresh',
              f_geometry_column: 'g',
              srid: 4326,
              type: 'POINT',
              row_estimate: null,
            },
          ],
        };
      },
    };
    const out = await listGeometryTablesPreview(client, 'gis', 50);
    expect(out.truncated).toBe(false);
    expect(out.tables[0]?.rowEstimate).toBeNull();
  });
});
