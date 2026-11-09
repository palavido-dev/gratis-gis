// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JWT } from 'next-auth/jwt';
import type { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';
import { authCookieNaming } from './auth-cookies';
import { sessionIdleSeconds, sessionMaxAgeSeconds } from './session-duration';

const keycloakUrl = (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
// When set (LAN / NAS install), server-side token calls stay on the
// docker network. The browser still uses KEYCLOAK_URL, which is the
// issuer baked into the token. Unset, both are the public URL and
// behavior matches the VPS stack.
const keycloakInternal = (
  process.env.KEYCLOAK_INTERNAL_URL ?? keycloakUrl
).replace(/\/$/, '');
const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
const tokenEndpoint = `${keycloakInternal}/realms/${realm}/protocol/openid-connect/token`;
const keycloakInternalDiffers = keycloakInternal !== keycloakUrl;

// Cookie naming lives in its own module because middleware has to
// derive the same names independently. See lib/auth-cookies.ts.
const cookieNaming = authCookieNaming(process.env.NEXTAUTH_URL);

/** Refresh `expires_at` 30 seconds before the actual expiry so an in-flight
 *  request doesn't race the boundary and end up with an expired token. */
const REFRESH_LEEWAY_SECONDS = 30;

/** How often a request moves the idle-timeout activity stamp. */
export const ACTIVITY_STAMP_INTERVAL_MS = 60_000;

/**
 * Refresh failures repeat on every request for as long as a browser
 * holds a dead refresh token (for example after the golden restore
 * drops the Keycloak database, which invalidates every session).
 * Log the first failure per minute rather than one line per request
 * so the signal survives in production logs without flooding them.
 * Before this existed, refresh failures were fully silent and the
 * broken-session state (#195) was invisible server-side.
 */
let lastRefreshWarnAt = 0;
function warnRefreshFailure(reason: string): void {
  const now = Date.now();
  if (now - lastRefreshWarnAt < 60_000) return;
  lastRefreshWarnAt = now;
  // eslint-disable-next-line no-console
  console.warn(`[auth] access token refresh failed: ${reason}`);
}

/**
 * In-flight refresh de-duplication, keyed by refresh token. A page
 * mount fans out into many parallel server-side requests (a map
 * view fires dozens), and each one runs the jwt() callback; once
 * the access token expires, every request in that burst decided to
 * refresh, stampeding Keycloak with parallel POSTs for the same
 * session. With realms that rotate refresh tokens this is worse
 * than load: the first grant invalidates the token the rest are
 * still presenting. Sharing one promise per refresh token means
 * one Keycloak round-trip per burst; every concurrent caller gets
 * the same refreshed JWT.
 */
const inFlightRefreshes = new Map<string, Promise<JWT>>();

/**
 * Successful refreshes, kept for a short while after they settle and
 * keyed by the refresh token they spent.
 *
 * A refresh that runs where no cookie can be written (server
 * components call getServerSession, which cannot set cookies in the
 * App Router) leaves the browser holding the old refresh token. The
 * next request presents it again. With refresh-token rotation that
 * token is already spent and Keycloak refuses it, so the session
 * would fail mid-use. Answering the repeat from here gives it the
 * same tokens the first refresh got, until a request that can write
 * the cookie (the BFF, see session-roll.ts) persists them.
 */
const RECENT_REFRESH_TTL_MS = 120_000;
/** Entry: the token set a spent refresh token was traded for, and
 *  when the entry may be forgotten. */
const recentRefreshes = new Map<string, { until: number; token: JWT }>();

function expiresAt(token: JWT): number {
  return typeof token.accessTokenExpires === 'number' ? token.accessTokenExpires : 0;
}

function rememberRefresh(spent: JWT, spentRefreshToken: string, token: JWT): void {
  const now = Date.now();
  for (const [key, entry] of recentRefreshes) {
    if (now > entry.until) recentRefreshes.delete(key);
  }
  // Keep the entry for as long as the spent set's access token still
  // works: until then a request carrying it does not refresh, and is
  // the one that could write the spent set back over the new one.
  recentRefreshes.set(spentRefreshToken, {
    until: Math.max(now + RECENT_REFRESH_TTL_MS, expiresAt(spent) + 60_000),
    token,
  });
}

function recentRefreshFor(refreshToken: string): JWT | null {
  const entry = recentRefreshes.get(refreshToken);
  if (!entry) return null;
  if (Date.now() > entry.until) {
    recentRefreshes.delete(refreshToken);
    return null;
  }
  return entry.token;
}

/**
 * The newest token set this process knows for the session `token`
 * belongs to.
 *
 * A slow request that started before a refresh still holds the older
 * set. If it then only moves the activity stamp, writing its cookie
 * would put the spent refresh token back over the rotated one, and
 * the session would fail at its next refresh. Following the chain of
 * refreshes (and only ever moving to a set whose access token expires
 * later) means a cookie written from here is never older than one
 * already handed out.
 */
export function newestTokenSet(token: JWT): JWT {
  let current = token;
  for (let hops = 0; hops < 8; hops++) {
    const rt = current.refreshToken;
    if (typeof rt !== 'string') break;
    const newer = recentRefreshFor(rt);
    if (!newer || expiresAt(newer) <= expiresAt(current)) break;
    current = newer;
  }
  if (current === token) return token;
  const lastActive = Math.max(
    typeof token.lastActive === 'number' ? token.lastActive : 0,
    typeof current.lastActive === 'number' ? current.lastActive : 0,
  );
  return { ...token, ...current, ...(lastActive ? { lastActive } : {}) } as JWT;
}

/** Test hook: forget refresh state between cases. */
export function resetRefreshStateForTests(): void {
  inFlightRefreshes.clear();
  recentRefreshes.clear();
}

/**
 * Trade the captured refresh_token for a fresh access_token + new
 * refresh_token from Keycloak. Returns an updated JWT mirror; on
 * failure, marks the token with `error: 'RefreshAccessTokenError'`
 * so middleware / pages can surface a sign-in prompt.
 *
 * Keycloak responds with `{ access_token, refresh_token,
 * expires_in, token_type, id_token, ... }`. We persist the new
 * access_token and a freshly-computed `accessTokenExpires`. The new
 * refresh_token may or may not be present (depends on realm
 * settings); when omitted, we keep the previous one until it too
 * expires.
 */
async function refreshAccessToken(token: JWT): Promise<JWT> {
  const refreshToken = token.refreshToken as string | undefined;
  if (!refreshToken) {
    warnRefreshFailure('no refresh token on session');
    return { ...token, error: 'RefreshAccessTokenError' };
  }
  const recent = recentRefreshFor(refreshToken);
  if (recent) return { ...token, ...recent, lastActive: token.lastActive } as JWT;
  const inFlight = inFlightRefreshes.get(refreshToken);
  if (inFlight) return inFlight;
  const pending = requestRefreshedToken(token, refreshToken)
    .then((next) => {
      if (!next.error) rememberRefresh(token, refreshToken, next);
      return next;
    })
    .finally(() => {
      inFlightRefreshes.delete(refreshToken);
    });
  inFlightRefreshes.set(refreshToken, pending);
  return pending;
}

/** The actual Keycloak round-trip behind refreshAccessToken. Never
 *  rejects: failures come back as the same token with the error
 *  flag set, matching the pre-dedup semantics. */
async function requestRefreshedToken(
  token: JWT,
  refreshToken: string,
): Promise<JWT> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
    });
    const secret = process.env.KEYCLOAK_CLIENT_SECRET_WEB;
    if (secret) body.set('client_secret', secret);
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
      error?: string;
    };
    if (!res.ok || !data.access_token) {
      warnRefreshFailure(
        `keycloak responded ${res.status}${data.error ? ` (${data.error})` : ''}`,
      );
      return { ...token, error: 'RefreshAccessTokenError' };
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 300;
    return {
      ...token,
      accessToken: data.access_token,
      accessTokenExpires: Date.now() + expiresIn * 1000,
      // Some realms rotate the refresh token; some don't. Keep the
      // newer one when present, otherwise hold onto the previous.
      refreshToken: data.refresh_token ?? refreshToken,
      idToken: data.id_token ?? (token.idToken as string | undefined),
      // Clear any stale error from a previous failed refresh.
      error: undefined,
    } as JWT;
  } catch {
    warnRefreshFailure('token endpoint unreachable');
    return { ...token, error: 'RefreshAccessTokenError' };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_WEB ?? '',
      issuer: `${keycloakUrl}/realms/${realm}`,
      // wellKnown discovery would follow the public issuer and make
      // the server call back out through Caddy. Empty disables it so
      // the explicit endpoints below are what the client uses.
      ...(keycloakInternalDiffers
        ? {
            wellKnown: '',
            token: tokenEndpoint,
            userinfo: `${keycloakInternal}/realms/${realm}/protocol/openid-connect/userinfo`,
            jwks_endpoint: `${keycloakInternal}/realms/${realm}/protocol/openid-connect/certs`,
            authorization: {
              url: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/auth`,
              params: { scope: 'openid email profile' },
            },
          }
        : {}),
      // We *want* offline_access here so the refresh token survives
      // the realm's ssoSessionIdleTimeout (the bit that signs PWA
      // users out after a day or two of not opening the app). But
      // requesting it requires the realm to have offline_access in
      // the client's optional scopes AND the user to have the
      // offline_access role. Prod Keycloak rejected the OAuth
      // callback with "Offline tokens not allowed for the user or
      // client" because the realm wasn't configured for it; the
      // 365-day NextAuth session.maxAge below still keeps users
      // signed in across PWA launches by extending the JWT cookie,
      // and the in-band refresh-token rotation handles ongoing
      // calls to portal-api. Re-add the scope here once the
      // realm-side config (offline_access default-role +
      // optional-client-scope) is in place. (#229 hotfix)
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // 1. Initial sign-in: NextAuth passes `account` with the OIDC
      //    response (access_token, refresh_token, id_token, expires_at).
      //    Capture everything we'll need to refresh later. expires_at
      //    is in seconds-since-epoch; convert to ms for parity with
      //    Date.now() in the refresh check.
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          accessTokenExpires:
            typeof account.expires_at === 'number'
              ? account.expires_at * 1000
              : Date.now() + 300 * 1000,
          refreshToken: account.refresh_token,
          idToken: account.id_token,
          lastActive: Date.now(),
        } as JWT;
      }

      // Never carry on from an older token set than this process has
      // already handed out (see newestTokenSet).
      token = newestTokenSet(token);

      const idle = sessionIdleSeconds();
      if (idle !== null && typeof token.lastActive === 'number') {
        if (Date.now() - token.lastActive > idle * 1000) {
          return { ...token, error: 'IdleTimeout' };
        }
      }
      // Stamp activity at most once a minute. The stamp only counts
      // once a route handler writes it back to the cookie (see
      // session-roll.ts), and rewriting the cookie on every one of a
      // map view's dozens of requests would be pure overhead.
      if (
        idle !== null &&
        (typeof token.lastActive !== 'number' ||
          Date.now() - token.lastActive >= ACTIVITY_STAMP_INTERVAL_MS)
      ) {
        token.lastActive = Date.now();
      }

      // 2. Subsequent calls: if the access token is still fresh,
      //    return as-is. Subtract a leeway so we refresh slightly
      //    early rather than handing out a token that might expire
      //    mid-request.
      const expiresAt = (token.accessTokenExpires as number | undefined) ?? 0;
      if (Date.now() < expiresAt - REFRESH_LEEWAY_SECONDS * 1000) {
        return token;
      }

      // 3. Token expired (or close to). Refresh against Keycloak.
      //    On failure the returned token carries an error flag; the
      //    session callback below surfaces it so middleware can
      //    redirect to sign-in.
      return refreshAccessToken(token);
    },
    async session({ session, token }) {
      // Only attach the access token when there actually is one. Assigning
      // `undefined` is rejected under `exactOptionalPropertyTypes: true`.
      const accessToken = token.accessToken as string | undefined;
      if (accessToken) {
        (session as SessionWithToken).accessToken = accessToken;
      }
      // Surface the refresh-failure flag so middleware/pages can route
      // the user back to sign-in when their refresh token has also
      // expired (full SSO timeout). Without this, every API call keeps
      // returning 401 silently and the UX looks like a hung page.
      const error = token.error as string | undefined;
      if (error) {
        (session as SessionWithToken).error = error;
      }
      return session;
    },
  },
  // Default stays 365 days. GRATIS_SESSION_MAX_AGE_SECONDS and
  // GRATIS_SESSION_IDLE_SECONDS can tighten the portal cookie.
  // Neither value revokes a Keycloak session. See
  // docs/operations/session.md.
  session: { strategy: 'jwt', maxAge: sessionMaxAgeSeconds() },
  jwt: { maxAge: sessionMaxAgeSeconds() },
  // We have only one provider (Keycloak). Override the default
  // /api/auth/signin picker page with a custom /signin that
  // immediately redirects to Keycloak; saves the user a useless
  // "Sign in with Keycloak" click. See app/signin/page.tsx.
  pages: { signIn: '/signin' },
  // Explicit cookie hardening.  NextAuth defaults to httpOnly +
  // secure + sameSite=lax on HTTPS, which is fine, but the
  // defaults are easy to silently lose on a future config change.
  // Making them explicit pins the contract and lets the CSRF
  // cookie use the stricter `__Host-` prefix + sameSite=strict.
  //
  // The prefixes and the `secure` flag follow `useSecureCookies` above
  // rather than being hardcoded, because the browser refuses a
  // `__Secure-` cookie without `secure`, and middleware derives the
  // name it looks for the same way. See the note on that constant.
  cookies: {
    sessionToken: {
      name: cookieNaming.sessionTokenName,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: cookieNaming.useSecureCookies,
      },
    },
    callbackUrl: {
      name: cookieNaming.callbackUrlName,
      options: {
        sameSite: 'lax',
        path: '/',
        secure: cookieNaming.useSecureCookies,
      },
    },
    csrfToken: {
      name: cookieNaming.csrfTokenName,
      options: {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: cookieNaming.useSecureCookies,
      },
    },
  },
};

/**
 * Drop the Keycloak access token before a session JSON body is sent
 * to the browser. Server code still reads the token from the JWT
 * callback via getServerSession. The cookie stays httpOnly.
 */
export function sessionWithoutAccessToken(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (!('accessToken' in body)) return body;
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.accessToken;
  return copy;
}

export type SessionWithToken = import('next-auth').Session & {
  accessToken?: string;
  error?: string;
};

export const keycloakEndSessionBase = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/logout`;
