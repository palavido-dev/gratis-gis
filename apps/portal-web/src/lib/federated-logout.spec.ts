// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOGOUT_ROUTE_PATH,
  buildEndSessionUrl,
  logoutHintCookieOptions,
  safeLogoutRedirect,
} from './federated-logout';

describe('buildEndSessionUrl', () => {
  const base = {
    endSessionBase: 'https://auth.test/realms/r/protocol/openid-connect/logout',
    portalBase: 'https://portal.test/',
    redirectPath: '/field',
    clientId: 'portal-web',
  };

  it('sends the id token hint when there is one', () => {
    const url = buildEndSessionUrl({ ...base, idToken: 'id.tok.en' });
    expect(url.searchParams.get('id_token_hint')).toBe('id.tok.en');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://portal.test/field',
    );
    expect(url.searchParams.get('client_id')).toBe('portal-web');
  });

  it('still works without one', () => {
    const url = buildEndSessionUrl({ ...base, idToken: undefined });
    expect(url.searchParams.has('id_token_hint')).toBe(false);
  });
});

describe('safeLogoutRedirect', () => {
  it.each([
    ['/field', '/field'],
    [null, '/'],
    ['//evil.test', '/'],
    ['/\\evil.test', '/'],
    ['https://evil.test', '/'],
  ])('%j -> %s', (input, expected) => {
    expect(safeLogoutRedirect(input)).toBe(expected);
  });
});

describe('logout hint cookie', () => {
  it('is httpOnly, short-lived and scoped to the logout route', () => {
    const o = logoutHintCookieOptions(true);
    expect(o).toMatchObject({ httpOnly: true, secure: true, path: LOGOUT_ROUTE_PATH });
    expect(o.maxAge).toBeLessThanOrEqual(300);
  });
});

describe('federatedSignOut order', () => {
  // The hint can only be read while the session cookie exists, so the
  // POST must come before NextAuth's signOut clears it.
  it('stashes the hint before signOut clears the session cookie', () => {
    const src = readFileSync(
      join(__dirname, '..', 'components', 'user-menu.tsx'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export async function federatedSignOut'));
    const post = body.indexOf("fetch('/api/auth/federated-logout'");
    const signOut = body.indexOf('await signOut(');
    expect(post).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(post);
  });
});

describe('logout redirect step', () => {
  // A BFF response in flight during signOut can write the session
  // cookie back; the redirect step must expire it again.
  it('expires every session cookie name and chunk', async () => {
    process.env.NEXTAUTH_URL = 'https://portal.test';
    process.env.NEXTAUTH_SECRET = 'x';
    const { NextRequest } = await import('next/server');
    const { GET } = await import('../app/api/auth/federated-logout/route');
    const req = new NextRequest('https://portal.test/api/auth/federated-logout', {
      headers: {
        cookie:
          'gg-logout-hint=tok; __Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.2=b; other=1',
      },
    });
    const res = await GET(req);
    const cleared = res.cookies
      .getAll()
      .filter((c) => c.value === '' && c.maxAge === 0)
      .map((c) => c.name);
    for (const name of [
      '__Secure-next-auth.session-token',
      '__Secure-next-auth.session-token.0',
      '__Secure-next-auth.session-token.1',
      '__Secure-next-auth.session-token.2',
      'next-auth.session-token',
      'next-auth.session-token.0',
    ]) {
      expect(cleared).toContain(name);
    }
    expect(cleared).not.toContain('other');
    const secure = res.cookies.get('__Secure-next-auth.session-token.2');
    expect(secure?.secure).toBe(true);
  });
});

describe('logout redirect step without the hint cookie', () => {
  // A link from another site carries the Lax session cookie but not
  // the Strict hint. It must not end the session silently.
  it('sends no id_token_hint and clears no session cookie', async () => {
    process.env.NEXTAUTH_URL = 'https://portal.test';
    process.env.NEXTAUTH_SECRET = 'x';
    const { NextRequest } = await import('next/server');
    const { GET } = await import('../app/api/auth/federated-logout/route');
    const req = new NextRequest('https://portal.test/api/auth/federated-logout', {
      headers: { cookie: '__Secure-next-auth.session-token=a' },
    });
    const res = await GET(req);
    expect(res.headers.get('location') ?? '').not.toContain('id_token_hint');
    const cleared = res.cookies
      .getAll()
      .filter((c) => c.value === '' && c.maxAge === 0)
      .map((c) => c.name);
    expect(cleared).not.toContain('__Secure-next-auth.session-token');
  });
});
