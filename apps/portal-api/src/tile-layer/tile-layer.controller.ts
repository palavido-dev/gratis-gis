// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
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
import { StorageService } from '../storage/storage.service.js';
import { TileLayerService } from './tile-layer.service.js';

/**
 * Content types the tile pipeline legitimately serves inline
 * (PMTiles archives, COGs, raster tiles).  Everything else leaves
 * this endpoint as a download: the stored object carries whatever
 * Content-Type the presigned PUT claimed, so an upload stored as
 * text/html or image/svg+xml rendered inline from this @Public
 * route would be stored XSS on the api origin.
 */
const INLINE_SAFE_TILE_TYPES = new Set([
  'application/octet-stream',
  'image/tiff',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
]);

/**
 * HTTP surface for tile_layer items (#179).
 *
 *   POST /items/:id/tile-layer/finalize
 *     Called by the frontend after a successful presigned-PUT
 *     upload to MinIO. Reads the PMTiles header from the
 *     just-uploaded file, extracts metadata, persists it on
 *     item.data. Returns the populated TileLayerData.
 *
 *   GET /tile-layer/:itemId/file
 *     Proxy endpoint MapLibre's pmtiles plugin range-reads.
 *     Forwards the Range header to the file's public MinIO URL
 *     and streams the response back. Item-level ACL applies via
 *     ItemsService.get inside resolveStorageUrl().
 */
