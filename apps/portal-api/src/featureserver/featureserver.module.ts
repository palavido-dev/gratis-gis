// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { ItemsModule } from '../items/items.module.js';
import { FeatureOidService } from './feature-oid.service.js';
import { FeatureServerAccessService } from './featureserver-access.service.js';
import { FeatureServerController } from './featureserver.controller.js';
import { FeatureServerQueryService } from './featureserver-query.service.js';

/**
 * The Esri FeatureServer interface, so ArcGIS Pro and QGIS can open a
 * data layer as a feature layer. Reads only for now; sign-in and edits
 * come next.
 */
@Module({
  imports: [LeaderElectionModule, ItemsModule],
  controllers: [FeatureServerController],
  providers: [FeatureOidService, FeatureServerAccessService, FeatureServerQueryService],
  exports: [FeatureOidService],
})
export class FeatureServerModule {}
