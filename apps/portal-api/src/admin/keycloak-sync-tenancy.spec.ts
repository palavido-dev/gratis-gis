// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';

import { KeycloakSyncService } from './keycloak-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService, KeycloakUserRep } from './keycloak-admin.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';

/**
 * In `multi` mode the realm mirror never creates an org and
 * never moves an existing user to another org. `single` mode keeps
 * the old behaviour, where the realm attribute wins.
 */
const ORG_A = { id: 'org-a', slug: 'acme' };
const ORG_B = { id: 'org-b', slug: 'bravo' };

interface LocalRow {
  id: string;
  username: string;
  orgId: string;
  disabledAt: Date | null;
}

function build(realm: KeycloakUserRep[], local: LocalRow[]) {
  const rows = new Map(local.map((r) => [r.username, { ...r }]));
  const prisma = {
    organization: {
      findMany: jest.fn(async () => [ORG_A, ORG_B]),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    user: {
      findMany: jest.fn(
        async (args: { where: { username?: { in: string[] }; orgId?: string } }) => {
          const all = [...rows.values()];
          if (args.where.username)
            return all.filter((r) => args.where.username!.in.includes(r.username));
          return all.filter((r) => r.orgId === args.where.orgId);
        },
      ),
      upsert: jest.fn(
        async (args: {
          where: { username: string };
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          const row = rows.get(args.where.username);
          const next = row
            ? { ...row, ...args.update }
            : ({ ...args.create, disabledAt: null } as unknown as LocalRow);
          rows.set(args.where.username, next as LocalRow);
          return { ...next, createdAt: new Date(0) };
        },
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { updateMany: jest.fn(async () => ({ count: 1 })) },
        apiKey: { updateMany: jest.fn(async () => ({ count: 0 })) },
      }),
    ),
  };
  const kc = {
    isConfigured: () => true,
    listServiceAccountUsernames: jest.fn(async () => new Set<string>()),
    listUsers: jest.fn(async ({ first }: { first: number }) => (first === 0 ? realm : [])),
  };
  const authSync = { invalidate: jest.fn() };
  const svc = new KeycloakSyncService(
    prisma as unknown as PrismaService,
    kc as unknown as KeycloakAdminService,
    authSync as unknown as AuthSyncService,
  );
  return { svc, prisma, rows, authSync };
}

const realmUser = (username: string, org: string, enabled = true): KeycloakUserRep => ({
  id: `kc-${username}`,
  username,
  enabled,
  attributes: { org: [org], org_role: ['viewer'] },
});

describe('KeycloakSyncService org creation and user moves by tenancy mode', () => {
  const SAVED = process.env.GRATIS_TENANCY;
  let errorSpy: jest.SpiedFunction<Logger['error']>;
  function setMode(mode: 'multi' | undefined) {
    if (mode === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = mode;
    resetTenancyModeForTests();
  }
  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (SAVED === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = SAVED;
    resetTenancyModeForTests();
  });

  describe('multi', () => {
    beforeEach(() => setMode('multi'));

    it('creates nothing for a realm user whose org has no local row', async () => {
      const { svc, prisma } = build([realmUser('nora', 'new-slug')], []);
      const res = await svc.reconcileAll();
      expect(res.skippedUnknownOrg).toBe(1);
      expect(res.inserted).toBe(0);
      expect(prisma.organization.create).not.toHaveBeenCalled();
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });

    it('does not move or update a user whose attribute names another org', async () => {
      const { svc, prisma, rows } = build(
        [realmUser('ana', 'bravo')],
        [{ id: 'local-ana', username: 'ana', orgId: ORG_A.id, disabledAt: null }],
      );
      const res = await svc.reconcileAll();
      expect(res.skippedOrgMismatch).toBe(1);
      expect(prisma.user.upsert).not.toHaveBeenCalled();
      expect(rows.get('ana')!.orgId).toBe(ORG_A.id);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('still applies a Keycloak disable to a mismatched user', async () => {
      const { svc, prisma, authSync } = build(
        [realmUser('ana', 'bravo', false)],
        [{ id: 'local-ana', username: 'ana', orgId: ORG_A.id, disabledAt: null }],
      );
      await svc.reconcileAll();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(authSync.invalidate).toHaveBeenCalledWith('local-ana');
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });

    it('creates a new user in a known org and updates a same-org user without writing orgId', async () => {
      const { svc, prisma, rows } = build(
        [realmUser('ana', 'acme'), realmUser('ben', 'bravo')],
        [{ id: 'local-ana', username: 'ana', orgId: ORG_A.id, disabledAt: null }],
      );
      const res = await svc.reconcileAll();
      expect(res.skippedOrgMismatch).toBe(0);
      expect(prisma.user.upsert).toHaveBeenCalledTimes(2);
      const anaArgs = prisma.user.upsert.mock.calls[0]![0];
      expect(anaArgs.update).not.toHaveProperty('orgId');
      expect(rows.get('ben')!.orgId).toBe(ORG_B.id);
      // One username read per page, not one per user.
      const pageReads = prisma.user.findMany.mock.calls.filter((c) => c[0].where.username);
      expect(pageReads).toHaveLength(1);
    });

    it('skips a row that a racing writer created in another org', async () => {
      const { svc, prisma, rows } = build([realmUser('ana', 'bravo')], []);
      // The page read saw no row; by the upsert one exists in acme.
      prisma.user.upsert.mockImplementationOnce(async (args) => {
        const row = { id: 'local-ana', username: 'ana', orgId: ORG_A.id, disabledAt: null };
        const next = { ...row, ...args.update };
        rows.set('ana', next as LocalRow);
        return { ...next, createdAt: new Date(0) };
      });
      const res = await svc.reconcileAll();
      expect(rows.get('ana')!.orgId).toBe(ORG_A.id);
      expect(res.skippedOrgMismatch).toBe(1);
    });
  });

  describe('single', () => {
    beforeEach(() => setMode(undefined));

    it('moves a user to the org its attribute names, as before', async () => {
      const { svc, prisma, rows } = build(
        [realmUser('ana', 'bravo')],
        [{ id: 'local-ana', username: 'ana', orgId: ORG_A.id, disabledAt: null }],
      );
      const res = await svc.reconcileAll();
      expect(res).not.toHaveProperty('skippedOrgMismatch');
      expect(prisma.user.upsert.mock.calls[0]![0].update).toEqual(
        expect.objectContaining({ orgId: ORG_B.id }),
      );
      expect(rows.get('ana')!.orgId).toBe(ORG_B.id);
      // No per-page username read in single mode.
      expect(prisma.user.findMany.mock.calls.some((c) => c[0].where.username)).toBe(false);
    });

    it('still creates no org for an unknown attribute', async () => {
      const { svc, prisma } = build([realmUser('nora', 'new-slug')], []);
      const res = await svc.reconcileAll();
      expect(res.skippedUnknownOrg).toBe(1);
      expect(prisma.organization.upsert).not.toHaveBeenCalled();
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });
  });
});
