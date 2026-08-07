// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ScriptsModule } from './scripts/scripts.module.js';
import { ScriptRunnerWorker } from './scripts/script-runner.worker.js';

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
 * It loads ScriptsModule and nothing else, so it never claims rows
 * from the import, tile, or analysis queues that portal-worker owns.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScriptsModule],
})
class ScriptWorkerAppModule {}

async function bootstrap() {
  const log = new Logger('ScriptRunner');
  const app = await NestFactory.createApplicationContext(
    ScriptWorkerAppModule,
    { bufferLogs: false },
  );
  app.enableShutdownHooks();

  // Shutdown must reach the children: onModuleDestroy kills any live
  // script process. Without the hooks above, docker stop would leave
  // an orphaned python process holding a run row in `running` until
  // the stale sweep noticed minutes later.
  app.get(ScriptRunnerWorker).start();
  log.log('script runner ready');
}

void bootstrap();
