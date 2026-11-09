// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { EngineModule } from '../engine/engine.module.js';
import { TileCacheService } from '../engine/tile-cache.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DB_POOL_STATS,
  MetricsService,
  TILE_CACHE_STATS,
} from './metrics.service.js';

/**
 * Prometheus metrics for portal-api. Providing the service costs
 * nothing; installMetrics() in main.ts turns it on only when
 * METRICS_TOKEN is set. See docs/operations/metrics.md.
 */
@Module({
  imports: [EngineModule],
  providers: [
    MetricsService,
    { provide: TILE_CACHE_STATS, useExisting: TileCacheService },
    { provide: DB_POOL_STATS, useExisting: PrismaService },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
