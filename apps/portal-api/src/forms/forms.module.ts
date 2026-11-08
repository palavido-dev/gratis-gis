// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

/**
 * Form submission storage + access (#131). The form item itself
 * (the schema) lives in the Items module; this module only owns
 * captured responses.
 *
 * DataLayerFeaturesModule is imported (#281e) so submissions can also be
 * mirrored into the paired data_layer that ItemsService.create
 * auto-provisions for every form item (#283 / #281c).
 *
 * The repair pass uses its own timer. It does not call
 * ScheduleModule.forRoot(). A fifth copy of that root hung boot
 * (app.module.spec keeps the set at the four modules that already
 * own it).
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    DataLayerFeaturesModule,
    LeaderElectionModule,
  ],
  controllers: [FormsController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}
