// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextRequest } from 'next/server';
import { encode, type JWT } from 'next-auth/jwt';
import { resetRefreshStateForTests } from './auth';
import {
  resolveRouteSession,
  sessionCookieWrites,
  tokenChanged,
} from './session-roll';

const SECRET = 'test-secret-for-session-roll';
const COOKIE = 'next-auth.session-token';

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.NEXTAUTH_URL = 'http://portal.test';
});

afterEach(() => {
  resetRefreshStateForTests();
  delete process.env.GRATIS_SESSION_IDLE_SECONDS;
  jest.restoreAllMocks();
});

async function requestWith(token: JWT): Promise<NextRequest> {
  const value = await encode({ token, secret: SECRET, maxAge: 3600 });
  return new NextRequest('http://portal.test/api/portal/items', {
    headers: { cookie: `${COOKIE}=${value}` },
  });
}

function keycloakAnswers(accessToken: string, refreshToken: string) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 300,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('resolveRouteSession', () => {
  it('writes a refreshed token back to the cookie', async () => {
    const fetchMock = keycloakAnswers('fresh-access', 'rotated-refresh');
    const req = await requestWith({
      accessToken: 'old-access',
      accessTokenExpires: Date.now() - 1000,
      refreshToken: 'old-refresh',
    });
    const { session, cookies } = await resolveRouteSession(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session?.accessToken).toBe('fresh-access');
    expect(cookies.map((c) => c.name)).toEqual([COOKIE]);
    expect(cookies[0]!.options.httpOnly).toBe(true);

    // The next request carries the written cookie, so it neither
    // refreshes again nor presents the spent refresh token.
    const next = new NextRequest('http://portal.test/api/portal/items', {
      headers: { cookie: `${COOKIE}=${cookies[0]!.value}` },
    });
    const again = await resolveRouteSession(next);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.session?.accessToken).toBe('fresh-access');
    expect(again.cookies).toEqual([]);
  });

  it('writes nothing when the token is fresh', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const req = await requestWith({
      accessToken: 'a',
      accessTokenExpires: Date.now() + 300_000,
      refreshToken: 'r',
    });
    const { session, cookies } = await resolveRouteSession(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session?.accessToken).toBe('a');
    expect(cookies).toEqual([]);
  });

  it('moves the idle activity stamp for a working user', async () => {
    process.env.GRATIS_SESSION_IDLE_SECONDS = '900';
    const stamp = Date.now() - 5 * 60_000;
    const req = await requestWith({
      accessToken: 'a',
      accessTokenExpires: Date.now() + 300_000,
      refreshToken: 'r',
      lastActive: stamp,
    });
    const { session, cookies } = await resolveRouteSession(req);
    expect(session?.error).toBeUndefined();
    expect(cookies).toHaveLength(1);
  });

  it('returns no session without a cookie', async () => {
    const req = new NextRequest('http://portal.test/api/portal/items');
    await expect(resolveRouteSession(req)).resolves.toEqual({
      session: null,
      cookies: [],
    });
  });
});

describe('refresh replay', () => {
  it('answers a second presentation of a spent refresh token without Keycloak', async () => {
    // A server component refreshed but could not write the cookie, so
    // the browser presents the old refresh token again. With rotation
    // Keycloak would refuse it.
    const fetchMock = keycloakAnswers('fresh-access', 'rotated-refresh');
    const stale = {
      accessToken: 'old-access',
      accessTokenExpires: Date.now() - 1000,
      refreshToken: 'old-refresh',
    };
    const first = await resolveRouteSession(await requestWith(stale));
    const second = await resolveRouteSession(await requestWith(stale));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.session?.accessToken).toBe('fresh-access');
    expect(second.session?.accessToken).toBe('fresh-access');
    expect(second.session?.error).toBeUndefined();
  });
});

describe('sessionCookieWrites', () => {
  const opts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: false };

  it('chunks a large value and clears chunks it no longer uses', () => {
    const big = 'x'.repeat(9000);
    const writes = sessionCookieWrites(COOKIE, big, [`${COOKIE}`, 'other'], opts, 60);
    expect(writes.filter((w) => w.options.maxAge > 0).map((w) => w.name)).toEqual([
      `${COOKIE}.0`,
      `${COOKIE}.1`,
      `${COOKIE}.2`,
    ]);
    expect(writes.filter((w) => w.options.maxAge > 0).map((w) => w.value).join('')).toBe(big);
    expect(writes.find((w) => w.name === COOKIE)?.options.maxAge).toBe(0);
    expect(writes.find((w) => w.name === 'other')).toBeUndefined();
  });

  it('collapses back to one cookie', () => {
    const writes = sessionCookieWrites(COOKIE, 'small', [`${COOKIE}.0`, `${COOKIE}.1`], opts, 60);
    expect(writes.map((w) => [w.name, w.options.maxAge])).toEqual([
      [COOKIE, 60],
      [`${COOKIE}.0`, 0],
      [`${COOKIE}.1`, 0],
    ]);
  });
});

describe('tokenChanged', () => {
  it('ignores fields that are not persisted state', () => {
    expect(tokenChanged({ accessToken: 'a', iat: 1 }, { accessToken: 'a', iat: 2 })).toBe(false);
    expect(tokenChanged({ accessToken: 'a' }, { accessToken: 'b' })).toBe(true);
  });
});
