// SPDX-License-Identifier: AGPL-3.0-or-later
import { KeycloakSyncService } from './keycloak-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService, KeycloakUserRep } from './keycloak-admin.service.js';
import type { AuthSyncService } from '../auth/auth-sync.service.js';

/**
 * A disable made in the Keycloak console has to reach the local row,
 * since API keys and scheduled scripts read `disabled_at`, not
 * Keycloak.
 */
function build(
  kcUser: KeycloakUserRep,
  localDisabledAt: Date | null,
  afterFetch?: (row: { disabledAt: Date | null }) => void,
) {
  const calls: string[] = [];
  const row = { disabledAt: localDisabledAt };
  const txRef: { current: unknown } = { current: null };
  const prisma = {
    organization: { findMany: jest.fn(async () => [{ id: 'org-1', slug: 'acme' }]) },
    user: {
      upsert: jest.fn(async () => ({
        id: 'local-1',
        createdAt: new Date(0),
        disabledAt: row.disabledAt,
      })),
      updateMany: jest.fn(
        async (args: {
          where: { disabledAt: null | { not?: null; lt?: Date } };
          data: { disabledAt: Date | null };
        }) => {
          // Honour the disabledAt filter against the stored row, so a
          // guarded enable that should not match really does not.
          const f = args.where.disabledAt;
          const stored = row.disabledAt;
          const matches =
            f === null
              ? stored === null
              : stored !== null && (f.lt === undefined || stored < f.lt);
          if (!matches) return { count: 0 };
          calls.push(args.data.disabledAt === null ? 'enable' : 'disable');
          row.disabledAt = args.data.disabledAt;
          return { count: 1 };
        },
      ),
      findMany: jest.fn(async () => []),
    },
    apiKey: {
      updateMany: jest.fn(async () => {
        calls.push('revoke');
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(txRef.current),
    ),
  };
  txRef.current = prisma;

  const kc = {
    isConfigured: () => true,
    listServiceAccountUsernames: jest.fn(async () => new Set<string>()),
    listUsers: jest.fn(async () => {
      // Runs after Keycloak answered: an admin action landing here
      // is newer than the page the reconcile is working from.
      await new Promise((r) => setTimeout(r, 5));
      afterFetch?.(row);
      return [kcUser];
    }),
  };
  const svc = new KeycloakSyncService(
    prisma as unknown as PrismaService,
    kc as unknown as KeycloakAdminService,
    { invalidate: jest.fn() } as unknown as AuthSyncService,
  );
  return { svc, calls };
}

const base: KeycloakUserRep = {
  id: 'kc-1',
  username: 'ana',
  enabled: true,
  attributes: { org: ['acme'], org_role: ['contributor'] },
};

describe('KeycloakSyncService mirrors enabled', () => {
  it('disables locally and revokes keys for a user disabled in Keycloak', async () => {
    const { svc, calls } = build({ ...base, enabled: false }, null);
    await svc.reconcileAll();
    expect(calls).toEqual(['disable', 'revoke']);
  });

  it('clears the marker, and only the marker, when Keycloak enables the user', async () => {
    const { svc, calls } = build(base, new Date(Date.now() - 60_000));
    await svc.reconcileAll();
    expect(calls).toEqual(['enable']);
  });

  it('keeps a disable made after the Keycloak page was fetched', async () => {
    // Keycloak said enabled=true, then an admin disabled the user
    // locally before the reconcile reached them. The stale page must
    // not undo that disable.
    const { svc, calls } = build(base, null, (row) => {
      row.disabledAt = new Date();
    });
    await svc.reconcileAll();
    expect(calls).toEqual([]);
  });

  it('does nothing when both sides already agree', async () => {
    const { svc, calls } = build(base, null);
    await svc.reconcileAll();
    expect(calls).toEqual([]);
  });
});
