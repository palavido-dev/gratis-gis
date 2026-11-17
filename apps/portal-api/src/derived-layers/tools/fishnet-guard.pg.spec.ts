// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fishnet cell cap was checked only at save, against the raw
// source extent. Preview, a buffer before the fishnet, or a derived
// source got around it, and ST_SquareGrid builds the whole grid before
// any LIMIT. The cap is now part of the SQL.

import { Pool } from 'pg';

import { fishnetGenerator } from './fishnet.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the fishnet guard suite would silently skip.');
}

jest.setTimeout(120_000);

d('fishnet cell cap in SQL', () => {
  let pool: Pool;
  const dbName = 'gg_fishnet_guard';

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(TEST_URL!);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 1 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  });

  afterAll(async () => {
    await pool?.end();
  });

  const run = (size: number, unit: string, polygonDeg: number) => {
    const params = fishnetGenerator.validate({ cellSize: size, unit, output: 'polygons' });
    const frag = fishnetGenerator.toSql('src', params as never, 0);
    const sql = `WITH src AS (
        SELECT ST_MakeEnvelope(0, 0, ${polygonDeg}, ${polygonDeg}, 4326) AS geom
      ) SELECT count(*)::int AS n FROM (${frag.sql}) q`;
    return pool.query<{ n: number }>(sql, frag.params);
  };

  it('builds a small grid as before', async () => {
    const r = await run(1000, 'meters', 0.05);
    expect(r.rows[0]!.n).toBeGreaterThan(0);
  });

  it('refuses a grid over the cap before building it', async () => {
    const t = Date.now();
    await expect(run(1, 'meters', 0.2)).rejects.toThrow(/more than 1000000 cells/);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
