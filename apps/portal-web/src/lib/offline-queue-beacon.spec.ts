// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The queue manifest beacon: that a large queue still gets through,
 * and that the throttle keeps the newest report instead of dropping it.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { enqueueEdit, putDeployment, updateQueueRecord } from './offline-store';

const USER = 'user-alice';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;
let fetchMock: FetchMock;
let beacon: typeof import('./offline-queue-beacon');

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  // The module only runs in a browser; give it the two pieces it reads.
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true, userAgent: 'jest' },
  });
  fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>(
    async () => new Response('{}', { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Fresh module state (the throttle window) for every case.
  jest.isolateModules(() => {
    beacon = jest.requireActual('./offline-queue-beacon');
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('postQueueManifest (53-3)', () => {
  it('sends a manifest over 64 KiB, without keepalive', async () => {
    for (const dc of ['dc-1', 'dc-2']) {
      await putDeployment({
        dataCollectionId: dc,
        title: dc,
        slug: dc,
        mapId: 'map',
        layerSchemas: {},
        cachedAt: '2026-11-01T00:00:00.000Z',
        estimatedSize: 0,
      });
      for (let i = 0; i < 200; i += 1) {
        const r = await enqueueEdit({
          dataCollectionId: dc,
          op: 'insert',
          dataLayerId: 'dl-1',
          layerKey: 'main',
          globalId: `${dc}-f${i}`,
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {},
          schemaHash: 'h',
          ownerUserId: USER,
        });
        if (r.kind !== 'queued') throw new Error('expected a fresh row');
        await updateQueueRecord({
          ...r.record,
          syncStatus: 'failed',
          retryCount: 3,
          failure: {
            code: 'sync.serverRefused',
            params: { detail: 'The value for "species" is not one of the allowed choices.' },
          } as never,
        });
      }
    }

    expect(await beacon.postQueueManifest(USER)).toBe(true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(String(init?.body).length).toBeGreaterThan(64 * 1024);
    expect(init?.keepalive).toBeUndefined();
    // 400 queued rows through fake-indexeddb is the point of this case
    // (the manifest must pass 64 KiB), and it can take over the 5 s
    // default on a busy CI runner.
  }, 30_000);
});

describe('postQueueManifestThrottled (53-6)', () => {
  /** Resolves once fetch has been called `n` times. */
  function posted(n: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (fetchMock.mock.calls.length >= n) resolve();
        else setImmediate(check);
      };
      check();
    });
  }

  it('sends a call made inside the window at the end of it', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    await beacon.postQueueManifestThrottled(USER);
    await posted(1);
    // A sync finishes two seconds later: its report must not be lost.
    jest.advanceTimersByTime(2_000);
    await beacon.postQueueManifestThrottled(USER);
    await beacon.postQueueManifestThrottled(USER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(8_000);
    await posted(2);
    // Two calls inside the window became one trailing post.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not hold the window shut after a failed post', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await beacon.postQueueManifestThrottled(USER);
    await posted(1);
    // Let the failed post's bookkeeping finish before the next call.
    await new Promise((r) => setImmediate(r));
    await beacon.postQueueManifestThrottled(USER);
    await posted(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
