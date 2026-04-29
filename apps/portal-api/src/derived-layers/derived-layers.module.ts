import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { DerivedLayersService } from './derived-layers.service.js';

/**
 * Derived layers live in their own module so the analysis surface
 * area (tools, generators, future tool-builder integration) gets a
 * clear home rather than crowding `items/`. The service is exported
 * so items.service can call it for validation on save and for read
 * routing on getGeoJson.
 *
 * The module imports only PrismaModule, NOT ItemsModule. The flow
 * is one-directional: items.service depends on derived-layers.service,
 * never the other way. Per-user authorization (can the caller read
 * the source data layer?) lives in items.service, which already
 * holds the SharingService.
 */
@Module({
  imports: [PrismaModule],
  providers: [DerivedLayersService],
  exports: [DerivedLayersService],
})
export class DerivedLayersModule {}
