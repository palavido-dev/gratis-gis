// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PrintRenderController } from './print-render.controller.js';
import { PrintRenderService } from './print-render.service.js';

@Module({
  imports: [PrismaModule, ItemsModule, AuthModule],
  controllers: [PrintRenderController],
  providers: [PrintRenderService],
  exports: [PrintRenderService],
})
export class PrintRenderModule {}
