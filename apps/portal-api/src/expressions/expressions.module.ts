// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { ExpressionsController } from './expressions.controller.js';
import { ExpressionsService } from './expressions.service.js';

/** Server-side evaluation of expressions, including data access. */
@Module({
  imports: [ItemsModule],
  providers: [ExpressionsService],
  controllers: [ExpressionsController],
  exports: [ExpressionsService],
})
export class ExpressionsModule {}
