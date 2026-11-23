// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ExpressionsModule } from '../expressions/expressions.module.js';
import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';

import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Report templates filled per feature and printed to PDF. */
@Module({
  imports: [ItemsModule, ExpressionsModule, DataLayerFeaturesModule, StorageModule],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
