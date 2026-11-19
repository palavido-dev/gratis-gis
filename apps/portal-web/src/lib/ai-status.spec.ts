// SPDX-License-Identifier: AGPL-3.0-or-later
import { fetchAiConfigured, invalidateAiStatus } from './ai-status';

describe('fetchAiConfigured', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateAiStatus();
  });

  it('asks once per page load and shares the answer', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ configured: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchAiConfigured()).resolves.toBe(true);
    await expect(fetchAiConfigured()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a refusal or a network error as not configured', async () => {
    globalThis.fetch = jest.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(fetchAiConfigured()).resolves.toBe(false);
    invalidateAiStatus();
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    await expect(fetchAiConfigured()).resolves.toBe(false);
  });

  it('asks again after the settings change', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: true })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchAiConfigured()).resolves.toBe(false);
    invalidateAiStatus();
    await expect(fetchAiConfigured()).resolves.toBe(true);
  });
});
