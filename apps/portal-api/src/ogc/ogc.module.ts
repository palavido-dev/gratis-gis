// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { AuthedOgcFeaturesController } from './authed-features.controller.js';
import { AuthedStacController } from './authed-stac.controller.js';

/**
 * The AUTHENTICATED standards surfaces: OGC API Features (/api/ogc)
 * over every data layer the caller can read, and STAC (/api/stac)
 * over every raster the caller can read, so desktop clients can open
 * private and org content with the same key that already draws it.
 * The anonymous mirrors stay in PublicModule; the shared spec-shaped
 * logic lives in public/ogc/features-core.ts and
 * public/stac/stac-core.ts.
 *
 * Depends on ItemsModule for ItemsService + SharingService (the one
 * true authorization pipeline) and DataLayerFeaturesModule for the
 * engine-backed reads, the same service the public surface uses.
 */
@Module({
  imports: [ItemsModule, DataLayerFeaturesModule],
  controllers: [AuthedOgcFeaturesController, AuthedStacController],
})
export class OgcModule {}
