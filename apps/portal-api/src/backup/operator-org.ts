// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { isMultiTenant } from '../common/tenancy.js';
import { runAsSystem } from '../common/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Install-wide powers (backup, maintenance, realm security and SMTP,
 * housekeeping schedule, feedback triage and the like) are not
 * organization admin powers. The
 * operator organization is GRATIS_OPERATOR_ORG_ID when that is set,
 * otherwise the oldest organization. A one-organization install is
 * unchanged. Admins of any later organization are not operators.
 * A set but malformed GRATIS_OPERATOR_ORG_ID fails closed: no
 * organization is the operator, and a warning is logged once.
 * `none` says the same thing on purpose, with no warning: for an
 * install whose admin login is shared, such as a public demo, where
 * nobody signing in should hold install-wide powers.
 *
 * When the install serves many organizations (GRATIS_TENANCY=multi)
 * there is no "oldest organization" fallback: GRATIS_OPERATOR_ORG_ID
 * must name the operator, and unset means nobody is the operator.
 * The API logs an error at boot when it is unset
 * (checkOperatorOrgConfig).
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
    if (fromEnv.toLowerCase() === 'none') return null;
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
  if (isMultiTenant()) return null;
  const oldest = await prisma.organization.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/**
 * Boot check for multi mode: without GRATIS_OPERATOR_ORG_ID nobody
 * holds install-wide powers, which is safe but almost certainly not
 * what the operator meant, so say it loudly. Returns false when the
 * setting is missing. Single mode needs no setting and logs nothing.
 */
export function checkOperatorOrgConfig(log: Pick<Logger, 'error'>): boolean {
  if (!isMultiTenant()) return true;
  if (process.env.GRATIS_OPERATOR_ORG_ID?.trim()) return true;
  log.error(
    'GRATIS_OPERATOR_ORG_ID is not set. This install serves many organizations, so it must name the operator organization; until it does, no organization holds install-wide powers (backup, maintenance, sign-in settings, housekeeping).',
  );
  return false;
}

/**
 * Marks a route under OperatorOrgGuard whose setting belongs to each
 * organization once the install serves many. In multi mode the guard
 * lets any caller through on such a route (the admin check beside it
 * still applies) and the route acts on the caller's own org. In
 * single mode the mark does nothing.
 */
export const ORG_SCOPED_WHEN_MULTI = 'gratis:org-scoped-when-multi-tenant';

export const OrgScopedWhenMultiTenant = (): MethodDecorator =>
  SetMetadata(ORG_SCOPED_WHEN_MULTI, true);

// Read without injecting Reflector, so the guard keeps its one
// dependency and every module that provides it stays unchanged.
const reflector = new Reflector();

function isOrgScopedWhenMulti(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    reflector.get<boolean | undefined>(ORG_SCOPED_WHEN_MULTI, handler) === true
  );
}

@Injectable()
export class OperatorOrgGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isMultiTenant() && isOrgScopedWhenMulti(context.getHandler?.())) {
      return true;
    }
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    // Guards run before the tenant context is set for the request,
    // and this read is about the install, not about any one org.
    const orgId = await runAsSystem('operator-check', () => operatorOrgId(this.prisma));
    if (!user || !orgId || user.orgId !== orgId) {
      throw new ForbiddenException(
        'This action is limited to admins of the operator organization.',
      );
    }
    return true;
  }
}
