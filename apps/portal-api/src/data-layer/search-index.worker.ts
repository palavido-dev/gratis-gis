// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { SearchIndexJobsService } from './search-index-jobs.service.js';

/** Builds are rare and admin-clicked, so a slow poll is fine. */
const POLL_INTERVAL_MS = 5_000;

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

  constructor(private readonly jobs: SearchIndexJobsService) {}

  async onModuleInit() {
    const n = await this.jobs.failInterrupted().catch((err) => {
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
        const job = await this.jobs.claimNext();
        if (job) {
          await this.jobs.run(job);
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
}
