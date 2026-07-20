// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisService } from './analysis.service.js';

/**
 * Server-side analysis wiring (#184, workbench foundation). The
 * jobs themselves execute in the pointcloud-worker service; this
 * module only creates queue rows and serves job status.
 */
@Module({
  imports: [ItemsModule],
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
