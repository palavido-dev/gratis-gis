// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { HealthController } from './health.controller.js';
import { PortalInfoController } from './portal-info.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { ItemsModule } from './items/items.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { PostgisLiveModule } from './postgis-live/postgis-live.module.js';
import { PrintRenderModule } from './print/print-render.module.js';
import { StorageModule } from './storage/storage.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { ImportJobsModule } from './import-jobs/import-jobs.module.js';
import { ImportAgoModule } from './import-ago/import-ago.module.js';
import { MapIconsModule } from './map-icons/map-icons.module.js';
import { FeaturesModule } from './features/features.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { AdminModule } from './admin/admin.module.js';
import { DataLayerFeaturesModule } from './data-layer/features.module.js';
import { PublicModule } from './public/public.module.js';
import { BackupModule } from './backup/backup.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { GeocodingModule } from './geocoding/geocoding.module.js';
import { TileLayerModule } from './tile-layer/tile-layer.module.js';
import { PointCloudModule } from './point-cloud/point-cloud.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { FormsModule } from './forms/forms.module.js';
import { FieldQueueModule } from './field-queue/field-queue.module.js';
import { EngineModule } from './engine/engine.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { ToolsModule } from './tools/tools.module.js';
import { OsmModule } from './osm/osm.module.js';
import { SamplesModule } from './samples/samples.module.js';
import { ScriptsModule } from './scripts/scripts.module.js';
import { LeaderElectionModule } from './cron/leader-election.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global per-IP rate limit.  ThrottlerGuard runs after JwtAuthGuard
    // (declared below); each route gets the default 300 requests / 60s
    // bucket unless it overrides via @Throttle on the controller.  Public
    // controllers (PublicModule, FeedbackModule, GeocodingModule) declare
    // their own tighter limits per-route.  Memory-backed, per-process;
    // portal-api currently runs 2 replicas behind Caddy, so the
    // effective ceiling is 2x the declared value -- acceptable for a
    // baseline limit.  Tighter at-the-edge limits will land via Caddy
    // when the operator picks a rate-limit module to compile in.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 300,
      },
    ]),
    PrismaModule,
    LeaderElectionModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    ItemsModule,
    StorageModule,
    IngestModule,
    ImportJobsModule,
    ImportAgoModule,
    MapIconsModule,
    FeaturesModule,
    MaintenanceModule,
    AdminModule,
    DataLayerFeaturesModule,
    PublicModule,
    BackupModule,
    NotificationsModule,
    FeedbackModule,
    GeocodingModule,
    TileLayerModule,
    PointCloudModule,
    AnalysisModule,
    FormsModule,
    FieldQueueModule,
    EngineModule,
    PolicyModule,
    ToolsModule,
    OsmModule,
    SamplesModule,
    ScriptsModule,
    RealtimeModule,
    PostgisLiveModule,
    PrintRenderModule,
  ],
  controllers: [HealthController, PortalInfoController],
  providers: [
    // Global per-IP rate limit, runs before the auth guard so an
    // anonymous flood gets bounced without paying the cost of token
    // validation.  APP_GUARDs run in declaration order, so list the
    // throttler first.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth guard; opt out per-route with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
