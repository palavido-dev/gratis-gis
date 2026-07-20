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
  @Public()
  @Get('point-cloud/:itemId/file')
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
    if (upstream.contentType) res.setHeader('Content-Type', upstream.contentType);
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
