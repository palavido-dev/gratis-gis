// SPDX-License-Identifier: AGPL-3.0-or-later
import type { JWT } from 'next-auth/jwt';
import type { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';

const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';
const tokenEndpoint = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`;

/** Refresh `expires_at` 30 seconds before the actual expiry so an in-flight
 *  request doesn't race the boundary and end up with an expired token. */
const REFRESH_LEEWAY_SECONDS = 30;

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
  const inFlight = inFlightRefreshes.get(refreshToken);
  if (inFlight) return inFlight;
  const pending = requestRefreshedToken(token, refreshToken).finally(() => {
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
        } as JWT;
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
  // 365-day session + JWT cookie. The default 30-day session is too
  // short for a field PWA where users may not open the app for
  // weeks at a stretch. Combined with the offline_access scope and
  // the refresh-token rotation in jwt() above, this lets the PWA
  // mint fresh access tokens silently on every launch as long as
  // the user has signed in within the last year. Equivalent to the
  // Field Maps "stay signed in" pattern. If the org wants tighter
  // session bounds, the realm-level ssoSessionMaxLifespan still
  // wins -- once the offline refresh token is invalidated server-
  // side, the JWT becomes useless and the user is forced through
  // sign-in again.
  session: { strategy: 'jwt', maxAge: 365 * 24 * 60 * 60 },
  jwt: { maxAge: 365 * 24 * 60 * 60 },
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
  cookies: {
    sessionToken: {
      name: '__Secure-next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    },
    callbackUrl: {
      name: '__Secure-next-auth.callback-url',
      options: { sameSite: 'lax', path: '/', secure: true },
    },
    csrfToken: {
      name: '__Host-next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: true,
      },
    },
  },
};

export type SessionWithToken = import('next-auth').Session & {
  accessToken?: string;
  error?: string;
};

export const keycloakEndSessionBase = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/logout`;
