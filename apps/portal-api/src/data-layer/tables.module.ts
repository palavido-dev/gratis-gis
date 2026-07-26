// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerTablesService } from './tables.service.js';
import { DataLayerSearchIndexService } from './search-index.service.js';

/**
 * Dependency-free (besides PrismaService) module that provides the
 * read-only data-layer helpers (bbox aggregate, last activity,
 * count, truncate) plus the search-index reconciler. ItemsModule
 * imports this so housekeeping and the data_layer detail surface
 * can stay independent of the full feature CRUD module.
 */
@Module({
  providers: [DataLayerTablesService, DataLayerSearchIndexService],
  exports: [DataLayerTablesService, DataLayerSearchIndexService],
})
export class DataLayerTablesModule {}
