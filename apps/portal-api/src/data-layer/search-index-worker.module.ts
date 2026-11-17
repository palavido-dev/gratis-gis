// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { DataLayerTablesModule } from './tables.module.js';
import { SearchIndexWorker } from './search-index.worker.js';

/**
 * Worker-only module that runs queued "Build search indexes" requests
 * (06-5). Kept out of the API graph so each API replica does not start
 * its own poll loop.
 */
@Module({
  imports: [PrismaModule, DataLayerTablesModule],
  providers: [SearchIndexWorker],
})
export class SearchIndexWorkerModule {}
