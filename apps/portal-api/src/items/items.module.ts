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
import { V3TablesModule } from '../features-v3/v3-tables.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [V3TablesModule, NotificationsModule],
  controllers: [
    ItemsController,
    ItemCredentialController,
    ItemProxyController,
    ServiceProbeController,
  ],
  providers: [
    ItemsService,
    SharingService,
    DataSnapshotService,
    CredentialService,
    EditorPolicyService,
  ],
  exports: [
    ItemsService,
    SharingService,
    DataSnapshotService,
    CredentialService,
    EditorPolicyService,
  ],
})
export class ItemsModule {}
