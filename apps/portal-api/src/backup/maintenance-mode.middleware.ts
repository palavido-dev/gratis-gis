// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

import { MaintenanceModeService } from './maintenance-mode.service.js';

/**
 * The routes an admin needs to re-run a restore after a failed one:
 * the run list (GET), the archive preview (GET) and the restore
 * itself (POST). A failed restore keeps maintenance on until a
 * restore finishes, and its message says to re-run one, so these
 * must get through. Starting a backup (POST /runs) stays blocked.
 * The controller decides whether a restore may start right now.
 */
export function isRestoreRoute(method: string, p: string): boolean {
  if (method === 'GET' && p === '/api/admin/backup/runs') return true;
  if (method === 'GET' && /^\/api\/admin\/backup\/runs\/[^/]+\/restore\/preview$/.test(p)) {
    return true;
  }
  return method === 'POST' && /^\/api\/admin\/backup\/runs\/[^/]+\/restore$/.test(p);
}

/**
 * Global middleware that returns 503 for every request while
 * maintenance mode is active, EXCEPT for the handful of routes the
 * admin needs in order to follow / recover the restore:
 *
 *   - /health            → load-balancer probes, stays 200
 *   - /api/admin/backup/restore/*   → status polling + overrides
 *   - /api/admin/backup/config      → lets the admin see the current
 *                                     ops config even mid-restore
 *   - the run list, the restore preview and the restore itself, so a
 *     failed restore can be re-run (see isRestoreRoute)
 *
 * The short whitelist is intentional. Anything that could write to
 * the database during a restore needs to stay blocked.
 */
@Injectable()
export class MaintenanceModeMiddleware implements NestMiddleware {
  constructor(private readonly mode: MaintenanceModeService) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (!this.mode.isActive()) return next();
    const p = req.originalUrl.split('?')[0] ?? '';
    if (
      p === '/health' ||
      p.startsWith('/api/admin/backup/restore') ||
      p === '/api/admin/backup/config' ||
      p === '/api/admin/maintenance' ||
      p.startsWith('/api/admin/maintenance/') ||
      isRestoreRoute(req.method, p)
    ) {
      return next();
    }
    const snap = this.mode.snapshot();
    res.status(503).json({
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        "The portal is temporarily unavailable while an admin is restoring a backup. This usually takes a minute or two: please try again shortly.",
      reason: snap.reason,
      startedAt: snap.startedAt,
    });
  }
}
