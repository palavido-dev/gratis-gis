// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A built-in starter the admin deleted came back on the next start
// once the trash was purged (04-8). The purge now records the starter
// on the organization and the seeders skip it.

import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { AuthSyncService } from './auth-sync.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the dismissed seed kinds suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const DB = 'gg_dismissed_seed_kinds';
const ORG = '50000000-0000-4000-8000-000000000001';
const USER = '50000000-0000-4000-8000-000000000002';
const ORG2 = '50000000-0000-4000-8000-000000000003';
const USER2 = '50000000-0000-4000-8000-000000000004';

d('purged starters stay purged', () => {
  const url = (() => {
    if (!TEST_URL) return '';
    const u = new URL(TEST_URL);
    u.pathname = `/${DB}`;
    return u.toString();
  })();
  let prisma: PrismaClient;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    applyTestMigrations(url, join(__dirname, '../../prisma/migrations'));
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, max: 2 }),
    });
    for (const [org, user, slug] of [
      [ORG, USER, 'dsk'],
      [ORG2, USER2, 'dsk2'],
    ] as const) {
      await prisma.organization.create({ data: { id: org, slug, name: slug } });
      await prisma.user.create({
        data: {
          id: user,
          orgId: org,
          username: slug,
          email: `${slug}@example.org`,
          fullName: slug,
          orgRole: 'admin',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (TEST_URL) {
      const admin = new Pool({ connectionString: TEST_URL, max: 1 });
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  function seeder(): AuthSyncService {
    const svc = Object.create(AuthSyncService.prototype) as AuthSyncService;
    (svc as unknown as { prisma: PrismaClient }).prisma = prisma;
    return svc;
  }

  async function seedThemes(svc: AuthSyncService, org: string, user: string) {
    await (
      svc as unknown as {
        ensureBuiltinThemes(o: string, u: string): Promise<void>;
      }
    ).ensureBuiltinThemes(org, user);
  }

  it('records a purged starter and does not seed it again', async () => {
    const svc = seeder();
    await seedThemes(svc, ORG, USER);
    const themes = await prisma.item.findMany({
      where: { orgId: ORG, type: 'theme' },
      select: { id: true, seedKind: true },
    });
    expect(themes.length).toBeGreaterThan(1);
    const victim = themes[0]!;

    // Purge (a hard delete, as the trash purge does).
    await prisma.item.delete({ where: { id: victim.id } });
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { dismissedSeedKinds: true },
    });
    expect(org.dismissedSeedKinds).toEqual([`theme/${victim.seedKind}`]);

    // The next start's seeding pass leaves it out.
    await seedThemes(svc, ORG, USER);
    const after = await prisma.item.findMany({
      where: { orgId: ORG, type: 'theme' },
      select: { seedKind: true },
    });
    expect(after.map((t) => t.seedKind)).not.toContain(victim.seedKind);
    expect(after).toHaveLength(themes.length - 1);
  });

  it('records each kind once, and leaves ordinary items alone', async () => {
    const plain = await prisma.item.create({
      data: { orgId: ORG, ownerId: USER, type: 'theme', title: 'Mine', data: {} },
    });
    await prisma.item.delete({ where: { id: plain.id } });
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { dismissedSeedKinds: true },
    });
    expect(org.dismissedSeedKinds).toHaveLength(1);
  });

  it('still lets an organization be deleted with its starters', async () => {
    await seedThemes(seeder(), ORG2, USER2);
    // Items cascade from the organization; the trigger then updates a
    // row the same statement deleted, which must be a no-op.
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await pool.query('DELETE FROM organization WHERE id = $1', [ORG2]);
    } finally {
      await pool.end();
    }
    expect(
      await prisma.organization.findUnique({ where: { id: ORG2 } }),
    ).toBeNull();
  });
});
