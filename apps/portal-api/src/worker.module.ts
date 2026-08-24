// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ImportJobsWorkerModule } from './import-jobs/import-jobs-worker.module.js';
import { LeaderElectionModule } from './cron/leader-election.module.js';
import { TileLayerWorkerModule } from './tile-layer/tile-layer-worker.module.js';
import { OfflinePackageWorkerModule } from './offline-package/offline-package-worker.module.js';
import { AnalysisBridgeModule } from './analysis/analysis-bridge.module.js';
import { ScriptsModule } from './scripts/scripts.module.js';

/**
 * Module graph for the portal-worker process.
 *
 * In its own file, separate from worker.main.ts, so the boot-time DI
 * spec can compile it: the entry point calls bootstrap() at module
 * scope, which makes it unimportable from a test.
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
    // #70: cuts one vector basemap archive per author-defined
    // offline area, so a field crew downloads a file instead of
    // each collector enumerating tiles for themselves. Also runs
    // the automatic-rebuild sweep for areas with a refresh
    // interval. See offline-package.worker.ts.
    OfflinePackageWorkerModule,
    // Analysis-to-import bridge: stages vector analysis outputs
    // (contours) from MinIO into the async import pipeline above.
    AnalysisBridgeModule,
    // #221: makes the script runner available. Its polling loop is
    // started explicitly in the entry point, and only when the
    // feature is enabled, so importing the module here does not by
    // itself turn this process into an execution host.
    ScriptsModule,
  ],
})
export class WorkerAppModule {}
