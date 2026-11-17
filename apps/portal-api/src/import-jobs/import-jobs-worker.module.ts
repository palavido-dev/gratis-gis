// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { ResourceQuotaModule } from '../admin/resource-quota.module.js';

import { ImportJobsService } from './import-jobs.service.js';
import { ImportJobsWorker } from './import-jobs.worker.js';

/**
 * Worker-only side of async import jobs (#115 P8).
 *
 * The worker runs in its own `portal-worker` container so the
 * api's request thread isn't starved by CPU-bound import work.
 * Both processes connect to the same Postgres, share a staging
 * volume (gg-staging), and use SELECT FOR UPDATE SKIP LOCKED in
 * ImportJobsService.claimNext() to make N>1 workers safe without
 * coordination.
 *
 * Imports the same dependency modules as ImportJobsModule (the
 * HTTP-surface module). The two are mutually exclusive: the api
 * loads ImportJobsModule (controller + service, no worker), the
 * worker loads ImportJobsWorkerModule (worker + service, no
 * controller).
 */
@Module({
  imports: [
    PrismaModule,
    ItemsModule,
    IngestModule,
    DataLayerFeaturesModule,
    DataLayerTablesModule,
    // ImportJobsService takes ResourceQuotaService as @Optional(). Without
    // this import it resolved to undefined here, so the worker never
    // released an import's byte hold when the import finished.
    ResourceQuotaModule,
  ],
  providers: [ImportJobsService, ImportJobsWorker],
  exports: [ImportJobsService],
})
export class ImportJobsWorkerModule {}
