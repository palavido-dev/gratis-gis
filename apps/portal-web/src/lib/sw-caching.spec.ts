// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Caching rules in public/sw.js.
 *
 * The worker is plain JavaScript served from /public, so it is loaded
 * here as text and run in a VM context with a small in-memory Cache
 * Storage. The real fetch, Request, Response and Headers from Node are
 * used, and fake-indexeddb (jest.setup.cjs) stands in for IndexedDB,
 * so the handlers run as written. Only the browser pieces a worker
 * gets from its global scope are stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const SW_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'public', 'sw.js'),
  'utf8',
);
const ORIGIN = 'https://portal.example.test';

class FakeCache {
  readonly entries = new Map<string, Response>();
  private key(req: Request | string): string {
    return typeof req === 'string' ? new URL(req, ORIGIN).href : req.url;
  }
  async match(req: Request | string): Promise<Response | undefined> {
    const hit = this.entries.get(this.key(req));
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request | string, res: Response): Promise<void> {
    // Like the real put, the body is read in full before it resolves.
    const body = await res.arrayBuffer();
    this.entries.set(
      this.key(req),
      new Response(body, { status: res.status, headers: res.headers }),
    );
  }
  async delete(req: Request | string): Promise<boolean> {
    return this.entries.delete(this.key(req));
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
  async addAll(): Promise<void> {}
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.stores.get(name);
    if (!c) {
      c = new FakeCache();
      this.stores.set(name, c);
    }
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }
}

type Handler = (event: unknown) => void;

interface LoadedWorker {
  caches: FakeCacheStorage;
  fetchMock: jest.Mock;
  dispatch(type: string, event: Record<string, unknown>): void;
}

function loadWorker(deployId: string, caches = new FakeCacheStorage()): LoadedWorker {
  const handlers = new Map<string, Handler[]>();
  const fetchMock = jest.fn();
  const self = {
    location: new URL(`/sw.js?v=${deployId}`, ORIGIN),
    addEventListener(type: string, fn: Handler) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
    registration: {},
  };
  const context = createContext({
    self,
    caches,
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
    caches,
    fetchMock,
    dispatch(type, event) {
      for (const fn of handlers.get(type) ?? []) fn(event);
    },
  };
}

/** Run a fetch event and return what the worker answered with. */
async function fetchVia(
  worker: LoadedWorker,
  url: string,
  init: { mode?: RequestMode } = {},
): Promise<Response | undefined> {
  const request = new Request(new URL(url, ORIGIN));
  if (init.mode) Object.defineProperty(request, 'mode', { value: init.mode });
  let answer: Promise<Response> | undefined;
  worker.dispatch('fetch', {
    request,
    respondWith(p: Promise<Response>) {
      answer = p;
    },
    waitUntil() {},
  });
  return answer ? await answer : undefined;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

describe('sw.js activate', () => {
  it('keeps caches it does not own and keeps data caches across deploys', async () => {
    const storage = new FakeCacheStorage();
    const old = loadWorker('1000', storage);
    for (const name of [
      'gratis-static-d-1000',
      'gratis-shell-d-1000',
      'gratis-pages-d-1000',
      'gratis-offline-basemap-v1',
      'some-other-lib-cache',
    ]) {
      await storage.open(name);
    }
    // Warm one tile and one geojson layer through the old worker.
    old.fetchMock.mockResolvedValue(new Response('tile', { status: 200 }));
    await fetchVia(old, 'https://tiles.example.test/1/2/3.png');
    old.fetchMock.mockResolvedValue(
      new Response('{"type":"FeatureCollection","features":[]}', { status: 200 }),
    );
    await fetchVia(old, '/api/portal/items/a/layers/b/geojson');
    await settle();
    const dataCaches = [...storage.stores.keys()].filter((k) =>
      /^gratis-(tiles|geojson)-/.test(k),
    );
    expect(dataCaches).toHaveLength(2);

    const next = loadWorker('2000', storage);
    let done: Promise<unknown> | undefined;
    next.dispatch('activate', {
      waitUntil(p: Promise<unknown>) {
        done = p;
      },
    });
    await done;

    const names = [...storage.stores.keys()];
    expect(names).toContain('gratis-offline-basemap-v1');
    expect(names).toContain('some-other-lib-cache');
    expect(names).not.toContain('gratis-static-d-1000');
    expect(names).not.toContain('gratis-shell-d-1000');
    expect(names).not.toContain('gratis-pages-d-1000');
    for (const n of dataCaches) {
      expect(names).toContain(n);
      expect(storage.stores.get(n)!.entries.size).toBe(1);
    }
  });
});

describe('sw.js geojson fallback', () => {
  const PAGE = '/api/portal/items/a/layers/b/geojson?limit=5000';

  it('answers a failed request with no cached copy as a marked 504', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockRejectedValue(new TypeError('offline'));
    const res = await fetchVia(w, `${PAGE}&cursor=c3`);
    expect(res!.status).toBe(504);
    expect(res!.headers.get('x-gg-sw-fallback')).toBe('1');
  });

  it('marks a cached copy served in place of the network', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockResolvedValueOnce(
      new Response('{"features":[1],"nextCursor":"x"}', { status: 200 }),
    );
    const live = await fetchVia(w, PAGE);
    expect(live!.headers.get('x-gg-sw-fallback')).toBeNull();
    await settle();
    w.fetchMock.mockRejectedValue(new TypeError('offline'));
    const res = await fetchVia(w, PAGE);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-gg-sw-fallback')).toBe('1');
    expect(await res!.text()).toContain('nextCursor');
  });

  it('does not cache keyset pages', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await fetchVia(w, `${PAGE}&cursor=c3`);
    await settle();
    const geo = [...w.caches.stores.entries()].find(([k]) => k.startsWith('gratis-geojson-'));
    expect(geo?.[1].entries.size ?? 0).toBe(0);
  });
});

