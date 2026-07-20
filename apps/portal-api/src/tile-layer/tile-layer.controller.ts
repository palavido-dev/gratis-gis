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
  @Public()
  @Get('tile-layer/:itemId/file')
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
    const storageKey = await this.tileLayer.resolveStorageKey(user, itemId);
    const upstream = await this.storage.streamObject(storageKey, rangeHeader);
    res.status(upstream.statusCode);
    if (upstream.contentRange) res.setHeader('Content-Range', upstream.contentRange);
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    if (upstream.contentType) res.setHeader('Content-Type', upstream.contentType);
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    // Range support: advertise so MapLibre + browsers know to
    // request slices.
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    // PMTiles content is immutable per upload (a new upload
    // produces a new storageKey + url), so we can let the
    // browser cache aggressively. ETag handles invalidation when
    // a tile layer's file is replaced.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    try {
      upstream.body.pipe(res);
      await new Promise<void>((resolve, reject) => {
        upstream.body.on('end', resolve);
        upstream.body.on('error', reject);
        res.on('close', resolve);
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
