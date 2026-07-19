// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminAppTemplatesController } from './admin-app-templates.controller.js';
import { AdminThemesController } from './admin-themes.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminBasemapProbeController } from './admin-basemap-probe.controller.js';
import { AdminBrandingController } from './admin-branding.controller.js';
import { AdminCapabilitiesController } from './admin-capabilities.controller.js';
import { AdminIntegrationsController } from './admin-integrations.controller.js';
import { AdminGuard } from './admin.guard.js';
import { HousekeepingController } from './housekeeping.controller.js';
import { HousekeepingService } from './housekeeping.service.js';
import { HousekeepingScheduleService } from './housekeeping-schedule.service.js';
import { HousekeepingCronService } from './housekeeping-cron.service.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { KeycloakSyncService } from './keycloak-sync.service.js';
import { AdminOnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { ItemsModule } from '../items/items.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationsAdminController } from '../notifications/admin.controller.js';
import { StorageModule } from '../storage/storage.module.js';
import { FieldQueueModule } from '../field-queue/field-queue.module.js';
import { FieldQueueAdminController } from '../field-queue/field-queue-admin.controller.js';

/**
 * Wires the admin surfaces: Keycloak integration (users +
 * branding) plus the housekeeping analytics dashboard. All
 * controllers under /admin/* are gated by AdminGuard
 * (instance-scoped via @UseGuards).
 *
 * KeycloakAdminService is safe to instantiate even when the admin
 * credentials aren't configured: it throws a descriptive 503 on
 * first call instead of crashing app bootstrap. That keeps the
 * base portal running for operators who haven't enabled user
 * management yet.
 */
@Module({
  imports: [
    DataLayerTablesModule,
    ItemsModule,
    NotificationsModule,
    StorageModule,
    FieldQueueModule,
  ],
  controllers: [
    AdminAppTemplatesController,
    AdminThemesController,
    AdminUsersController,
    AdminBasemapProbeController,
    AdminBrandingController,
    AdminCapabilitiesController,
    AdminIntegrationsController,
    AdminOnboardingController,
    HousekeepingController,
    NotificationsAdminController,
    FieldQueueAdminController,
  ],
  providers: [
    KeycloakAdminService,
    KeycloakSyncService,
    AdminGuard,
    HousekeepingService,
    HousekeepingScheduleService,
    HousekeepingCronService,
    OnboardingService,
  ],
  exports: [KeycloakAdminService, KeycloakSyncService],
})
export class AdminModule {}
