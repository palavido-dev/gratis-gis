// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesService } from './features.service.js';
import { DataLayerFeaturesController } from './features.controller.js';
import { DataLayerAttachmentsService } from './attachments.service.js';
import { DataLayerAttachmentsController } from './attachments.controller.js';
import { DataLayerLayerAttachmentsController } from './layer-attachments.controller.js';
import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DerivedLayersModule } from '../derived-layers/derived-layers.module.js';
import { EngineModule } from '../engine/engine.module.js';

/**
 * Data-layer feature CRUD + attachments. Depends on ItemsModule
 * (auth / gate checks), StorageModule (attachment cleanup on
 * delete), DerivedLayersModule (lazy-grow staleness hook for
 * buffer-by-field caches), and EngineModule (the observation log
 * + DataLayerEngine adapter every read and write goes through
 * post-Phase-2.2).
 */
@Module({
  imports: [
    ItemsModule,
    StorageModule,
    NotificationsModule,
    DerivedLayersModule,
    EngineModule,
  ],
  providers: [DataLayerFeaturesService, DataLayerAttachmentsService],
  controllers: [
    DataLayerFeaturesController,
    DataLayerAttachmentsController,
    DataLayerLayerAttachmentsController,
  ],
  exports: [DataLayerFeaturesService, DataLayerAttachmentsService],
})
export class DataLayerFeaturesModule {}
