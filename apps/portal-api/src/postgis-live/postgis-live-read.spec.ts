// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PostGIS Live: the probe is for editors only, reads of a table with
// more than 50 columns used to fail on Postgres's 100 argument limit,
// and malformed filter clauses reached the driver as 500s.

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Pool } from 'pg';

import { PostgisLiveService_ } from './postgis-live.service.js';

const ITEM = '11111111-1111-4111-8111-111111111111';

function columns(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'integer' }));
}

function service(opts: { canEdit: boolean; layerColumns?: number; query?: (sql: string, p: unknown[]) => Promise<{ rows: unknown[] }> }) {
  const item = {
    id: ITEM,
    type: 'service',
    data: {
      protocol: 'postgis_live',
      host: 'db.example',
      port: 5432,
      database: 'gis',
      role: 'r',
      layers: [
        {
          name: 'public.wide',
          title: 'wide',
          geometryColumn: 'geom',
          geometryKind: 'POINT',
          srid: 4326,
          columns: columns(opts.layerColumns ?? 2),
        },
      ],
    },
  };
  const prisma = {
    item: { findFirst: jest.fn(async () => item) },
    itemShare: { findMany: jest.fn(async () => []) },
  };
  const sharing = { canRead: () => true, canEdit: () => opts.canEdit };
  const svc = new PostgisLiveService_(prisma as never, {} as never, sharing as never);
  const sql: string[] = [];
  const client = {
    query: jest.fn(async (s: string, p: unknown[] = []) => {
      sql.push(s);
      if (opts.query && !/statement_timeout/i.test(s)) return opts.query(s, p);
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  (svc as unknown as { getPool: () => Promise<unknown> }).getPool = async () => ({
    connect: async () => client,
  });
  return { svc, sql };
}

describe('PostGIS Live probe', () => {
  it('is refused to a reader who cannot edit the service', async () => {
    const { svc, sql } = service({ canEdit: false });
    await expect(svc.probe({ id: 'u' } as never, ITEM)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sql).toEqual([]);
  });

  it('reads all columns in one query and uses the estimated extent, not a sample scan', async () => {
    const { svc, sql } = service({
      canEdit: true,
      query: async (s) => {
        if (s.includes('geometry_columns')) {
          return {
            rows: [
              { f_table_schema: 'public', f_table_name: 'a', f_geometry_column: 'geom', srid: 4326, type: 'POINT' },
              { f_table_schema: 'public', f_table_name: 'b', f_geometry_column: 'geom', srid: 4326, type: 'POINT' },
            ],
          };
        }
        if (s.includes('information_schema.columns')) {
          return {
            rows: [
              { table_name: 'a', column_name: 'name', data_type: 'text' },
              { table_name: 'a', column_name: 'geom', data_type: 'USER-DEFINED' },
              { table_name: 'b', column_name: 'kind', data_type: 'text' },
            ],
          };
        }
        return { rows: [] };
      },
    });
    const layers = await svc.probe({ id: 'u' } as never, ITEM);
    expect(sql.filter((s) => s.includes('information_schema.columns'))).toHaveLength(1);
    expect(sql.some((s) => /BERNOULLI/.test(s))).toBe(false);
    expect(sql.some((s) => /ST_EstimatedExtent/.test(s))).toBe(true);
    expect(layers.map((l) => l.columns.map((c) => c.name))).toEqual([['name'], ['kind']]);
  });
});

describe('PostGIS Live reads', () => {
  it('refuses malformed filter clauses with a 400', async () => {
    const { svc } = service({ canEdit: false });
    for (const clauses of [[null], [{ field: 'c0', op: 'contains', value: 5 }], [{ field: 'c0', op: '==', value: [1] }]]) {
      await expect(
        svc.readFeatures({ id: 'u' } as never, ITEM, {
          tableName: 'public.wide',
          filter: { combinator: 'all', clauses } as never,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

d('PostGIS Live read SQL on a wide table', () => {
  const dbName = 'gg_b5_postgis_live_wide';
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(TEST_URL!);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 1 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    const cols = columns(60).map((c) => `${c.name} integer DEFAULT 1`).join(', ');
    await pool.query(`CREATE TABLE wide (geom geometry(Point, 4326), ${cols})`);
    await pool.query(`INSERT INTO wide (geom) VALUES (ST_SetSRID(ST_MakePoint(1, 1), 4326))`);
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('returns all 60 attributes', async () => {
    const { svc } = service({
      canEdit: false,
      layerColumns: 60,
      query: (s, p) => pool.query(s, p) as never,
    });
    const fc = await svc.readFeatures({ id: 'u' } as never, ITEM, { tableName: 'public.wide' });
    const props = (fc.features[0] as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toHaveLength(60);
    expect(props.c59).toBe(1);
  });
});
