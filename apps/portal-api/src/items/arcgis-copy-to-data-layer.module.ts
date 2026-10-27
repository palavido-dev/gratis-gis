// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ImportAgoModule } from '../import-ago/import-ago.module.js';
import { ArcgisCopyToDataLayerController } from './arcgis-copy-to-data-layer.controller.js';
import { ArcgisCopyToDataLayerService } from './arcgis-copy-to-data-layer.service.js';
import { ItemsModule } from './items.module.js';

/**
 * Item-scoped ArcGIS FeatureServer → data_layer copy.
 * Kept outside ItemsModule to import ImportAgoModule (hosted-fs)
 * without cycling Items ↔ DataLayerFeatures.
 */
@Module({
  imports: [ItemsModule, ImportAgoModule],
  controllers: [ArcgisCopyToDataLayerController],
  providers: [ArcgisCopyToDataLayerService],
})
export class ArcgisCopyToDataLayerModule {}
