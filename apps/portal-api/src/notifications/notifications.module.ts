import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from '../prisma/prisma.module.js';
import { EmailTransport } from './email-transport.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationsWorker } from './notifications.worker.js';
import { NotificationsCron } from './notifications-cron.service.js';
import { NotificationPreferencesController } from './preferences.controller.js';
import { SystemSettingsService } from './system-settings.service.js';
import { NotificationTypeDefaultService } from './notification-type-default.service.js';

/**
 * Cross-cutting notifications platform (#127). Other modules import
 * NotificationsService and call `notify(userId, type, payload)` to
 * enqueue a notification; the in-process worker drains the queue
 * via SMTP.
 *
 * NotificationsService is exported so feature modules (items,
 * users, editor) can inject it. The worker + transport are
 * internal: only the service's public API is part of the
 * cross-module contract, which keeps SMTP swap-out a one-file
 * change later.
 */
@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [NotificationPreferencesController],
  providers: [
    NotificationsService,
    NotificationsWorker,
    NotificationsCron,
    EmailTransport,
    SystemSettingsService,
    NotificationTypeDefaultService,
  ],
  // Export the platform settings + default services so the admin
  // controller (registered in AdminModule, not here, to avoid a
  // circular import) can inject them. EmailTransport is exported
  // for the same reason -- the admin controller's "send test" path
  // reuses the existing pool wrapper for one-shot delivery.
  exports: [
    NotificationsService,
    SystemSettingsService,
    NotificationTypeDefaultService,
    EmailTransport,
  ],
})
export class NotificationsModule {}
