// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OfflinePackage } from '@prisma/client';
import type {
  OfflineArea,
  OfflinePackageSummary,
  OfflinePackageStatus,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Queue and read model for offline basemap packages (#70).
 *
 * Deliberately free of storage and HTTP so that both the API module
 * and the worker module can hold it without either dragging the
 * other's dependencies along.
 */

/**
 * How long a build may go without a heartbeat before the sweep
 * declares its worker dead.
 *
 * Generous because the two slow phases are both network-bound
 * against an upstream archive: the size check runs a few seconds and
 * the download of a cap-sized area a couple of minutes, and both beat
 * on either side. A healthy build never comes close.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

@Injectable()
export class OfflinePackageService {
  private readonly log = new Logger(OfflinePackageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queue a build for one area.
   *
   * Returns the existing row when a build for the area is already
   * queued or running, rather than a second one. That is enforced by
   * a partial unique index, so this is not a check-then-act race: a
   * concurrent insert loses at the database and lands here.
   */
  async enqueue(input: {
    orgId: string;
    itemId: string;
    area: OfflineArea;
    createdBy: string;
    sourceUrl: string;
  }): Promise<{ package: OfflinePackage; alreadyQueued: boolean }> {
    try {
      const row = await this.prisma.offlinePackage.create({
        data: {
          orgId: input.orgId,
          itemId: input.itemId,
          areaId: input.area.id,
          createdBy: input.createdBy,
          bbox: input.area.bbox,
          minZoom: input.area.minZoom,
          maxZoom: input.area.maxZoom,
          sourceUrl: input.sourceUrl,
        },
      });
      return { package: row, alreadyQueued: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.offlinePackage.findFirst({
          where: {
            itemId: input.itemId,
            areaId: input.area.id,
            status: { in: ['queued', 'building'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        // The losing insert and the winning one can interleave with
        // the winner finishing, in which case there is no active row
        // left to return. Retrying once is correct rather than
        // reporting a conflict that has already resolved.
        if (existing) return { package: existing, alreadyQueued: true };
        const retry = await this.prisma.offlinePackage.create({
          data: {
            orgId: input.orgId,
            itemId: input.itemId,
            areaId: input.area.id,
            createdBy: input.createdBy,
            bbox: input.area.bbox,
            minZoom: input.area.minZoom,
            maxZoom: input.area.maxZoom,
            sourceUrl: input.sourceUrl,
          },
        });
        return { package: retry, alreadyQueued: false };
      }
      throw err;
    }
  }

  /**
   * Claim the oldest queued build.
   *
   * Raw SELECT ... FOR UPDATE SKIP LOCKED for the pick, then a typed
   * Prisma update inside the same transaction for the flip, matching
   * ImportJobsService.claimNext.
   */
  async claimNext(): Promise<OfflinePackage | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id
          FROM offline_package
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );
      if (rows.length === 0) return null;
      const id = rows[0]!.id;
      return tx.offlinePackage.update({
        where: { id },
        data: {
          status: 'building',
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
      });
    });
  }

  /** Beat, and record the tile count once the size check knows it. */
  async beat(id: string, tileCount?: number): Promise<void> {
    await this.prisma.offlinePackage.updateMany({
      where: { id, status: 'building' },
      data: {
        lastHeartbeatAt: new Date(),
        ...(tileCount === undefined ? {} : { tileCount }),
      },
    });
  }

  /**
   * Promote a finished build and demote the one it replaces.
   *
   * Both flips happen in one transaction, and the demotion is scoped
   * to rows that are `ready` and not this one. If it ran the other
   * way round, a crash between the two statements would leave the
   * area with no current package at all, which reads to a collector
   * as the area having been deleted.
   */
  async markReady(
    id: string,
    storageKey: string,
    sizeBytes: number,
    tileCount: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.offlinePackage.update({
        where: { id },
        data: {
          status: 'ready',
          storageKey,
          sizeBytes,
          tileCount,
          finishedAt: new Date(),
          errorMessage: null,
        },
      });
      await tx.offlinePackage.updateMany({
        where: {
          itemId: row.itemId,
          areaId: row.areaId,
          status: 'ready',
          id: { not: id },
        },
        data: { status: 'superseded' },
      });
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.prisma.offlinePackage.updateMany({
      where: { id, status: 'building' },
      data: {
        status: 'failed',
        // Truncated: the builder puts the tail of the upstream tool's
        // stderr in here and that can run to kilobytes.
        errorMessage: message.slice(0, 2000),
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Fail builds whose worker died.
   *
   * Must not be boot-only. The container restarts in seconds, so at
   * boot a crashed build's heartbeat is still fresh and the staleness
   * threshold skips it forever; the worker calls this periodically
   * for that reason.
   */
  async recoverStale(maxAgeMs: number = STALE_AFTER_MS): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.prisma.offlinePackage.findMany({
      where: {
        status: 'building',
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          { lastHeartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
    });
    if (stale.length === 0) return;
    await this.prisma.offlinePackage.updateMany({
      // Guard on 'building' so a build that finishes between the read
      // above and this write is not flipped to failed after having
      // already published its archive.
      where: { id: { in: stale.map((s) => s.id) }, status: 'building' },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage:
          'The server stopped while building this package. Build it again to retry.',
      },
    });
    this.log.warn(
      `Recovered ${stale.length} stale offline package build${
        stale.length === 1 ? '' : 's'
      } as failed.`,
    );
  }

  /**
   * Areas whose newest ready package has aged past their refresh
   * interval, so the sweep can queue a rebuild.
   *
   * Returns item ids only. Resolving which areas within an item are
   * due needs the item's data JSON, which the caller reads anyway to
   * get the bbox it must queue with.
   */
  async itemsWithPackages(): Promise<string[]> {
    const rows = await this.prisma.offlinePackage.findMany({
      where: { status: 'ready' },
      select: { itemId: true },
      distinct: ['itemId'],
    });
    return rows.map((r) => r.itemId);
  }

  /** Every package for an item, newest first. */
  async listForItem(itemId: string): Promise<OfflinePackage[]> {
    return this.prisma.offlinePackage.findMany({
      where: { itemId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async byId(id: string): Promise<OfflinePackage | null> {
    return this.prisma.offlinePackage.findUnique({ where: { id } });
  }

  /**
   * Drop rows for areas the author has deleted, and demote the
   * archives they point at so the orphan sweep can reclaim them.
   *
   * Called when a data_collection's areas are saved. Returns the
   * storage keys that are now unreferenced.
   */
  async pruneMissingAreas(
    itemId: string,
    keepAreaIds: string[],
  ): Promise<string[]> {
    const doomed = await this.prisma.offlinePackage.findMany({
      where: { itemId, areaId: { notIn: keepAreaIds } },
      select: { id: true, storageKey: true },
    });
    if (doomed.length === 0) return [];
    await this.prisma.offlinePackage.deleteMany({
      where: { id: { in: doomed.map((d) => d.id) } },
    });
    return doomed
      .map((d) => d.storageKey)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
  }

  /** Map a row to the wire shape. */
  toWire(row: OfflinePackage): OfflinePackageSummary {
    return {
      id: row.id,
      areaId: row.areaId,
      status: row.status as OfflinePackageStatus,
      bbox: [
        row.bbox[0] ?? 0,
        row.bbox[1] ?? 0,
        row.bbox[2] ?? 0,
        row.bbox[3] ?? 0,
      ],
      minZoom: row.minZoom,
      maxZoom: row.maxZoom,
      tileCount: row.tileCount,
      sizeBytes: row.sizeBytes,
      error: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}
