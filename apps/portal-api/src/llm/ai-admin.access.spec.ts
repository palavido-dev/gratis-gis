// SPDX-License-Identifier: AGPL-3.0-or-later
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AiAdminController } from './ai-admin.controller.js';

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'acme',
    username: 'ada',
    email: 'ada@example.com',
    orgRole: 'viewer',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  };
}

function ctx(principal: AuthUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: principal }),
    }),
  } as unknown as ExecutionContext;
}

describe('AI admin access', () => {
  const guard = new AdminGuard();

  it('mounts AdminGuard on the settings controller', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AiAdminController) as unknown[];
    expect(guards).toContain(AdminGuard);
  });

  it.each(['viewer', 'contributor'] as const)(
    'refuses a %s',
    (orgRole) => {
      expect(() => guard.canActivate(ctx(user({ orgRole })))).toThrow(
        ForbiddenException,
      );
    },
  );

  it('refuses an API key even when the owner is an admin', () => {
    expect(() =>
      guard.canActivate(
        ctx(user({ orgRole: 'admin', authKind: 'api_key' })),
      ),
    ).toThrow(/API keys cannot be used on admin endpoints/);
  });

  it('allows an admin signed in through the portal', () => {
    expect(
      guard.canActivate(ctx(user({ orgRole: 'admin', authKind: 'jwt' }))),
    ).toBe(true);
  });
});
