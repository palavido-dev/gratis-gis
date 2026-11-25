// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ObjectIDs for the FeatureServer interface: the trigger numbers new
// features as they are written, the backfill numbers older ones in the
// order they were first written, and a number never changes or moves.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { FeatureOidService } from './feature-oid.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the feature ObjectID suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '23000000-0000-4000-8000-000000000001';
const USER = '23000000-0000-4000-8000-000000000002';
const ITEM = '23000000-0000-4000-8000-000000000003';
const SCOPE = `data_layer:${ITEM}:pts`;
const OTHER = `data_layer:${ITEM}:lines`;
const E = (n: number) => `23000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('feature ObjectIDs', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  let svc: FeatureOidService;
  const dbName = 'gg_feature_oid';
  const dbUrl = databaseUrl(TEST_URL!, dbName);
  let seq = 0;

  async function write(scope: string, entity: string, kind: string, at: string): Promise<void> {
    seq += 1;
    await pool.query(
      `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, attrs, author_sub, source)
       VALUES ($1, $2, $2, $3, $4, $5, '{}'::jsonb, 'test', '{}'::jsonb)`,
      [`23000000-0000-7000-9000-${String(seq).padStart(12, '0')}`, at, scope, entity, kind],
    );
  }

  async function oidOf(scope: string, entity: string): Promise<number | null> {
    const r = await pool.query(`SELECT oid FROM feature_oid WHERE scope = $1 AND entity = $2`, [
      scope,
      entity,
    ]);
    return r.rowCount ? Number(r.rows[0].oid) : null;
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prismaClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }) });
    svc = new FeatureOidService(
      prismaClient as unknown as PrismaService,
      { shouldRun: () => true } as unknown as LeaderElectionService,
    );
    await pool.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'oid-org', 'Oid Org')`, [ORG]);
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'oid-user', 'oid@example.test', 'Oid User', 'admin')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
       VALUES ($1, $2, $3, 'data-layer', 'Layer', $4::jsonb, now())`,
      [ITEM, ORG, USER, JSON.stringify({ version: 3, layers: [{ id: 'pts' }, { id: 'lines' }] })],
    );
  });

  afterAll(async () => {
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('numbers features written before the trigger existed, oldest first', async () => {
    // Stand-in for rows written before the migration.
    await pool.query(`ALTER TABLE observation DISABLE TRIGGER observation_assign_oid`);
    await write(SCOPE, E(3), 'create', '2026-01-03T00:00:00Z');
    await write(SCOPE, E(1), 'create', '2026-01-01T00:00:00Z');
    await write(SCOPE, E(2), 'create', '2026-01-02T00:00:00Z');
    await write(SCOPE, E(1), 'update', '2026-01-04T00:00:00Z');
    await pool.query(`ALTER TABLE observation ENABLE TRIGGER observation_assign_oid`);
    expect(await oidOf(SCOPE, E(1))).toBeNull();

    expect(await svc.backfillPending(10)).toBe(2);
    const [a, b, c] = [await oidOf(SCOPE, E(1)), await oidOf(SCOPE, E(2)), await oidOf(SCOPE, E(3))];
    expect(a).not.toBeNull();
    expect(b).toBe(a! + 1);
    expect(c).toBe(a! + 2);

    // Done is done: a second pass changes nothing.
    expect(await svc.backfillPending(10)).toBe(0);
    await svc.ensureScope(SCOPE);
    expect(await oidOf(SCOPE, E(1))).toBe(a);
  });

  it('numbers a new feature on its first write, and an update spends no number', async () => {
    await write(SCOPE, E(4), 'create', '2026-02-01T00:00:00Z');
    const four = await oidOf(SCOPE, E(4));
    expect(four).not.toBeNull();
    await write(SCOPE, E(4), 'update', '2026-02-02T00:00:00Z');
    await write(SCOPE, E(1), 'update', '2026-02-03T00:00:00Z');
    await write(SCOPE, E(5), 'create', '2026-02-04T00:00:00Z');
    // Consecutive: the two updates in between used no sequence value.
    expect(await oidOf(SCOPE, E(5))).toBe(four! + 1);
    expect(await oidOf(SCOPE, E(4))).toBe(four);
  });

  it('keeps the number after a delete and never reuses it', async () => {
    const one = await oidOf(SCOPE, E(1));
    await write(SCOPE, E(1), 'delete', '2026-03-01T00:00:00Z');
    expect(await oidOf(SCOPE, E(1))).toBe(one);
    await write(SCOPE, E(6), 'create', '2026-03-02T00:00:00Z');
    expect(await oidOf(SCOPE, E(6))).not.toBe(one);
  });

  it('numbers only data layer scopes', async () => {
    await write('osm:somewhere', E(7), 'create', '2026-03-03T00:00:00Z');
    expect(await oidOf('osm:somewhere', E(7))).toBeNull();
  });

  it('looks numbers up both ways within one layer only', async () => {
    await write(OTHER, E(8), 'create', '2026-03-04T00:00:00Z');
    const oids = await svc.oidsFor(SCOPE, [E(2), E(8)]);
    expect(oids.has(E(2))).toBe(true);
    // E(8) lives in the other layer.
    expect(oids.has(E(8))).toBe(false);
    const eight = BigInt((await oidOf(OTHER, E(8)))!);
    expect((await svc.entitiesFor(SCOPE, [eight])).size).toBe(0);
    expect((await svc.entitiesFor(OTHER, [eight])).get(eight)).toBe(E(8));
  });

  it('numbers a scope once when two replicas backfill it at the same time', async () => {
    const BIG = `data_layer:${ITEM}:polys`;
    await pool.query(`ALTER TABLE observation DISABLE TRIGGER observation_assign_oid`);
    for (let n = 20; n < 60; n++) {
      await write(BIG, E(n), 'create', `2026-04-01T00:00:${String(n).padStart(2, '0')}Z`);
    }
    await pool.query(`ALTER TABLE observation ENABLE TRIGGER observation_assign_oid`);

    // Two services stand in for two API replicas: each has its own
    // in-process map, so only the database lock keeps them apart.
    const other = new FeatureOidService(
      prismaClient as unknown as PrismaService,
      { shouldRun: () => true } as unknown as LeaderElectionService,
    );
    // Hold back every insert into feature_oid until both backfills are
    // queued, so neither can finish before the other one starts.
    const gate = await pool.connect();
    let both: Promise<unknown>;
    try {
      await gate.query('BEGIN');
      await gate.query('LOCK TABLE feature_oid IN SHARE MODE');
      both = Promise.all([svc.ensureScope(BIG), other.ensureScope(BIG)]);
      // Wait until both are blocked: one on the table lock and one on
      // the backfill lock (or, without that lock, both on the table).
      for (let i = 0; i < 200; i++) {
        const w = await pool.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        if (w.rows[0].n >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await gate.query('COMMIT');
    } finally {
      gate.release();
    }
    await both;
    // A request joining afterwards finds the scope done.
    await svc.ensureScopeForRequest(BIG);

    const r = await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT entity)::int AS entities,
              count(DISTINCT oid)::int AS oids,
              ((SELECT last_value FROM feature_oid_oid_seq) - min(oid))::int AS spent
         FROM feature_oid WHERE scope = $1`,
      [BIG],
    );
    // Each entity has exactly one number, and exactly 40 numbers were
    // drawn since the backfill began, so one INSERT ran. A second one
    // racing it would have drawn 40 more and thrown them away on the
    // conflicts.
    expect(r.rows[0]).toEqual({ n: 40, entities: 40, oids: 40, spent: 39 });
    const marks = await pool.query(`SELECT count(*)::int AS n FROM feature_oid_scope WHERE scope = $1`, [BIG]);
    expect(marks.rows[0].n).toBe(1);
  });

  it('forgets every layer of a purged item', async () => {
    await svc.forgetItem(ITEM);
    const left = await pool.query(`SELECT count(*)::int AS n FROM feature_oid WHERE scope LIKE $1`, [
      `data_layer:${ITEM}:%`,
    ]);
    expect(left.rows[0].n).toBe(0);
    const marks = await pool.query(`SELECT count(*)::int AS n FROM feature_oid_scope`);
    expect(marks.rows[0].n).toBe(0);
  });
});
