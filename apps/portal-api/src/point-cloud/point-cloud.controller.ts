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
import { PointCloudService } from './point-cloud.service.js';
import { mergeCostModel } from './merge-estimate.js';

/**
 * HTTP surface for point_cloud items (#179).
 *
 *   POST /items/:id/point-cloud/finalize
 *     Called after a successful presigned-PUT upload. Validates
 *     the bytes in MinIO are COPC, lifts header metadata onto
 *     item.data, returns the populated PointCloudData.
 *
 *   GET /point-cloud/:itemId/file
 *     Range proxy the COPC viewer streams octree nodes from.
 *     @Public() with a nullable user, the same dual path as the
 *     private-storage route: authed callers get the standard item
 *     ACL, anonymous callers resolve only access='public' items.
 *     A public map with a point cloud layer therefore renders for
 *     signed-out visitors without a separate mirror controller.
 */
@ApiTags('point-cloud')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class PointCloudController {
  constructor(
    private readonly pointCloud: PointCloudService,
    private readonly storage: StorageService,
  ) {}

  @Post('items/:itemId/point-cloud/finalize')
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
    const data = await this.pointCloud.finalizeUpload(user, itemId, body);
    return { data };
  }

  /**
   * The merge cost model + ceiling (#205), so the panel can show
   * "N tiles, M GB, roughly H hours" and refuse an oversized batch
   * BEFORE the user uploads gigabytes. Enforcement stays server-side
   * in enqueueBuild; this is the courtesy copy of the same numbers.
   * Not item-scoped: the model is deployment-wide.
   */
  @Get('point-cloud/merge-limits')
  mergeLimits() {
    return mergeCostModel();
  }

  /**
   * Merge several uploaded lidar tiles into this point cloud's COPC
   * (#200). The browser presigned-PUTs each tile, then posts the
   * list here; the worker merges them with untwine. Returns the
   * build job id so the panel can poll the item for 'ready', plus
   * the up-front time estimate (#205) for the building state.
   */
  @Post('items/:itemId/point-cloud/build')
  async build(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      sources: Array<{
        storageKey: string;
        fileName: string;
        sizeBytes: number;
      }>;
    },
  ) {
    return this.pointCloud.buildFromSources(user, itemId, body);
  }

  /**
   * Add more tiles to an existing point cloud and rebuild the merged
   * COPC over the full set (#200). Same body shape as build.
   */
  @Post('items/:itemId/point-cloud/add-sources')
  async addSources(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      sources: Array<{
        storageKey: string;
        fileName: string;
        sizeBytes: number;
      }>;
    },
  ) {
    return this.pointCloud.addSources(user, itemId, body);
  }

  /**
   * Range-request proxy. COPC readers issue many small ranged
   * reads (header, then octree hierarchy pages, then node chunks
   * as the camera moves), so this endpoint mirrors the tile-layer
   * proxy exactly: forward the Range header to MinIO via the SDK,
   * mirror status + Content-Range back, stream the body.
   *
   * Cache headers match the tile-layer proxy reasoning: a re-
   * upload produces a new storageKey, and the ETag (MinIO's, keyed
   * to the object) invalidates stale node reads after replacement.
   */
  /**
   * Both paths serve identical bytes. The `.copc.laz`-suffixed one
   * is what dataUrl advertises: maplibre-gl-lidar (and other COPC
   * viewers) decide streaming vs full-download by testing the URL
   * for ".copc.", so an extension-less URL silently downgrades a
   * multi-GB cloud to a whole-file download that OOMs the tab. The
   * bare path stays for anything that persisted it before the
   * suffix existed.
   */
  @Public()
  @Get(['point-cloud/:itemId/file', 'point-cloud/:itemId/file.copc.laz'])
  async serveFile(
    @CurrentUser() user: AuthUser | null,
    @Param('itemId') itemId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const storageKey = await this.pointCloud.resolveStorageKey(user, itemId);
    const upstream = await this.storage.streamObject(storageKey, rangeHeader);
    res.status(upstream.statusCode);
    if (upstream.contentRange) {
      res.setHeader('Content-Range', upstream.contentRange);
    }
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    // The stored Content-Type came from whatever the uploader declared
    // at presign time, and this route is @Public and served from the
    // portal's own origin, so echoing it unqualified makes any upload
    // that sniffs as HTML a stored-XSS vector with session access.
    // COPC readers only ever want the bytes, so force an opaque type,
    // forbid sniffing, and mark it a download.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    try {
      upstream.body.pipe(res);
      await new Promise<void>((resolve, reject) => {
        upstream.body.on('end', resolve);
        upstream.body.on('error', reject);
        res.on('close', resolve);
      });
    } catch (err) {
      // Client disconnects mid-stream are normal (camera moves kill
      // in-flight node fetches). Log unexpected errors only.
      if (!req.destroyed) {
        this.logStreamError(err);
      }
      try {
        res.end();
      } catch {
        /* response may already be closed */
      }
    }
  }

  private logStreamError(err: unknown): void {
    console.error('point-cloud proxy stream error', err);
  }
}
