// SPDX-License-Identifier: AGPL-3.0-or-later
import { UnauthorizedException } from '@nestjs/common';
import {
  BUILTIN_BASEMAP_SEEDS,
  PRINT_TEMPLATE_STARTERS,
  STARTERS,
  THEME_STARTERS,
} from '@gratis-gis/shared-types';

import { AuthSyncService } from './auth-sync.service.js';
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
