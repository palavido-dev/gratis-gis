// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pieces of the federated sign-out route (app/api/auth/federated-logout)
 * that do not need a request, so they can be tested.
 */

/**
 * Cookie that carries the id token from the "prepare" step to the
 * redirect step of a federated sign-out.
 *
 * Keycloak shows a "Do you want to log out?" page when the end-session
 * request has no `id_token_hint`. On a shared tablet a user who taps
 * Sign out and walks away from that page leaves the SSO session alive,
 * and the next person is signed in as them. The hint lives only in the
 * NextAuth session cookie, and the client clears that cookie (through
 * NextAuth's own signOut, which knows the exact attributes) before it
 * navigates to the redirect step. So the prepare step copies the id
 * token into this short-lived, httpOnly cookie scoped to the route
 * path, and the redirect step reads and deletes it. The token never
 * reaches page JavaScript.
 */
export const LOGOUT_HINT_COOKIE = 'gg-logout-hint';
export const LOGOUT_ROUTE_PATH = '/api/auth/federated-logout';
export const LOGOUT_HINT_MAX_AGE_SECONDS = 120;

export function logoutHintCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: LOGOUT_ROUTE_PATH,
    secure,
    maxAge: LOGOUT_HINT_MAX_AGE_SECONDS,
  };
}

/** Same-origin path for Keycloak's post-logout redirect, or `/`. */
export function safeLogoutRedirect(requested: string | null): string {
  return requested &&
    requested.startsWith('/') &&
    !requested.startsWith('//') &&
    !requested.startsWith('/\\')
    ? requested
    : '/';
}

export function buildEndSessionUrl(opts: {
  endSessionBase: string;
  portalBase: string;
  redirectPath: string;
  clientId: string;
  idToken: string | undefined;
}): URL {
  const url = new URL(opts.endSessionBase);
  if (opts.idToken) url.searchParams.set('id_token_hint', opts.idToken);
  url.searchParams.set(
    'post_logout_redirect_uri',
    `${opts.portalBase.replace(/\/$/, '')}${opts.redirectPath}`,
  );
  // Keycloak 19+ requires client_id when there is no id_token_hint.
  url.searchParams.set('client_id', opts.clientId);
  return url;
}

const SESSION_COOKIE_BASE = 'next-auth.session-token';

export interface CookieClear {
  name: string;
  value: '';
  options: {
    path: '/';
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    maxAge: 0;
  };
}

/**
 * Expire every session cookie name and chunk at the redirect step.
 *
 * NextAuth's signOut clears the session cookie first, but a BFF
 * response still in flight can land after that and write the session
 * back (the BFF rewrites the cookie when it refreshes the token). On a
 * shared device that would leave the next person signed in as the
 * last. The redirect step is the last portal response before Keycloak,
 * so it expires the cookie again: both the `__Secure-` and the plain
 * name, unchunked and as `.0`/`.1` chunks, plus any other chunk the
 * request carried. A `__Secure-` name can only be cleared with the
 * secure flag, so it always gets it.
 */
export function sessionCookieClears(
  presentNames: readonly string[],
  secureCookies: boolean,
): CookieClear[] {
  const names = new Set<string>();
  for (const base of [`__Secure-${SESSION_COOKIE_BASE}`, SESSION_COOKIE_BASE]) {
    names.add(base);
    names.add(`${base}.0`);
    names.add(`${base}.1`);
    for (const present of presentNames) {
      const chunk = present.startsWith(base) && /^\.\d+$/.test(present.slice(base.length));
      if (present === base || chunk) {
        names.add(present);
      }
    }
  }
  return [...names].map((name) => ({
    name,
    value: '',
    options: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-') ? true : secureCookies,
      maxAge: 0,
    },
  }));
}
