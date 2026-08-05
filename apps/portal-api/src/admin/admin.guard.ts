// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Gatekeeper for /admin/* routes.
 *
 * JwtAuthGuard runs first (global), so by the time this guard sees the
 * request, `req.user` is the AuthUser populated from the JWT + local
 * DB. We require that user to carry orgRole === 'admin'. Anything else
 * short-circuits with a 403 so non-admins never learn whether a
 * particular resource exists.
 *
 * #219: API keys are refused here outright, whatever role they carry.
 * This guard checks the ROLE, so without the extra gate an admin's
 * leaked key would hand an attacker user management, branding, and
 * backup/restore. Machine automation wants data endpoints, not the
 * admin console, so the safe default costs nothing real and stays
 * reversible: a future per-key "allow admin" flag would slot in here.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user || user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Admin role required for this operation.',
      );
    }
    if (user.authKind === 'api_key') {
      throw new ForbiddenException(
        'API keys cannot be used on admin endpoints. Sign in to the portal for admin operations.',
      );
    }
    return true;
  }
}
