// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ItemsModule } from '../items/items.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestStagingService } from './ingest-staging.service.js';
import { ResourceQuotaModule } from '../admin/resource-quota.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { IngestUploadService } from './ingest-upload.service.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ItemsModule,
    FeaturesModule,
    DataLayerFeaturesModule,
    DataLayerTablesModule,
    ResourceQuotaModule,
    StorageModule,
  ],
  providers: [IngestService, IngestStagingService, IngestUploadService],
  controllers: [IngestController],
  // Both IngestService (GDAL probe + stream) and IngestStagingService
  // (the /tmp/gg-staging/<id>/ store) are reused by ImportJobsModule
  // and ImportJobsController -- export them so DI can resolve through
  // the module boundary instead of constructing fresh instances.
  exports: [IngestService, IngestStagingService],
})
export class IngestModule {}
