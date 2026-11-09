// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { GeocodingService } from './geocoding.service.js';

/**
 * Runtime geocoding endpoint for geocoding_service items (#74).
 *
 * `GET /geocode/:itemId?text=<query>&bbox=<w,s,e,n>&limit=<n>`
 *
 * Auth: standard JWT guard. The service-layer authz checks ensure
 * the caller has read access to BOTH the geocoder item and the
 * underlying data_layer.
 */
@ApiTags('geocoding')
@ApiBearerAuth()
@Controller('geocode')
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Get(':itemId')
  async search(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Query('text') text?: string,
    @Query('bbox') bbox?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedBbox = parseBbox(bbox);
    const parsedLimit = parseLimit(limit);
    const opts: {
      bbox?: [number, number, number, number];
      limit?: number;
    } = {};
    if (parsedBbox) opts.bbox = parsedBbox;
    if (parsedLimit !== null) opts.limit = parsedLimit;
    const candidates = await this.geocoding.search(
      user,
      itemId,
      text ?? '',
      opts,
    );
    return { candidates };
  }

  /**
   * Rebuild the per-searchField GIN trigram indexes that power
   * this geocoder's runtime query (#74 perf followup). Synchronous;
   * can take several minutes on large data layers. The editor UI
   * shows a "Building search indexes..." spinner while this runs.
   *
   * Requires admin on the geocoder item (the service layer
   * enforces this). The endpoint returns the list of indexes
   * created / kept / dropped so the UI can summarize.
   */
  @Post(':itemId/rebuild-indexes')
  async rebuildIndexes(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
  ) {
    return this.geocoding.rebuildIndexes(user, itemId);
  }

  /**
   * Probe an ArcGIS GeocodeServer URL for the external-arcgis mode
   * editor. Called from the detail editor when the author pastes a
   * URL and clicks Probe; returns the metadata the editor needs to
   * fill in (title, address fields, single-line field name,
   * supported countries, capabilities, attribution) so the resulting
   * geocoding_service item is configured without the author having
   * to read the upstream's JSON document by hand.
   *
   * Auth: any logged-in user. We don't require admin on a specific
   * item because the user is configuring a NEW item (or one they
   * own); item-level authz fires when they actually save.
   */
  @Post('probe-arcgis')
  async probeArcgis(@Body() body: { url?: string }) {
    if (!body || typeof body.url !== 'string') {
      throw new BadRequestException('Body must include { url: string }.');
    }
    return this.geocoding.probeExternalArcgis(body.url);
  }
}

/** Parse the comma-separated `bbox=w,s,e,n` query param. Returns
 *  null when the param is absent or malformed; the caller treats
 *  null as "no spatial constraint from the request" and falls back
 *  to the geocoder's configured bboxFilter. */
function parseBbox(
  raw: string | undefined,
): [number, number, number, number] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequestException(
      'bbox must be four comma-separated numbers: west,south,east,north',
    );
  }
  const [w, s, e, n] = parts as [number, number, number, number];
  if (w >= e || s >= n) {
    throw new BadRequestException(
      'bbox has invalid ordering: west must be < east, south must be < north',
    );
  }
  return [w, s, e, n];
}

function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return Math.floor(n);
}
