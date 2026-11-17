// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { fetchRetrying, mapWithConcurrency } from './request-pool';

describe('mapWithConcurrency', () => {
  it('never has more than the limit in flight and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const run = mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight -= 1;
      return n * 10;
    });
    // Release one waiting call at a time until all have finished.
    let released = 0;
    while (released < 7) {
      await new Promise<void>((r) => setImmediate(r));
      const g = gates.shift();
      if (g) {
        g();
        released += 1;
      }
    }
    expect(await run).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('fetchRetrying', () => {
  const sleep = jest.fn(async () => {});
  beforeEach(() => sleep.mockClear());

  it('waits out a 429 using Retry-After and returns the success', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(res(200));
    const out = await fetchRetrying('/x', undefined, { fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('returns the last failure after the final attempt', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(503));
    const out = await fetchRetrying('/x', undefined, { fetchImpl, sleep, attempts: 3 });
    expect(out.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx other than 429', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(404));
    const out = await fetchRetrying('/x', undefined, { fetchImpl, sleep });
    expect(out.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps a huge Retry-After', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '99999' }))
      .mockResolvedValueOnce(res(200));
    await fetchRetrying('/x', undefined, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('rethrows a network error once attempts run out', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('offline'));
    await expect(
      fetchRetrying('/x', undefined, { fetchImpl, sleep, attempts: 2 }),
    ).rejects.toThrow('offline');
  });
});
