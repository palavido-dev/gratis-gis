// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AreaOfInterestModule } from '../area-of-interest/area-of-interest.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { WhatsHereController } from './whats-here.controller.js';
import { WhatsHereReportService } from './whats-here-report.service.js';

/** What's Here reports (#796). Areas live in AreaOfInterestModule. */
@Module({
  imports: [AreaOfInterestModule, DataLayerFeaturesModule, ItemsModule, ReportsModule],
  controllers: [WhatsHereController],
  providers: [WhatsHereReportService],
})
export class WhatsHereModule {}
