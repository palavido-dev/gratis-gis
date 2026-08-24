// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';
import { CredentialService } from './credential.service.js';
import { ItemCredentialController } from './credential.controller.js';
import { ItemProxyController } from './item-proxy.controller.js';
import { ServiceProbeController } from './service-probe.controller.js';
import { EditorPolicyService } from './editor-policy.service.js';
import { WebMapJsonService } from './web-map-json.service.js';
import { WebMapJsonImportService } from './web-map-json-import.service.js';
import { ItemBboxRefreshService } from './item-bbox-refresh.service.js';
import { DrawingsController } from './drawings.controller.js';
import { DrawingsService } from './drawings.service.js';
import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DerivedLayersModule } from '../derived-layers/derived-layers.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { OfflinePackageCoreModule } from '../offline-package/offline-package-core.module.js';

@Module({
  imports: [
    DataLayerTablesModule,
    NotificationsModule,
    DerivedLayersModule,
    PolicyModule,
    // #115 P11: ItemsService.tearDownItemBackingStorage calls
    // storage.deleteObject when a file item is permanently
    // deleted. Without this import the constructor DI fails.
    StorageModule,
    // #74: ItemsService prunes offline_package rows when a
    // data_collection's areas are saved. The Prisma-only core
    // module avoids the ItemsModule <-> OfflinePackageModule cycle.
    OfflinePackageCoreModule,
  ],
  controllers: [
    ItemsController,
    ItemCredentialController,
    ItemProxyController,
    ServiceProbeController,
    DrawingsController,
    CommentsController,
  ],
  providers: [
    ItemsService,
    SharingService,
    DataSnapshotService,
    CredentialService,
    EditorPolicyService,
    WebMapJsonService,
    WebMapJsonImportService,
    ItemBboxRefreshService,
    DrawingsService,
    CommentsService,
  ],
  exports: [
    ItemsService,
    SharingService,
    DataSnapshotService,
    CredentialService,
    EditorPolicyService,
    WebMapJsonService,
    WebMapJsonImportService,
    ItemBboxRefreshService,
    DrawingsService,
    CommentsService,
  ],
})
export class ItemsModule {}
