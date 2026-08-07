// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ImportJobsWorkerModule } from './import-jobs/import-jobs-worker.module.js';
import { LeaderElectionModule } from './cron/leader-election.module.js';
import { TileLayerWorkerModule } from './tile-layer/tile-layer-worker.module.js';
import { AnalysisBridgeModule } from './analysis/analysis-bridge.module.js';
import { ScriptsModule } from './scripts/scripts.module.js';
import { ScriptRunnerWorker } from './scripts/script-runner.worker.js';
import { isScriptsEnabled } from './scripts/scripts-config.js';

/**
 * portal-worker entry point (#115 P8).
 *
 * Runs the same image as portal-api but bootstraps a standalone
 * Nest application context (no HTTP listener) that loads only the
 * worker-side modules. The ImportJobsWorker's polling loop keeps
 * the process alive; SIGTERM / SIGINT closes it cleanly.
 *
 * Why a separate process instead of a thread:
 *   - The Node event loop is process-scoped. CPU-heavy work in
 *     the worker (gdal-async feature pumps, EWKT serialization,
 *     COPY stream encoding) blocks every other piece of JS in
 *     the same process. With the worker in its own container,
 *     the api stays responsive to user requests no matter what
 *     the worker is doing.
 *   - Horizontal scale: scaling the worker doesn't drag the api
 *     with it. A burst of imports just spawns more
 *     portal-worker containers; the api stays at its baseline.
 *   - Memory isolation: a runaway import that OOMs the process
 *     only kills the worker, not the api.
 *
 * Co-deployed with portal-api: same docker image, different
 * CMD. The container shares the staging volume with the api so
 * files uploaded via POST /ingest/stage are readable here.
 */
@Module({
  imports: [
    // Global ConfigService is needed because transitive deps reach
    // NotificationsService (via ItemsModule -> share notifications)
    // and IngestStagingService, both of which DI ConfigService for
    // env-driven knobs. Without `isGlobal: true` here, the worker
    // crashes at boot with "Nest can't resolve dependencies of the
    // NotificationsService" because no module in scope re-exports
    // it.
    ConfigModule.forRoot({ isGlobal: true }),
    LeaderElectionModule,
    ImportJobsWorkerModule,
    // Tile-layer pyramid worker (raster-upload follow-up).
    // Polls cog-ready tile_layer items and builds a PMTiles
    // raster pyramid from the COG via gdal2tiles.py + pmtiles
    // convert.  See pyramid.worker.ts for the state machine.
    TileLayerWorkerModule,
    // Analysis-to-import bridge: stages vector analysis outputs
    // (contours) from MinIO into the async import pipeline above.
    AnalysisBridgeModule,
    // #221: executes queued `script` runs. Imported here and nowhere
    // else that matters: the module is also in AppModule so the API
    // can serve the run endpoints, but the runner's polling loop is
    // started explicitly below, so an API replica never spends its
    // CPU executing user code.
    ScriptsModule,
  ],
})
class WorkerAppModule {}

async function bootstrap() {
  const log = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
  });
  // Graceful shutdown: tear down Nest providers (closes Prisma,
  // releases the worker's polling timer) before the container
  // process exits. Without this, an in-flight import job's COPY
  // transaction would be left dangling when docker stops the
  // container.
  app.enableShutdownHooks();

  // #221: start the script runner here rather than in the module, so
  // that importing ScriptsModule into AppModule (which the API needs
  // for the run endpoints) never turns an API replica into an
  // execution host for user code.
  //
  // Opt-in, and off by default: a portal that has not decided it wants
  // to run user-authored Python on its own machine should not start
  // doing so because it upgraded.
  if (isScriptsEnabled()) {
    app.get(ScriptRunnerWorker).start();
    log.log('script runner enabled');
  }

  log.log('portal-worker ready');

  // The ImportJobsWorker's polling loop keeps the event loop
  // busy; nothing else here. We do not call app.close() because
  // the process should run forever (until killed).
}

void bootstrap();
