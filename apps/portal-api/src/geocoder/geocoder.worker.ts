// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { runAsSystem } from '../common/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { geofabrikRegions } from './geocoder-regions.js';
import { buildArgs, GeocoderRunner } from './geocoder-runner.js';
import {
  GEOCODER_LOG_LINES,
  readGeocoderSetting,
  refreshDue,
  writeGeocoderSetting,
  type GeocoderSettings,
} from './geocoder-settings.js';

const POLL_MS = 10_000;
const LOG_FLUSH_MS = 3_000;
/** Build buffer budget. The worker also runs imports in the same 3.5 GiB. */
const BUILD_MEMORY_MB = 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Builds and serves the managed geocoder in portal-worker.
 *
 * The admin page writes the choices and sets status `queued`. This
 * loop, on the leader, notices, downloads the extracts, builds the
 * pack and restarts the server. Every worker serves whatever pack is
 * on disk.
 */
@Injectable()
export class GeocoderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(GeocoderWorker.name);
  private readonly runner = new GeocoderRunner();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(await this.runner.available())) {
      this.log.log(
        `open-geocode is not installed at ${this.runner.paths.bin}; the managed geocoder is off.`,
      );
      return;
    }
    await this.runner.startServer();
    await runAsSystem('geocoder-recover', () => this.recoverInterrupted()).catch((err) =>
      this.log.warn(`Could not check the geocoder build state: ${String(err)}`),
    );
    this.running = true;
    void this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.runner.stopServer();
  }

  /** A build that was mid-way when the worker stopped will not finish. */
  private async recoverInterrupted(): Promise<void> {
    const { settings } = await readGeocoderSetting(this.prisma);
    if (settings.status === 'downloading' || settings.status === 'building') {
      await writeGeocoderSetting(this.prisma, {
        status: 'failed',
        statusMessage: 'The worker restarted during the build. Start it again.',
      });
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (this.leader.shouldRun()) {
          await runAsSystem('geocoder-poll', () => this.tick());
        }
      } catch (err) {
        this.log.warn(`Geocoder poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(POLL_MS);
    }
  }

  private async tick(): Promise<void> {
    const stored = await readGeocoderSetting(this.prisma);
    let { settings } = stored;
    if (settings.status === 'none' && settings.regions.length === 0) {
      const seeded = await this.seedFromEnv();
      if (!seeded) return;
      settings = seeded;
    }
    if (refreshDue(settings)) {
      settings = await writeGeocoderSetting(this.prisma, {
        status: 'queued',
        statusMessage: 'Scheduled refresh',
      });
    }
    if (settings.status !== 'queued' || settings.regions.length === 0) return;
    await this.build(settings, stored.oaToken);
  }

  /**
   * GEOCODER_REGIONS (comma-separated Geofabrik ids, for example
   * `us/west-virginia`) sets up a portal whose admin page is locked,
   * such as a public demo. Only used while nothing has been chosen.
   */
  private async seedFromEnv(): Promise<GeocoderSettings | null> {
    const ids = (process.env.GEOCODER_REGIONS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return null;
    const all = await geofabrikRegions();
    const regions = ids.flatMap((id) => {
      const r = all.find((x) => x.id === id);
      return r ? [{ id: r.id, name: r.name, pbfUrl: r.pbfUrl }] : [];
    });
    if (regions.length === 0) {
      this.log.warn(`GEOCODER_REGIONS names no known Geofabrik region: ${ids.join(', ')}`);
      return null;
    }
    this.log.log(`Seeding the managed geocoder from GEOCODER_REGIONS: ${ids.join(', ')}`);
    return writeGeocoderSetting(this.prisma, {
      regions,
      tiger: process.env.GEOCODER_TIGER?.trim() !== '0',
      status: 'queued',
      statusMessage: 'Set up from the server configuration',
    });
  }

  private async build(settings: GeocoderSettings, oaToken: string | null): Promise<void> {
    const lines: string[] = [];
    let lastFlush = 0;
    const flush = async (patch: Partial<GeocoderSettings> = {}, force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < LOG_FLUSH_MS) return;
      lastFlush = now;
      await writeGeocoderSetting(this.prisma, { ...patch, log: lines.slice(-GEOCODER_LOG_LINES) });
    };
    const note = (line: string) => {
      lines.push(line);
      if (lines.length > GEOCODER_LOG_LINES * 2) lines.splice(0, lines.length - GEOCODER_LOG_LINES);
    };

    const startedAt = new Date().toISOString();
    const useOa = settings.openAddresses && Boolean(oaToken);
    try {
      await flush(
        { status: 'downloading', statusMessage: 'Downloading map data', startedAt },
        true,
      );
      const inputs: string[] = [];
      for (const region of settings.regions) {
        note(`Downloading ${region.name}`);
        let lastPct = -1;
        const path = await this.runner.download(region, (bytes, total) => {
          const pct = total ? Math.floor((bytes / total) * 100) : -1;
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            void flush({
              statusMessage: total
                ? `Downloading ${region.name}: ${pct}% of ${mb(total)}`
                : `Downloading ${region.name}: ${mb(bytes)}`,
            });
          }
        });
        inputs.push(path);
      }
      if (settings.openAddresses && !oaToken) {
        note('OpenAddresses is on but no token is saved; building without it.');
      }
      await flush({ status: 'building', statusMessage: 'Building the address index' }, true);
      const args = buildArgs(inputs, this.runner.packDir, {
        tiger: settings.tiger,
        openAddresses: useOa,
        memoryBudgetMb: BUILD_MEMORY_MB,
      });
      await this.runner.build(args, useOa && oaToken ? { OA_TOKEN: oaToken } : {}, (line) => {
        note(line);
        void flush();
      });
      await this.runner.restartServer();
      await this.runner.tidy();
      const packBytes = await this.runner.packBytes();
      note('Build finished.');
      await flush(
        {
          status: 'ready',
          statusMessage: null,
          builtAt: new Date().toISOString(),
          builtRegions: settings.regions.map((r) => r.id),
          packBytes,
        },
        true,
      );
      this.log.log(`Managed geocoder built: ${settings.regions.map((r) => r.id).join(', ')}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      note(`Build failed: ${msg}`);
      this.log.warn(`Managed geocoder build failed: ${msg}`);
      await flush(
        { status: 'failed', statusMessage: msg.split('\n').pop()?.slice(0, 300) ?? 'Build failed' },
        true,
      ).catch(() => undefined);
      // A failed build leaves the previous pack in place and serving.
      if (!(await this.runner.hasPack())) return;
      await this.runner.startServer();
    }
  }
}
