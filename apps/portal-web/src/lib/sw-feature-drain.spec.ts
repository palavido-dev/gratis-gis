// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The service worker's Background Sync drain of the feature queue
 * (public/sw.js drainFeatureQueue), against the same fake IndexedDB
 * the page's offline store writes to.
 *
 * The worker is plain JavaScript, so it is loaded as text and run in a
 * VM context, as sw-caching.spec.ts does. Rows are seeded through the
 * real offline-store module, so the worker reads exactly what the page
 * would have written.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import {
  enqueueEdit,
  listQueueAllOwners,
  setOfflineIdentity,
  updateQueueRecord,
  type FeatureEditInput,
} from './offline-store';

const SW_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'public', 'sw.js'),
  'utf8',
);
const ORIGIN = 'https://portal.example.test';
const DC = 'deployment-1';
const USER = 'user-alice';

type Handler = (event: unknown) => void;
type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function loadWorker(fetchMock: FetchMock): { sync(): Promise<unknown> } {
  const handlers = new Map<string, Handler[]>();
  const self = {
    location: new URL('/sw.js?v=1', ORIGIN),
    addEventListener(type: string, fn: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
    registration: {},
  };
  const context = createContext({
    self,
    caches: { open: async () => ({}), keys: async () => [] },
    fetch: fetchMock,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
  });
  runInContext(SW_SOURCE, context);
  return {
    sync() {
      let done: Promise<unknown> = Promise.resolve();
      for (const fn of handlers.get('sync') ?? []) {
        fn({
          tag: 'gg-offline-queue',
          waitUntil(p: Promise<unknown>) {
            done = p;
          },
        });
      }
      return done;
    },
  };
}

function edit(over: Partial<FeatureEditInput> = {}): FeatureEditInput {
  return {
    dataCollectionId: DC,
    op: 'insert',
    dataLayerId: 'dl-1',
    layerKey: 'main',
    globalId: 'feature-1',
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { species: 'oak' },
    schemaHash: 'hash-1',
    ownerUserId: USER,
    ...over,
  };
}

type Body = { features?: Array<{ globalId: string; properties: Record<string, unknown> }> };
const sentBody = (init?: RequestInit): Body =>
  JSON.parse(String(init?.body ?? '{}')) as Body;

let fetchMock: FetchMock;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  fetchMock = jest.fn();
  await setOfflineIdentity(USER);
});

/** feature-w is queued strictly before feature-x so the drain reaches
 *  it first; rows queued in the same millisecond have no fixed order. */
async function queueWThenX(): Promise<void> {
  const w = await enqueueEdit(edit({ globalId: 'feature-w' }));
  if (w.kind !== 'queued') throw new Error('expected a fresh row');
  await updateQueueRecord({ ...w.record, queuedAt: '2000-01-01T00:00:00.000Z' });
  await enqueueEdit(edit({ globalId: 'feature-x', properties: { species: 'old' } }));
}

/** Hold feature-w's POST until released, so an edit can be saved while
 *  the drain is mid-run. */
function holdW() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const reachedGate = new Promise<void>((r) => (reached = r));
  return {
    release,
    reached: reachedGate,
    async maybeHold(init?: RequestInit) {
      if (sentBody(init).features?.[0]?.globalId === 'feature-w') {
        reached();
        await gate;
      }
    },
  };
}

describe('sw.js drainFeatureQueue: edit folded in after the queue was listed', () => {
  it('sends the newer values once and leaves no row behind', async () => {
    await queueWThenX();
    const hold = holdW();
    fetchMock.mockImplementation(async (_url, init) => {
      await hold.maybeHold(init);
      return new Response('{"inserted":1}', { status: 201 });
    });
    const worker = loadWorker(fetchMock);

    const run = worker.sync();
    await hold.reached;
    const folded = await enqueueEdit(
      edit({ op: 'update', globalId: 'feature-x', geometry: null, properties: { species: 'new' } }),
    );
    expect(folded.kind).toBe('folded');
    hold.release();
    await run;

    const xBodies = fetchMock.mock.calls
      .map(([, init]) => sentBody(init).features?.[0])
      .filter((f) => f?.globalId === 'feature-x');
    expect(xBodies).toHaveLength(1);
    expect(xBodies[0]!.properties).toEqual({ species: 'new' });
    expect(await listQueueAllOwners(DC)).toEqual([]);
  });

  it('keeps the newer values queued when the send cannot reach the network', async () => {
    await queueWThenX();
    const hold = holdW();
    fetchMock.mockImplementation(async (_url, init) => {
      await hold.maybeHold(init);
      if (sentBody(init).features?.[0]?.globalId === 'feature-x') {
        throw new TypeError('Failed to fetch');
      }
      return new Response('{"inserted":1}', { status: 201 });
    });
    const worker = loadWorker(fetchMock);

    const run = worker.sync().catch(() => undefined); // asks for a retry
    await hold.reached;
    await enqueueEdit(
      edit({ op: 'update', globalId: 'feature-x', geometry: null, properties: { species: 'new' } }),
    );
    hold.release();
    await run;

    const rows = await listQueueAllOwners(DC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.globalId).toBe('feature-x');
    expect(rows[0]!.syncStatus).toBe('pending');
    expect(rows[0]!.properties).toEqual({ species: 'new' });
  });

  it('sends the data collection header on a queued insert', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(new Response('{"inserted":1}', { status: 201 }));
    await loadWorker(fetchMock).sync();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['x-data-collection-id']).toBe(DC);
  });
});
