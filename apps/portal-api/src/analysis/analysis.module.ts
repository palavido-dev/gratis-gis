// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisService } from './analysis.service.js';
import { SamController } from './sam.controller.js';

/**
 * Server-side analysis wiring (#184, workbench foundation). The
 * jobs themselves execute in the pointcloud-worker service; this
 * module only creates queue rows and serves job status. The SAM
 * controller adds the magic-outline embedding surface (ensure /
 * state / fetch) on the same job queue.
 */
@Module({
  imports: [ItemsModule, StorageModule],
  controllers: [AnalysisController, SamController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
