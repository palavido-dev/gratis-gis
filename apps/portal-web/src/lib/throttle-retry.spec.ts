// SPDX-License-Identifier: AGPL-3.0-or-later
import { fetchWithThrottleRetry, retryAfterMs } from './throttle-retry';

const r = (status: number, retryAfter?: string) =>
  new Response(null, {
    status,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  });

describe('fetchWithThrottleRetry', () => {
  it('waits the named time and retries a 429', async () => {
    const replies = [r(429, '2'), r(429), r(200)];
    const waits: number[] = [];
    const res = await fetchWithThrottleRetry(async () => replies.shift()!, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(waits).toEqual([2000, 5000]);
  });

  it('does not retry other failures', async () => {
    let calls = 0;
    const res = await fetchWithThrottleRetry(async () => {
      calls += 1;
      return r(403);
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });

  it('gives up after the attempt limit and returns the 429', async () => {
    let calls = 0;
    const res = await fetchWithThrottleRetry(
      async () => {
        calls += 1;
        return r(429, '1');
      },
      { attempts: 3, sleep: async () => undefined },
    );
    expect(res.status).toBe(429);
    expect(calls).toBe(3);
  });

  it('bounds Retry-After', () => {
    expect(retryAfterMs(r(429, '9999'))).toBe(60_000);
    expect(retryAfterMs(r(429, 'soon'))).toBe(5_000);
  });
});
