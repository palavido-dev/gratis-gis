// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  OfflineAreaWithPackage,
  OfflinePackageSummary,
} from '@gratis-gis/shared-types';
import {
  OFFLINE_PACKAGE_MAX_TILES,
  validateOfflineArea,
} from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';
import { OfflinePackageService } from './offline-package.service.js';
import { readAreas } from './offline-package.worker.js';
import { resolveBasemapSource } from './basemap-source.js';

/**
 * Offline basemap packages for a data_collection (#70).
 *
 * Read endpoints require `canRead` on the deployment, because a
 * collector who can open a deployment is exactly who needs to take
 * it offline. Queueing a build requires `canEdit`: it costs server
 * time and upstream bandwidth, so it belongs to the author.
 *
 * The archive is served from here rather than from the generic
 * private-storage route because the item that owns a package is
 * found through the offline_package table, not through a key stored
 * on the item. Bending the generic route to know about that would
 * have widened a path whose whole job is to be narrow.
 */
@Controller('items')
export class OfflinePackageController {
  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly storage: StorageService,
    private readonly packages: OfflinePackageService,
  ) {}

  /** Areas on this deployment, each with its current build. */
  @Get(':itemId/offline-areas')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
  ): Promise<{ areas: OfflineAreaWithPackage[]; maxTiles: number }> {
    const item = await this.items.get(user, itemId);
    if (!item) throw new NotFoundException('Item not found');
    if (!(await this.sharing.canRead(user, item, item.shares ?? []))) {
      throw new ForbiddenException('You cannot read this item');
    }
    const areas = readAreas(item.data);
    const rows = await this.packages.listForItem(itemId);

    const forArea = (areaId: string): OfflineAreaWithPackage['current'] => {
      const row = rows.find((r) => r.areaId === areaId && r.status === 'ready');
      return row ? this.packages.toWire(row) : null;
    };

    return {
      areas: areas.map((area) => {
        const pendingRow = rows.find(
          (r) =>
            r.areaId === area.id &&
            (r.status === 'queued' || r.status === 'building'),
        );
        const failedRow = rows.find(
          (r) => r.areaId === area.id && r.status === 'failed',
        );
        const current = forArea(area.id);
        return {
          area,
          current,
          pending: pendingRow ? this.packages.toWire(pendingRow) : null,
          // A stale failure sitting next to a working package is
          // noise: the author already dealt with it by rebuilding.
          // Only surface a failure that is the latest word.
          lastFailure:
            failedRow &&
            !pendingRow &&
            (!current ||
              failedRow.createdAt >
                new Date(current.finishedAt ?? current.createdAt))
              ? this.packages.toWire(failedRow)
              : null,
        };
      }),
      maxTiles: OFFLINE_PACKAGE_MAX_TILES,
    };
  }

  /**
   * Queue a build for one area.
   *
   * Idempotent: a second call while a build is in flight returns the
   * build already running rather than starting another. That is
   * enforced by a partial unique index, not by a check here, so a
   * double click and the automatic-refresh sweep cannot race.
   */
  @Post(':itemId/offline-areas/:areaId/build')
  async build(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('areaId') areaId: string,
  ): Promise<{ package: OfflinePackageSummary; alreadyQueued: boolean }> {
    const item = await this.items.get(user, itemId);
    if (!item) throw new NotFoundException('Item not found');
    if (!(await this.sharing.canEdit(user, item, item.shares ?? []))) {
      throw new ForbiddenException('You cannot edit this item');
    }
    const area = readAreas(item.data).find((a) => a.id === areaId);
    if (!area) throw new NotFoundException('Offline area not found');
    // Re-validated server-side. The authoring UI checks the same
    // rules, but an area can also arrive through a direct PATCH of
    // the item, which never passes through that UI.
    const problem = validateOfflineArea(area);
    if (problem) throw new BadRequestException(problem);

    const sourceUrl = await resolveBasemapSource();
    const result = await this.packages.enqueue({
      orgId: item.orgId,
      itemId,
      area,
      createdBy: user.id,
      sourceUrl,
    });
    return {
      package: this.packages.toWire(result.package),
      alreadyQueued: result.alreadyQueued,
    };
  }

  /**
   * Stream the built archive.
   *
   * Range reads are the point: PMTiles is read by byte range, so a
   * client that only needs part of the archive asks for part of it.
   * The response mirrors the upstream status so a 206 stays a 206.
   */
  @Get(':itemId/offline-packages/:packageId/file')
  async serve(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Param('packageId') packageId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const row = await this.packages.byId(packageId);
    // Checking the package belongs to the item in the path stops the
    // id alone from being a read primitive over every package in the
    // instance: without it, any item the caller can read would
    // authorize any package anywhere.
    if (!row || row.itemId !== itemId) {
      throw new NotFoundException('Package not found');
    }
    if (!row.storageKey || row.status === 'failed') {
      throw new NotFoundException('This package has not been built yet');
    }
    const item = await this.items.get(user, itemId);
    if (!item) throw new NotFoundException('Item not found');
    if (!(await this.sharing.canRead(user, item, item.shares ?? []))) {
      throw new ForbiddenException('You cannot read this item');
    }

    const upstream = await this.storage.streamObject(row.storageKey, rangeHeader);
    res.status(upstream.statusCode);
    if (upstream.contentRange) {
      res.setHeader('Content-Range', upstream.contentRange);
    }
    if (upstream.contentLength !== undefined) {
      res.setHeader('Content-Length', String(upstream.contentLength));
    }
    if (upstream.etag) res.setHeader('ETag', upstream.etag);
    res.setHeader('Content-Type', 'application/vnd.pmtiles');
    // Never inline: the bytes are an opaque archive, and letting the
    // browser decide how to treat a stored file served from this
    // origin is how a storage route becomes an XSS route.
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', upstream.acceptRanges ?? 'bytes');
    // A package is immutable once built: a rebuild writes a new row
    // with a new id, so this URL's bytes never change. `private`
    // because the ACL is per-caller and a shared cache must not
    // hand the archive to someone who cannot read the deployment.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');

    try {
      upstream.body.pipe(res);
      await new Promise<void>((resolve, reject) => {
        upstream.body.on('end', resolve);
        upstream.body.on('error', reject);
        res.on('close', () => {
          // A collector who cancels a download leaves an in-flight
          // read; destroy it so the socket returns to the pool
          // rather than draining a whole archive nobody wants.
          upstream.body.destroy();
          resolve();
        });
      });
    } catch (err) {
      if (!req.destroyed) {
        // eslint-disable-next-line no-console
        console.error('offline package stream error', err);
      }
      try {
        res.end();
      } catch {
        /* response may already be closed */
      }
    }
  }
}
