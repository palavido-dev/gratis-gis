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
