import { Module } from '@nestjs/common';

import { AdminUsersController } from './admin-users.controller.js';
import { AdminBrandingController } from './admin-branding.controller.js';
import { AdminCapabilitiesController } from './admin-capabilities.controller.js';
import { AdminGuard } from './admin.guard.js';
import { HousekeepingController } from './housekeeping.controller.js';
import { HousekeepingService } from './housekeeping.service.js';
import { HousekeepingScheduleService } from './housekeeping-schedule.service.js';
import { HousekeepingCronService } from './housekeeping-cron.service.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { V3TablesModule } from '../features-v3/v3-tables.module.js';
import { ItemsModule } from '../items/items.module.js';

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
  imports: [V3TablesModule, ItemsModule],
  controllers: [
    AdminUsersController,
    AdminBrandingController,
    AdminCapabilitiesController,
    HousekeepingController,
  ],
  providers: [
    KeycloakAdminService,
    AdminGuard,
    HousekeepingService,
    HousekeepingScheduleService,
    HousekeepingCronService,
  ],
  exports: [KeycloakAdminService],
})
export class AdminModule {}
