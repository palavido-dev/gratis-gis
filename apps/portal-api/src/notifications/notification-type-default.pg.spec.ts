// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The org-wide notification defaults and the per-user preference save
// read notification_type_default by (type, channel). This runs them
// against a freshly migrated database, so a column type that does not
// match the Prisma schema fails here instead of as a 500.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { NotificationTypeDefaultService } from './notification-type-default.service.js';
import { NotificationPreferencesController } from './preferences.controller.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the notification defaults suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_notification_defaults';
const ORG = '31000000-0000-4000-8000-00000000000a';
const USER = '31000000-0000-4000-8000-0000000000a1';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('notification defaults on a migrated database', () => {
  // Built lazily: describe.skip still runs this body without a URL.
  const url = TEST_URL ? databaseUrl(TEST_URL, DB) : '';
  let pool: Pool;
  let client: PrismaClient;
  let defaults: NotificationTypeDefaultService;
  let prefs: NotificationPreferencesController;
  const user = { id: USER, orgId: ORG } as AuthUser;

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
    await pool.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'nd', 'nd')`, [ORG]);
    await pool.query(
      `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
       VALUES ($1, $2, 'nd-user', 'nd-user@example.test', 'nd-user', 'viewer')`,
      [USER, ORG],
    );
    const prisma = client as unknown as PrismaService;
    defaults = new NotificationTypeDefaultService(prisma);
    prefs = new NotificationPreferencesController(prisma, defaults);
  });

  afterAll(async () => {
    await client?.$disconnect();
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.end();
  });

  it('a user saves a preference with no org default stored', async () => {
    await expect(
      prefs.upsert(user, { type: 'share_created', channel: 'email', enabled: false }),
    ).resolves.toEqual({ enabled: false, isDefault: false });
    const rows = await pool.query(
      `SELECT type::text, channel::text, enabled FROM notification_preference WHERE user_id = $1`,
      [USER],
    );
    expect(rows.rows).toEqual([{ type: 'share-created', channel: 'email', enabled: false }]);
  });

  it('an org default is stored, read back and followed by a user save', async () => {
    await defaults.setOverride('share_expiring', 'email', false);
    expect(await defaults.effectiveDefault('share_expiring', 'email')).toBe(false);
    expect((await defaults.loadOverrideMap()).get('share_expiring|email')).toBe(false);
    // Matching the org default removes the user's row.
    await expect(
      prefs.upsert(user, { type: 'share_expiring', channel: 'email', enabled: false }),
    ).resolves.toEqual({ enabled: false, isDefault: true });
    // Back to the code default removes the override.
    await defaults.setOverride('share_expiring', 'email', true);
    expect((await defaults.loadOverrideMap()).has('share_expiring|email')).toBe(false);
  });
});
