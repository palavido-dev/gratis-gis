// SPDX-License-Identifier: AGPL-3.0-or-later
import { KeycloakSyncService } from './keycloak-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService, KeycloakUserRep } from './keycloak-admin.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

/**
 * Accounts invited before the slug fix carry the org's UUID in their
 * `org` attribute. auth-sync accepts that form, so their row sits in
 * the org, but reconcile only resolved slugs, never saw them, and the
 * soft-delete pass locked them out on every run.
 */
const ORG = { id: '30000000-0000-4000-8000-000000000001', slug: 'acme' };

function build(realm: KeycloakUserRep[], local: Array<{ id: string; username: string }>) {
  const tombstoned: string[] = [];
  const prisma = {
    organization: { findMany: jest.fn(async () => [ORG]) },
    user: {
      upsert: jest.fn(async (args: { where: { username: string } }) => ({
        id: `local-${args.where.username}`,
        createdAt: new Date(0),
        disabledAt: null,
      })),
      findMany: jest.fn(async () => local),
      updateMany: jest.fn(
        async (args: { where: { id?: { in: string[] } }; data: { deletedAt?: Date } }) => {
          if (args.data.deletedAt && args.where.id) tombstoned.push(...args.where.id.in);
          return { count: args.where.id?.in.length ?? 0 };
        },
      ),
    },
  };
  const kc = {
    isConfigured: () => true,
    listServiceAccountUsernames: jest.fn(async () => new Set<string>()),
    listUsers: jest.fn(async ({ first }: { first: number }) => (first === 0 ? realm : [])),
  };
  const svc = new KeycloakSyncService(
    prisma as unknown as PrismaService,
    kc as unknown as KeycloakAdminService,
    { invalidate: jest.fn() } as unknown as AuthSyncService,
  );
  return { svc, tombstoned, prisma };
}

const user = (username: string, org?: string): KeycloakUserRep => ({
  id: `kc-${username}`,
  username,
  enabled: true,
  attributes: org ? { org: [org], org_role: ['viewer'] } : {},
});

describe('KeycloakSyncService org attribute forms', () => {
  it('accepts the org id form and does not tombstone that user', async () => {
    const { svc, tombstoned, prisma } = build(
      [user('ana', 'acme'), user('legacy', ORG.id)],
      [
        { id: 'local-ana', username: 'ana' },
        { id: 'local-legacy', username: 'legacy' },
        { id: 'local-gone', username: 'gone' },
      ],
    );
    const res = await svc.reconcileAll();
    expect(res.skippedUnknownOrg).toBe(0);
    expect(prisma.user.upsert).toHaveBeenCalledTimes(2);
    expect(tombstoned).toEqual(['local-gone']);
  });

  it('never tombstones a username the realm still has, even with no usable org', async () => {
    const { svc, tombstoned } = build(
      [user('ana', 'acme'), user('drifted', 'unknown-org'), user('bare')],
      [
        { id: 'local-ana', username: 'ana' },
        { id: 'local-drifted', username: 'drifted' },
        { id: 'local-bare', username: 'bare' },
      ],
    );
    await svc.reconcileAll();
    expect(tombstoned).toEqual([]);
  });
});
