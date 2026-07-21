// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { ImportJobsWorkerModule } from '../import-jobs/import-jobs-worker.module.js';

import { AnalysisBridgeWorker } from './analysis-bridge.worker.js';

/**
 * Worker-side module for the analysis-to-import bridge. Loaded by
 * worker.main.ts only; the api process never runs the poller.
 * Reuses ImportJobsWorkerModule's exported ImportJobsService so
 * bridge-enqueued jobs land in the exact queue the import worker
 * in this same process drains.
 */
@Module({
  imports: [PrismaModule, StorageModule, IngestModule, ImportJobsWorkerModule],
  providers: [AnalysisBridgeWorker],
})
export class AnalysisBridgeModule {}
