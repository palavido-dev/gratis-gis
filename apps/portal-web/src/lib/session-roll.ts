// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve the session in a route handler and write back any change
 * the jwt callback made.
 *
 * getServerSession runs the jwt callback (token refresh, idle
 * activity stamp), but in the App Router it has no response to write
 * to: next-auth installs a no-op setCookie. Only /api/auth/session
 * ever persisted the result. So once the access token expired, every
 * BFF request refreshed again from the same refresh token, and a user
 * working in one tab for longer than GRATIS_SESSION_IDLE_SECONDS was
 * signed out mid-task because the activity stamp never moved.
 *
 * A route handler can set cookies, so the BFF resolves the session
 * here instead: decode the cookie, run the same jwt callback, and
 * when the token changed, encode it and return the cookie writes for
 * the response.
 */
import type { NextRequest } from 'next/server';
import type { JWT } from 'next-auth/jwt';
import { encode, getToken } from 'next-auth/jwt';
import { authOptions, type SessionWithToken } from './auth';
import { authCookieNaming } from './auth-cookies';
import { sessionMaxAgeSeconds } from './session-duration';

export interface CookieWrite {
  name: string;
  value: string;
  options: {
    httpOnly?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    path?: string;
    secure?: boolean;
    maxAge: number;
  };
}

/**
 * Same split next-auth uses: a cookie over 4096 bytes is written as
 * `<name>.0`, `<name>.1`, ... and getToken joins them back. 163 is
 * next-auth's estimate of the attribute overhead per cookie.
 */
const CHUNK_SIZE = 4096 - 163;

/** Fields whose change means the cookie must be rewritten. */
const PERSISTED_FIELDS = [
  'accessToken',
  'accessTokenExpires',
  'refreshToken',
  'idToken',
  'lastActive',
  'error',
] as const;

export function tokenChanged(before: JWT, after: JWT): boolean {
  return PERSISTED_FIELDS.some((key) => before[key] !== after[key]);
}

/**
 * Cookie writes for a new session cookie value, clearing any chunk
 * the old value used that the new one does not.
 */
export function sessionCookieWrites(
  name: string,
  value: string,
  existingNames: readonly string[],
  options: Omit<CookieWrite['options'], 'maxAge'>,
  maxAge: number,
): CookieWrite[] {
  const writes: CookieWrite[] = [];
  const count = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
  const written = new Set<string>();
  if (count === 1) {
    writes.push({ name, value, options: { ...options, maxAge } });
    written.add(name);
  } else {
    for (let i = 0; i < count; i++) {
      const chunkName = `${name}.${i}`;
      writes.push({
        name: chunkName,
        value: value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        options: { ...options, maxAge },
      });
      written.add(chunkName);
    }
  }
  for (const old of existingNames) {
    if (old !== name && !old.startsWith(`${name}.`)) continue;
    if (written.has(old)) continue;
    writes.push({ name: old, value: '', options: { ...options, maxAge: 0 } });
  }
  return writes;
}

export interface RouteSession {
  session: SessionWithToken | null;
  cookies: CookieWrite[];
}

type JwtCallback = (params: { token: JWT }) => Promise<JWT>;

/**
 * The session for a route handler request, plus the cookie writes
 * that persist whatever the jwt callback changed.
 */
export async function resolveRouteSession(req: NextRequest): Promise<RouteSession> {
  const secret = process.env.NEXTAUTH_SECRET ?? '';
  const naming = authCookieNaming(process.env.NEXTAUTH_URL);
  const token = await getToken({
    req,
    secret,
    cookieName: naming.sessionTokenName,
  });
  if (!token) return { session: null, cookies: [] };

  const before = { ...token };
  const jwt = authOptions.callbacks?.jwt as unknown as JwtCallback;
  const next = await jwt({ token });

  const session: SessionWithToken = { expires: '' } as SessionWithToken;
  if (typeof next.accessToken === 'string') session.accessToken = next.accessToken;
  if (typeof next.error === 'string') session.error = next.error;

  if (!tokenChanged(before, next)) return { session, cookies: [] };

  const maxAge = sessionMaxAgeSeconds();
  const value = await encode({ token: next, secret, maxAge });
  const sessionOptions = authOptions.cookies?.sessionToken?.options ?? {};
  const cookies = sessionCookieWrites(
    naming.sessionTokenName,
    value,
    req.cookies.getAll().map((c) => c.name),
    {
      httpOnly: sessionOptions.httpOnly ?? true,
      sameSite: (sessionOptions.sameSite as 'lax' | undefined) ?? 'lax',
      path: sessionOptions.path ?? '/',
      secure: sessionOptions.secure ?? naming.useSecureCookies,
    },
    maxAge,
  );
  return { session, cookies };
}
