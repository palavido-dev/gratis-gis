// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ScriptExecutorController } from './scripts/script-executor.controller.js';
import { ScriptExecutorService } from './scripts/script-executor.service.js';

/**
 * Module graph for the script-executor process (#221).
 *
 * Deliberately tiny, and that is the security property: no Prisma, no
 * storage, no auth, no items. It cannot reach the database because it
 * has no client and no credentials, and it cannot reach it over the
 * network either because of where its container sits. Two independent
 * reasons, which is the point.
 *
 * Its smallness is worth defending in review. Importing anything that
 * transitively pulls in PrismaModule would quietly hand the process
 * that runs untrusted code a database handle.
 *
 * In its own file so the boot-time DI spec can compile it.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [ScriptExecutorController],
  providers: [ScriptExecutorService],
})
export class ScriptExecutorAppModule {}
