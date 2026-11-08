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
 * operator organization is the oldest organization when
 * GRATIS_OPERATOR_ORG_ID is unset. A value that is not a UUID of
 * an organization that exists fails closed. It does not fall
 * back to the oldest organization.
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
  if (fromEnv) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromEnv)) {
      return null;
    }
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
