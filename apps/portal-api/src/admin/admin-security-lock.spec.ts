// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminSecurityController } from './admin-security.controller.js';

/**
 * In public-testing mode the admin login is shared, so it must not
 * add or remove sign-in providers or flip the realm-wide MFA rule.
 */
describe('AdminSecurityController in public-testing mode', () => {
  const env = process.env.PORTAL_LOCK_ADMIN_TIER;
  const kc = {
    createOidcProvider: jest.fn(),
    deleteIdentityProvider: jest.fn(),
    setMfaRequired: jest.fn(),
  };
  const ctrl = new AdminSecurityController(kc as never);
  const user = { id: 'a', orgId: 'o', orgSlug: 'o' } as unknown as AuthUser;

  beforeEach(() => {
    process.env.PORTAL_LOCK_ADMIN_TIER = 'true';
  });
  afterEach(() => {
    if (env === undefined) delete process.env.PORTAL_LOCK_ADMIN_TIER;
    else process.env.PORTAL_LOCK_ADMIN_TIER = env;
  });

  it('refuses every change', async () => {
    await expect(
      ctrl.create(user, {
        alias: 'idp',
        displayName: 'IdP',
        clientId: 'c',
        clientSecret: 's',
        authorizationUrl: 'https://login.example.com/a',
        tokenUrl: 'https://login.example.com/t',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.remove(user, 'idp')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.mfa(user, { required: true } as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(kc.createOidcProvider).not.toHaveBeenCalled();
    expect(kc.deleteIdentityProvider).not.toHaveBeenCalled();
    expect(kc.setMfaRequired).not.toHaveBeenCalled();
  });
});
