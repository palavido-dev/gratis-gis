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
  try {
    const refreshToken = token.refreshToken as string | undefined;
    if (!refreshToken) {
      return { ...token, error: 'RefreshAccessTokenError' };
    }
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
    return { ...token, error: 'RefreshAccessTokenError' };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_WEB ?? '',
      issuer: `${keycloakUrl}/realms/${realm}`,
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
  session: { strategy: 'jwt' },
  // We have only one provider (Keycloak). Override the default
  // /api/auth/signin picker page with a custom /signin that
  // immediately redirects to Keycloak; saves the user a useless
  // "Sign in with Keycloak" click. See app/signin/page.tsx.
  pages: { signIn: '/signin' },
};

export type SessionWithToken = import('next-auth').Session & {
  accessToken?: string;
  error?: string;
};

export const keycloakEndSessionBase = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/logout`;
