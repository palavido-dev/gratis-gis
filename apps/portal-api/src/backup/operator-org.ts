// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Install-wide backup is not an organization admin power. The
 * operator organization is GRATIS_OPERATOR_ORG_ID when that is set,
 * otherwise the oldest organization. A one-organization install is
 * unchanged. Admins of any later organization are not operators.
 * A set but malformed GRATIS_OPERATOR_ORG_ID fails closed: no
 * organization is the operator, and a warning is logged once.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const logger = new Logger('OperatorOrg');
let warnedInvalidEnv = false;

/** Test hook: lets a spec observe the once-only warning again. */
export function resetOperatorOrgWarningForTests(): void {
  warnedInvalidEnv = false;
}

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
    if (!UUID_RE.test(fromEnv)) {
      if (!warnedInvalidEnv) {
        warnedInvalidEnv = true;
        logger.warn(
          'GRATIS_OPERATOR_ORG_ID is set but is not a UUID; no organization is the operator.',
        );
      }
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
