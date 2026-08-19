// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PublicController } from './public.controller.js';
import { OgcLandingController } from './ogc/landing.controller.js';
import { OgcFeaturesController } from './ogc/features.controller.js';
import { OgcStylesController } from './ogc/styles.controller.js';
import { OgcTilesController } from './ogc/tiles.controller.js';
import { OgcRecordsController } from './ogc/records.controller.js';
import { PublicStacController } from './stac/stac.controller.js';
import { OgcProblemJsonFilter } from './ogc/problem-json.filter.js';
import { PublicCswController } from './public-csw.controller.js';
import { PublicProxyController } from './public-proxy.controller.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';

/**
 * Unauthenticated endpoints. Kept in its own module so the audit
 * trail of "what the internet can see" is easy to grep: a small set
 * of controllers, no business services beyond what the OGC surface
 * borrows from DataLayerFeaturesModule and what the public proxy borrows
 * from ItemsModule (CredentialService for upstream auth injection).
 *
 * OGC API controllers live under ogc/. Each conformance class is
 * its own controller per docs/ogc-api-strategy.md; new classes plug
 * in here without rewriting existing files. The OgcProblemJsonFilter
 * is registered as a global APP_FILTER but is scoped internally to
 * /api/public/ogc/* paths so other surfaces keep their existing
 * error envelope.
 */
@Module({
  imports: [DataLayerFeaturesModule, ItemsModule],
  controllers: [
    PublicController,
    OgcLandingController,
    OgcFeaturesController,
    OgcStylesController,
    OgcTilesController,
    OgcRecordsController,
    PublicStacController,
    PublicCswController,
    PublicProxyController,
  ],
  providers: [{ provide: APP_FILTER, useClass: OgcProblemJsonFilter }],
})
export class PublicModule {}
