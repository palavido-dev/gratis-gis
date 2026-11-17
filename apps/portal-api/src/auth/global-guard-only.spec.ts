// SPDX-License-Identifier: AGPL-3.0-or-later
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { TileLayerController } from '../tile-layer/tile-layer.controller.js';
import { ElevationMosaicController } from '../tile-layer/elevation-mosaic.controller.js';
import { PointCloudController } from '../point-cloud/point-cloud.controller.js';
import { AnalysisController } from '../analysis/analysis.controller.js';
import { SamController } from '../analysis/sam.controller.js';
import { FormsController } from '../forms/forms.controller.js';
import { GeocodingController } from '../geocoding/geocoding.controller.js';
import { ScriptsController } from '../scripts/scripts.controller.js';
import { AuthedOgcFeaturesController } from '../ogc/authed-features.controller.js';
import { AuthedStacController } from '../ogc/authed-stac.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * JwtAuthGuard is registered once as an APP_GUARD. Repeating it on a
 * controller ran it a second time per request, which for an API key
 * meant resolving the key twice (three queries plus the touch) on
 * routes that tiles hit dozens of times per pan.
 */
describe('controllers rely on the global JwtAuthGuard', () => {
  it.each([
    TileLayerController,
    ElevationMosaicController,
    PointCloudController,
    AnalysisController,
    SamController,
    FormsController,
    GeocodingController,
    ScriptsController,
    AuthedOgcFeaturesController,
    AuthedStacController,
  ])('%p does not apply it again', (controller) => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
      []) as unknown[];
    expect(guards).not.toContain(JwtAuthGuard);
  });
});
