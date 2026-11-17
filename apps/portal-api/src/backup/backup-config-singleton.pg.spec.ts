// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * backup_config is a singleton. Two replicas booting against an empty
 * table used to insert a row each (findFirst, then create), and every
 * later save landed on one row while reads returned the other. This
 * runs the real migrations and the real create path against Postgres.
 *
 * The table is built from the original migration in a throwaway
 * schema, then the singleton migration is applied on top of it.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

import type { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the backup config '
    + 'singleton pg suite would silently skip.',
  );
}

jest.setTimeout(60_000);

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const migration = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

d('backup_config singleton against Postgres', () => {
  const schema = `gg_backup_cfg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: PgClient;
  let client: PrismaClient;

  beforeAll(async () => {
    admin = new PgClient({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(migration('20260424190000_backup_config'));
    // The state the race left behind: two rows, the newer one saved.
    await admin.query(`
      INSERT INTO backup_config (id, retention_count, updated_at) VALUES
        ('00000000-0000-0000-0000-000000000001', NULL, now() - interval '1 day'),
        ('00000000-0000-0000-0000-000000000002', 30, now());
    `);
    await admin.query(migration('20261109100000_backup_config_singleton'));
    const url = new URL(TEST_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }, { schema }),
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('the migration keeps only the most recently saved row', async () => {
    const { rows } = await admin.query(
      `SELECT id, retention_count FROM ${schema}.backup_config`,
    );
    expect(rows).toEqual([
      { id: '00000000-0000-0000-0000-000000000002', retention_count: 30 },
    ]);
  });

  it('the table refuses a second row', async () => {
    await expect(
      admin.query(`INSERT INTO ${schema}.backup_config DEFAULT VALUES`),
    ).rejects.toThrow(/backup_config_singleton_key/);
  });

  it('concurrent first reads on an empty table create one row', async () => {
    await admin.query(`DELETE FROM ${schema}.backup_config`);
    const replicas = [0, 1, 2, 3].map(
      () => new BackupService(client as unknown as PrismaService, new ConfigService()),
    );
    const configs = await Promise.all(replicas.map((r) => r.getConfig()));
    expect(configs).toHaveLength(4);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM ${schema}.backup_config`,
    );
    expect(rows[0].n).toBe(1);

    // A save on one replica is what every replica reads back.
    await replicas[0]!.updateConfig({ retentionCount: 9 }, null);
    for (const r of replicas) {
      expect((await r.getConfig()).retentionCount).toBe(9);
    }
  });
});
