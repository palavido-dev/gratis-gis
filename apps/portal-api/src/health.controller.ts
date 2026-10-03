// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from './auth/public.decorator.js';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * Load-balancer probe. The database is the check that can fail:
 * a process that is up while Postgres is down is not ready to
 * serve the portal. Keycloak, MinIO, and Caddy are separate
 * containers; `infra/doctor.sh` is the host-level look at those.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    let database: 'ok' | 'down' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    const ok = database === 'ok';
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      checks: { database },
      ts: new Date().toISOString(),
    };
  }
}
