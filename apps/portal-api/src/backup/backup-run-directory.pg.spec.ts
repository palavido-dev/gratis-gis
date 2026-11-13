// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * backup_run.archive_directory records the folder a run wrote to, so
 * an archive stays reachable after the backup folder setting changes
 * (05-6). This applies the backup_run migrations in a throwaway schema
 * and reads the column back through Prisma. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the backup run '
    + 'directory pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const migration = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

d('backup_run archive_directory against Postgres', () => {
  const schema = `gg_backup_dir_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    for (const m of [
      '20260424180000_backup_run',
      '20260810020000_backup_run_cancel',
      '20260819020000_backup_run_heartbeat',
      '20261026042100_backup_run_one_running',
    ]) {
      await admin.query(migration(m));
    }
    // A row from before the column.
    await admin.query(
      `INSERT INTO backup_run (status, filename) VALUES ('succeeded', 'backup-old.tar.gz')`,
    );
    await admin.query(migration('20261113120000_backup_run_archive_directory'));
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }, { schema }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('keeps older rows with no folder and stores the folder on new ones', async () => {
    const old = await client.backupRun.findFirst({ where: { filename: 'backup-old.tar.gz' } });
    expect(old?.archiveDirectory).toBeNull();
    const run = await client.backupRun.create({
      data: { trigger: 'manual', archiveDirectory: '/app/backups/nightly' },
    });
    const back = await client.backupRun.findUnique({ where: { id: run.id } });
    expect(back?.archiveDirectory).toBe('/app/backups/nightly');
  });
});
