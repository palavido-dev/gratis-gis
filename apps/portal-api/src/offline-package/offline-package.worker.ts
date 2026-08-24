// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { OfflinePackage } from '@prisma/client';
import type { DataCollectionData, OfflineArea } from '@gratis-gis/shared-types';
import { OFFLINE_PACKAGE_MAX_TILES } from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { OfflinePackageService } from './offline-package.service.js';
import { isReachable, resolveBasemapSource } from './basemap-source.js';

/**
 * Builds offline basemap packages (#70).
 *
 * One build is two `pmtiles extract` calls against a remote archive:
 *
 *   1. `--dry-run`, which resolves the tile list over a handful of
 *      range reads and reports the count without downloading any of
 *      it. This is the size guard, and it is why an author who draws
 *      half a continent is told so in seconds.
 *   2. The real extract, which writes a self-contained archive.
 *
 * Then the archive goes to object storage and the row flips to
 * `ready`, demoting whatever package the area was serving before.
 *
 * Reading the upstream archive over HTTP rather than holding a local
 * copy is the whole trick: PMTiles is designed for range reads, so a
 * 4,000 km2 cutout of a 137 GB planet costs about 50 requests and
 * 9 MB of transfer.
 */

/** Poll interval. Builds are seconds-to-minutes, so this is fine. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Loop iterations between maintenance sweeps, about a minute at the
 * poll above. Covers both the stale-build recovery and the
 * automatic-refresh check.
 */
const SWEEP_EVERY_TICKS = 12;

/** Hard ceiling on the real extract, independent of tile count. */
const EXTRACT_TIMEOUT_MS = 20 * 60 * 1000;

