// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  BUILTIN_BASEMAP_SEEDS,
  PRINT_TEMPLATE_STARTERS,
  STARTERS,
  THEME_STARTERS,
} from '@gratis-gis/shared-types';

import {
  AuthSyncService,
  isMasterAdminAccount,
  NOT_ATTACHED_MESSAGE,
} from './auth-sync.service.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { KeycloakClaims } from './jwt.strategy.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The principal cache in `upsertFromClaims`. Every spec here counts
 * Prisma calls rather than inspecting the cache, because "no database
 * round trip on a hit" is the whole point and is what a regression
 * would silently take away.
 *
 * Time is driven through `Date.now` so the TTL and the lastSeenAt
 * throttle can be crossed deliberately. The TTL itself is read from
 * the environment once at module load, so the default of 10 s is what
 * these specs assume.
 */

const T0 = Date.parse('2026-04-01T00:00:00.000Z');
const TTL_MS = 10_000;
const LAST_SEEN_THROTTLE_MS = 60_000;

const ORG = { id: 'org-1', slug: 'randolph', name: 'Randolph' };

function makeClaims(overrides: Partial<KeycloakClaims> = {}): KeycloakClaims {
  return {
    sub: 'sub-1',
    preferred_username: 'matt',
    email: 'matt@example.org',
    name: 'Matt P',
    org: 'randolph',
    org_role: 'contributor',
    ...overrides,
  };
}

/**
 * One local user row whose id differs from the token's sub, the way a
 * seeded user's does. That is the case `invalidate(userId)` has to
 * handle: admin code knows the local id, the cache is keyed by sub.
 */
function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    orgId: ORG.id,
    username: 'matt',
    email: 'matt@example.org',
    fullName: 'Matt P',
    orgRole: 'contributor' as const,
    deletedAt: null,
    autoDisableAt: null as Date | null,
    lastSeenAt: new Date(T0),
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...overrides,
  };
}

/**
 * Every seeder's "already seeded" answer at once. Each seeder reads a
 * different field off the rows it gets back and ignores the rest, so
 * one list satisfies all four and the first request seeds nothing.
 */
const SEEDED_ITEMS = [
  ...BUILTIN_BASEMAP_SEEDS.map((s) => ({ data: { seededKey: s.seededKey }, seedKind: null })),
  ...STARTERS.map((s) => ({ data: null, seedKind: s.kind })),
  ...THEME_STARTERS.map((s) => ({ data: null, seedKind: s.kind })),
  ...PRINT_TEMPLATE_STARTERS.map((s) => ({ data: null, seedKind: s.kind })),
];

