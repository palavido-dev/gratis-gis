// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { SamplesService } from './samples.service.js';
import { SamplesController } from './samples.controller.js';

/**
 * Per-org sample content seeding (#147 Phase 1). Deliberately built
 * on the same services user actions go through (ItemsModule for item
 * creation and access changes, DataLayerFeaturesModule for feature
 * writes, FormsModule for submissions) so seeded content is
 * indistinguishable from hand-made content everywhere downstream.
 */
@Module({
  imports: [PrismaModule, ItemsModule, FormsModule, DataLayerFeaturesModule],
  controllers: [SamplesController],
  providers: [SamplesService],
  exports: [SamplesService],
})
export class SamplesModule {}
