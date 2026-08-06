// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { FeedbackAdminController } from './feedback-admin.controller.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

/**
 * In-portal feedback (#146). Reuses EmailTransport from
 * NotificationsModule rather than standing up a second SMTP wrapper,
 * and StorageModule for optional screenshots.
 *
 * Two controllers: an unauthenticated POST for reporters, and an
 * admin-guarded triage surface for reading what came in.
 */
@Module({
  imports: [NotificationsModule, StorageModule],
  controllers: [FeedbackController, FeedbackAdminController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
