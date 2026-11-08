// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, Logger } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  OperatorOrgGuard,
  operatorOrgId,
  resetOperatorOrgWarningForTests,
} from './operator-org.js';

const user = {
  id: 'admin-2',
  orgId: 'org-later',
  orgSlug: 'later',
  username: 'bee',
  email: 'bee@example.com',
  orgRole: 'admin',
  groupIds: [],
  capabilities: new Set(),
} as AuthUser;

describe('operator organization', () => {
  it('uses the oldest organization when no operator id is set', async () => {
    delete process.env.GRATIS_OPERATOR_ORG_ID;
    const prisma = {
      organization: {
        findFirst: async (args: { where?: { id: string } }) => {
          if (args.where) return null;
          return { id: 'org-first' };
        },
      },
    };
    await expect(operatorOrgId(prisma)).resolves.toBe('org-first');
  });

  it('fails closed and warns once when the operator id is not a UUID', async () => {
    process.env.GRATIS_OPERATOR_ORG_ID = 'not-a-uuid';
    resetOperatorOrgWarningForTests();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const calls: unknown[] = [];
    const prisma = {
      organization: {
        findFirst: async (args: unknown) => {
          calls.push(args);
          return { id: 'org-first' };
        },
      },
    };
    try {
      await expect(operatorOrgId(prisma)).resolves.toBeNull();
      await expect(operatorOrgId(prisma)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      delete process.env.GRATIS_OPERATOR_ORG_ID;
    }
  });

  it('refuses an admin from a later organization', async () => {
    delete process.env.GRATIS_OPERATOR_ORG_ID;
    const prisma = {
      organization: {
        findFirst: async () => ({ id: 'org-first' }),
      },
    } as unknown as PrismaService;
    const guard = new OperatorOrgGuard(prisma);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    };
    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
