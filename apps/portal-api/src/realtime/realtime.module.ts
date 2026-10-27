// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

@Module({
  imports: [PrismaModule, ItemsModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