@ApiTags('tile-layer')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class TileLayerController {
  constructor(
    private readonly tileLayer: TileLayerService,
    private readonly storage: StorageService,
  ) {}

  @Post('items/:itemId/tile-layer/finalize')
  async finalize(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      storageKey: string;
      storageUrl: string;
      fileName: string;
      sizeBytes: number;
    },
  ) {
    const data = await this.tileLayer.finalizeUpload(user, itemId, body);
    return { data };
  }

  /**
   * Pre-upload space check.  Frontend calls this on file select
   * (before requesting a presigned PUT) so a too-big upload is
   * refused up front instead of hammering MinIO with ENOSPC after
   * megabytes of bytes have already been transferred.  Returns
   * `ok: false` plus a user-readable reason when the host disk
   * doesn't have headroom for the upload + conversion pipeline.
   * No `itemId` in the path because the check is purely about
   * disk space; the create-item flow can call this before the
   * item exists.
   */
  @Post('tile-layer/check-space')
  async checkSpace(
    @CurrentUser() _user: AuthUser,
    @Body()
    body: {
      fileName: string;
      sizeBytes: number;
    },
  ) {
    return this.tileLayer.checkUploadSpace(body);
  }

  /**
   * Retry a failed PMTiles pyramid build.  Flips the item back
   * to processingState='cog-ready' so the pyramid worker re-
   * claims it on the next poll tick.  Owner / admin gated inside
   * the service.
   */
  @Post('items/:itemId/tile-layer/retry-pyramid')
  async retryPyramid(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
  ) {
    const data = await this.tileLayer.retryPyramid(user, itemId);
    return { data };
  }

  /**
   * #199: deployment-wide mosaic cost coefficients, so the client
   * can estimate (and refuse) a build BEFORE uploading gigabytes.
   * Same contract as point-cloud/merge-limits.
   */
  @Get('tile-layer/mosaic-limits')
  async mosaicLimits(@CurrentUser() _user: AuthUser) {
    return this.tileLayer.mosaicLimits();
  }

  /**
   * #199: build one seamless imagery mosaic from N uploaded source
   * rasters. Sources were already PUT to MinIO via presigned
   * uploads; this records them on the item and queues the worker
   * build. Returns the job id + human time estimate.
   */
  @Post('items/:itemId/tile-layer/mosaic-build')
  async mosaicBuild(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ) {
    return this.tileLayer.mosaicBuild(user, itemId, body);
  }

  /**
   * #199: append more images to an existing mosaic and rebuild
   * over the full retained set.
   */
  @Post('items/:itemId/tile-layer/mosaic-add-sources')
  async mosaicAddSources(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ) {
    return this.tileLayer.mosaicAddSources(user, itemId, body);
  }

  /**
   * Range-request proxy. MapLibre's pmtiles plugin issues many
   * range requests as the user pans / zooms; this endpoint
   * forwards each one to the underlying MinIO public URL. We
   * resolve the file URL on every call so a revoked item access
   * stops working immediately (no client-side URL caching to
   * worry about for ACL purposes).
   *
   * Implementation: do a server-side fetch with the same Range
   * header, then mirror the response status + Content-Range +
   * Content-Length headers and pipe the body through. This is
   * less efficient than a redirect would be, but a redirect to
   * a presigned URL would expire mid-session, and proxying lets
   * us apply per-request ACL checks (cheap; just an items.get
   * read inside the service).
   */
  /**
   * #185: the suffixed routes pin the served format. The bare
   * route keeps its historical current-format behavior (prefer
   * pyramid, fall back to source image) for basemap URLs that
   * predate the suffixes. Map layers stamp a suffixed URL at add
   * time so the bytes never change format underneath the client
   * (the bare endpoint flips from image to tile pyramid a few
   * minutes after upload when the background build finishes).
   */
  @Public()
  @Get([
    'tile-layer/:itemId/file',
    'tile-layer/:itemId/file.pmtiles',
    'tile-layer/:itemId/file.cog',
  ])
  async serveFile(
    @CurrentUser() user: AuthUser | null,
    @Param('itemId') itemId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // After the bucket policy was tightened to deny anonymous GET
    // on item-tile-layer/*, this proxy fetches via the SDK using
    // portal-api's credentials instead of the public URL.  ACL
    // check happens in `resolveStorageKey` (which calls items.get).
    const format = req.path.endsWith('.pmtiles')
      ? ('pmtiles' as const)
      : req.path.endsWith('.cog')
        ? ('cog' as const)
        : undefined;
    const storageKey = await this.tileLayer.resolveStorageKey(
      user,
      itemId,
      format,
    );
    const upstream = await this.storage.streamObject(storageKey, rangeHeader);
    res.status(upstream.statusCode);
    if (upstream.contentRange) res.setHeader('Content-Range', upstream.contentRange);
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    if (upstream.contentType) res.setHeader('Content-Type', upstream.contentType);
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    // ?download=1 turns the response into a named file download for
    // the detail page's Download buttons (QGIS / desktop GIS use).
    // The bytes are identical to what map rendering streams; this
    // only adds the attachment disposition + a friendly filename.
    // Without it, anything outside the raster/binary allowlist is
    // still forced to an attachment: the Content-Type going out is
    // whatever the stored object claims, and letting an active
    // type render inline from this origin would be stored XSS.
    const servedType = (upstream.contentType ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (req.query.download === '1') {
      const name = await this.tileLayer.downloadFileName(
        user,
        itemId,
        format,
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${name.replace(/["\\\r\n]/g, '')}"`,
      );
    } else if (!INLINE_SAFE_TILE_TYPES.has(servedType)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    // nosniff so a browser never second-guesses the declared type
    // into something scriptable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Range support: advertise so MapLibre + browsers know to
    // request slices.
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    // NOT immutable: the pyramid worker can re-bake the tile file
    // under the same URL (retry after a failed build, or a pipeline
    // fix), and `immutable` suppresses revalidation entirely, which
    // served day-old stale tiles after a re-bake. One hour of
    // blind caching keeps the range-request storm off the server
    // while bounding staleness; ETag + If-Range handle clean
    // revalidation past that.
    res.setHeader('Cache-Control', 'public, max-age=3600');

    try {
      upstream.body.pipe(res);
      await new Promise<void>((resolve, reject) => {
        upstream.body.on('end', resolve);
        upstream.body.on('error', reject);
        res.on('close', () => {
          // Client hung up (panning kills in-flight tile fetches):
          // destroy the S3 read so its socket returns to the pool
          // instead of draining to the end and leaking under churn.
          upstream.body.destroy();
          resolve();
        });
      });
    } catch (err) {
      // Client disconnected mid-stream is normal (panning kills
      // in-flight tile fetches). Log unexpected errors only.
      if (!req.destroyed) {
        // eslint-disable-next-line no-console
        console.error('tile-layer proxy stream error', err);
      }
      try {
        res.end();
      } catch {
        /* response may already be closed */
      }
    }
  }
}
