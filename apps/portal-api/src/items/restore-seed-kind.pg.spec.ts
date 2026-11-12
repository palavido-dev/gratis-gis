// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Restore starters" creates a fresh starter while the original sits
// in the trash. Restoring the original then broke the partial unique
// index on (org_id, type, seed_kind) and returned a 500. The restored
// copy must come back as an ordinary item instead.

import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { applyTestMigrations } from '../testing/apply-test-migrations.js';
import { ItemsService } from './items.service.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error(
    'REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the restore seedKind suite would silently skip.',
  );
}

jest.setTimeout(180_000);

const ORG = '24000000-0000-4000-8000-000000000001';
const USER = '24000000-0000-4000-8000-000000000002';
const OLD = '24000000-0000-4000-8000-000000000003';
const NEW = '24000000-0000-4000-8000-000000000004';
const COHORT_OLD = '24000000-0000-4000-8000-000000000005';
const COHORT_NEW = '24000000-0000-4000-8000-000000000006';
const COHORT = '24000000-0000-4000-8000-000000000007';

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

d('restoring a trashed starter after a replacement exists', () => {
  let prisma: PrismaClient;
  let service: ItemsService;
  const dbName = 'gg_b7_restore_seed';
  const dbUrl = databaseUrl(TEST_URL!, dbName);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    applyTestMigrations(dbUrl, join(__dirname, '../../prisma/migrations'));
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 2 }) });
    await prisma.organization.create({ data: { id: ORG, slug: 'b7', name: 'b7' } });
    await prisma.user.create({
      data: { id: USER, orgId: ORG, username: 'b7', email: 'b7@example.org', fullName: 'B7' },
    });
    const base = { orgId: ORG, ownerId: USER, type: 'app_template' as const, data: {} };
    const trashed = new Date();
    await prisma.item.create({
      data: { ...base, id: OLD, title: 'Old', seedKind: 'sidebar', deletedAt: trashed },
    });
    await prisma.item.create({ data: { ...base, id: NEW, title: 'New', seedKind: 'sidebar' } });
    await prisma.item.create({
      data: {
        ...base,
        id: COHORT_OLD,
        title: 'Old theme',
        seedKind: 'dark',
        deletedAt: trashed,
        deletedCohortId: COHORT,
      },
    });
    await prisma.item.create({
      data: { ...base, id: COHORT_NEW, title: 'New theme', seedKind: 'dark' },
    });

    service = Object.create(ItemsService.prototype) as ItemsService;
    const s = service as unknown as Record<string, unknown>;
    s.prisma = prisma;
    s.sharing = { canAdmin: () => true };
    s.get = (_u: AuthUser, id: string) => prisma.item.findUniqueOrThrow({ where: { id } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const user = { sub: USER, orgId: ORG } as unknown as AuthUser;

  it('restores a single item and drops its seedKind', async () => {
    const out = await service.restore(user, OLD);
    expect(out?.deletedAt).toBeNull();
    expect(out?.seedKind).toBeNull();
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: NEW } });
    expect(fresh.seedKind).toBe('sidebar');
  });

  it('restores a cohort and drops the clashing seedKind', async () => {
    const out = await service.restore(user, COHORT_OLD);
    expect(out?.deletedAt).toBeNull();
    expect(out?.seedKind).toBeNull();
  });
});
