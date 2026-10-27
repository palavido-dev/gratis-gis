// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { EngineModule } from '../engine/engine.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OverpassClient } from './overpass-client.js';
import { OsmService } from './osm.service.js';
import { OsmScrubService } from './osm-scrub.service.js';
import { OsmSaveAsLayerService } from './save-as-layer.service.js';
import { OsmSaveAsLayerController } from './save-as-layer.controller.js';
import { OsmQueryController } from './osm-query.controller.js';

/**
 * Wires the OSM overlay adapter (#OSM).  Exports OsmService so the
 * recipe runner can resolve `osm-query` SourceRefs into transient
 * observation-log scopes that the spatial-filter SQL emitter
 * consumes like any other source.
 *
 * OsmScrubService (#100) is registered as a provider so the @Cron
 * decorator binds at module init. LeaderElectionService is global
 * (see leader-election.module.ts), so we don't need to import its
 * module here -- only the cron-leader replica runs the scrub.
 *
 * OsmSaveAsLayerService + controller (#102) wire the
 * "Save overlay as data_layer" path: the runtime UI hits
 * POST /osm/save-as-data-layer with a FeatureCollection and gets
 * back a freshly-provisioned data_layer item id. Pulls in
 * ItemsModule + DataLayerFeaturesModule for the provisioning and
 * bulk-insert calls respectively.
 *
 * OsmQueryController (R3-mcp-query-osm / #161) exposes
 * GET /osm/query as a capped facade over OsmService for MCP and
 * scripts. GET so read-only API keys can call it.
 */
@Module({
  imports: [PrismaModule, EngineModule, ItemsModule, DataLayerFeaturesModule],
  providers: [
    OverpassClient,
    OsmService,
    OsmScrubService,
    OsmSaveAsLayerService,
  ],
  controllers: [OsmSaveAsLayerController, OsmQueryController],
  exports: [OsmService],
})
export class OsmModule {}
