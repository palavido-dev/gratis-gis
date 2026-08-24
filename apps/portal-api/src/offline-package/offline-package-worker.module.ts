// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { OfflinePackageService } from './offline-package.service.js';
import { OfflinePackageWorker } from './offline-package.worker.js';

/**
 * Worker-only side of offline basemap packages (#70).
 *
 * Separate from OfflinePackageModule, which carries the controller,
 * so the worker container can build packages without loading the
 * API's HTTP and auth graph, and so the api container does not start
 * a second poll loop per replica. Prod runs api at two replicas; the
 * worker at one.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [OfflinePackageService, OfflinePackageWorker],
  exports: [OfflinePackageService],
})
export class OfflinePackageWorkerModule {}
