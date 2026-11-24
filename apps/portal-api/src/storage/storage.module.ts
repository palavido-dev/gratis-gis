// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module, forwardRef } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { EngineModule } from '../engine/engine.module.js';
import { StorageController } from './storage.controller.js';
import { StorageUsageController } from './storage-usage.controller.js';
import { StorageService } from './storage.service.js';
import { StorageLedgerService } from './storage-ledger.service.js';
import { StorageUsageReconcileService } from './storage-usage-reconcile.service.js';

@Module({
  // ItemsModule exports ItemsService + SharingService + PrismaService
  // (or at least the first two; PrismaService is global anyway).
  // forwardRef avoids the circular-init issue if a future Items submodule
  // imports StorageModule.
  imports: [forwardRef(() => ItemsModule), EngineModule],
  providers: [StorageService, StorageLedgerService, StorageUsageReconcileService],
  controllers: [StorageController, StorageUsageController],
  exports: [StorageService, StorageLedgerService, StorageUsageReconcileService],
})
export class StorageModule {}
