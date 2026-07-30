// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One place to answer "is this session actually good for anything".
 *
 * The NextAuth cookie lives for a year, but the Keycloak tokens
 * inside it die whenever Keycloak forgets the session: the nightly
 * golden restore on the demo, an SSO max-lifespan expiry, a Keycloak
 * restart mid-deploy. When that happens the jwt callback flags the
 * token with `error: 'RefreshAccessTokenError'` and the BFF strips
 * the access token from every proxied call, so the API treats the
 * user as anonymous (#195).
 *
 * The bug this file exists to prevent: `!!session` is true in that
 * state, so every surface that gated on it kept claiming the user
 * was signed in while the expired-session banner sat directly above
 * saying the opposite, and their private content was gone. Gate on
 * hasUsableSession instead, so the whole UI agrees with what the BFF
 * is actually doing.
 *
 * Pure and dependency-free on purpose: server components read it
 * from getServerSession, client components from useSession.
 */

import type { Session } from 'next-auth';

/** The flag lib/auth.ts sets when a token refresh against Keycloak fails. */
export const SESSION_STALE_ERROR = 'RefreshAccessTokenError';

/**
 * What both getServerSession and useSession hand back, plus the error
 * the session callback stamps on. Spelled as an intersection with
 * Session rather than a bare `{ error?: string }` so a plain Session
 * still satisfies it: a parameter whose properties are all optional
 * is a weak type, and TypeScript rejects arguments that share none of
 * them.
 */
type MaybeSession = (Session & { error?: string | null }) | null | undefined;

/**
 * True when a session exists but its Keycloak tokens are dead.
 *
 * Any error on the session counts, not just SESSION_STALE_ERROR,
 * because that is the rule the BFF proxy applies when it decides to
 * strip the bearer. Narrowing this predicate would put the UI back
 * out of step with the API the moment a second error value exists.
 */
export function isSessionStale(session: MaybeSession): boolean {
  return !!session?.error;
}

/** True when a session exists and its tokens still work. */
export function hasUsableSession(session: MaybeSession): boolean {
  return !!session && !isSessionStale(session);
}
