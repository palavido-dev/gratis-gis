// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ScriptScheduleService } from './script-schedule.service.js';
import { ScriptsModule } from './scripts.module.js';

/**
 * Timers for `script` items, kept out of ScriptsModule on purpose.
 *
 * ScriptsModule is in all three bootable graphs (API, portal-worker,
 * script-worker). This module is in the API graph only, because it is
 * the only place that both holds the cron leader lock and has a reason
 * to carry SchedulerRegistry.
 *
 * Splitting it is not tidiness. A provider needing SchedulerRegistry
 * added to ScriptsModule would typecheck, pass every unit test, and
 * crash-loop portal-worker on deploy, since Nest resolves the graph at
 * boot and nowhere earlier. That has already happened twice on this
 * project. app.module.spec.ts compiles all four graphs to catch it.
 */
@Module({
  imports: [
    PrismaModule,
    LeaderElectionModule,
    ScheduleModule.forRoot(),
    ScriptsModule,
  ],
  providers: [ScriptScheduleService],
  exports: [ScriptScheduleService],
})
export class ScriptScheduleModule {}
