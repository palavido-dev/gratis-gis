// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ItemsModule } from '../items/items.module.js';
import { ScriptRunnerWorker } from './script-runner.worker.js';
import { ScriptsController } from './scripts.controller.js';
import { ScriptsService } from './scripts.service.js';

/**
 * `script` items (#221): queue, history, and the runner.
 *
 * The runner is provided here but NOT started here. Its `start()` is
 * called by the worker entry point only, so an API replica never
 * spends its CPU executing user code while it is also meant to be
 * answering requests.
 */
@Module({
  // AuthModule explicitly, even though it is @Global(). Global means
  // "exports are visible everywhere ONCE this module is in the graph",
  // not "imported automatically". AppModule imports it, so the API was
  // fine; the two worker graphs do not, so ScriptRunnerWorker could
  // not resolve ApiKeyService and portal-worker crash-looped on
  // deploy. A module that uses a provider should declare where it
  // comes from rather than rely on some other module having pulled it
  // in, which is the same fragility that took the API down in #219.
  imports: [AuthModule, ItemsModule],
  controllers: [ScriptsController],
  providers: [ScriptsService, ScriptRunnerWorker],
  // ScriptsService is exported for ScriptScheduleModule, which lives in
  // the API graph only. The scheduler is deliberately NOT a provider
  // here: this module is in all three bootable graphs, and the
  // scheduler needs SchedulerRegistry, which the worker graphs have no
  // reason to carry. Adding it here would resolve fine at typecheck and
  // crash-loop portal-worker at boot, which is the exact failure this
  // module's other comment is about.
  exports: [ScriptRunnerWorker, ScriptsService],
})
export class ScriptsModule {}
