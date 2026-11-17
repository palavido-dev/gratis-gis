// SPDX-License-Identifier: AGPL-3.0-or-later
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AiAdminController } from './ai-admin.controller.js';
import { AiConfigService } from './ai-config.service.js';
import { isAiConfigLocked } from './ai-env.js';

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

describe('AI admin config lock', () => {
  const keys = ['PORTAL_LOCK_ADMIN_TIER', 'PORTAL_LOCK_AI_CONFIG'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses save and clear when public-testing locks AI config', async () => {
    process.env.PORTAL_LOCK_ADMIN_TIER = 'true';
    expect(isAiConfigLocked()).toBe(true);
    const config = {
      save: jest.fn(),
      clear: jest.fn(),
      getPublic: jest.fn(),
    };
    const controller = new AiAdminController(
      config as unknown as AiConfigService,
    );
    // assertAiConfigWritable throws before save returns a Promise, so
    // wrap in an async function for .rejects.
    await expect(async () =>
      controller.save(user({ orgRole: 'admin', authKind: 'jwt' }), {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(async () =>
      controller.clear(user({ orgRole: 'admin', authKind: 'jwt' })),
    ).rejects.toMatchObject({ status: 403 });
    expect(config.save).not.toHaveBeenCalled();
    expect(config.clear).not.toHaveBeenCalled();
  });
});
