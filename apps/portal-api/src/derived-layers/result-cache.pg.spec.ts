// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The derived-layer cache key changes when a source layer is written
// (07-7). Runs the real version probe against migrated Postgres.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { PrismaService } from '../prisma/prisma.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { scopeVersions } from './result-cache.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the derived cache suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_derived_result_cache';
const ITEM = '40000000-0000-4000-8000-000000000001';
const SCOPE = `data_layer:${ITEM}:default`;
const OTHER = `data_layer:${ITEM}:other`;

d('derived-layer cache version probe on migrated Postgres', () => {
  const url = (() => {
    if (!TEST_URL) return '';
    const u = new URL(TEST_URL);
    u.pathname = `/${DB}`;
    return u.toString();
  })();
  let pool: Pool;
  let client: PrismaClient;

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

  async function insert(scope: string) {
    await pool.query(
      `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents, geom, attrs)
       VALUES (gen_random_uuid(), now(), now(), $1, gen_random_uuid(), 'create', 'test', '{}'::jsonb, '{}'::uuid[],
               ST_MakePoint(0, 0)::geometry(Point, 4326), '{}'::jsonb)`,
      [scope],
    );
  }

  it('changes when a source scope is written and not otherwise', async () => {
    const prisma = client as unknown as PrismaService;
    await insert(SCOPE);
    const v1 = await scopeVersions(prisma, [SCOPE]);
    expect(await scopeVersions(prisma, [SCOPE])).toBe(v1);
    // A write to a layer the recipe does not read leaves it alone.
    await insert(OTHER);
    expect(await scopeVersions(prisma, [SCOPE])).toBe(v1);
    await insert(SCOPE);
    expect(await scopeVersions(prisma, [SCOPE])).not.toBe(v1);
    // A scope with no rows still has a version.
    expect(await scopeVersions(prisma, [`data_layer:${ITEM}:none`])).toBe(
      `data_layer:${ITEM}:none=0:0:0`,
    );
  });
});
