import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { DerivedLayersModule } from '../derived-layers/derived-layers.module.js';
import { FeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';
import { RelationshipsController } from './relationships.controller.js';

@Module({
  imports: [ItemsModule, DerivedLayersModule],
  providers: [FeaturesService],
  controllers: [FeaturesController, RelationshipsController],
  exports: [FeaturesService],
})
export class FeaturesModule {}
