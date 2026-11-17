// SPDX-License-Identifier: AGPL-3.0-or-later
import { KeycloakSyncService } from './keycloak-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

/**
 * Keycloak's user list leaves out client service-account users, so the
 * soft-delete pass saw them as "not in the realm". The snapshot
 * tooling's portal-api-admin account was tombstoned on every boot
 * because of it, and every pre-snapshot purge then failed with
 * "This account is deleted".
 */
function build(
  localRows: Array<{ id: string; username: string }>,
  serviceAccounts: () => Promise<Set<string>>,
) {
  const tombstoned: string[] = [];
  const invalidate = jest.fn();
  const prisma = {
    organization: { findMany: jest.fn(async () => [{ id: 'org-1', slug: 'acme' }]) },
    user: {
      findMany: jest.fn(async () => localRows),
      updateMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => {
        tombstoned.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      }),
    },
  };
  const kc = {
    isConfigured: () => true,
    // An empty realm page: nothing was seen, so every local row is a
    // soft-delete candidate.
    listUsers: jest.fn(async () => []),
    listServiceAccountUsernames: jest.fn(serviceAccounts),
  };
  const svc = new KeycloakSyncService(
    prisma as unknown as PrismaService,
    kc as unknown as KeycloakAdminService,
    { invalidate } as unknown as AuthSyncService,
  );
  return { svc, tombstoned, invalidate };
}

const serviceAccount = { id: 'sa-1', username: 'service-account-portal-api-admin' };
const goneUser = { id: 'u-1', username: 'ana' };

describe('KeycloakSyncService soft-delete pass and service accounts', () => {
  it('keeps a service-account user that the realm list left out', async () => {
    const { svc, tombstoned, invalidate } = build(
      [serviceAccount, goneUser],
      async () => new Set(['service-account-portal-api-admin']),
    );
    const res = await svc.reconcileAll();
    expect(tombstoned).toEqual(['u-1']);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith('u-1');
    expect(res.softDeleted).toBe(1);
  });

  it('matches service-account usernames without regard to case', async () => {
    const { svc, tombstoned } = build(
      [{ id: 'sa-2', username: 'Service-Account-Reporting' }],
      async () => new Set(['service-account-reporting']),
    );
    await svc.reconcileAll();
    expect(tombstoned).toEqual([]);
  });

  it('does not protect an ordinary user whose name only looks like one', async () => {
    // Protection comes from Keycloak's client links, not the prefix.
    const { svc, tombstoned } = build(
      [{ id: 'u-2', username: 'service-account-lookalike' }],
      async () => new Set(['service-account-portal-api-admin']),
    );
    await svc.reconcileAll();
    expect(tombstoned).toEqual(['u-2']);
  });

  it('skips the whole soft-delete pass when the service-account lookup fails', async () => {
    const { svc, tombstoned } = build([serviceAccount, goneUser], async () => {
      throw new Error('Keycloak client list failed: 503');
    });
    const res = await svc.reconcileAll();
    expect(tombstoned).toEqual([]);
    expect(res.softDeleted).toBe(0);
  });
});
