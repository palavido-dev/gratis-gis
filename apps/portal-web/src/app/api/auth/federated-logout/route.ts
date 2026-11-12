// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { keycloakEndSessionBase } from '@/lib/auth';
import { authCookieNaming } from '@/lib/auth-cookies';
import {
  LOGOUT_HINT_COOKIE,
  buildEndSessionUrl,
  logoutHintCookieOptions,
  safeLogoutRedirect,
  sessionCookieClears,
} from '@/lib/federated-logout';

/**
 * Federated logout. The piece plain NextAuth doesn't do.
 *
 * Problem: calling `/api/auth/signout` only drops the portal-side
 * session cookie. Keycloak's own SSO session stays alive, so the next
 * click on "Sign in with Keycloak" silent-auths the same user right
 * back in. The fix is OIDC RP-Initiated Logout, in three steps run by
 * federatedSignOut() in components/user-menu.tsx:
 *
 *   1. POST here while the NextAuth session cookie still exists. The
 *      route copies the id token into a short-lived httpOnly cookie
 *      scoped to this path (see lib/federated-logout.ts for why).
 *   2. The client runs NextAuth's signOut({ redirect: false }), which
 *      clears the session cookies with the exact attributes NextAuth
 *      set them with. Clearing them from this route kept drifting
 *      from those attributes, so that stays NextAuth's job.
 *   3. The client navigates here (GET). The route reads the id token
 *      from the step 1 cookie, deletes that cookie, and redirects to
 *      Keycloak's end-session endpoint with `id_token_hint`, so
 *      Keycloak ends the SSO session without a confirmation page and
 *      sends the browser to `post_logout_redirect_uri`. It also expires
 *      the session cookie again, in case a BFF response that was in
 *      flight during step 2 wrote it back.
 *
 * Do not link to this route directly: a bare link skips step 2 and
 * leaves the NextAuth cookie alive, and skips the service worker and
 * IndexedDB purge federatedSignOut() runs first.
 */
function secureCookies(): boolean {
  return authCookieNaming(process.env.NEXTAUTH_URL).useSecureCookies;
}

async function sessionIdToken(req: NextRequest): Promise<string | undefined> {
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? '',
    cookieName: authCookieNaming(process.env.NEXTAUTH_URL).sessionTokenName,
  });
  const idToken = token?.idToken;
  return typeof idToken === 'string' && idToken ? idToken : undefined;
}

/** Step 1: stash the id token while the session cookie still exists. */
export async function POST(req: NextRequest) {
  const res = new NextResponse(null, { status: 204 });
  const idToken = await sessionIdToken(req);
  if (idToken) {
    res.cookies.set(LOGOUT_HINT_COOKIE, idToken, logoutHintCookieOptions(secureCookies()));
  }
  return res;
}

/** Step 3: redirect through Keycloak's end-session endpoint. */
export async function GET(req: NextRequest) {
  // Only the step 1 cookie counts. It is SameSite=Strict, so it is
  // present only on the app's own navigation. The session cookie is
  // SameSite=Lax and rides along on a link from any other site, so
  // falling back to it let any page or email sign a visitor out of
  // the portal and Keycloak without a confirmation. Without the hint
  // Keycloak asks the user to confirm, and the portal session cookies
  // are left alone.
  const hint = req.cookies.get(LOGOUT_HINT_COOKIE)?.value;
  const idToken = hint || undefined;

  const base = (process.env.NEXTAUTH_URL ?? new URL(req.url).origin).replace(
    /\/$/,
    '',
  );
  // #249.17 Phase 1: callers can pass `?redirect=<path>` to override
  // the post-logout landing target. Used by the field PWA so signing
  // out from /field returns to /field rather than the landing page.
  // Only same-origin paths pass, so this is not an open redirect.
  const redirectPath = safeLogoutRedirect(
    new URL(req.url).searchParams.get('redirect'),
  );

  const res = NextResponse.redirect(
    buildEndSessionUrl({
      endSessionBase: keycloakEndSessionBase,
      portalBase: base,
      redirectPath,
      clientId: process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
      idToken,
    }),
  );
  res.cookies.set(LOGOUT_HINT_COOKIE, '', {
    ...logoutHintCookieOptions(secureCookies()),
    maxAge: 0,
  });
  // A BFF response that was in flight during signOut can have written
  // the session cookie back. Expire it again here, but only on the
  // app's own sign-out (see the hint check above).
  if (hint) {
    for (const c of sessionCookieClears(
      req.cookies.getAll().map((x) => x.name),
      secureCookies(),
    )) {
      res.cookies.set(c.name, c.value, c.options);
    }
  }
  return res;
}
