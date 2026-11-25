// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SearchIndexWorker,
  STALE_BUILD_MS,
  STALE_SWEEP_INTERVAL_MS,
} from './search-index.worker.js';
import type { SearchIndexJobsService } from './search-index-jobs.service.js';

describe('SearchIndexWorker stale build sweep', () => {
  function worker(count = 0) {
    const failStale = jest.fn(async () => count);
    const w = new SearchIndexWorker({ failStale } as unknown as SearchIndexJobsService);
    return { w, failStale };
  }

  it('fails builds older than the limit, at most once per interval', async () => {
    const { w, failStale } = worker(1);
    const t0 = 1_000_000_000_000;
    expect(await w.sweepStale(t0)).toBe(1);
    expect(failStale).toHaveBeenCalledWith(STALE_BUILD_MS, new Date(t0));
    expect(await w.sweepStale(t0 + STALE_SWEEP_INTERVAL_MS - 1)).toBe(0);
    expect(failStale).toHaveBeenCalledTimes(1);
    await w.sweepStale(t0 + STALE_SWEEP_INTERVAL_MS);
    expect(failStale).toHaveBeenCalledTimes(2);
  });

  it('uses a limit far above a real build', () => {
    expect(STALE_BUILD_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});
