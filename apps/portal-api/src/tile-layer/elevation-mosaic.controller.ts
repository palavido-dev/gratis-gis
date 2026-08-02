// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  TileCacheOverloadError,
  matchesIfNoneMatch,
  tileOverloadRetryAfterSeconds,
} from '../engine/tile-cache.service.js';
import { parseStackParam } from './elevation-mosaic.compositor.js';
import { ElevationMosaicService } from './elevation-mosaic.service.js';

/**
 * Elevation mosaic tile surface (#211).
 *
 *   GET /elevation-mosaic/:z/:x/:y.png?stack=<id>,<id>,...
 *
 * Terrarium-encoded raster-dem tiles composed per pixel across the
 * ordered DEM stack (first id wins, nodata falls through). The stack
 * rides in the query rather than a map item route so scratch maps
 * (#187, no backing item) get mosaic terrain too; authorization is
 * per DEM entry via the same dual ACL as the COG file proxy, which
 * is exactly the access a client already has fetching each DEM's
 * file directly. @Public() + optional bearer, same single-route
 * pattern as /tile-layer/:id/file; the BFF passes the path through
 * for anonymous viewers (the public-viewer rule).
 */
@ApiTags('tile-layer')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class ElevationMosaicController {
  constructor(private readonly mosaic: ElevationMosaicService) {}

  @Public()
  @Get('elevation-mosaic/:z/:x/:y.png')
  async tile(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: AuthUser | null,
    @Param('z') zStr: string,
    @Param('x') xStr: string,
    @Param('y') yStr: string,
    @Query('stack') stackRaw?: string,
  ): Promise<void> {
    const stack = parseStackParam(stackRaw);
    if (!stack) {
      throw new BadRequestException(
        'stack must be 1-8 comma-separated elevation item ids.',
      );
    }
    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);
    if (
      !Number.isInteger(z) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      z < 0 ||
      z > 24 ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z
    ) {
      throw new BadRequestException('Invalid tile coordinates.');
    }
    let hit: Awaited<ReturnType<ElevationMosaicService['tile']>>;
    try {
      hit = await this.mosaic.tile(user, stack, z, x, y);
    } catch (e) {
      if (e instanceof TileCacheOverloadError) {
        // Same back-off contract as MVT tiles: concurrency cap
        // saturated, tell the client to retry shortly instead of
        // amplifying the storm.
        res.setHeader('Retry-After', String(tileOverloadRetryAfterSeconds()));
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).end();
        return;
      }
      throw e;
    }
    // DEM bytes change rarely (a re-bake under the same key is the
    // only path) and the client stamps the stack fingerprint into
    // the URL, so an hour of blind caching matches the COG file
    // route these same DEMs are served from today. ETag handles
    // revalidation past the TTL.
    const cacheControl = user
      ? 'private, max-age=3600'
      : 'public, max-age=3600';
    if (!hit) {
      // No resolvable source touches this stack at all for this
      // viewer: nothing to compose, nothing worth caching long.
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
      return;
    }
    if (matchesIfNoneMatch(req.headers['if-none-match'], hit.etag)) {
      res.setHeader('ETag', hit.etag);
      res.setHeader('Cache-Control', cacheControl);
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', hit.etag);
    res.setHeader('Cache-Control', cacheControl);
    if (hit.empty) {
      // Composed tile misses every source footprint: 204 renders
      // as flat ground, same as a missing single-source tile.
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(hit.buf);
  }
}