describe('sw.js static cache', () => {
  it('never caches API responses that look like images', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockResolvedValue(new Response('<svg/>', { status: 200 }));
    const res = await fetchVia(w, '/api/portal/items/a/thumbnail.svg');
    expect(res).toBeUndefined();
    const hit = await fetchVia(w, '/fonts/inter.woff2');
    expect(hit!.status).toBe(200);
  });
});

describe('sw.js tile revalidation', () => {
  it('serves a cached GetMap tile and refreshes it in the background', async () => {
    const w = loadWorker('1');
    const url = 'https://wms.example.test/wms?service=WMS&request=GetMap&bbox=1,2,3,4';
    w.fetchMock.mockResolvedValueOnce(new Response('old', { status: 200 }));
    await fetchVia(w, url);
    await settle();
    w.fetchMock.mockResolvedValueOnce(new Response('new', { status: 200 }));
    const first = await fetchVia(w, url);
    expect(await first!.text()).toBe('old');
    await settle();
    const second = await fetchVia(w, url);
    expect(await second!.text()).toBe('new');
  });

  it('keeps plain XYZ tiles cache-first', async () => {
    const w = loadWorker('1');
    const url = 'https://tiles.example.test/4/5/6.png';
    w.fetchMock.mockResolvedValueOnce(new Response('t', { status: 200 }));
    await fetchVia(w, url);
    await settle();
    await fetchVia(w, url);
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sw.js field runtime page cache', () => {
  const PAGE = '/items/0b8f0000-0000-4000-8000-000000000001/field';
  const html = (signedIn: boolean) =>
    new Response(
      `<html><head>${signedIn ? '<meta name="gg-field-signed-in" content="1"/>' : ''}</head><body>${signedIn ? 'Add' : 'read only'}</body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );

  it('does not replace a signed-in copy with an anonymous render', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockResolvedValueOnce(html(true));
    await fetchVia(w, PAGE, { mode: 'navigate' });
    w.fetchMock.mockResolvedValueOnce(html(false));
    await fetchVia(w, PAGE, { mode: 'navigate' });
    w.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await fetchVia(w, PAGE, { mode: 'navigate' });
    expect(await offline!.text()).toContain('Add');
  });

  it('still caches an anonymous render when there is no copy yet', async () => {
    const w = loadWorker('1');
    w.fetchMock.mockResolvedValueOnce(html(false));
    await fetchVia(w, PAGE, { mode: 'navigate' });
    w.fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await fetchVia(w, PAGE, { mode: 'navigate' });
    expect(await offline!.text()).toContain('read only');
  });
});
