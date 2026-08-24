// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { OfflinePackageCoreModule } from './offline-package-core.module.js';
import { OfflinePackageController } from './offline-package.controller.js';

/**
 * API side of offline basemap packages (#70): list areas, queue a
 * build, stream a built archive.
 *
 * The build loop itself lives in OfflinePackageWorkerModule, which
 * only the worker container loads. Splitting them keeps the poll
 * loop out of the api's two replicas, where it would claim work
 * twice over.
 */
@Module({
  imports: [ItemsModule, StorageModule, OfflinePackageCoreModule],
  controllers: [OfflinePackageController],
})
export class OfflinePackageModule {}
