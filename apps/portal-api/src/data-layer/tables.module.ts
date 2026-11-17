// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerTablesService } from './tables.service.js';
import { DataLayerSearchIndexService } from './search-index.service.js';
import { SearchIndexJobsService } from './search-index-jobs.service.js';

/**
 * Dependency-free (besides PrismaService) module that provides the
 * read-only data-layer helpers (bbox aggregate, last activity,
 * count, truncate) plus the search-index reconciler. ItemsModule
 * imports this so housekeeping and the data_layer detail surface
 * can stay independent of the full feature CRUD module. The search
 * index build queue lives here too, shared by the API (which queues)
 * and the worker (which builds).
 */
@Module({
  providers: [
    DataLayerTablesService,
    DataLayerSearchIndexService,
    SearchIndexJobsService,
  ],
  exports: [
    DataLayerTablesService,
    DataLayerSearchIndexService,
    SearchIndexJobsService,
  ],
})
export class DataLayerTablesModule {}
