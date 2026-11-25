// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { FeatureOidService } from './feature-oid.service.js';
import { FeatureServerAccessService } from './featureserver-access.service.js';
import { FeatureServerController } from './featureserver.controller.js';
import { FeatureServerEditService } from './featureserver-edit.service.js';
import { FeatureServerQueryService } from './featureserver-query.service.js';
import { FeatureServerTokensController } from './featureserver-tokens.controller.js';

/**
 * The Esri FeatureServer interface, so ArcGIS Pro and QGIS can open
 * and edit a data layer as a feature layer, signing in with a token
 * made from a personal API key.
 */
@Module({
  imports: [LeaderElectionModule, ItemsModule, DataLayerFeaturesModule, AuthModule],
  controllers: [FeatureServerController, FeatureServerTokensController],
  providers: [FeatureOidService, FeatureServerAccessService, FeatureServerQueryService, FeatureServerEditService],
  exports: [FeatureOidService],
})
export class FeatureServerModule {}
