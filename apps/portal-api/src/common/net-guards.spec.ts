// SPDX-License-Identifier: AGPL-3.0-or-later

// Same DNS pin as the import-ago specs: the guard's hostname
// lookup must not touch live DNS on CI runners. The default
// resolves to a fixed public address so the guard's full logic
// still executes; individual tests override per-call to exercise
// the rebinding branch.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '151.101.1.1', family: 4 })),
}));

import { lookup } from 'node:dns/promises';

import {
  assertSafeOutboundUrl,
  isPrivateOrLoopbackHost,
  safeFetch,
  UnsafeOutboundUrlError,
} from './net-guards.js';

const lookupMock = lookup as unknown as jest.Mock;

describe('isPrivateOrLoopbackHost', () => {
  it.each([
    '0.0.0.0',
    '0.255.1.2',
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
  ])('blocks private / loopback IPv4 %s', (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each(['8.8.8.8', '151.101.1.1', '1.2.3.4'])(
    'allows public IPv4 %s',
    (host) => {
      expect(isPrivateOrLoopbackHost(host)).toBe(false);
    },
  );

  it.each([
    // Dotted-quad mapped form, as URL.hostname (bracketed) and as
    // a bare DNS-lookup result.
    '[::ffff:127.0.0.1]',
    '::ffff:127.0.0.1',
    '[::ffff:10.0.0.5]',
    '::ffff:192.168.1.7',
    '[::ffff:0.0.0.0]',
    // Hex-group mapped form (7f00:0001 is 127.0.0.1).
    '[::ffff:7f00:1]',
    '[::ffff:a9fe:a9fe]',
  ])('blocks IPv4-mapped IPv6 %s onto the IPv4 rules', (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it('allows a public IPv4-mapped address', () => {
    expect(isPrivateOrLoopbackHost('[::ffff:8.8.8.8]')).toBe(false);
    expect(isPrivateOrLoopbackHost('::ffff:8.8.8.8')).toBe(false);
  });

  it.each(['[::1]', '::1', '[::]', '::', '[fc00::1]', 'fd12:3456::1'])(
    'blocks IPv6 loopback / unspecified / unique-local %s',
    (host) => {
      expect(isPrivateOrLoopbackHost(host)).toBe(true);
    },
  );

  it('allows a public bracketed IPv6 address', () => {
    expect(isPrivateOrLoopbackHost('[2606:4700::1111]')).toBe(false);
  });

  it.each(['localhost', 'api.localhost', 'minio', 'keycloak'])(
    'blocks localhost and bare single-label hosts (%s)',
    (host) => {
      expect(isPrivateOrLoopbackHost(host)).toBe(true);
    },
  );

  it('allows a public FQDN', () => {
    expect(isPrivateOrLoopbackHost('tiles.example.com')).toBe(false);
  });
});

describe('assertSafeOutboundUrl', () => {
  afterEach(() => {
    lookupMock.mockClear();
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
  });

  it('rejects a private literal before any DNS lookup', async () => {
    await expect(assertSafeOutboundUrl('http://0.0.0.0/x')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address (rebinding)', async () => {
    lookupMock.mockResolvedValueOnce({ address: '192.168.1.5', family: 4 });
    await expect(
      assertSafeOutboundUrl('https://rebind.example.com/'),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('rejects a hostname that resolves to an IPv4-mapped loopback', async () => {
    lookupMock.mockResolvedValueOnce({ address: '::ffff:127.0.0.1', family: 6 });
    await expect(
      assertSafeOutboundUrl('https://rebind.example.com/'),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('returns the parsed URL for a public host', async () => {
    const url = await assertSafeOutboundUrl('https://tiles.example.com/z/x/y');
    expect(url.hostname).toBe('tiles.example.com');
  });
});

describe('safeFetch redirect handling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    lookupMock.mockClear();
  });

  function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it('follows a redirect to a safe host and returns the final response', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example.com/file'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await safeFetch('https://origin.example.com/start');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://cdn.example.com/file',
    );
    // Every dispatch must be manual so no hop can slip past the
    // per-hop validation.
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    expect(fetchMock.mock.calls[1][1].redirect).toBe('manual');
  });

  it('resolves a relative Location against the redirecting hop', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('/inner?f=1'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await safeFetch('https://origin.example.com/outer/path');
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://origin.example.com/inner?f=1',
    );
  });

  it('refuses a redirect into link-local metadata space', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      safeFetch('https://origin.example.com/start'),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to 0.0.0.0', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('http://0.0.0.0:9000/bucket/secret'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      safeFetch('https://origin.example.com/start'),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a host that resolves privately', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://rebind.example.com/'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // First lookup (original host) resolves public, second (the
    // redirect target) resolves private.
    lookupMock
      .mockResolvedValueOnce({ address: '151.101.1.1', family: 4 })
      .mockResolvedValueOnce({ address: '10.0.0.9', family: 4 });

    await expect(
      safeFetch('https://origin.example.com/start'),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after five followed redirects', async () => {
    let n = 0;
    const fetchMock = jest.fn(async () => {
      n += 1;
      return redirectTo(`https://hop${n}.example.com/next`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      safeFetch('https://origin.example.com/start'),
    ).rejects.toThrow(/too many redirects/);
    // Initial dispatch plus the five allowed follows.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('returns the 3xx untouched when the caller asked for manual redirects', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example.com/file'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await safeFetch('https://origin.example.com/start', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a redirect status without a Location as-is', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await safeFetch('https://origin.example.com/start');
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downgrades POST to GET on a 303 and drops the body', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://origin.example.com/done', 303))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await safeFetch('https://origin.example.com/form', {
      method: 'POST',
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const secondInit = fetchMock.mock.calls[1][1];
    expect(secondInit.method).toBe('GET');
    // The body is dropped entirely (not set to null): fetch is
    // handed an init with no body property on a GET hop.
    expect(secondInit.body).toBeUndefined();
    expect((secondInit.headers as Headers).get('content-type')).toBeNull();
  });

  it('strips credential headers when a redirect leaves the origin', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://elsewhere.example.com/file'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await safeFetch('https://origin.example.com/start', {
      headers: { authorization: 'Bearer secret', accept: 'application/json' },
    });
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(secondHeaders.get('authorization')).toBeNull();
    // Non-credential headers survive the hop.
    expect(secondHeaders.get('accept')).toBe('application/json');
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirectTo('https://origin.example.com/moved'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await safeFetch('https://origin.example.com/start', {
      headers: { authorization: 'Bearer secret' },
    });
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(secondHeaders.get('authorization')).toBe('Bearer secret');
  });
});
