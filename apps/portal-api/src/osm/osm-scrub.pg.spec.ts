// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hourly OSM cache scrub deleted rows by ctid. observation is
// partitioned by tx_time, a ctid is only unique inside one partition,
// so every chunk also deleted the rows at the same physical slots in
// the other monthly partitions: user data layer rows. This suite puts
// user rows in an older partition and cache rows in the current one,
// at the same slots, and checks only the cache rows go.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { OsmScrubService } from './osm-scrub.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the OSM scrub suite would silently skip.',
  );
}

jest.setTimeout(180_000);

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('OSM cache scrub on the partitioned observation table', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  const dbName = 'gg_osm_scrub';
  const dbUrl = databaseUrl(TEST_URL!, dbName);
  const USER = 'data_layer:24000000-0000-4000-8000-000000000001:lyr_a';
  const CACHE = 'osm:abc123';

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prismaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 2 }) });
    const insert = (scope: string, n: number, monthsBack: number) =>
      pool.query(
        `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents)
         SELECT gen_random_uuid(), date_trunc('month', now()) - make_interval(months => $3::int) + interval '1 day', now(), $1, gen_random_uuid(), 'create', 'test', '{}'::jsonb, '{}'::uuid[]
         FROM generate_series(1, $2::int)`,
        [scope, n, monthsBack],
      );
    // User rows two months back, cache rows this month. Both start at
    // the first slot of a fresh partition, so their ctids coincide.
    await insert(USER, 1000, 2);
    await insert(CACHE, 300, 0);
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  const count = async (scope: string): Promise<number> =>
    Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM observation WHERE scope = $1', [scope])).rows[0]!.n);

  it('the cache rows and the user rows share physical slots (the precondition of the bug)', async () => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM observation u JOIN observation c ON u.ctid = c.ctid
       WHERE u.scope = $1 AND c.scope = $2`,
      [USER, CACHE],
    );
    expect(Number(r.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('purgeScope removes only the cache scope', async () => {
    const service = Object.create(OsmScrubService.prototype) as OsmScrubService;
    (service as unknown as { prisma: PrismaClient }).prisma = prismaClient;
    const removed = await service.purgeScope(CACHE);
    expect(removed).toBe(300);
    expect(await count(CACHE)).toBe(0);
    expect(await count(USER)).toBe(1000);
  });

  it('refuses a scope that is not an OSM cache scope', async () => {
    const service = Object.create(OsmScrubService.prototype) as OsmScrubService;
    (service as unknown as { prisma: PrismaClient }).prisma = prismaClient;
    await expect(service.purgeScope(USER)).rejects.toThrow(/non-OSM scope/);
    expect(await count(USER)).toBe(1000);
  });
});
