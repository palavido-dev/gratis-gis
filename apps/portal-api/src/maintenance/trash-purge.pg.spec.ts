// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The nightly purge holds a FOR UPDATE row lock in a transaction that
// sits idle while teardown runs on other connections. Production sets
// idle_in_transaction_session_timeout (5 minutes), so a slow teardown
// used to get the transaction killed: the backing data was gone but
// the item row survived, and the purge retried it every night. The
// transaction must opt out of that timeout for itself.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { ItemsService } from '../items/items.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { TrashPurgeService } from './trash-purge.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the trash purge suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '22000000-0000-4000-8000-000000000001';
const USER = '22000000-0000-4000-8000-000000000002';
const ITEM = '22000000-0000-4000-8000-000000000003';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('trash purge under idle_in_transaction_session_timeout', () => {
  let pool: Pool;
  let prismaClient: PrismaClient;
  const dbName = 'gg_trash_purge';
  const dbUrl = databaseUrl(TEST_URL!, dbName);
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    // Stand-in for the production setting, short enough to trip in a test.
    // Set on the database so every new connection gets it, as a role or
    // server setting would in production.
    const setup = new Pool({ connectionString: dbUrl, max: 1 });
    await setup.query(
      `ALTER DATABASE ${dbName} SET idle_in_transaction_session_timeout = '500ms'`,
    );
    await setup.end();
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    prismaClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: dbUrl, max: 4 }),
    });
    await pool.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'purge-org', 'Purge Org')`,
      [ORG],
    );
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'purge-user', 'purge@example.test', 'Purge User', 'admin')`,
      [USER, ORG],
    );
    await pool.query(
      `INSERT INTO item (id, org_id, owner_id, type, title, data_json, updated_at, deleted_at)
       VALUES ($1, $2, $3, 'map', 'Old map', '{}'::jsonb, now(), now() - interval '90 days')`,
      [ITEM, ORG, USER],
    );
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await prismaClient?.$disconnect();
    await pool?.end();
  });

  it('deletes the row when teardown outlasts the idle timeout', async () => {
    // Teardown runs on other connections while the locking transaction
    // waits; 1.5 s is three times the idle timeout above.
    const slowTeardown = jest.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    );
    const svc = new TrashPurgeService(
      prismaClient as unknown as PrismaService,
      { get: (_k: string, def: string) => def } as unknown as ConfigService,
      { shouldRun: () => true } as unknown as LeaderElectionService,
      {
        tearDownItemBackingStorage: slowTeardown,
        detachPurgedItemReferences: async () => undefined,
      } as unknown as ItemsService,
    );

    const out = await svc.purgeExpired();

    expect(slowTeardown).toHaveBeenCalledTimes(1);
    expect(out.items).toBe(1);
    const left = await pool.query(`SELECT id FROM item WHERE id = $1`, [ITEM]);
    expect(left.rowCount).toBe(0);
  });
});
