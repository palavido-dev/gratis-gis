// SPDX-License-Identifier: AGPL-3.0-or-later
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions, type SessionWithToken } from './auth';

const API_BASE = process.env.PORTAL_API_URL ?? 'http://localhost:4000';

/**
 * Server-side fetch against portal-api that forwards the current user's
 * Keycloak access token. Use inside server components and route handlers.
 *
 * If there is no session, redirects to the sign-in flow. The middleware in
 * src/middleware.ts guards protected routes before they reach this code,
 * so in practice we expect a session here, but this is a defense-in-depth
 * backstop.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Per-call timing log behind the API_FETCH_TIMING flag. The slow
  // page-mount path on map items has 7+ sequential apiFetch awaits;
  // the log lets us split each call into "session" (NextAuth cookie
  // decrypt) vs "upstream" (portal-api round-trip) so we can tell
  // which hop owns the time when the page is slow.
  const trace = process.env.API_FETCH_TIMING === '1';
  const t0 = trace ? Date.now() : 0;

  const session = (await getServerSession(authOptions)) as SessionWithToken | null;
  const tSession = trace ? Date.now() : 0;
  // #195: a session whose Keycloak refresh failed still carries the
  // last access token it ever minted plus an error flag (set by
  // refreshAccessToken in lib/auth.ts). Forwarding that dead bearer
  // guarantees a 401 from portal-api, which surfaces to the user as
  // the route error boundary. Treat it exactly like having no
  // session: send the user through sign-in to mint a fresh token.
  if (
    !session?.accessToken ||
    session.error === 'RefreshAccessTokenError'
  ) {
    // Redirect via the custom /signin so the user skips the
    // default provider picker (we have only one provider).
    redirect('/signin');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  const tFetch = trace ? Date.now() : 0;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // #254 phase 2: structured error so callers can distinguish auth
    // failures (401 / 403) from server errors. The field-catalog page
    // surfaces 401 as "your session expired" with a sign-in button
    // rather than the generic empty state, so a stale-cookie load
    // doesn't silently look like "no deployments".
    const err = new Error(`portal-api ${res.status}: ${body}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  const json = (await res.json()) as T;
  if (trace) {
    const tDone = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[apiFetch] ${path} ` +
        `session=${tSession - t0}ms upstream=${tFetch - tSession}ms ` +
        `body=${tDone - tFetch}ms total=${tDone - t0}ms`,
    );
  }
  return json;
}

/**
 * Server-side fetch against portal-api WITHOUT an auth header
 * (#307). Used by the viewer runtime when an anonymous visitor
 * opens a public-share link. Targets portal-api's /api/public/...
 * surface, which returns 404 on private items so existence never
 * leaks. Throws the same structured error apiFetch does on
 * non-2xx, with a `status` field callers can branch on.
 */
export async function publicApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      `portal-api ${res.status}: ${body}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Detect whether the caller has an active session. Lets viewer
 * pages decide between auth'd /api/items/:id (full visibility
 * resolution) and anonymous /api/public/items/:id (public-only).
 * Centralized here so the page doesn't have to know about the
 * NextAuth surface directly.
 */
export async function hasSession(): Promise<boolean> {
  const session = (await getServerSession(
    authOptions,
  )) as SessionWithToken | null;
  // A session with the refresh-failure flag is a dead session: its
  // access token can no longer be renewed and portal-api rejects
  // it. Reporting it as "signed in" made viewer pages take the
  // authenticated fetch path and crash to the error boundary for
  // returning visitors; reporting signed-out lets them fall back
  // to their anonymous /api/public fetch path, which is exactly
  // what an expired visitor should see.
  return Boolean(session?.accessToken && !session.error);
}
