import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

import { MaintenanceModeService } from './maintenance-mode.service.js';

/**
 * Global middleware that returns 503 for every request while
 * maintenance mode is active, EXCEPT for the handful of routes the
 * admin needs in order to follow / recover the restore:
 *
 *   - /health            → load-balancer probes, stays 200
 *   - /api/admin/backup/restore/*   → status polling + overrides
 *   - /api/admin/backup/config      → lets the admin see the current
 *                                     ops config even mid-restore
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
      p === '/api/admin/backup/config'
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
