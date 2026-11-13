// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The housekeeping "Build search indexes" queue (2026-11 review, 06-5)
// against the repo's migrations: one active build per org, claim,
// recorded outcome, and recovery of a build a dead worker left running.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { SearchIndexJobsService } from './search-index-jobs.service.js';
import type { DataLayerSearchIndexService } from './search-index.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the search index queue suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_search_index_jobs';
const ORG = '30000000-0000-4000-8000-000000000001';
const USER = '30000000-0000-4000-8000-000000000002';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('search index build queue on migrated Postgres', () => {
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let client: PrismaClient;
  const buildForOrg = jest.fn();
  let jobs: SearchIndexJobsService;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 2 });
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 2 }),
    });
    jobs = new SearchIndexJobsService(
      client as unknown as PrismaService,
      { buildForOrg } as unknown as DataLayerSearchIndexService,
    );
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    if (TEST_URL) {
      const admin = new Pool({ connectionString: TEST_URL, max: 1 });
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('keeps one active build per org and records the outcome', async () => {
    const a = await jobs.enqueue(ORG, USER);
    const b = await jobs.enqueue(ORG, USER);
    expect(b.id).toBe(a.id);
    expect(a.status).toBe('queued');

    const claimed = await jobs.claimNext();
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe('running');
    expect(await jobs.claimNext()).toBeNull();
    // Still active while running: a click gets the running build.
    expect((await jobs.enqueue(ORG, USER)).id).toBe(a.id);

    buildForOrg.mockResolvedValueOnce({ created: ['x'], durationMs: 5 });
    await jobs.run(claimed!);
    const done = await jobs.latest(ORG);
    expect(done?.status).toBe('succeeded');
    expect(done?.result).toEqual({ created: ['x'], durationMs: 5 });

    // A finished build no longer blocks a new one.
    const next = await jobs.enqueue(ORG, USER);
    expect(next.id).not.toBe(a.id);
  });

  it('records a failed build with its message', async () => {
    const job = await jobs.claimNext();
    expect(job).not.toBeNull();
    buildForOrg.mockRejectedValueOnce(new Error('boom'));
    await jobs.run(job!);
    const row = await jobs.latest(ORG);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('boom');
  });

  it('fails a build a dead worker left running', async () => {
    await jobs.enqueue(ORG, USER);
    await jobs.claimNext();
    expect(await jobs.failInterrupted()).toBe(1);
    const row = await jobs.latest(ORG);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/worker restarted/);
  });

  it('refuses a second active row at the database', async () => {
    await pool.query(
      `INSERT INTO search_index_build (org_id, status) VALUES ($1, 'queued')`,
      [ORG],
    );
    await expect(
      pool.query(
        `INSERT INTO search_index_build (org_id, status) VALUES ($1, 'running')`,
        [ORG],
      ),
    ).rejects.toThrow(/search_index_build_one_active_per_org/);
  });
});
