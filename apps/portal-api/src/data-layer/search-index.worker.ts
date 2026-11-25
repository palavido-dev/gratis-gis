// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { SearchIndexJobsService } from './search-index-jobs.service.js';
import { runAsOrg, runAsSystem } from '../common/tenant-context.js';

/** Builds are rare and admin-clicked, so a slow poll is fine. */
const POLL_INTERVAL_MS = 5_000;

/**
 * A build still 'running' this long after it started is failed by the
 * sweep in the loop below. Real builds take minutes.
 */
export const STALE_BUILD_MS = 6 * 60 * 60 * 1000;
/** How often the loop runs that sweep. */
export const STALE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Worker-side loop for queued "Build search indexes" requests (06-5).
 * Runs in the worker container only, one build at a time.
 */
@Injectable()
export class SearchIndexWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SearchIndexWorker.name);
  private running = false;
  private lastSweepAt = 0;

  constructor(private readonly jobs: SearchIndexJobsService) {}

  async onModuleInit() {
    const n = await runAsSystem('job-recover', () =>
      this.jobs.failInterrupted(),
    ).catch((err) => {
      this.log.warn(`Could not clear interrupted builds: ${String(err)}`);
      return 0;
    });
    if (n > 0) this.log.warn(`Marked ${n} interrupted search index build(s) failed.`);
    this.running = true;
    void this.loop();
  }

  onModuleDestroy() {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.sweepStale();
        const job = await runAsSystem('job-claim', () =>
          this.jobs.claimNext(),
        );
        if (job) {
          await runAsOrg(job.orgId, () => this.jobs.run(job));
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        this.log.warn(
          `Search index poll errored, backing off: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await sleep(15_000);
      }
    }
  }

  /**
   * Fail builds left 'running' for longer than STALE_BUILD_MS, at most
   * once per STALE_SWEEP_INTERVAL_MS. This worker runs one build at a
   * time and never sweeps during it, so its own build is never swept.
   */
  async sweepStale(now: number = Date.now()): Promise<number> {
    if (now - this.lastSweepAt < STALE_SWEEP_INTERVAL_MS) return 0;
    this.lastSweepAt = now;
    const n = await runAsSystem('job-recover', () =>
      this.jobs.failStale(STALE_BUILD_MS, new Date(now)),
    );
    if (n > 0) this.log.warn(`Marked ${n} stalled search index build(s) failed.`);
    return n;
  }
}
