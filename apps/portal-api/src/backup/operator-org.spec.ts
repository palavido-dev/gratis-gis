// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { OperatorOrgGuard, operatorOrgId } from './operator-org.js';

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
