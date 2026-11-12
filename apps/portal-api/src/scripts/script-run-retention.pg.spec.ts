// SPDX-License-Identifier: AGPL-3.0-or-later
//
// script_run rows used to live forever: no foreign key to the script
// item and no pruning. This runs the repo's migrations and the
// worker's real prune query against Postgres.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { ApiKeyService } from '../auth/api-key.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { ScriptRunnerWorker } from './script-runner.worker.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the script run retention suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_script_run_retention';
const ORG = '20000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-000000000002';
const SCRIPT_A = '20000000-0000-4000-8000-000000000003';
const SCRIPT_B = '20000000-0000-4000-8000-000000000004';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('script_run retention on migrated Postgres', () => {
  // Built lazily: describe.skip still runs this body without a URL.
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let client: PrismaClient;
  let worker: ScriptRunnerWorker;

  async function runCount(scriptId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM script_run WHERE script_id = $1',
      [scriptId],
    );
    return Number(r.rows[0]!.n);
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 2 });
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) });
    worker = new ScriptRunnerWorker(
      client as unknown as PrismaService,
      {} as ApiKeyService,
    );
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'runs-org', 'Runs Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'runs-user', 'runs@example.test', 'Runs User', 'admin')`,
      [USER, ORG],
    );
    for (const id of [SCRIPT_A, SCRIPT_B]) {
      await pool.query(
        `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at)
         VALUES ($1, $2, $3, 'script', 'Script', '{}'::jsonb, now())`,
        [id, ORG, USER],
      );
    }
    // Script A: five finished runs, oldest first, plus one queued run
    // that is older than all of them. Script B: one finished run.
    const rows: Array<[string, string, number]> = [
      [SCRIPT_A, 'queued', 10],
      [SCRIPT_A, 'done', 5],
      [SCRIPT_A, 'failed', 4],
      [SCRIPT_A, 'done', 3],
      [SCRIPT_A, 'cancelled', 2],
      [SCRIPT_A, 'done', 1],
      [SCRIPT_B, 'done', 9],
    ];
    for (const [script, state, hoursAgo] of rows) {
      await pool.query(
        `INSERT INTO script_run (id, script_id, org_id, user_id, state, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now() - make_interval(hours => $5))`,
        [script, ORG, USER, state, hoursAgo],
      );
    }
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  });

  it('keeps the newest finished runs of each script and every unfinished one', async () => {
    expect(await worker.pruneOldRuns(2)).toBe(3);
    const left = await pool.query<{ state: string }>(
      'SELECT state FROM script_run WHERE script_id = $1 ORDER BY created_at',
      [SCRIPT_A],
    );
    expect(left.rows.map((r) => r.state)).toEqual(['queued', 'cancelled', 'done']);
    expect(await runCount(SCRIPT_B)).toBe(1);
  });

  it('purging the script item deletes its runs', async () => {
    await pool.query('DELETE FROM item WHERE id = $1', [SCRIPT_A]);
    expect(await runCount(SCRIPT_A)).toBe(0);
    expect(await runCount(SCRIPT_B)).toBe(1);
  });
});
