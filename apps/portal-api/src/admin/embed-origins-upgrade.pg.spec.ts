// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Upgrade test for the per-organization embed allow-list. The list
// used to be one install-wide system_setting row. A one-organization
// install that saved a list before the upgrade must still have it
// after: the migration copies it onto the oldest organization, which
// is the org single mode reads and writes.
//
// Skipped unless TEST_DATABASE_URL is set; needs PostGIS.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PublicController } from '../public/public.controller.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;
if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset');
}

jest.setTimeout(180_000);

const MIGRATION = '20261124120000_org_embed_origins';
const MIGRATIONS = join(__dirname, '../../prisma/migrations');
const OLDEST = '40000000-0000-4000-8000-000000000001';
const LATER = '40000000-0000-4000-8000-000000000002';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabase(name: string): Promise<string> {
  const admin = new Pool({ connectionString: TEST_URL, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return databaseUrl(TEST_URL!, name);
}

async function originsOf(pool: Pool): Promise<Record<string, string[]>> {
  const r = await pool.query<{ id: string; embed_origins: string[] }>(
    'SELECT id, embed_origins FROM organization ORDER BY created_at',
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.embed_origins]));
}

d('embed origins upgrade', () => {
  const savedTenancy = process.env.GRATIS_TENANCY;

  beforeAll(() => {
    delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  });

  afterAll(() => {
    if (savedTenancy === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = savedTenancy;
    resetTenancyModeForTests();
  });

  it("keeps a single install's saved list on its organization", async () => {
    const url = await freshDatabase('gg_embed_origins_upgrade');
    applyTestMigrations(url, MIGRATIONS, { upTo: MIGRATION });
    const pool = new Pool({ connectionString: url, max: 2 });
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) });
    try {
      await pool.query(
        `INSERT INTO organization (id, slug, name, created_at) VALUES
           ($1, 'first', 'First', now() - interval '2 days'),
           ($2, 'second', 'Second', now() - interval '1 day')`,
        [OLDEST, LATER],
      );
      // A hand-edited row may hold a non-string; it is not copied.
      await pool.query(
        `INSERT INTO system_setting (key, value) VALUES ('embed_origins', $1::jsonb)`,
        [JSON.stringify({ origins: ['https://dash.example.org', 'https://b.example.org', 42] })],
      );

      applyTestMigrations(url, MIGRATIONS, { from: MIGRATION });

      expect(await originsOf(pool)).toEqual({
        [OLDEST]: ['https://dash.example.org', 'https://b.example.org'],
        [LATER]: [],
      });
      // The public read a single install's app pages use still answers
      // with the saved list.
      const controller = new PublicController(
        prisma as unknown as PrismaService,
        {} as never,
        {} as never,
      );
      await expect(controller.embedOrigins()).resolves.toEqual({
        origins: ['https://dash.example.org', 'https://b.example.org'],
      });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it('gives every org an empty list when nothing was saved', async () => {
    const url = await freshDatabase('gg_embed_origins_upgrade_empty');
    applyTestMigrations(url, MIGRATIONS, { upTo: MIGRATION });
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await pool.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'only', 'Only')`, [
        OLDEST,
      ]);
      applyTestMigrations(url, MIGRATIONS, { from: MIGRATION });
      expect(await originsOf(pool)).toEqual({ [OLDEST]: [] });
    } finally {
      await pool.end();
    }
  });
});
