// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { keycloakEndSessionBase } from '@/lib/auth';

/**
 * Federated logout. The piece plain NextAuth doesn't do.
 *
 * Problem: calling `/api/auth/signout` only drops the portal-side
 * session cookie. Keycloak's own SSO session stays alive, so the next
 * click on "Sign in with Keycloak" silent-auths the same user right
 * back in. The fix is OIDC RP-Initiated Logout:
 *
 *   1. We build a redirect to Keycloak's `end_session_endpoint`
 *      with the stored `id_token_hint` and a `post_logout_redirect_uri`
 *      pointing at the public landing page (`/`).
 *   2. We also clear the NextAuth session / CSRF cookies on the same
 *      response so the portal side is dropped in the same round-trip.
 *   3. The browser hits Keycloak; Keycloak clears its SSO session and
 *      redirects to `/`.
 *   4. The landing page renders the unauthenticated public view (with
 *      its own Sign in link). The next sign-in click goes through
 *      Keycloak's login form for real because there is no SSO session.
 *
 * Contract: this route does NOT clear the NextAuth session cookie.
 * Every caller must run NextAuth's client-side signOut({ redirect:
 * false }) FIRST and only then navigate here; the shared
 * federatedSignOut() helper in components/user-menu.tsx does both
 * (plus the service worker cache purge) and is the only sanctioned
 * way in. Do not link to this route directly: a bare link leaves
 * the NextAuth cookie alive, so the portal still treats the user
 * as signed in even though Keycloak's SSO session is gone.
 */
export async function GET(req: NextRequest) {
  // getToken's `secret` field is required; fall back to an empty
  // string if the env is somehow missing so the call type-checks
  // the worst case is a null token, which we handle gracefully below
  // by relying on client_id alone for the Keycloak round-trip.
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? '',
  });
  const idToken = token?.idToken as string | undefined;

  const base = (
    process.env.NEXTAUTH_URL ?? new URL(req.url).origin
  ).replace(/\/$/, '');
  // #249.17 Phase 1: callers can pass `?redirect=<path>` to override
  // the post-logout landing target. Used by the field PWA so signing
  // out from /field returns to /field rather than the landing page.
  // The unauthenticated /field load then routes through the
  // middleware -> /signin?callbackUrl=/field -> Keycloak login ->
  // /field, which keeps a mobile field user "in the field sandbox"
  // through a sign-out + sign-in cycle. Validation: only same-origin
  // path-like values pass through to prevent open-redirect bugs;
  // anything that includes a scheme or doesn't start with '/' falls
  // back to the default landing page. Default behaviour preserved
  // (`/`) when the param is absent so non-field sign-outs are
  // unchanged.
  const requested = new URL(req.url).searchParams.get('redirect');
  const safeRedirect =
    requested && requested.startsWith('/') && !requested.startsWith('//')
      ? requested
      : '/';
  const postLogoutRedirectUri = `${base}${safeRedirect}`;

  const endSession = new URL(keycloakEndSessionBase);
  if (idToken) endSession.searchParams.set('id_token_hint', idToken);
  endSession.searchParams.set(
    'post_logout_redirect_uri',
    postLogoutRedirectUri,
  );
  // `client_id` is required by Keycloak 19+ when no id_token_hint is
  // available; set it unconditionally so first-load cases (missing
  // id_token on the JWT for whatever reason) still complete the
  // round-trip.
  endSession.searchParams.set(
    'client_id',
    process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
  );

  // The user-menu's Sign out button calls NextAuth's client-side
  // signOut() FIRST (which clears the local session cookies via
  // NextAuth's own runtime, matching the exact attributes it set
  // them with), THEN navigates here. By the time we run, the
  // local session is already gone -- this route just builds the
  // Keycloak end-session redirect so the IDP-side SSO session is
  // killed too. Without this hop the next "Sign in with
  // Keycloak" click would silent-auth the same user back in.
  //
  // We previously tried to do BOTH the cookie clear AND the
  // Keycloak redirect from this route. The cookie-clear half kept
  // mismatching NextAuth's actual cookie names (depends on
  // useSecureCookies + cookie name overrides + httpOnly flags
  // that have to round-trip exactly), and Chrome's __Secure-/
  // __Host- prefix rules added more landmines. Splitting the
  // responsibilities means each step uses its proper API: signOut
  // for cookies (NextAuth knows what it set), this route for the
  // Keycloak hop only.
  return NextResponse.redirect(endSession);
}
