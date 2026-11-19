// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ItemsModule } from '../items/items.module.js';
import { TrashPurgeService } from './trash-purge.service.js';
import { SnapshotPurgeService } from './snapshot-purge.service.js';
import { PartitionRunwayService } from './partition-runway.service.js';

/**
 * Home for scheduled maintenance work (trash purge, snapshot prune;
 * more later, e.g. thumbnail garbage collection, storage
 * reconciliation).
 */
@Module({
  imports: [ScheduleModule.forRoot(), ItemsModule],
  providers: [TrashPurgeService, SnapshotPurgeService, PartitionRunwayService],
})
export class MaintenanceModule {}
