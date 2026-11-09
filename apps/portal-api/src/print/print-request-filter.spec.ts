// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  answerPrintRequest,
  createPrintRequestFilter,
  type InterceptedRequest,
} from './print-request-filter.js';

describe('print renderer request filter', () => {
  const decide = createPrintRequestFilter([
    'http://portal-web:3000',
    'https://gratisgis.org',
    undefined,
  ]);

  it('lets the preview page and the portal through to Chromium', () => {
    expect(decide('http://portal-web:3000/print-preview/x')).toBe('continue');
    expect(decide('https://gratisgis.org/api/portal/items/1')).toBe('continue');
  });

  it('keeps in-browser URLs', () => {
    expect(decide('data:image/png;base64,AAAA')).toBe('continue');
    expect(decide('blob:http://portal-web:3000/abc')).toBe('continue');
  });

  it('sends every other http(s) URL through portal-api, internal names included', () => {
    expect(decide('https://tile.openstreetmap.org/1/0/0.png')).toBe('fetch');
    expect(decide('http://minio:9000/bucket/key')).toBe('fetch');
    expect(decide('http://169.254.169.254/latest/meta-data/')).toBe('fetch');
  });

  it('aborts other schemes', () => {
    expect(decide('file:///etc/passwd')).toBe('abort');
    expect(decide('not a url')).toBe('abort');
  });
});

function fakeRequest(url: string, method = 'GET') {
  const calls: string[] = [];
  let responded: { status: number; headers: Record<string, string>; body: Buffer } | null =
    null;
  const req: InterceptedRequest = {
    url: () => url,
    method: () => method,
    headers: () => ({ accept: 'image/png', cookie: 'session=1', referer: 'http://portal-web:3000/' }),
    postData: () => undefined,
    continue: async () => {
      calls.push('continue');
    },
    abort: async () => {
      calls.push('abort');
    },
    respond: async (r) => {
      calls.push('respond');
      responded = r;
    },
  };
  return { req, calls, responded: () => responded };
}

describe('answerPrintRequest', () => {
  const decide = createPrintRequestFilter(['http://portal-web:3000']);

  it('fetches a third-party URL itself and answers Chromium with respond()', async () => {
    const { req, calls, responded } = fakeRequest('https://tiles.example.org/1/0/0.png');
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(Buffer.from('PNG'), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'access-control-allow-origin': '*',
          'set-cookie': 'x=1',
          'content-encoding': 'gzip',
        },
      });
    };
    await answerPrintRequest(req, decide, fetcher);
    // Chromium is never told to continue, so it never resolves the
    // name itself: the only lookup is the pinned one in safeFetch.
    expect(calls).toEqual(['respond']);
    expect(seen[0]?.url).toBe('https://tiles.example.org/1/0/0.png');
    expect(new Headers(seen[0]?.init.headers).get('cookie')).toBeNull();
    const r = responded();
    expect(r?.status).toBe(200);
    expect(r?.body.toString()).toBe('PNG');
    expect(r?.headers['content-type']).toBe('image/png');
    expect(r?.headers['access-control-allow-origin']).toBe('*');
    expect(r?.headers['set-cookie']).toBeUndefined();
    expect(r?.headers['content-encoding']).toBeUndefined();
  });

  it('aborts when the pinned fetch refuses the address', async () => {
    const { req, calls } = fakeRequest('http://rebind.example/');
    await answerPrintRequest(req, decide, async () => {
      throw new Error('resolves to a private address');
    });
    expect(calls).toEqual(['abort']);
  });

  it('refuses a private address with the real safeFetch', async () => {
    for (const url of ['http://127.0.0.1:5432/', 'http://169.254.169.254/latest/']) {
      const { req, calls } = fakeRequest(url);
      await answerPrintRequest(req, decide);
      expect(calls).toEqual(['abort']);
    }
  });

  it('lets trusted origins through untouched', async () => {
    const { req, calls } = fakeRequest('http://portal-web:3000/_next/app.js');
    const fetcher = jest.fn();
    await answerPrintRequest(req, decide, fetcher);
    expect(calls).toEqual(['continue']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts methods it does not proxy', async () => {
    const { req, calls } = fakeRequest('https://api.example.org/x', 'DELETE');
    const fetcher = jest.fn();
    await answerPrintRequest(req, decide, fetcher);
    expect(calls).toEqual(['abort']);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
