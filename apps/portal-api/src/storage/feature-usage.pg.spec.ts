// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The feature data estimate against Postgres: a seeded layer is
// estimated within 15% of the table space its rows take (indexes left
// out), quickly; deleted and superseded versions do not count; two
// orgs' numbers never mix; purge takes a layer off.
//
// FEATURE_USAGE_ROWS sets the seeded layer's size (default 200000).

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { StorageLedgerService } from './storage-ledger.service.js';
import {
  forgetItemFeatureUsage,
  layerScope,
  measureLayer,
  runFeatureUsagePass,
} from './feature-usage.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the feature usage pg suite would skip.');
}

jest.setTimeout(900_000);

const ROWS = Number(process.env.FEATURE_USAGE_ROWS ?? 200_000);
const MIGRATIONS = join(__dirname, '../../prisma/migrations');
const ORG_A = '6a000000-0000-4000-8000-00000000000a';
const ORG_B = '6b000000-0000-4000-8000-00000000000b';
const USER_A = '6a000000-0000-4000-8000-0000000000a1';
const USER_B = '6b000000-0000-4000-8000-0000000000b1';
const BIG = '6a000000-0000-4000-8000-0000000000f1';
const SMALL_B = '6b000000-0000-4000-8000-0000000000f2';
const DB = `gg_feature_usage_${process.pid}`;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('feature data estimate against Postgres', () => {
  let pool: Pool;
  let client: PrismaClient;
  let prisma: PrismaService;

  const seed = async (itemId: string, layer: string, n: number, note: number): Promise<void> => {
    await pool.query(
      `INSERT INTO observation (id, valid_from, scope, entity, kind, attrs, geom, author_sub, source)
       SELECT gen_random_uuid(), now(), $1, gen_random_uuid(), 'create',
              jsonb_build_object('name', 'feature ' || g, 'value', g, 'note', repeat('x', $3::int)),
              ST_SetSRID(ST_MakePoint(random() * 10, random() * 10), 4326), 'seed', '{}'::jsonb
         FROM generate_series(1, $2::int) g`,
      [layerScope(itemId, layer), n, note],
    );
  };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    const url = databaseUrl(TEST_URL!, DB);
    applyTestMigrations(url, MIGRATIONS);
    pool = new Pool({ connectionString: url, max: 2 });
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'a', 'A'), ($2, 'b', 'B')`,
      [ORG_A, ORG_B],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'a', 'a@example.test', 'A', 'admin'), ($3, $4, 'b', 'b@example.test', 'B', 'admin')`,
      [USER_A, ORG_A, USER_B, ORG_B],
    );
    const layers = JSON.stringify({ version: 3, layers: [{ id: 'sites' }] });
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'big', $5::jsonb, now()),
              ($4, $6, $7, 'data-layer', 'small', $5::jsonb, now())`,
      [BIG, ORG_A, USER_A, SMALL_B, layers, ORG_B, USER_B],
    );
    // Only the layer's rows in the table, so its table size is the truth
    // to compare with. Secondary indexes do not change that size; they
    // are dropped here to keep the seed quick and small on disk.
    for (const idx of ['observation_geom_gix', 'observation_attrs_gin', 'observation_cell_idx', 'observation_tx_time_idx']) {
      await pool.query(`DROP INDEX IF EXISTS ${idx}`);
    }
    await seed(BIG, 'sites', ROWS, 40);
    await pool.query('VACUUM ANALYZE observation');
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) });
    prisma = client as unknown as PrismaService;
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.end();
  });

  it(`estimates a ${ROWS}-feature layer within 15% of its table size, quickly`, async () => {
    const t0 = Date.now();
    const m = await measureLayer(prisma, { itemId: BIG, layerKey: 'sites', orgId: ORG_A });
    const ms = Date.now() - t0;
    const truth = await pool.query<{ b: string }>(
      `SELECT COALESCE(SUM(pg_table_size(inhrelid)), 0) AS b FROM pg_inherits
        WHERE inhparent = 'observation'::regclass`,
    );
    const actual = Number(truth.rows[0]!.b);
    const off = Math.abs(m.estBytes - actual) / actual;
    console.log(
      `feature usage: ${m.featureCount} features, estimate ${m.estBytes} B, table ${actual} B, ` +
        `off by ${(off * 100).toFixed(1)}%, measured in ${ms} ms`,
    );
    expect(m.featureCount).toBe(ROWS);
    expect(off).toBeLessThan(0.15);
    expect(ms).toBeLessThan(5000);
    const totals = await pool.query<{ feature_bytes: string; feature_count: string }>(
      'SELECT feature_bytes, feature_count FROM org_storage_usage WHERE org_id = $1',
      [ORG_A],
    );
    expect(Number(totals.rows[0]!.feature_bytes)).toBe(m.estBytes);
    expect(Number(totals.rows[0]!.feature_count)).toBe(ROWS);
  });

  it('counts the latest version of each feature only, and not deleted ones', async () => {
    await seed(SMALL_B, 'sites', 10, 10);
    const entities = await pool.query<{ entity: string }>(
      `SELECT entity FROM observation WHERE scope = $1 ORDER BY entity LIMIT 3`,
      [layerScope(SMALL_B, 'sites')],
    );
    const [e1, e2] = entities.rows.map((r) => r.entity);
    // An edit (a newer version of e1) and a delete of e2.
    await pool.query(
      `INSERT INTO observation (id, valid_from, scope, entity, kind, attrs, author_sub, source)
       VALUES (gen_random_uuid(), now() + interval '1 second', $1, $2, 'update', '{"name":"edited"}', 'seed', '{}'),
              (gen_random_uuid(), now() + interval '1 second', $1, $3, 'delete', NULL, 'seed', '{}')`,
      [layerScope(SMALL_B, 'sites'), e1, e2],
    );
    const m = await measureLayer(prisma, { itemId: SMALL_B, layerKey: 'sites', orgId: ORG_B });
    expect(m.featureCount).toBe(9);
  });

  it("two orgs' numbers never mix, and usage reads its own org", async () => {
    const ledger = new StorageLedgerService(prisma);
    const a = await ledger.usage(ORG_A);
    const b = await ledger.usage(ORG_B);
    expect(a.featureCount).toBe(ROWS);
    expect(b.featureCount).toBe(9);
    expect(a.totalBytes).toBe(a.objectBytes + a.featureBytes);
  });

  it('the nightly pass finds new layers, measures oldest first, and stops at its budget', async () => {
    await pool.query(`UPDATE layer_storage_usage SET measured_at = now() - interval '2 days'`);
    let clock = 0;
    const stopped = await runFeatureUsagePass(prisma, { budgetMs: 1, now: () => clock++ });
    expect(stopped.measured).toBeLessThanOrEqual(1);
    const full = await runFeatureUsagePass(prisma, { budgetMs: 600_000 });
    expect(full.remaining).toBe(0);
  });

  it('purge takes a layer off its org only', async () => {
    await forgetItemFeatureUsage(prisma, SMALL_B, ORG_B);
    const b = await pool.query<{ feature_bytes: string }>(
      'SELECT feature_bytes FROM org_storage_usage WHERE org_id = $1',
      [ORG_B],
    );
    expect(Number(b.rows[0]!.feature_bytes)).toBe(0);
    const a = await pool.query<{ feature_count: string }>(
      'SELECT feature_count FROM org_storage_usage WHERE org_id = $1',
      [ORG_A],
    );
    expect(Number(a.rows[0]!.feature_count)).toBe(ROWS);
  });
});
