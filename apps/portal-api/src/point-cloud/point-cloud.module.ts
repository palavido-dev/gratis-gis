// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PointCloudController } from './point-cloud.controller.js';
import { PointCloudService } from './point-cloud.service.js';

/**
 * Point cloud wiring (#179). Mirrors TileLayerModule: ItemsModule
 * for the canonical item CRUD + ACL pipeline, StorageModule for
 * presigned uploads and ranged serving against MinIO.
 */
@Module({
  imports: [ItemsModule, StorageModule],
  controllers: [PointCloudController],
  providers: [PointCloudService],
  exports: [PointCloudService],
})
export class PointCloudModule {}
