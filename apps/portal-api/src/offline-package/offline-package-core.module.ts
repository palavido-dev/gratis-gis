// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { OfflinePackageService } from './offline-package.service.js';

/**
 * The queue/read service on its own, with only Prisma behind it.
 *
 * Three module graphs need OfflinePackageService: the API module
 * (controller), the worker module (builder + sweep), and ItemsModule
 * (pruning packages when a data_collection's areas are saved). The
 * last one is why this module exists: OfflinePackageModule imports
 * ItemsModule for its controller's auth checks, so ItemsModule
 * importing it back would be a DI cycle. The service only ever
 * needed Prisma; giving it a Prisma-only home lets every graph hold
 * it without holding each other.
 */
@Module({
  imports: [PrismaModule],
  providers: [OfflinePackageService],
  exports: [OfflinePackageService],
})
export class OfflinePackageCoreModule {}
