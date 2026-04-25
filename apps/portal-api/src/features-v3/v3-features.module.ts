import { Module } from '@nestjs/common';

import { V3FeaturesService } from './v3-features.service.js';
import { V3FeaturesController } from './v3-features.controller.js';
import { V3AttachmentsService } from './v3-attachments.service.js';
import { V3AttachmentsController } from './v3-attachments.controller.js';
import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';

/**
 * v3 feature CRUD + attachments. Depends on ItemsModule (auth / gate
 * checks) and StorageModule (attachment cleanup on delete). Does NOT
 * depend on V3TablesModule: tables are provisioned upstream by
 * ItemsService; this module just reads / writes rows and attachment
 * metadata against whatever's already there.
 */
@Module({
  imports: [ItemsModule, StorageModule],
  providers: [V3FeaturesService, V3AttachmentsService],
  controllers: [V3FeaturesController, V3AttachmentsController],
  exports: [V3FeaturesService, V3AttachmentsService],
})
export class V3FeaturesModule {}
