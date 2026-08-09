// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { LeaderElectionModule } from '../cron/leader-election.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ScriptScheduleService } from './script-schedule.service.js';
import { ScriptsModule } from './scripts.module.js';

/**
 * Timers for `script` items, kept out of ScriptsModule on purpose.
 *
 * ScriptsModule is in all three bootable graphs (API, portal-worker,
 * script-worker). This module is in the API graph only, because it is
 * the only place that holds the cron leader lock.
 *
 * Splitting it is not tidiness. A provider added to ScriptsModule that
 * the worker graphs cannot resolve would typecheck, pass every unit
 * test, and crash-loop portal-worker on deploy, since Nest resolves the
 * graph at boot and nowhere earlier. That has already happened twice on
 * this project.
 *
 * Deliberately NOT importing `ScheduleModule.forRoot()`.
 *
 * The first version did, to get SchedulerRegistry, and v0.9.10 hung on
 * boot: both API replicas mapped every route, logged leader election,
 * and then stopped before listening, with no error. A fifth
 * `forRoot()` in the graph, and the module-ordering change that came
 * with inserting it, were the only things this module contributed
 * besides its own provider, whose bootstrap hook never ran.
 *
 * The registry was never needed. It is an introspection surface, and
 * this service already owns its jobs in a Map it tears down itself.
 * `cron`'s CronJob runs perfectly well unregistered, so dropping the
 * import removes the dependency, the fifth forRoot, and the ordering
 * change together.
 */
@Module({
  imports: [PrismaModule, LeaderElectionModule, ScriptsModule],
  providers: [ScriptScheduleService],
  exports: [ScriptScheduleService],
})
export class ScriptScheduleModule {}
