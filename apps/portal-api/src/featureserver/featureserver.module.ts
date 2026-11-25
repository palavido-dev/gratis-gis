// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { FeatureOidService } from './feature-oid.service.js';

/**
 * The Esri FeatureServer interface, so ArcGIS Pro can read and edit
 * data layers. This first part only numbers features (ObjectIDs); the
 * routes come next.
 */
@Module({
  imports: [LeaderElectionModule],
  providers: [FeatureOidService],
  exports: [FeatureOidService],
})
export class FeatureServerModule {}
