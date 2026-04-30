import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { DerivedLayersService } from './derived-layers.service.js';
import { DerivedLayerCacheRefreshService } from './cache-refresh.service.js';

/**
 * Derived layers live in their own module so the analysis surface
 * area (tools, generators, future tool-builder integration) gets a
 * clear home rather than crowding `items/`. The services are exported
 * so:
 *   - items.service can call DerivedLayersService for validation on
 *     save and read routing on getGeoJson.
 *   - features-v3 / features modules can call
 *     DerivedLayerCacheRefreshService.notifySourceWrite from their
 *     write paths so a feature edit that exceeds the cached
 *     buffer-by-field cap grows the cap lazily.
 *
 * The module imports only PrismaModule, NOT ItemsModule or any of
 * the features modules. The flow is one-directional: items.service
 * and the features modules depend on us, never the other way.
 * Per-user authorization (can the caller read the source data
 * layer?) lives in items.service, which already holds SharingService.
 */
@Module({
  imports: [PrismaModule],
  providers: [DerivedLayersService, DerivedLayerCacheRefreshService],
  exports: [DerivedLayersService, DerivedLayerCacheRefreshService],
})
export class DerivedLayersModule {}
