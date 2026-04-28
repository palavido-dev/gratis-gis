import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from '../prisma/prisma.module.js';
import { EmailTransport } from './email-transport.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationsWorker } from './notifications.worker.js';

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
  providers: [NotificationsService, NotificationsWorker, EmailTransport],
  exports: [NotificationsService],
})
export class NotificationsModule {}
