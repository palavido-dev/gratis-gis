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
  if (!session?.accessToken) {
    redirect('/api/auth/signin');
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
    throw new Error(`portal-api ${res.status}: ${body}`);
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