/** The dry run only reads directories, so it should be quick. */
const DRY_RUN_TIMEOUT_MS = 3 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class OfflinePackageWorker implements OnModuleInit {
  private readonly log = new Logger(OfflinePackageWorker.name);
  private ticksSinceSweep = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly packages: OfflinePackageService,
  ) {}

  async onModuleInit() {
    await this.packages.recoverStale().catch((err) => {
      this.log.warn(`Stale-build recovery on boot failed: ${msg(err)}`);
    });
    this.running = true;
    // Detached: the loop lives as long as the process.
    void this.loop();
    this.log.log('Offline package worker started (5s poll interval).');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.ticksSinceSweep += 1;
        if (this.ticksSinceSweep >= SWEEP_EVERY_TICKS) {
          this.ticksSinceSweep = 0;
          await this.packages.recoverStale().catch((err) => {
            this.log.warn(`Periodic stale-build recovery failed: ${msg(err)}`);
          });
          await this.queueDueRefreshes().catch((err) => {
            this.log.warn(`Automatic refresh sweep failed: ${msg(err)}`);
          });
        }
        const job = await this.packages.claimNext();
        if (job) {
          await this.build(job).catch(async (err) => {
            // build() flips the row itself. Anything escaping here is
            // the markFailed call having thrown; keep the loop alive.
            this.log.error(
              `Unhandled error building package ${job.id}: ${msg(err)}`,
              err instanceof Error ? err.stack : undefined,
            );
          });
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        this.log.warn(`Offline package poll errored, backing off: ${msg(err)}`);
        await sleep(15_000);
      }
    }
  }

  private async build(job: OfflinePackage): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'offline-package-'));
    const outPath = join(workDir, 'basemap.pmtiles');
    try {
      const source = await this.sourceFor(job);
      const bbox = job.bbox.slice(0, 4).join(',');
      const commonArgs = [
        'extract',
        source,
        outPath,
        `--bbox=${bbox}`,
        `--minzoom=${job.minZoom}`,
        `--maxzoom=${job.maxZoom}`,
      ];

      // Size guard. The dry run reports the exact tile list without
      // fetching the tiles, so an oversized area costs a few seconds
      // rather than a filled disk. Checking here rather than only in
      // the authoring UI matters because the automatic refresh sweep
      // queues builds with nobody watching.
      const probe = await this.run(
        'pmtiles',
        [...commonArgs, '--dry-run'],
        DRY_RUN_TIMEOUT_MS,
      );
      const tileCount = parseRegionTiles(probe);
      if (tileCount === null) {
        throw new Error(
          `Could not read the tile count from the basemap tool. Output was:\n${probe.slice(-800)}`,
        );
      }
      await this.packages.beat(job.id, tileCount);
      if (tileCount > OFFLINE_PACKAGE_MAX_TILES) {
        throw new Error(
          `This area needs ${tileCount.toLocaleString()} tiles, over the limit of ` +
            `${OFFLINE_PACKAGE_MAX_TILES.toLocaleString()}. Lower the highest detail ` +
            `level or draw a smaller area.`,
        );
      }
      if (tileCount === 0) {
        throw new Error(
          'The basemap has no coverage for this area. Check the extent.',
        );
      }

      await this.run('pmtiles', commonArgs, EXTRACT_TIMEOUT_MS);
      await this.packages.beat(job.id);

      const { size } = await stat(outPath);
      const { key } = await this.storage.uploadLocalFile(
        'offline-package',
        outPath,
        'application/vnd.pmtiles',
      );
      await this.packages.markReady(job.id, key, size, tileCount);
      this.log.log(
        `Built offline package ${job.id} for item ${job.itemId} area ${job.areaId}: ` +
          `${tileCount} tiles, ${(size / 1024 / 1024).toFixed(1)} MB.`,
      );
    } catch (err) {
      await this.packages.markFailed(job.id, msg(err));
      this.log.warn(`Offline package ${job.id} failed: ${msg(err)}`);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The archive to cut from.
   *
   * The row records what was chosen when the build was queued, but a
   * daily upstream build is retained about a week, so a row that sat
   * in the queue over a weekend, or an automatic refresh queued from
   * a months-old row, can point at something that has since gone.
   * Re-resolving on a miss turns that from a build failure the author
   * has to notice and retry into nothing at all.
   */
  private async sourceFor(job: OfflinePackage): Promise<string> {
    if (await isReachable(job.sourceUrl)) return job.sourceUrl;
    const fresh = await resolveBasemapSource();
    this.log.log(
      `Basemap source ${job.sourceUrl} is gone; using ${fresh} for package ${job.id}.`,
    );
    await this.prisma.offlinePackage.update({
      where: { id: job.id },
      data: { sourceUrl: fresh },
    });
    return fresh;
  }

  /**
   * Queue rebuilds for areas whose package has aged past the
   * author's refresh interval.
   *
   * Only areas with a ready package are considered: an area that has
   * never built successfully, or whose last build failed, is the
   * author's to retry, and re-queueing it on a timer would hide a
   * persistent failure behind an endlessly retrying job.
   */
  private async queueDueRefreshes(): Promise<void> {
    const itemIds = await this.packages.itemsWithPackages();
    if (itemIds.length === 0) return;
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds }, deletedAt: null },
      select: { id: true, orgId: true, ownerId: true, data: true },
    });
    for (const item of items) {
      const areas = readAreas(item.data);
      if (areas.length === 0) continue;
      const rows = await this.packages.listForItem(item.id);
      for (const area of areas) {
        if (!area.refreshDays) continue;
        // A build already in flight, or a failure the author has not
        // dealt with, both mean hands off.
        if (
          rows.some(
            (r) =>
              r.areaId === area.id &&
              (r.status === 'queued' || r.status === 'building'),
          )
        ) {
          continue;
        }
        const current = rows.find(
          (r) => r.areaId === area.id && r.status === 'ready',
        );
        if (!current?.finishedAt) continue;
        const ageMs = Date.now() - current.finishedAt.getTime();
        if (ageMs < area.refreshDays * 24 * 60 * 60 * 1000) continue;
        const sourceUrl = await resolveBasemapSource();
        await this.packages.enqueue({
          orgId: item.orgId,
          itemId: item.id,
          area,
          // Attributed to the item's owner rather than to whoever
          // last pressed a button: nobody pressed one.
          createdBy: item.ownerId,
          sourceUrl,
        });
        this.log.log(
          `Queued automatic rebuild of area "${area.name}" on item ${item.id} ` +
            `(package was ${Math.floor(ageMs / 86_400_000)} days old).`,
        );
      }
    }
  }

  /**
   * Run an external command, returning its combined output.
   *
   * Duplicated from the pyramid worker rather than shared, for the
   * same reason that one duplicated it from tile-conversion: keeping
   * the worker's imports down to Prisma and Storage is what lets it
   * ship without the API's HTTP and auth graph.
   *
   * The go-pmtiles CLI logs progress to stderr, including the tile
   * count this build parses, so both streams are captured and
   * returned together instead of stderr being kept only for errors.
   */
  private run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const collect = (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.length > 64 * 1024) {
          // Keep the tail: the count and any error land at the end.
          out = `...${out.slice(-32 * 1024)}`;
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `${cmd} did not finish within ${Math.round(timeoutMs / 60000)} minutes.`,
          ),
        );
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to run ${cmd}: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else {
          reject(
            new Error(
              `${cmd} exited with code ${code}${out ? `\n${out.trim()}` : ''}`,
            ),
          );
        }
      });
    });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pull the tile count out of the CLI's log output.
 *
 * The line is `Region tiles 1683, result tile entries 1683`. Parsed
 * rather than estimated because the estimate counts the bbox
 * rectangle while the archive only holds tiles that have data, so
 * over ocean or empty land the two differ by a lot, and the number
 * the size guard acts on has to be the real one.
 *
 * Returning null rather than 0 on no match keeps "the tool changed
 * its output" distinguishable from "this area is empty". Treating
 * them the same would silently disable the size guard.
 */
export function parseRegionTiles(output: string): number | null {
  const m = /Region tiles\s+(\d+)/i.exec(output);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Offline areas on a data_collection's data JSON, defensively. */
export function readAreas(data: unknown): OfflineArea[] {
  if (!data || typeof data !== 'object') return [];
  const areas = (data as Partial<DataCollectionData>).offlineAreas;
  if (!Array.isArray(areas)) return [];
  return areas.filter(
    (a): a is OfflineArea =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as OfflineArea).id === 'string' &&
      Array.isArray((a as OfflineArea).bbox) &&
      (a as OfflineArea).bbox.length === 4,
  );
}
