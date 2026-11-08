// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Install-wide backup is not an organization admin power. The
 * operator organization is GRATIS_OPERATOR_ORG_ID when that is a
 * UUID, otherwise the oldest organization. A one-organization
 * install is unchanged. Admins of any later organization are not
 * operators.
 */
export async function operatorOrgId(prisma: {
  organization: {
    findFirst: (args: {
      where?: { id: string };
      orderBy?: { createdAt: 'asc' };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
}): Promise<string | null> {
  const fromEnv = process.env.GRATIS_OPERATOR_ORG_ID?.trim();
  if (fromEnv && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromEnv)) {
    const row = await prisma.organization.findFirst({
      where: { id: fromEnv },
      select: { id: true },
    });
    return row?.id ?? null;
  }
  const oldest = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

@Injectable()
export class OperatorOrgGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    const orgId = await operatorOrgId(this.prisma);
    if (!user || !orgId || user.orgId !== orgId) {
      throw new ForbiddenException(
        'Install backup is limited to admins of the operator organization.',
      );
    }
    return true;
  }
}
