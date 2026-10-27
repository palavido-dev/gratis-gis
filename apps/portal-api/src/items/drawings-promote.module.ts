// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from './items.module.js';
import { DrawingsPromoteController } from './drawings-promote.controller.js';
import { DrawingsPromoteService } from './drawings-promote.service.js';

/**
 * Wires the drawings Phase 1.5 "Promote to data layer" path.
 *
 * Kept outside ItemsModule for the same reason OsmModule owns
 * save-as-layer: DataLayerFeaturesModule already imports
 * ItemsModule, so putting the promote service inside ItemsModule
 * would create a cycle. DrawingsService is exported from
 * ItemsModule for the permission check.
 */
@Module({
  imports: [ItemsModule, DataLayerFeaturesModule],
  controllers: [DrawingsPromoteController],
  providers: [DrawingsPromoteService],
})
export class DrawingsPromoteModule {}