function makePrisma(opts: { user?: ReturnType<typeof makeUserRow>; org?: typeof ORG | null } = {}) {
  const userRow = opts.user ?? makeUserRow();
  const orgRow = opts.org === undefined ? ORG : opts.org;
  const prisma = {
    organization: {
      findUnique: jest.fn(async () => orgRow),
      upsert: jest.fn(async () => ORG),
    },
    user: {
      // The parameter is declared so a spec can swap in a per-username
      // implementation; jest types the mock's arguments from it.
      findUnique: jest.fn(async (_args: { where: { username: string } }) => userRow),
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(
        async (args: { where: { username: string }; update: Record<string, unknown> }) => ({
          ...userRow,
          ...args.update,
        }),
      ),
    },
    groupMember: {
      findMany: jest.fn(async () => [{ groupId: 'g-1' }]),
    },
    userCapabilityOverride: {
      findMany: jest.fn(async () => []),
    },
    item: {
      findMany: jest.fn(async () => SEEDED_ITEMS),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  return prisma;
}

type Prisma = ReturnType<typeof makePrisma>;

/** Total Prisma calls of any kind, so "no reads" means none at all. */
function dbCalls(prisma: Prisma): number {
  let n = 0;
  for (const model of Object.values(prisma)) {
    for (const fn of Object.values(model as Record<string, jest.Mock>)) {
      n += fn.mock.calls.length;
    }
  }
  return n;
}

const svc = (prisma: Prisma) => new AuthSyncService(prisma as unknown as PrismaService);

describe('AuthSyncService.upsertFromClaims principal cache', () => {
  let now = T0;
  let nowSpy: jest.SpiedFunction<typeof Date.now>;
  beforeEach(() => {
    now = T0;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => nowSpy.mockRestore());

  it('builds the principal once and answers the second call with no database call', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    const first = await service.upsertFromClaims(makeClaims());
    expect(first.id).toBe('user-1');
    expect(first.orgSlug).toBe('randolph');
    expect(first.groupIds).toEqual(['g-1']);
    const afterFirst = dbCalls(prisma);
    expect(afterFirst).toBeGreaterThan(0);

    now += 1_000;
    const second = await service.upsertFromClaims(makeClaims());
    expect(second).toBe(first);
    expect(dbCalls(prisma)).toBe(afterFirst);
  });

  it('reads the org instead of upserting it when it already exists', async () => {
    const prisma = makePrisma();
    await svc(prisma).upsertFromClaims(makeClaims());
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({ where: { slug: 'randolph' } });
    expect(prisma.organization.upsert).not.toHaveBeenCalled();
  });

  it('creates the org only when the read misses', async () => {
    const prisma = makePrisma({ org: null });
    await svc(prisma).upsertFromClaims(makeClaims());
    expect(prisma.organization.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.organization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { slug: 'randolph', name: 'randolph' } }),
    );
  });

  it('invalidate(userId) forgets the entry so the next call rebuilds', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    const first = await service.upsertFromClaims(makeClaims());
    const before = dbCalls(prisma);
    // The LOCAL id, not the sub: that is what admin code has in hand.
    service.invalidate('user-1');
    const second = await service.upsertFromClaims(makeClaims());
    expect(second).not.toBe(first);
    expect(dbCalls(prisma)).toBeGreaterThan(before);
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidate for an unknown user is a no-op that leaves other entries cached', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    const before = dbCalls(prisma);
    service.invalidate('somebody-else');
    await service.upsertFromClaims(makeClaims());
    expect(dbCalls(prisma)).toBe(before);
  });

  it('invalidateAll forgets every entry', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    service.invalidateAll();
    await service.upsertFromClaims(makeClaims());
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(2);
  });

  it('rebuilds once the TTL has passed, without a user write while the lastSeenAt throttle holds', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    // First request in the process always writes lastSeenAt.
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);

    now += TTL_MS - 1;
    await service.upsertFromClaims(makeClaims());
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(1);

    now += 2;
    await service.upsertFromClaims(makeClaims());
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(2);
    // The rebuild re-read the row; nothing about the claims changed and
    // the minute has not passed, so the read-first sync stays read only.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
  });

  it('takes the write path when the lastSeenAt throttle is due, even inside the TTL', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    now += LAST_SEEN_THROTTLE_MS - 1;
    await service.upsertFromClaims(makeClaims());
    // Both the TTL and the throttle were re-armed by the rebuild at
    // T0 + 59 999 ms, so this is a rebuild for the TTL, not the throttle.
    expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    now += 1;
    await service.upsertFromClaims(makeClaims());
    // Still inside the second entry's TTL, but a minute since the last
    // write: the cache steps aside so lastSeenAt gets its update.
    expect(prisma.user.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.upsert.mock.calls[1]![0].update).toEqual({ lastSeenAt: expect.any(Date) });
  });

  it('misses when the token says something different about the person', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    const promoted = makeClaims({ org_role: 'admin' });
    const user = await service.upsertFromClaims(promoted);
    // The role change reached the row (the sync's write path) and the
    // principal reflects it. This is how a Keycloak role change lands
    // without any admin code calling invalidate.
    expect(prisma.user.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.upsert.mock.calls[1]![0].update).toEqual(
      expect.objectContaining({ orgRole: 'admin' }),
    );
    expect(user.orgRole).toBe('admin');
  });

  it('coalesces concurrent callers for the same subject into one build', async () => {
    const prisma = makePrisma();
    const service = svc(prisma);
    const [a, b, c] = await Promise.all([
      service.upsertFromClaims(makeClaims()),
      service.upsertFromClaims(makeClaims()),
      service.upsertFromClaims(makeClaims()),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed build, so the next caller retries', async () => {
    const prisma = makePrisma();
    prisma.groupMember.findMany.mockRejectedValueOnce(new Error('pool exhausted'));
    const service = svc(prisma);
    await expect(service.upsertFromClaims(makeClaims())).rejects.toThrow('pool exhausted');
    const user = await service.upsertFromClaims(makeClaims());
    expect(user.groupIds).toEqual(['g-1']);
  });

  it('refuses a soft-deleted user before upserting lastSeenAt', async () => {
    const prisma = makePrisma({
      user: makeUserRow({ deletedAt: new Date(T0 - 1) }),
    });
    const service = svc(prisma);
    await expect(service.upsertFromClaims(makeClaims())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('refuses a disabled user even with a still-valid token', async () => {
    const prisma = makePrisma({
      user: makeUserRow({ disabledAt: new Date(T0 - 1) }),
    });
    const service = svc(prisma);
    await expect(service.upsertFromClaims(makeClaims())).rejects.toThrow(/disabled/);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('seeds built-in basemaps under the seed unique index, skipping duplicates', async () => {
    const prisma = makePrisma();
    prisma.item.findMany.mockImplementation(async () =>
      SEEDED_ITEMS.filter((r) => !(r.data && 'seededKey' in r.data)),
    );
    await svc(prisma).upsertFromClaims(makeClaims());
    const calls = prisma.item.createMany.mock.calls as unknown as Array<
      [{ skipDuplicates?: boolean; data: Array<{ type: string; seedKind?: string }> }]
    >;
    const basemaps = calls.find((c) => c[0].data.some((d) => d.type === 'basemap'));
    expect(basemaps?.[0].skipDuplicates).toBe(true);
    expect(basemaps?.[0].data.every((d) => typeof d.seedKind === 'string' && d.seedKind.startsWith('basemap:'))).toBe(true);
  });

  it('re-checks the auto-disable instant on every hit', async () => {
    // Disable falls 5 s from now, well inside the 10 s TTL. The entry
    // must refuse on the dot, not when it happens to expire.
    const prisma = makePrisma({
      user: makeUserRow({ autoDisableAt: new Date(T0 + 5_000) }),
    });
    const service = svc(prisma);
    await service.upsertFromClaims(makeClaims());
    now += 4_999;
    await expect(service.upsertFromClaims(makeClaims())).resolves.toBeDefined();
    const before = dbCalls(prisma);
    now += 1;
    await expect(service.upsertFromClaims(makeClaims())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Refused from the cache, with no database round trip.
    expect(dbCalls(prisma)).toBe(before);
  });

  it('exempts an org admin from the cached auto-disable check as the build path does', async () => {
    const prisma = makePrisma({
      user: makeUserRow({ orgRole: 'admin', autoDisableAt: new Date(T0 - 1) }),
    });
    const service = svc(prisma);
    const claims = makeClaims({ org_role: 'admin' });
    await expect(service.upsertFromClaims(claims)).resolves.toBeDefined();
    await expect(service.upsertFromClaims(claims)).resolves.toBeDefined();
  });

  it('keeps entries for different subjects apart and invalidates only the named user', async () => {
    const prisma = makePrisma();
    // Two people; the stub hands back whichever row matches the username.
    const rows: Record<string, ReturnType<typeof makeUserRow>> = {
      matt: makeUserRow(),
      ann: makeUserRow({ id: 'user-2', username: 'ann', email: 'ann@example.org' }),
    };
    prisma.user.findUnique.mockImplementation(
      async (args: { where: { username: string } }) => rows[args.where.username]!,
    );
    prisma.user.upsert.mockImplementation(
      async (args: { where: { username: string }; update: Record<string, unknown> }) => ({
        ...rows[args.where.username]!,
        ...args.update,
      }),
    );
    const service = svc(prisma);
    const matt = makeClaims();
    const ann = makeClaims({ sub: 'sub-2', preferred_username: 'ann', email: 'ann@example.org' });
    await service.upsertFromClaims(matt);
    await service.upsertFromClaims(ann);
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(2);

    service.invalidate('user-2');
    await service.upsertFromClaims(matt);
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(2);
    await service.upsertFromClaims(ann);
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(3);
  });

  it('evicts the least recently used entry past the bound', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockImplementation(
      async (args: { where: { username: string } }) =>
        makeUserRow({ id: `id-${args.where.username}`, username: args.where.username }),
    );
    prisma.user.upsert.mockImplementation(
      async (args: { where: { username: string }; update: Record<string, unknown> }) => ({
        ...makeUserRow({ id: `id-${args.where.username}`, username: args.where.username }),
        ...args.update,
      }),
    );
    const service = svc(prisma);
    const claimsFor = (i: number) =>
      makeClaims({ sub: `sub-${i}`, preferred_username: `u${i}`, email: `u${i}@example.org` });
    // Fill to the bound; the first entry is the oldest.
    for (let i = 0; i < 5_000; i += 1) await service.upsertFromClaims(claimsFor(i));
    const before = prisma.groupMember.findMany.mock.calls.length;
    await service.upsertFromClaims(claimsFor(0));
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(before);
    // One more distinct subject pushes the size over the bound. Entry 0
    // was just touched, so the victim is entry 1.
    await service.upsertFromClaims(claimsFor(5_000));
    await service.upsertFromClaims(claimsFor(0));
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(before + 1);
    await service.upsertFromClaims(claimsFor(1));
    expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(before + 2);
  });
});

describe('master admin protection on sign-in', () => {
  const ORIGINAL = process.env.PORTAL_MASTER_ADMIN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PORTAL_MASTER_ADMIN;
    else process.env.PORTAL_MASTER_ADMIN = ORIGINAL;
  });

  const adminClaims = () =>
    makeClaims({ sub: 'sub-admin', preferred_username: 'admin', org_role: 'admin' });

  it('marks a new "admin" row protected when it is created', async () => {
    delete process.env.PORTAL_MASTER_ADMIN;
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    await svc(prisma).upsertFromClaims(adminClaims());
    const args = prisma.user.upsert.mock.calls[0]?.[0] as unknown as {
      create: Record<string, unknown>;
    };
    expect(args.create.isProtected).toBe(true);
  });

  it('protects an existing unprotected "admin" row', async () => {
    delete process.env.PORTAL_MASTER_ADMIN;
    const prisma = makePrisma({
      user: makeUserRow({ username: 'admin', orgRole: 'admin', isProtected: false }),
    });
    await svc(prisma).upsertFromClaims(adminClaims());
    const args = prisma.user.upsert.mock.calls[0]?.[0] as unknown as {
      update: Record<string, unknown>;
    };
    expect(args.update.isProtected).toBe(true);
  });

  it('leaves other admins and an empty PORTAL_MASTER_ADMIN alone', async () => {
    expect(isMasterAdminAccount('admin', 'admin', {})).toBe(true);
    expect(isMasterAdminAccount('sam', 'admin', {})).toBe(false);
    expect(isMasterAdminAccount('admin', 'contributor', {})).toBe(false);
    expect(isMasterAdminAccount('admin', 'admin', { PORTAL_MASTER_ADMIN: '' })).toBe(false);
    expect(isMasterAdminAccount('root', 'admin', { PORTAL_MASTER_ADMIN: 'root' })).toBe(true);
  });
});

/**
 * In `multi` mode a sign-in never creates an organization and
 * never moves an existing user to another one. `single` mode keeps the
 * old behaviour, which the specs above and the last block here cover.
 */
describe('org creation and user moves by tenancy mode', () => {
  const SAVED_TENANCY = process.env.GRATIS_TENANCY;
  const ORG_B = { id: 'org-2', slug: 'tucker', name: 'Tucker' };
  const ORG_UUID = '30000000-0000-4000-8000-000000000001';
  let now = T0;
  let nowSpy: jest.SpiedFunction<typeof Date.now>;
  let warnSpy: jest.SpiedFunction<Logger['warn']>;
  let errorSpy: jest.SpiedFunction<Logger['error']>;

  function setMode(mode: 'single' | 'multi' | undefined) {
    if (mode === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = mode;
    resetTenancyModeForTests();
  }

  beforeEach(() => {
    now = T0;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    nowSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    if (SAVED_TENANCY === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = SAVED_TENANCY;
    resetTenancyModeForTests();
  });

  /** A Prisma stub whose `organization` table holds exactly `orgs`. */
  function prismaWithOrgs(
    orgs: Array<{ id: string; slug: string; name: string }>,
    user: ReturnType<typeof makeUserRow> | null,
  ) {
    const prisma = makePrisma(user ? { user } : {});
    if (user === null) {
      prisma.user.findUnique.mockResolvedValue(null as never);
      prisma.user.upsert.mockImplementation(
        async (args: { where: { username: string }; update: Record<string, unknown> }) =>
          ({
            ...makeUserRow({ id: 'sub-1' }),
            ...((args as unknown as { create: Record<string, unknown> }).create ?? {}),
          }) as never,
      );
    }
    prisma.organization.findUnique.mockImplementation((async (args: {
      where: { id?: string; slug?: string };
    }) =>
      orgs.find(
        (o) =>
          (args.where.id !== undefined && o.id === args.where.id) ||
          (args.where.slug !== undefined && o.slug === args.where.slug),
      ) ?? null) as never);
    return prisma;
  }

  describe('multi', () => {
    beforeEach(() => setMode('multi'));

    it('refuses a token for an unknown org with 401 and creates no org', async () => {
      const prisma = prismaWithOrgs([ORG], null);
      const service = svc(prisma);
      const err = await service
        .upsertFromClaims(makeClaims({ org: 'new-slug' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as Error).message).toBe(NOT_ATTACHED_MESSAGE);
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      // Nothing else was read or written either: refused before the user.
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(prisma.item.createMany).not.toHaveBeenCalled();
    });

    it('logs the unknown slug at warn level, at most once a minute per slug', async () => {
      const service = svc(prismaWithOrgs([ORG], null));
      const tryOrg = (org: string) =>
        service.upsertFromClaims(makeClaims({ org })).catch(() => undefined);
      await tryOrg('new-slug');
      await tryOrg('new-slug');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain('"new-slug"');
      await tryOrg('other-slug');
      expect(warnSpy).toHaveBeenCalledTimes(2);
      now += 60_000;
      await tryOrg('new-slug');
      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('refuses an existing user of org A presenting org B and leaves the row in org A', async () => {
      // matt's row is in randolph (org-1); tucker exists too.
      const prisma = prismaWithOrgs([ORG, ORG_B], makeUserRow());
      const err = await svc(prisma)
        .upsertFromClaims(makeClaims({ org: 'tucker' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      // Same words as an unknown org: nothing confirms tucker exists.
      expect((err as Error).message).toBe(NOT_ATTACHED_MESSAGE);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain('org-1');
    });

    it('creates a new user in a known org as before, without seeding built-ins', async () => {
      const prisma = prismaWithOrgs([ORG], null);
      const user = await svc(prisma).upsertFromClaims(makeClaims());
      expect(user.orgId).toBe('org-1');
      expect(user.orgSlug).toBe('randolph');
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
      const args = prisma.user.upsert.mock.calls[0]![0] as unknown as {
        create: Record<string, unknown>;
      };
      expect(args.create).toEqual(
        expect.objectContaining({ id: 'sub-1', orgId: 'org-1', username: 'matt' }),
      );
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      // Seeding belongs to provisioning in multi mode.
      expect(prisma.item.findMany).not.toHaveBeenCalled();
      expect(prisma.item.createMany).not.toHaveBeenCalled();
    });

    it('adds no query for a known org and an existing user', async () => {
      const prisma = prismaWithOrgs([ORG], makeUserRow());
      await svc(prisma).upsertFromClaims(makeClaims());
      expect(prisma.organization.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.groupMember.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.userCapabilityOverride.findMany).toHaveBeenCalledTimes(1);
      // The first request in a process always writes lastSeenAt.
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
      expect(dbCalls(prisma)).toBe(5);
    });

    it('never writes orgId when updating a row in the same org', async () => {
      const prisma = prismaWithOrgs([ORG], makeUserRow());
      await svc(prisma).upsertFromClaims(makeClaims({ org_role: 'admin' }));
      const args = prisma.user.upsert.mock.calls[0]![0] as unknown as {
        update: Record<string, unknown>;
      };
      expect(args.update).toEqual(expect.objectContaining({ orgRole: 'admin' }));
      expect(args.update).not.toHaveProperty('orgId');
    });

    it('refuses when a racing request created the row in another org', async () => {
      const prisma = prismaWithOrgs([ORG], null);
      // The read saw no row; by the upsert another request had made one
      // in org-2, so the upsert lands in its update branch.
      prisma.user.upsert.mockImplementation(
        async (args: { where: { username: string }; update: Record<string, unknown> }) =>
          ({ ...makeUserRow({ orgId: 'org-2' }), ...args.update }) as never,
      );
      await expect(svc(prisma).upsertFromClaims(makeClaims())).rejects.toThrow(
        NOT_ATTACHED_MESSAGE,
      );
      const args = prisma.user.upsert.mock.calls[0]![0] as unknown as {
        update: Record<string, unknown>;
      };
      expect(args.update).not.toHaveProperty('orgId');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('looks a UUID-shaped claim up by id and uses that org', async () => {
      const uuidOrg = { id: ORG_UUID, slug: 'acme', name: 'Acme' };
      const prisma = prismaWithOrgs([uuidOrg], makeUserRow({ orgId: ORG_UUID }));
      const user = await svc(prisma).upsertFromClaims(makeClaims({ org: ORG_UUID }));
      expect(user.orgId).toBe(ORG_UUID);
      expect(user.orgSlug).toBe('acme');
      expect(prisma.organization.findUnique).toHaveBeenCalledWith({ where: { id: ORG_UUID } });
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
    });

    it('refuses a UUID-shaped claim that matches no org and creates nothing', async () => {
      const prisma = prismaWithOrgs([ORG], null);
      await expect(
        svc(prisma).upsertFromClaims(makeClaims({ org: ORG_UUID })),
      ).rejects.toThrow(NOT_ATTACHED_MESSAGE);
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });

    it('drops a cached principal when the org claim changes, then refuses', async () => {
      const prisma = prismaWithOrgs([ORG, ORG_B], makeUserRow());
      const service = svc(prisma);
      const first = await service.upsertFromClaims(makeClaims());
      now += 1_000;
      // Inside the TTL, but the org is part of the fingerprint: the
      // cached org-1 principal is not served for an org=tucker token.
      await expect(service.upsertFromClaims(makeClaims({ org: 'tucker' }))).rejects.toThrow(
        NOT_ATTACHED_MESSAGE,
      );
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
      // The entry is gone, so the original token is rebuilt, not served.
      const again = await service.upsertFromClaims(makeClaims());
      expect(again).not.toBe(first);
      expect(again.orgId).toBe('org-1');
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
    });

    it('runs the org hook on the build path', async () => {
      const prisma = prismaWithOrgs([ORG], makeUserRow());
      const service = svc(prisma);
      const hook = jest.spyOn(
        service as unknown as { assertOrgUsable: (o: unknown) => void },
        'assertOrgUsable',
      );
      await service.upsertFromClaims(makeClaims());
      expect(hook).toHaveBeenCalledWith(ORG);
    });
  });

  describe('single', () => {
    beforeEach(() => setMode(undefined));

    it('still creates the org on first sign-in and seeds its built-ins', async () => {
      const prisma = prismaWithOrgs([], null);
      await svc(prisma).upsertFromClaims(makeClaims({ org: 'new-slug' }));
      expect(prisma.organization.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: { slug: 'new-slug', name: 'new-slug' } }),
      );
      expect(prisma.item.findMany).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('still moves an existing user to the org the token names', async () => {
      const prisma = prismaWithOrgs([ORG, ORG_B], makeUserRow());
      const user = await svc(prisma).upsertFromClaims(makeClaims({ org: 'tucker' }));
      const args = prisma.user.upsert.mock.calls[0]![0] as unknown as {
        update: Record<string, unknown>;
      };
      expect(args.update).toEqual(expect.objectContaining({ orgId: 'org-2' }));
      expect(user.orgId).toBe('org-2');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not run the org hook', async () => {
      const prisma = prismaWithOrgs([ORG], makeUserRow());
      const service = svc(prisma);
      const hook = jest.spyOn(
        service as unknown as { assertOrgUsable: (o: unknown) => void },
        'assertOrgUsable',
      );
      await service.upsertFromClaims(makeClaims());
      expect(hook).not.toHaveBeenCalled();
    });
  });
});
