// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasUnsafePathSegment,
  isCrossOriginMutation,
  isUnsafePathSegment,
  securityResponseHeaders,
} from './bff-guards';

describe('isUnsafePathSegment', () => {
  it.each(['', '.', '..', '%2e', '%2E%2e', '.%2e', 'x\\..', '\\', 'a?b', 'a#b', '.\n.', 'a\tb'])(
    'rejects %j',
    (seg) => {
      expect(isUnsafePathSegment(seg)).toBe(true);
    },
  );

  it.each(['items', '0', 'query', 'file.pmtiles', '...', 'a.b', 'some%20name'])(
    'accepts %j',
    (seg) => {
      expect(isUnsafePathSegment(seg)).toBe(false);
    },
  );

  it('blocks the backslash walk out of the public prefix', () => {
    // Anonymous GET /api/portal/items/x%5C..%5C..%5C..%5Cadmin%5Cusers
    // arrives decoded; without the backslash rule it matched the
    // public items allowlist and URL parsing turned it into
    // /api/admin/users.
    const suffix = 'items/x\\..\\..\\..\\admin\\users';
    expect(
      new URL(`http://api:4000/api/public/${suffix}`).pathname,
    ).toBe('/api/admin/users');
    expect(hasUnsafePathSegment(suffix)).toBe(true);
  });
});

function headers(h: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe('isCrossOriginMutation', () => {
  it('never blocks a read', () => {
    expect(
      isCrossOriginMutation('GET', headers({ 'sec-fetch-site': 'cross-site' })),
    ).toBe(false);
  });

  it.each(['same-site', 'cross-site'])('blocks a POST with Sec-Fetch-Site %s', (site) => {
    expect(
      isCrossOriginMutation(
        'POST',
        headers({ 'sec-fetch-site': site, host: 'portal.example' }),
      ),
    ).toBe(true);
  });

  it.each(['same-origin', 'none'])('allows Sec-Fetch-Site %s', (site) => {
    expect(isCrossOriginMutation('DELETE', headers({ 'sec-fetch-site': site }))).toBe(
      false,
    );
  });

  it('compares Origin with the forwarded host when Sec-Fetch-Site is absent', () => {
    expect(
      isCrossOriginMutation(
        'PATCH',
        headers({
          origin: 'http://192.168.1.10:8080',
          host: 'portal-web:3000',
          'x-forwarded-host': '192.168.1.10:8080',
        }),
      ),
    ).toBe(false);
    // Another app on the same NAS IP, different port: same-site, not
    // same-origin.
    expect(
      isCrossOriginMutation(
        'POST',
        headers({ origin: 'http://192.168.1.10:9000', host: '192.168.1.10:8080' }),
      ),
    ).toBe(true);
    expect(
      isCrossOriginMutation('POST', headers({ origin: 'null', host: 'portal.example' })),
    ).toBe(true);
  });

  it('allows a non-browser client with neither header', () => {
    expect(isCrossOriginMutation('POST', headers({ host: 'portal.example' }))).toBe(
      false,
    );
  });
});

describe('securityResponseHeaders', () => {
  const PAGE = "default-src 'self'";

  it('passes the proxy sandbox policy and nosniff through', () => {
    const out = new Map(
      securityResponseHeaders(
        headers({
          'content-security-policy': "sandbox; default-src 'none'",
          'x-content-type-options': 'nosniff',
        }),
        PAGE,
      ),
    );
    expect(out.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(out.get('x-content-type-options')).toBe('nosniff');
  });

  it('falls back to the page policy', () => {
    const out = new Map(securityResponseHeaders(headers({}), PAGE));
    expect(out.get('content-security-policy')).toBe(PAGE);
    expect(out.has('x-content-type-options')).toBe(false);
  });
});

describe('PAGE_CSP_SOURCE', () => {
  // Next drops a route handler header that next.config already set,
  // so the config policy must not cover the BFF or the proxy's
  // sandbox CSP never reaches the browser.
  it('covers every page but not the BFF', () => {
    // Jest here is CommonJS and cannot load the .mjs, so read the
    // constant from source.
    const source = readFileSync(join(__dirname, 'content-security-policy.mjs'), 'utf8');
    const PAGE_CSP_SOURCE = /PAGE_CSP_SOURCE = '([^']+)'/.exec(source)![1]!;
    const { getPathMatch } = jest.requireActual<{
      getPathMatch: (
        path: string,
        opts: { removeUnnamedParams: boolean; strict: boolean },
      ) => (pathname: string) => unknown;
    }>('next/dist/shared/lib/router/utils/path-match');
    const match = getPathMatch(PAGE_CSP_SOURCE, {
      removeUnnamedParams: true,
      strict: true,
    });
    expect(Boolean(match('/'))).toBe(true);
    expect(Boolean(match('/items/abc'))).toBe(true);
    expect(Boolean(match('/api/auth/session'))).toBe(true);
    expect(Boolean(match('/api/portal/items/x/proxy/a'))).toBe(false);
  });
});
