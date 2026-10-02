// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { AdminUsersController } from './admin-users.controller.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { KeycloakUserRep } from './keycloak-admin.service.js';

/**
 * Lockout + take-over guard coverage for #133 / #134.
 *
 * The controller has read-modify-write behavior split between the
 * Keycloak service and the local Prisma user row; the guard helper
 * (`assertMutationAllowed`) reads from both and refuses based on
 * four invariants:
 *
 *   1. Protected users (master admin) can't be touched at all.
 *   2. The caller can't self-demote, self-disable, self-auto-disable,
 *      or self-delete.
 *   3. The org always retains at least one active admin.
 *   4. New admins can't be minted when PORTAL_LOCK_ADMIN_TIER is on.
 *
 * Each invariant gets at least one positive + negative case.
 */

interface LocalUser {
  id: string;
  orgId: string;
  orgRole: 'viewer' | 'contributor' | 'admin';
  isProtected: boolean;
  username: string;
  lastSeenAt?: Date | null;
  autoDisableAt?: Date | null;
}

function makeAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-self',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'admin',
    email: 'admin@example.test',
    orgRole: 'admin',
    capabilityOverrides: {},
    ...overrides,
  } as unknown as AuthUser;
}

function makeFakePrisma(opts: {
  localByUsername: Map<string, LocalUser>;
  adminCount: number;
}) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { username: string } }) => {
        return opts.localByUsername.get(where.username) ?? null;
      }),
      findMany: jest.fn(async () => [...opts.localByUsername.values()]),
      count: jest.fn(async () => opts.adminCount),
    },
  };
}

function makeFakeKc(opts: {
  byId: Map<string, KeycloakUserRep>;
}) {
  return {
    getUser: jest.fn(async (id: string) => {
      const u = opts.byId.get(id);
      if (!u) throw new NotFoundException('User not found');
      return u;
    }),
    updateUser: jest.fn(async (_id: string, _patch: unknown) => ({
      id: 'kc-target',
      username: 'target',
      email: 'target@example.test',
    })),
    deleteUser: jest.fn(async () => undefined),
    sendExecuteActionsEmail: jest.fn(async () => undefined),
    createUser: jest.fn(async () => ({})),
    listUsers: jest.fn(async (): Promise<KeycloakUserRep[]> => []),
    isConfigured: jest.fn(() => true),
  };
}

function makeController({
  caller,
  targets,
  adminCount,
}: {
  caller: AuthUser;
  targets: Array<{
    id: string;
    kc: KeycloakUserRep;
    local: LocalUser | null;
  }>;
  adminCount: number;
}): { controller: AdminUsersController; kc: ReturnType<typeof makeFakeKc>; prisma: ReturnType<typeof makeFakePrisma> } {
  const kcById = new Map<string, KeycloakUserRep>();
  const localByUsername = new Map<string, LocalUser>();
  for (const t of targets) {
    kcById.set(t.id, t.kc);
    if (t.local) localByUsername.set(t.local.username, t.local);
  }
  const kc = makeFakeKc({ byId: kcById });
  const prisma = makeFakePrisma({ localByUsername, adminCount });
  const controller = new AdminUsersController(
    kc as unknown as ConstructorParameters<typeof AdminUsersController>[0],
    prisma as unknown as ConstructorParameters<typeof AdminUsersController>[1],
    // The guards under test never reach a write, so the principal
    // cache has nothing to forget; a recording stub keeps that honest.
    { invalidate: jest.fn(), invalidateAll: jest.fn() } as unknown as ConstructorParameters<
      typeof AdminUsersController
    >[2],
  );
  // Stash so the closure tests can read me; the controller pulls
  // it from a decorator at runtime which Jest can't drive directly,
  // so each test passes `caller` explicitly into the public method.
  void caller;
  return { controller, kc, prisma };
}

