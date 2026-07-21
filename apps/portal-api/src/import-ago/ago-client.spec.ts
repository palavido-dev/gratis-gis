// SPDX-License-Identifier: AGPL-3.0-or-later

// Same DNS pin as import.spec.ts: the SSRF guard stays in the
// test path (see the note below), but its hostname lookup must
// not touch live DNS or slow CI runners intermittently time the
// tests out. A fixed public address keeps the guard's logic
// exercised without the network.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '151.101.1.1', family: 4 })),
}));

import { AgoApiError, AgoClient } from './ago-client.js';
import type {
  AgoItem,
  AgoPortalSelf,
  AgoUserContentResponse,
} from './ago-types.js';

/**
 * Tests stub the `safeFetch` boundary by swapping global
 * ``fetch`` for a controllable mock. We avoid mocking the
 * ``../common/net-guards.js`` module directly so the SSRF guard
 * stays in the test path and a future regression that bypasses
 * it would fail loudly.
 *
 * That means every test URL has to be one ``assertSafeOutboundUrl``
 * would accept. We use ``https://www.arcgis.com/...`` -- a real
 * public AGO host that is unambiguously external and that the
 * outbound guard allows.
 */

const PORTAL_URL = 'https://www.arcgis.com/sharing/rest';

interface MockResponse {
  status: number;
  body: unknown;
}

