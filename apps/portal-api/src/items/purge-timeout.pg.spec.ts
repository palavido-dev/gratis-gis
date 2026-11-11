// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Purging a v3 data layer deletes every row of it from `observation`.
// The app role carries a 30 s statement_timeout, and a big layer takes
// longer than that to delete: on the demo a 2.5M polygon layer failed
// to purge with "canceling statement due to statement timeout", and
// the rows stayed behind for good (#573). The delete must lift the
// limit for itself.
//
// The test shrinks the role timeout to 300 ms and makes the delete
// slower than that with a statement trigger, so it runs in a second.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { ItemsService } from './items.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the purge timeout suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ITEM = '23000000-0000-4000-8000-000000000003';
const OTHER = '23000000-0000-4000-8000-000000000004';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('data layer purge under the app statement_timeout', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  const dbName = 'gg_purge_timeout';
  const dbUrl = databaseUrl(TEST_URL!, dbName);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    const setup = new Pool({ connectionString: dbUrl, max: 1 });
    // Every DELETE on observation sleeps 1 s once per statement, so the
    // purge's delete outlasts the 300 ms limit below whatever the row
    // count. Statement-level, so it fires on the partitioned parent.
    await setup.query(`
      CREATE FUNCTION gg_test_slow_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
    await setup.query(`
      CREATE TRIGGER gg_test_slow_delete BEFORE DELETE ON observation
      FOR EACH STATEMENT EXECUTE FUNCTION gg_test_slow_delete()`);
    // Stand-in for the app role's 30 s limit. The migrations set that
    // limit on the role itself, which outranks a database setting, so
    // use the one form more specific than both: role in this database.
    await setup.query(
      `ALTER ROLE CURRENT_USER IN DATABASE ${dbName} SET statement_timeout = '300ms'`,
    );
    await setup.end();
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }),
    });
    for (const [item, n] of [
      [ITEM, 50],
      [OTHER, 3],
    ] as const) {
      await pool.query(
        `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents)
         SELECT gen_random_uuid(), now(), now(), $1, gen_random_uuid(), 'create', 'test', '{}'::jsonb, '{}'::uuid[]
         FROM generate_series(1, $2::int)`,
        [`data_layer:${item}:lyr_a`, n],
      );
    }
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  const count = async (item: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM observation WHERE scope LIKE $1',
      [`data_layer:${item}:%`],
    );
    return Number(r.rows[0]!.n);
  };

  it('the plain delete trips the limit (the bug this guards)', async () => {
    await expect(
      prismaClient.$executeRaw`DELETE FROM observation WHERE scope LIKE ${`data_layer:${ITEM}:%`}`,
    ).rejects.toThrow(/statement timeout/);
    expect(await count(ITEM)).toBe(50);
  });

  it('tearDownItemBackingStorage deletes every row of a slow layer', async () => {
    const service = Object.create(ItemsService.prototype) as ItemsService;
    (service as unknown as { prisma: PrismaClient }).prisma = prismaClient;
    await service.tearDownItemBackingStorage(ITEM, 'data_layer', {
      version: 3,
      storageType: 'postgis',
      layers: [],
    });
    expect(await count(ITEM)).toBe(0);
    // Other items' rows are untouched.
    expect(await count(OTHER)).toBe(3);
  });

  it('leaves the limit in place for the next statement on the pool', async () => {
    const r = await prismaClient.$queryRaw<
      Array<{ statement_timeout: string }>
    >`SHOW statement_timeout`;
    expect(r[0]!.statement_timeout).toBe('300ms');
  });
});