describe('AdminUsersController guards (#133 / #134)', () => {
  const ORIGINAL_ENV = process.env.PORTAL_LOCK_ADMIN_TIER;

  afterEach(() => {
    process.env.PORTAL_LOCK_ADMIN_TIER = ORIGINAL_ENV;
  });

  // ------------------------------------------------------------
  // (1) Protected master admin
  // ------------------------------------------------------------

  it('refuses every PATCH against a protected user, regardless of caller', async () => {
    const caller = makeAuthUser({ username: 'other-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-master',
          kc: { id: 'kc-master', username: 'admin' } as KeycloakUserRep,
          local: {
            id: 'kc-master',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: true,
            username: 'admin',
          },
        },
      ],
      adminCount: 5, // plenty of admins; protection alone should refuse
    });
    await expect(
      controller.update(caller, 'kc-master', { orgRole: 'viewer' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses DELETE against a protected user', async () => {
    const caller = makeAuthUser({ username: 'other-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-master',
          kc: { id: 'kc-master', username: 'admin' } as KeycloakUserRep,
          local: {
            id: 'kc-master',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: true,
            username: 'admin',
          },
        },
      ],
      adminCount: 5,
    });
    await expect(controller.remove(caller, 'kc-master')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses reset-password against a protected user', async () => {
    const caller = makeAuthUser({ username: 'other-admin' });
    const { controller, kc } = makeController({
      caller,
      targets: [
        {
          id: 'kc-master',
          kc: { id: 'kc-master', username: 'admin' } as KeycloakUserRep,
          local: {
            id: 'kc-master',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: true,
            username: 'admin',
          },
        },
      ],
      adminCount: 5,
    });
    await expect(
      controller.resetPassword(caller, 'kc-master'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(kc.sendExecuteActionsEmail).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------
  // (2) Self-mutation refusal
  // ------------------------------------------------------------

  it('refuses self-demote (admin demoting themselves)', async () => {
    const caller = makeAuthUser({ username: 'lone-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-lone',
          kc: { id: 'kc-lone', username: 'lone-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-lone',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'lone-admin',
          },
        },
      ],
      adminCount: 3, // not sole; self-refusal is independent of count
    });
    await expect(
      controller.update(caller, 'kc-lone', { orgRole: 'viewer' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses self-disable (admin disabling themselves)', async () => {
    const caller = makeAuthUser({ username: 'lone-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-lone',
          kc: { id: 'kc-lone', username: 'lone-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-lone',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'lone-admin',
          },
        },
      ],
      adminCount: 3,
    });
    await expect(
      controller.update(caller, 'kc-lone', { enabled: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses self-delete', async () => {
    const caller = makeAuthUser({ username: 'lone-admin' });
    const { controller, kc } = makeController({
      caller,
      targets: [
        {
          id: 'kc-lone',
          kc: { id: 'kc-lone', username: 'lone-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-lone',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'lone-admin',
          },
        },
      ],
      adminCount: 3,
    });
    await expect(controller.remove(caller, 'kc-lone')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(kc.deleteUser).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------
  // (3) Sole-admin floor
  // ------------------------------------------------------------

  it('refuses demoting another admin when they are the sole active admin', async () => {
    // Caller is, e.g., a system admin acting on themselves through
    // another path. For this test we pretend the caller is a
    // non-self admin and adminCount is 1 (the target IS that lone
    // admin). The floor still trips because the post-mutation
    // world would have zero admins.
    const caller = makeAuthUser({ username: 'caller-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-target',
          kc: { id: 'kc-target', username: 'caller-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-target',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'caller-admin',
          },
        },
      ],
      adminCount: 1,
    });
    // Self-demote check trips first when target.username === me.username,
    // so this still throws BadRequest. We're really proving "the gate
    // fires"; the floor itself is exercised by the next test where
    // target != self.
    await expect(
      controller.update(caller, 'kc-target', { orgRole: 'viewer' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses demoting the sole non-self admin', async () => {
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-other',
          kc: { id: 'kc-other', username: 'other-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-other',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'other-admin',
          },
        },
      ],
      adminCount: 1, // only the target counts; caller isn't admin in this scenario
    });
    await expect(
      controller.update(caller, 'kc-other', { orgRole: 'viewer' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows demoting an admin when other active admins exist', async () => {
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller, kc } = makeController({
      caller,
      targets: [
        {
          id: 'kc-other',
          kc: { id: 'kc-other', username: 'other-admin' } as KeycloakUserRep,
          local: {
            id: 'kc-other',
            orgId: 'org-1',
            orgRole: 'admin',
            isProtected: false,
            username: 'other-admin',
          },
        },
      ],
      adminCount: 3, // plenty
    });
    await expect(
      controller.update(caller, 'kc-other', { orgRole: 'viewer' }),
    ).resolves.toBeDefined();
    expect(kc.updateUser).toHaveBeenCalledWith('kc-other', {
      orgRole: 'viewer',
    });
  });

  // ------------------------------------------------------------
  // (4) PORTAL_LOCK_ADMIN_TIER
  // ------------------------------------------------------------

  it('refuses promote-to-admin when PORTAL_LOCK_ADMIN_TIER=true', async () => {
    process.env.PORTAL_LOCK_ADMIN_TIER = 'true';
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller } = makeController({
      caller,
      targets: [
        {
          id: 'kc-other',
          kc: { id: 'kc-other', username: 'other-user' } as KeycloakUserRep,
          local: {
            id: 'kc-other',
            orgId: 'org-1',
            orgRole: 'contributor',
            isProtected: false,
            username: 'other-user',
          },
        },
      ],
      adminCount: 5,
    });
    await expect(
      controller.update(caller, 'kc-other', { orgRole: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses invite with orgRole=admin when PORTAL_LOCK_ADMIN_TIER=true', () => {
    process.env.PORTAL_LOCK_ADMIN_TIER = '1';
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller } = makeController({
      caller,
      targets: [],
      adminCount: 5,
    });
    // invite() throws synchronously (the lock check runs before
    // any async Keycloak call), so we assert the throw, not a
    // rejected promise.
    expect(() =>
      controller.invite(caller, {
        username: 'newbie',
        email: 'newbie@example.test',
        orgRole: 'admin',
      } as never),
    ).toThrow(ForbiddenException);
  });

  it('allows promote-to-admin when PORTAL_LOCK_ADMIN_TIER is off', async () => {
    process.env.PORTAL_LOCK_ADMIN_TIER = '';
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller, kc } = makeController({
      caller,
      targets: [
        {
          id: 'kc-other',
          kc: { id: 'kc-other', username: 'other-user' } as KeycloakUserRep,
          local: {
            id: 'kc-other',
            orgId: 'org-1',
            orgRole: 'contributor',
            isProtected: false,
            username: 'other-user',
          },
        },
      ],
      adminCount: 5,
    });
    await expect(
      controller.update(caller, 'kc-other', { orgRole: 'admin' }),
    ).resolves.toBeDefined();
    expect(kc.updateUser).toHaveBeenCalledWith('kc-other', { orgRole: 'admin' });
  });

  // ------------------------------------------------------------
  // Negative controls: pure name / email patches still work
  // ------------------------------------------------------------

  it('allows pure first-name change on a non-protected target', async () => {
    const caller = makeAuthUser({ username: 'me-admin' });
    const { controller, kc } = makeController({
      caller,
      targets: [
        {
          id: 'kc-other',
          kc: { id: 'kc-other', username: 'other-user' } as KeycloakUserRep,
          local: {
            id: 'kc-other',
            orgId: 'org-1',
            orgRole: 'contributor',
            isProtected: false,
            username: 'other-user',
          },
        },
      ],
      adminCount: 5,
    });
    await expect(
      controller.update(caller, 'kc-other', { firstName: 'New' }),
    ).resolves.toBeDefined();
    expect(kc.updateUser).toHaveBeenCalledWith('kc-other', { firstName: 'New' });
  });
});

describe('AdminUsersController org-scoped reads', () => {
  function kcUser(
    id: string,
    username: string,
    org: string | null,
  ): KeycloakUserRep {
    const attributes: Record<string, string[]> = {};
    if (org !== null) attributes.org = [org];
    return {
      id,
      username,
      enabled: true,
      email: `${username}@example.test`,
      attributes,
    };
  }

  function localUser(username: string, orgId: string): LocalUser {
    return {
      id: `local-${username}`,
      orgId,
      orgRole: 'contributor',
      isProtected: false,
      username,
      lastSeenAt: new Date('2026-03-01T00:00:00Z'),
      autoDisableAt: null,
    };
  }

  it('lists only users in the calling admin org', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme', username: 'me-admin' });
    const mine = kcUser('kc-mine', 'mine', 'acme');
    const invitee = kcUser('kc-invitee', 'invitee', 'acme');
    const other = kcUser('kc-other', 'other', 'beta');
    const unscoped = kcUser('kc-svc', 'service-account', null);
    const { controller, kc, prisma } = makeController({
      caller,
      targets: [
        { id: mine.id, kc: mine, local: localUser('mine', 'org-1') },
        { id: invitee.id, kc: invitee, local: null },
        { id: other.id, kc: other, local: localUser('other', 'org-2') },
        { id: unscoped.id, kc: unscoped, local: null },
      ],
      adminCount: 1,
    });
    kc.listUsers.mockResolvedValue([mine, invitee, other, unscoped]);

    const rows = await controller.list(caller, 'ada', '0', '50');

    expect(kc.listUsers).toHaveBeenCalledWith({ search: 'ada', first: 0, max: 50 });
    expect(rows.map((u) => u.username)).toEqual(['mine', 'invitee']);
    expect(rows.find((u) => u.username === 'other')).toBeUndefined();
    expect(rows.find((u) => u.username === 'service-account')).toBeUndefined();
    expect(rows[0]?.lastSeenAt).toBe('2026-03-01T00:00:00.000Z');
    expect(rows[0]?.isProtected).toBe(false);
    expect(prisma.user.findMany).toHaveBeenCalled();
  });

  it('keeps a local user in the caller org when the Keycloak org attribute is missing', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const legacy = kcUser('kc-legacy', 'legacy', null);
    const { controller, kc } = makeController({
      caller,
      targets: [{ id: legacy.id, kc: legacy, local: localUser('legacy', 'org-1') }],
      adminCount: 1,
    });
    kc.listUsers.mockResolvedValue([legacy]);

    const rows = await controller.list(caller);
    expect(rows.map((u) => u.username)).toEqual(['legacy']);
  });

  it('drops a user whose local org disagrees with a matching Keycloak org attribute', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const conflict = kcUser('kc-conflict', 'conflict', 'acme');
    const { controller, kc } = makeController({
      caller,
      targets: [{ id: conflict.id, kc: conflict, local: localUser('conflict', 'org-2') }],
      adminCount: 1,
    });
    kc.listUsers.mockResolvedValue([conflict]);

    await expect(controller.list(caller)).resolves.toEqual([]);
  });

  it('treats a legacy org-id attribute as the caller org', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const legacyId = kcUser('kc-uuid', 'uuid-org', 'org-1');
    const { controller, kc } = makeController({
      caller,
      targets: [{ id: legacyId.id, kc: legacyId, local: null }],
      adminCount: 1,
    });
    kc.listUsers.mockResolvedValue([legacyId]);

    const rows = await controller.list(caller);
    expect(rows.map((u) => u.username)).toEqual(['uuid-org']);
  });

  it('returns a same-org user from GET /admin/users/:id', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const mine = kcUser('kc-mine', 'mine', 'acme');
    const { controller } = makeController({
      caller,
      targets: [{ id: mine.id, kc: mine, local: localUser('mine', 'org-1') }],
      adminCount: 1,
    });

    await expect(controller.get(caller, 'kc-mine')).resolves.toMatchObject({
      id: 'kc-mine',
      username: 'mine',
    });
  });

  it('returns 404 for a user in another org instead of the record', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const other = kcUser('kc-other', 'other', 'beta');
    const { controller } = makeController({
      caller,
      targets: [{ id: other.id, kc: other, local: localUser('other', 'org-2') }],
      adminCount: 1,
    });

    await expect(controller.get(caller, 'kc-other')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the target has no org signal at all', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const unscoped = kcUser('kc-svc', 'service-account', null);
    const { controller } = makeController({
      caller,
      targets: [{ id: unscoped.id, kc: unscoped, local: null }],
      adminCount: 1,
    });

    await expect(controller.get(caller, 'kc-svc')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a never-signed-in invitee whose Keycloak org matches', async () => {
    const caller = makeAuthUser({ orgId: 'org-1', orgSlug: 'acme' });
    const invitee = kcUser('kc-invitee', 'invitee', 'acme');
    const { controller } = makeController({
      caller,
      targets: [{ id: invitee.id, kc: invitee, local: null }],
      adminCount: 1,
    });

    await expect(controller.get(caller, 'kc-invitee')).resolves.toMatchObject({
      username: 'invitee',
    });
  });
});
