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
