// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The claim statements of the four job queues against the repo's
// migrations: oldest first with one organization, organizations
// taking turns with many.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool, type PoolClient } from 'pg';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { nextQueuedJobSql, type JobQueue } from './fair-queue.js';
import { resetTenancyModeForTests } from './tenancy.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the fair queue suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_fair_queue';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

type Row = {
  org: string;
  status: 'queued' | 'done';
  createdMinutesAgo: number;
  startedMinutesAgo?: number;
};

/** Insert one job row; foreign keys are off for this session. */
async function insertJob(c: PoolClient, queue: JobQueue, row: Row): Promise<string> {
  const id = randomUUID();
  // $5 and $6: minutes ago; a null start stays null.
  const created = `now() - make_interval(mins => $5::int)`;
  const started = `now() - make_interval(mins => $6::int)`;
  const minutes = [row.createdMinutesAgo, row.startedMinutesAgo ?? null];
  const someone = randomUUID();
  switch (queue) {
    case 'import_job':
      await c.query(
        `INSERT INTO import_job (id, item_id, layer_id, staging_id, source_file_name, source_layer_name,
           mode, created_by, org_id, status, created_at, started_at)
         VALUES ($1, $2, 'l', 's', 'f', 'n', 'append', $2, $3, $4::"ImportJobStatus", ${created}, ${started})`,
        [id, someone, row.org, row.status === 'queued' ? 'queued' : 'succeeded', ...minutes],
      );
      break;
    case 'offline_package':
      await c.query(
        `INSERT INTO offline_package (id, org_id, item_id, area_id, created_by, bbox, min_zoom, max_zoom,
           source_url, status, created_at, started_at)
         VALUES ($1, $2, $3, 'a', $3, '{0,0,1,1}', 0, 1, 'x', $4::"OfflinePackageStatus", ${created}, ${started})`,
        [id, row.org, someone, row.status === 'queued' ? 'queued' : 'ready', ...minutes],
      );
      break;
    case 'script_run':
      await c.query(
        `INSERT INTO script_run (id, script_id, org_id, user_id, state, created_at, started_at)
         VALUES ($1, $2, $3, $2, $4, ${created}, ${started})`,
        [id, someone, row.org, row.status === 'queued' ? 'queued' : 'succeeded', ...minutes],
      );
      break;
    case 'search_index_build':
      await c.query(
        `INSERT INTO search_index_build (id, org_id, requested_by, status, created_at, started_at)
         VALUES ($1, $2, $3, $4, ${created}, ${started})`,
        [id, row.org, someone, row.status === 'queued' ? 'queued' : 'succeeded', ...minutes],
      );
      break;
  }
  return id;
}

d('job queues take turns between organizations', () => {
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let client: PrismaClient;
  const before = process.env.GRATIS_TENANCY;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 2 });
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
    if (TEST_URL) {
      const admin = new Pool({ connectionString: TEST_URL, max: 1 });
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  const QUEUES: JobQueue[] = ['import_job', 'offline_package', 'script_run', 'search_index_build'];

  it.each(QUEUES)('%s: oldest first with one organization, turns with many', async (queue) => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const c = await pool.connect();
    let aOldest: string;
    let bJob: string;
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`DELETE FROM ${queue}`);
      // Org A started a job a minute ago and has more queued, older
      // than org B's one queued job.
      await insertJob(c, queue, {
        org: orgA,
        status: 'done',
        createdMinutesAgo: 30,
        startedMinutesAgo: 1,
      });
      aOldest = await insertJob(c, queue, { org: orgA, status: 'queued', createdMinutesAgo: 20 });
      if (queue !== 'search_index_build') {
        // One active build per org is a rule of that queue.
        await insertJob(c, queue, { org: orgA, status: 'queued', createdMinutesAgo: 19 });
      }
      bJob = await insertJob(c, queue, { org: orgB, status: 'queued', createdMinutesAgo: 5 });
    } finally {
      c.release();
    }

    const pick = async (): Promise<string | undefined> =>
      client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(nextQueuedJobSql(queue));
        return rows[0]?.id;
      });

    delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
    expect(await pick()).toBe(aOldest);

    process.env.GRATIS_TENANCY = 'multi';
    resetTenancyModeForTests();
    expect(await pick()).toBe(bJob);
  });
});
