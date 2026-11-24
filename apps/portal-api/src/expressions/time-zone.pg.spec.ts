// SPDX-License-Identifier: AGPL-3.0-or-later
//
// today() uses the time zone of the org that owns the layer. Two orgs
// sit on opposite sides of the date line (UTC+14 and UTC-11, always a
// different calendar day), each with a public layer. The tile
// expression for each layer is compiled by the real service with a
// real Prisma client, then run on the database.
//
// - multi mode: each layer gets its own org's date, read anonymously
//   (a public layer's owner, not the viewer, decides the zone).
// - single mode: unchanged, both layers get the install's (oldest)
//   org's date.
//
// Skipped unless TEST_DATABASE_URL is set; needs PostGIS.

import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SharingService } from '../items/sharing.service.js';
import { ExpressionsService } from './expressions.service.js';
import { resetExpressionTimeZoneCacheForTests } from './time-zone.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;
if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset');
}

jest.setTimeout(180_000);

const DB = 'gg_expr_time_zone';
const EAST = {
  org: '30000000-0000-4000-8000-000000000001',
  user: '30000000-0000-4000-8000-000000000002',
  item: '30000000-0000-4000-8000-000000000003',
  tz: 'Pacific/Kiritimati',
};
const WEST = {
  org: '30000000-0000-4000-8000-000000000011',
  user: '30000000-0000-4000-8000-000000000012',
  item: '30000000-0000-4000-8000-000000000013',
  tz: 'Pacific/Pago_Pago',
};
const LAYER = 'pts';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('today() follows the owning org time zone', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let service: ExpressionsService;
  const savedTenancy = process.env.GRATIS_TENANCY;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    const url = databaseUrl(TEST_URL!, DB);
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    pool = new Pool({ connectionString: url, max: 4 });
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 4 }) });
    service = new ExpressionsService(
      prisma as unknown as PrismaService,
      { canRead: () => true } as unknown as SharingService,
    );
    // EAST is created first, so it is the install's (oldest) org.
    let at = 0;
    for (const o of [EAST, WEST]) {
      at += 1;
      await pool.query(
        `INSERT INTO organization (id, slug, name, time_zone, created_at)
         VALUES ($1, $2, $2, $3, now() - make_interval(days => $4::int))`,
        [o.org, `tz-${o.tz.toLowerCase().replace(/[^a-z]/g, '-')}`, o.tz, 10 - at],
      );
      await pool.query(
        `INSERT INTO "user" (id, org_id, username, email, full_name, org_role)
         VALUES ($1, $2, $3, $4, 'Owner', 'admin')`,
        [o.user, o.org, `owner-${o.org}`, `owner-${o.org}@example.test`],
      );
      await pool.query(
        `INSERT INTO item (id, org_id, owner_id, type, title, access, data_json, updated_at)
         VALUES ($1, $2, $3, 'data-layer', 'Points', 'public', $4::jsonb, now())`,
        [
          o.item,
          o.org,
          o.user,
          JSON.stringify({
            version: 3,
            storageType: 'postgis',
            layers: [
              {
                id: LAYER,
                label: 'Points',
                name: LAYER,
                geometryType: 'Point',
                fields: [{ name: 'name', type: 'string', label: 'Name', nullable: true }],
              },
            ],
          }),
        ],
      );
    }
  });

  afterAll(async () => {
    if (savedTenancy === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = savedTenancy;
    resetTenancyModeForTests();
    resetExpressionTimeZoneCacheForTests();
    await prisma?.$disconnect();
    await pool?.end();
  });

  function setMode(mode: 'single' | 'multi'): void {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
    resetExpressionTimeZoneCacheForTests();
  }

  async function dateIn(tz: string): Promise<string> {
    const r = await pool.query<{ d: string }>(
      `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`,
      [tz],
    );
    return r.rows[0]!.d;
  }

  /** today() as the tile path computes it for the item's layer. */
  async function todayOnLayer(itemId: string): Promise<string> {
    const item = await prisma.item.findUnique({ where: { id: itemId }, include: { shares: true } });
    const computed = await service.tileComputed(null, item!, LAYER, [
      { name: 'd', expression: 'today()' },
    ]);
    const column = computed!.columns[0]!;
    const rows = await prisma.$queryRaw<Array<{ v: string }>>(
      Prisma.sql`SELECT ${column.sql} AS v
        FROM (SELECT '{}'::jsonb AS attrs, NULL::geometry AS geom, gen_random_uuid() AS entity) currents`,
    );
    return rows[0]!.v;
  }

  it('the two zones are on different days (test premise)', async () => {
    expect(await dateIn(EAST.tz)).not.toBe(await dateIn(WEST.tz));
  });

  it('multi mode: each org layer gets its own org date', async () => {
    setMode('multi');
    expect(await todayOnLayer(EAST.item)).toBe(await dateIn(EAST.tz));
    expect(await todayOnLayer(WEST.item)).toBe(await dateIn(WEST.tz));
  });

  it('single mode: every layer gets the install (oldest) org date, as before', async () => {
    setMode('single');
    const install = await dateIn(EAST.tz);
    expect(await todayOnLayer(EAST.item)).toBe(install);
    expect(await todayOnLayer(WEST.item)).toBe(install);
  });
});
