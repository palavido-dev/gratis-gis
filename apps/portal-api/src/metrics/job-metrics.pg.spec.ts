// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The job queue query runs against the real schema, and PrismaService's
// pool counters come from the pool Prisma actually uses. Both need
// Postgres; the suite gets a database of its own.

import { join } from 'node:path';
import { Pool } from 'pg';

import { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { JobMetricsReader } from './job-metrics.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the job metrics suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '51000000-0000-4000-8000-000000000001';
const USER = '51000000-0000-4000-8000-000000000002';
const ITEM = '51000000-0000-4000-8000-000000000003';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('job queue metrics against the real schema', () => {
  const dbName = 'gg_metrics_jobs';
  let dbUrl = '';
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let prisma: PrismaService;

  beforeAll(async () => {
    dbUrl = databaseUrl(TEST_URL!, dbName);
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    process.env.DATABASE_URL = dbUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await prisma?.$disconnect();
  });

  it('reads zero everywhere on an empty database', async () => {
    const snap = await new JobMetricsReader(prisma, 0).read();
    expect(snap).not.toBeNull();
    expect(Object.values(snap!.queued).every((n) => n === 0)).toBe(true);
    expect(Object.values(snap!.failedRecent).every((n) => n === 0)).toBe(true);
  });

  it('counts queued, running and recently failed jobs per type', async () => {
    const importJob = (status: 'queued' | 'running' | 'failed' | 'succeeded', finishedAt?: Date) =>
      prisma.importJob.create({
        data: {
          itemId: ITEM,
          layerId: 'l',
          stagingId: 's',
          sourceFileName: 'f.geojson',
          sourceLayerName: 'f',
          mode: 'replace',
          createdBy: USER,
          orgId: ORG,
          status,
          finishedAt: finishedAt ?? null,
          createdAt: new Date(Date.now() - 120_000),
        },
      });
    await importJob('queued');
    await importJob('queued');
    await importJob('running');
    await importJob('succeeded', new Date());
    await importJob('failed', new Date());
    // Failed two hours ago: outside the window.
    await importJob('failed', new Date(Date.now() - 2 * 3600_000));
    await prisma.analysisJob.create({
      data: { orgId: ORG, userId: USER, kind: 'contours', sourceItemId: ITEM, state: 'importing' },
    });
    await prisma.scriptRun.create({
      data: { scriptId: ITEM, orgId: ORG, userId: USER, state: 'failed', finishedAt: new Date() },
    });

    const snap = (await new JobMetricsReader(prisma, 0).read())!;
    expect(snap.queued.import).toBe(2);
    expect(snap.running.import).toBe(1);
    expect(snap.failedRecent.import).toBe(1);
    expect(snap.oldestQueuedSeconds.import).toBeGreaterThanOrEqual(100);
    expect(snap.running.analysis).toBe(1);
    expect(snap.queued.analysis).toBe(0);
    expect(snap.failedRecent.script).toBe(1);
  });

  it('reports the counters of the pool Prisma queries through', async () => {
    await prisma.$queryRaw`SELECT 1`;
    const stats = prisma.poolStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.idle).toBeLessThanOrEqual(stats.total);
    expect(stats.waiting).toBe(0);
    expect(stats.max).toBe(Number(process.env.DB_POOL_MAX ?? 25));
  });
});
