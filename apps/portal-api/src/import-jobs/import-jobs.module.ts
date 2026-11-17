// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { ResourceQuotaModule } from '../admin/resource-quota.module.js';

import { ImportJobsService } from './import-jobs.service.js';
import { ImportJobsController } from './import-jobs.controller.js';

/**
 * Async import jobs HTTP surface (#115).
 *
 *   - the persistence + lifecycle service (ImportJobsService)
 *   - the HTTP surface (ImportJobsController)
 *
 * The actual worker process lives in ImportJobsWorkerModule and
 * runs in a separate `portal-worker` container (#115 P8 worker
 * split). Splitting them keeps CPU-bound import work from
 * starving the api's request thread when a county-scale ingest
 * is in flight, and lets the worker scale horizontally without
 * dragging the api with it.
 *
 * Imports IngestModule (for the GDAL streaming reader and the
 * staging service) so the controller can probe the staging file
 * at enqueue time to capture totalFeatures.
 */
@Module({
  imports: [
    PrismaModule,
    ItemsModule,
    IngestModule,
    DataLayerFeaturesModule,
    DataLayerTablesModule,
    ResourceQuotaModule,
  ],
  providers: [ImportJobsService],
  controllers: [ImportJobsController],
  exports: [ImportJobsService],
})
export class ImportJobsModule {}
