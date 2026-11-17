// SPDX-License-Identifier: AGPL-3.0-or-later
import { KeycloakSyncService } from './keycloak-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

/**
 * One user whose row cannot be written (for example a Keycloak rename
 * whose id is already used locally) must not stop the rest of the
 * mirror. Accounts with no email get auth-sync's placeholder.
 */
describe('KeycloakSyncService per-user errors', () => {
  it('skips the failing user and keeps going', async () => {
    const written: Array<{ username: string; email: string }> = [];
    const prisma = {
      organization: { findMany: jest.fn(async () => [{ id: 'org-1', slug: 'acme' }]) },
      user: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 0 })),
        upsert: jest.fn(async (args: { where: { username: string }; create: { email: string } }) => {
          if (args.where.username === 'renamed') throw new Error('unique constraint on id');
          written.push({ username: args.where.username, email: args.create.email });
          return { id: 'x', disabledAt: null, createdAt: new Date(), updatedAt: new Date() };
        }),
      },
    };
    const pages = [
      [
        { id: 'k1', username: 'renamed', enabled: true, attributes: { org: ['acme'] } },
        { id: 'k2', username: 'bo', enabled: true, attributes: { org: ['acme'] } },
      ],
      [],
    ];
    const kc = {
      isConfigured: () => true,
      listUsers: jest.fn(async () => pages.shift() ?? []),
      listServiceAccountUsernames: jest.fn(async () => new Set<string>()),
    };
    const svc = new KeycloakSyncService(
      prisma as unknown as PrismaService,
      kc as unknown as KeycloakAdminService,
      { invalidate: jest.fn() } as unknown as AuthSyncService,
    );
    await svc.reconcileAll();
    expect(written).toEqual([{ username: 'bo', email: 'bo@local.gratisgis' }]);
  });
});
