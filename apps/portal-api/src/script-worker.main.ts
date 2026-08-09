// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { ScriptWorkerAppModule } from './script-worker.module.js';
import { ScriptRunnerWorker } from './scripts/script-runner.worker.js';
import { isScriptsEnabled } from './scripts/scripts-config.js';

/**
 * script-runner entry point (#221).
 *
 * A THIRD process, separate from both portal-api and portal-worker,
 * for reasons that are about isolation rather than scale:
 *
 *   - It needs a Python interpreter and the scientific stack. Adding
 *     those to the portal-api image would grow every API replica by
 *     hundreds of megabytes for a capability they never use.
 *   - It is the only process that executes code the portal did not
 *     write. Giving that its own container means its memory limit,
 *     its network policy, and its blast radius are all separately
 *     adjustable, and a runaway script cannot OOM the import queue.
 *   - portal-worker holds MinIO root credentials for tile and point
 *     cloud work. This process has no reason to, and the fewer
 *     secrets in the environment nearest the user code, the shorter
 *     the argument about what could leak.
 *
 * The module graph lives in script-worker.module.ts so the boot-time
 * DI spec can compile it; this file only starts things.
 */
async function bootstrap() {
  const log = new Logger('ScriptRunner');
  const app = await NestFactory.createApplicationContext(
    ScriptWorkerAppModule,
    { bufferLogs: false },
  );
  app.enableShutdownHooks();

  // The off switch has to reach the claimer, not just the API.
  //
  // Without this the claimer polled and executed queued runs regardless
  // of PORTAL_SCRIPTS_ENABLED, so a row left over from before the flag
  // was turned off, injected directly, or restored from a golden dump
  // would still run. worker.main.ts already gates its copy this way; the
  // dedicated script-runner container did not, which made "scripts are
  // off" true for the API and false for the thing that runs them.
  if (isScriptsEnabled()) {
    // Shutdown must reach the children: onModuleDestroy kills any live
    // script process. Without the hooks above, docker stop would leave
    // an orphaned python process holding a run row in `running` until
    // the stale sweep noticed minutes later.
    app.get(ScriptRunnerWorker).start();
    log.log('script runner ready');
  } else {
    log.log('scripts are disabled (PORTAL_SCRIPTS_ENABLED); claimer idle');
  }
}

void bootstrap();
