// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';

import type { AuthSyncService } from '../auth/auth-sync.service.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService, KeycloakUserRep } from './keycloak-admin.service.js';
import { KeycloakSyncService } from './keycloak-sync.service.js';

/**
 * A realm user whose `org` attribute names no local organization is
 * skipped in both modes. When the install serves many organizations
 * nothing creates the org later, so the skip is logged as an error.
 */
function build(realm: KeycloakUserRep[]) {
  const prisma = {
    organization: { findMany: jest.fn(async () => [{ id: 'org-a', slug: 'acme' }]) },
    user: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const kc = {
    isConfigured: () => true,
    listServiceAccountUsernames: jest.fn(async () => new Set<string>()),
    listUsers: jest.fn(async ({ first }: { first: number }) => (first === 0 ? realm : [])),
  };
  return new KeycloakSyncService(
    prisma as unknown as PrismaService,
    kc as unknown as KeycloakAdminService,
    { invalidate: jest.fn() } as unknown as AuthSyncService,
  );
}

const ghost: KeycloakUserRep = {
  id: 'kc-ghost',
  username: 'ghost',
  enabled: true,
  attributes: { org: ['no-such-org'], org_role: ['viewer'] },
};

describe.each(['single', 'multi'] as const)('reconcileAll, unknown org (%s mode)', (mode) => {
  const saved = process.env.GRATIS_TENANCY;
  let errorSpy: jest.SpiedFunction<Logger['error']>;
  beforeEach(() => {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
  });

  it('skips the user, and logs an error only in multi mode', async () => {
    const res = await build([ghost]).reconcileAll();
    expect(res.skippedUnknownOrg).toBe(1);
    expect(res.inserted).toBe(0);
    if (mode === 'multi') {
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toContain('"no-such-org"');
    } else {
      expect(errorSpy).not.toHaveBeenCalled();
    }
  });
});
