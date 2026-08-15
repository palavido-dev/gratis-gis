// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { EngineModule } from '../engine/engine.module.js';
import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { CogTileService } from './cog-tiles.service.js';
import { ElevationMosaicController } from './elevation-mosaic.controller.js';
import { ElevationMosaicService } from './elevation-mosaic.service.js';
import { TileLayerController } from './tile-layer.controller.js';
import { TileLayerService } from './tile-layer.service.js';

/**
 * Tile layer wiring (#179). Depends on ItemsModule for the
 * canonical item CRUD + ACL pipeline, StorageModule for presigned
 * uploads / cleanup deletes against MinIO, and EngineModule for
 * the shared tile cache behind the elevation mosaic (#211).
 *
 * Exports the service so ItemsService can wire it into the
 * cross-storage cleanup path that runs on item purge.
 */
@Module({
  imports: [ItemsModule, StorageModule, EngineModule],
  controllers: [TileLayerController, ElevationMosaicController],
  providers: [TileLayerService, ElevationMosaicService, CogTileService],
  exports: [TileLayerService],
})
export class TileLayerModule {}
