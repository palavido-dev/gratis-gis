// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminAuditModule } from '../admin/admin-audit.module.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { BackupController } from './backup.controller.js';
import { BackupCronService } from './backup-cron.service.js';
import { BackupRestoreService } from './backup-restore.service.js';
import { BackupService } from './backup.service.js';
import { MaintenanceModeMiddleware } from './maintenance-mode.middleware.js';
import { MaintenanceModeService } from './maintenance-mode.service.js';

/**
 * Bundles backup creation + scheduled run registration + restore.
 * The maintenance-mode middleware is applied globally (forRoutes
 * '*') so every request in the system is gated, not just the ones
 * that happen to land on a BackupModule controller.
 */
@Module({
  imports: [ScheduleModule.forRoot(), AdminAuditModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    BackupCronService,
    BackupRestoreService,
    MaintenanceModeService,
    AdminGuard,
  ],
  exports: [BackupService, MaintenanceModeService],
})
export class BackupModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MaintenanceModeMiddleware).forRoutes('*');
  }
}
