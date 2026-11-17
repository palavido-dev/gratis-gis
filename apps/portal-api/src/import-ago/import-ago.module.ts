// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';

import { AgoConnectionsService } from './connections.service.js';
import { AgoDryRunService } from './dry-run.js';
import { AgoHostedFsImportService } from './hosted-fs.js';
import { AgoImportService } from './import.js';
import { AgoImportJobsService } from './jobs.service.js';
import { ImportAgoController } from './import-ago.controller.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';

/**
 * Wires the AGO migration importer. Depends on:
 *
 *   - ``ItemsModule`` for ``ItemsService`` (per-type item
 *     creation) and ``WebMapJsonImportService`` (Web Map
 *     conversion).
 *   - ``AdminModule`` for the ``AdminGuard`` the controller
 *     enforces.
 *   - ``PrismaModule`` for the AgoConnectionsService that owns
 *     the per-portal client_id table.
 */
@Module({
  imports: [
    ItemsModule,
    AdminModule,
    PrismaModule,
    DataLayerFeaturesModule,
    StorageModule,
  ],
  controllers: [ImportAgoController],
  providers: [
    OperatorOrgGuard,
    AgoConnectionsService,
    AgoDryRunService,
    AgoHostedFsImportService,
    AgoImportService,
    AgoImportJobsService,
  ],
  exports: [
    AgoConnectionsService,
    AgoDryRunService,
    AgoHostedFsImportService,
    AgoImportService,
    AgoImportJobsService,
  ],
})
export class ImportAgoModule {}
