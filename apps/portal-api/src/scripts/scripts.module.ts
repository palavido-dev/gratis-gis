// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

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
  imports: [ItemsModule],
  controllers: [ScriptsController],
  providers: [ScriptsService, ScriptRunnerWorker],
  exports: [ScriptRunnerWorker],
})
export class ScriptsModule {}