function mockFetch(responses: Map<string, MockResponse>): jest.Mock {
  return jest.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    // Find a registered response by checking which url prefix
    // matches the request -- we register without the query
    // string but match against the full URL.
    for (const [prefix, resp] of responses.entries()) {
      if (url.startsWith(prefix)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    throw new Error(`No mock registered for ${url}`);
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AgoClient.portalSelf', () => {
  it('parses the portal-self response', async () => {
    const self: AgoPortalSelf = {
      id: 'portal-1',
      name: 'Test Portal',
      user: { username: 'alice', fullName: 'Alice A', email: 'alice@example.com' },
      currentVersion: '11.3',
    };
    globalThis.fetch = mockFetch(
      new Map([[`${PORTAL_URL}/portals/self`, { status: 200, body: self }]]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    const result = await client.portalSelf();
    expect(result.user?.username).toBe('alice');
    expect(result.currentVersion).toBe('11.3');
  });

  it('throws AgoApiError when AGO returns an error envelope', async () => {
    globalThis.fetch = mockFetch(
      new Map([
        [
          `${PORTAL_URL}/portals/self`,
          {
            status: 200,
            body: {
              error: { code: 498, message: 'Invalid token.', details: [] },
            },
          },
        ],
      ]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'bad' });
    await expect(client.portalSelf()).rejects.toThrow(AgoApiError);
    await expect(client.portalSelf()).rejects.toThrow('Invalid token.');
  });

  it('throws AgoApiError on HTTP non-200', async () => {
    globalThis.fetch = mockFetch(
      new Map([[`${PORTAL_URL}/portals/self`, { status: 500, body: {} }]]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    await expect(client.portalSelf()).rejects.toThrow(AgoApiError);
  });
});

describe('AgoClient.listUserContent', () => {
  it('returns the user-content payload with items + folders', async () => {
    const body: AgoUserContentResponse = {
      username: 'alice',
      total: 2,
      start: 1,
      num: 100,
      nextStart: -1,
      folders: [{ id: 'f1', title: 'Hydrology', username: 'alice' }],
      items: [
        sampleItem({ id: 'i1', title: 'Parcels', type: 'Feature Service' }),
      ],
    };
    globalThis.fetch = mockFetch(
      new Map([[`${PORTAL_URL}/content/users/alice`, { status: 200, body }]]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    const out = await client.listUserContent({ username: 'alice' });
    expect(out.items).toHaveLength(1);
    expect(out.folders).toHaveLength(1);
    expect(out.nextStart).toBe(-1);
  });

  it('caps num at 100 (AGO API limit)', async () => {
    let capturedUrl = '';
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ username: 'alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    await client.listUserContent({ username: 'alice', num: 500 });
    expect(new URL(capturedUrl).searchParams.get('num')).toBe('100');
  });

  it('uses the folder-scoped path when folderId is set', async () => {
    let capturedUrl = '';
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ username: 'alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    await client.listUserContent({ username: 'alice', folderId: 'abc123' });
    expect(capturedUrl).toContain('/content/users/alice/abc123');
  });
});

describe('AgoClient.walkUserContent', () => {
  it('yields root items then each folder in title order', async () => {
    const root: AgoUserContentResponse = {
      username: 'alice',
      nextStart: -1,
      folders: [
        { id: 'f-z', title: 'Z', username: 'alice' },
        { id: 'f-a', title: 'A', username: 'alice' },
      ],
      items: [sampleItem({ id: 'root-1', title: 'Root Item' })],
    };
    const aFolder: AgoUserContentResponse = {
      username: 'alice',
      nextStart: -1,
      items: [sampleItem({ id: 'a-1', title: 'In A' })],
    };
    const zFolder: AgoUserContentResponse = {
      username: 'alice',
      nextStart: -1,
      items: [sampleItem({ id: 'z-1', title: 'In Z' })],
    };
    globalThis.fetch = mockFetch(
      new Map([
        [`${PORTAL_URL}/content/users/alice?`, { status: 200, body: root }],
        [`${PORTAL_URL}/content/users/alice/f-a?`, { status: 200, body: aFolder }],
        [`${PORTAL_URL}/content/users/alice/f-z?`, { status: 200, body: zFolder }],
      ]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    const collected: Array<{ id: string; folderTitle: string }> = [];
    const result = await client.walkUserContent({
      username: 'alice',
      onItem: (item, folder) => {
        collected.push({ id: item.id, folderTitle: folder.title });
      },
    });
    expect(result.total).toBe(3);
    expect(result.folders).toBe(2);
    // Root first, then folders alphabetically.
    expect(collected).toEqual([
      { id: 'root-1', folderTitle: '(root)' },
      { id: 'a-1', folderTitle: 'A' },
      { id: 'z-1', folderTitle: 'Z' },
    ]);
  });

  it('follows nextStart pagination cursors', async () => {
    let calls = 0;
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      calls += 1;
      const start = Number(url.searchParams.get('start') ?? '1');
      // 3 root pages, then no folders.
      if (start === 1) {
        return jsonResponse({
          username: 'alice',
          nextStart: 101,
          folders: [],
          items: pageOfItems('p1', 100),
        });
      }
      if (start === 101) {
        return jsonResponse({
          username: 'alice',
          nextStart: 201,
          folders: [],
          items: pageOfItems('p2', 100),
        });
      }
      return jsonResponse({
        username: 'alice',
        nextStart: -1,
        folders: [],
        items: pageOfItems('p3', 25),
      });
    });
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    let count = 0;
    const result = await client.walkUserContent({
      username: 'alice',
      onItem: () => {
        count += 1;
      },
    });
    expect(result.total).toBe(225);
    expect(count).toBe(225);
    expect(calls).toBe(3);
  });
});

describe('AgoClient.getItem / getItemData', () => {
  it('returns the full item record', async () => {
    const item = sampleItem({
      id: 'web-map-1',
      title: 'My Web Map',
      type: 'Web Map',
    });
    globalThis.fetch = mockFetch(
      new Map([
        [`${PORTAL_URL}/content/items/web-map-1`, { status: 200, body: item }],
      ]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    const out = await client.getItem('web-map-1');
    expect(out.title).toBe('My Web Map');
    expect(out.type).toBe('Web Map');
  });

  it('returns the type-specific data envelope', async () => {
    globalThis.fetch = mockFetch(
      new Map([
        [
          `${PORTAL_URL}/content/items/wm-1/data`,
          {
            status: 200,
            body: { version: '2.30', layers: [], baseMap: { baseMapLayers: [] } },
          },
        ],
      ]),
    );
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'tok' });
    const data = await client.getItemData<{ version: string }>('wm-1');
    expect(data.version).toBe('2.30');
  });
});

describe('AgoClient url composition', () => {
  it('always sends f=json + token', async () => {
    let url = '';
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      url = typeof input === 'string' ? input : input.toString();
      return jsonResponse({ id: 'p' });
    });
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: 'my-token' });
    await client.portalSelf();
    const u = new URL(url);
    expect(u.searchParams.get('f')).toBe('json');
    expect(u.searchParams.get('token')).toBe('my-token');
  });

  it('omits token= when the constructor was given an empty token', async () => {
    let url = '';
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      url = typeof input === 'string' ? input : input.toString();
      return jsonResponse({ id: 'p' });
    });
    const client = new AgoClient({ portalUrl: PORTAL_URL, token: '' });
    await client.portalSelf();
    expect(new URL(url).searchParams.has('token')).toBe(false);
  });

  it('strips trailing slashes from portal URL', async () => {
    let url = '';
    globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
      url = typeof input === 'string' ? input : input.toString();
      return jsonResponse({ id: 'p' });
    });
    const client = new AgoClient({
      portalUrl: `${PORTAL_URL}//`,
      token: 't',
    });
    await client.portalSelf();
    expect(url.startsWith(`${PORTAL_URL}/portals/self`)).toBe(true);
  });
});

// ----------------------------------------------------------
// Test helpers
// ----------------------------------------------------------

function sampleItem(overrides: Partial<AgoItem>): AgoItem {
  return {
    id: 'sample',
    type: 'Web Map',
    title: 'Sample Item',
    owner: 'alice',
    access: 'private',
    ...overrides,
  };
}

function pageOfItems(prefix: string, n: number): AgoItem[] {
  return Array.from({ length: n }, (_, i) =>
    sampleItem({ id: `${prefix}-${i}`, title: `${prefix}-${i}` }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
