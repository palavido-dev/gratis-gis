// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { AuthedOgcFeaturesController } from './authed-features.controller.js';

/**
 * The AUTHENTICATED OGC API surface (/api/ogc): Features over every
 * data layer the caller can read, so desktop clients can open
 * private and org layers as true feature layers with attribute
 * tables. The anonymous mirror stays in PublicModule; the shared
 * spec-shaped logic lives in public/ogc/features-core.ts.
 *
 * Depends on ItemsModule for ItemsService + SharingService (the one
 * true authorization pipeline) and DataLayerFeaturesModule for the
 * engine-backed reads, the same service the public surface uses.
 */
@Module({
  imports: [ItemsModule, DataLayerFeaturesModule],
  controllers: [AuthedOgcFeaturesController],
})
export class OgcModule {}
