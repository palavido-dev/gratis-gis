// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Route-level auth guard. Redirects unauthenticated users to sign-in and
 * preserves the originally requested URL as callbackUrl, so they land
 * where they intended after authenticating.
 *
 * Also stamps an `x-gratis-pathname` request header on every protected
 * request so server components downstream can branch on the current
 * route without a custom server. Used by AppShell to suppress its own
 * chrome on the field-deployment runtime (which owns the full
 * viewport).
 *
 * The `matcher` below is the list of routes that require a session. Public
 * pages (the home page, the /api/auth/* routes) are intentionally excluded.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAuth } from 'next-auth/middleware';

export default withAuth(
  function onAuthorized(req: NextRequest) {
    // Forward the path to the downstream handlers so a server
    // component can read it via headers().get('x-gratis-pathname').
    // Re-issuing the request is the documented Next.js pattern for
    // injecting headers from middleware.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-gratis-pathname', req.nextUrl.pathname);
    return NextResponse.next({ request: { headers: requestHeaders } });
  },
  {
    pages: {
      // Mirror authOptions.pages.signIn so middleware redirects skip
      // the default provider picker and go straight to /signin, which
      // immediately calls signIn('keycloak'). One provider == one less
      // click for the user.
      signIn: '/signin',
    },
    callbacks: {
      // Default behavior is "authorized iff token present". We allow
      // a small allowlist of paths under matcher coverage to be
      // public. The Web App Manifest under /field/manifest.webmanifest
      // is the obvious one: PWA installers fetch it without the
      // user's session cookies (different fetch context), and a
      // 307-to-/signin breaks the install. Manifest files contain
      // no protected data; serving them anonymously is safe.
      authorized: ({ req, token }) => {
        if (req.nextUrl.pathname === '/field/manifest.webmanifest') {
          return true;
        }
        // #307 anonymous public access: a shared viewer link has the
        // form /items/:id/viewer/run. Let it through without a token
        // and let the page itself decide whether the item is
        // public-shared (render) or private (redirect to sign-in).
        // This is the AGOL model: the public link works for anyone
        // when the admin marked the item public, and falls back to
        // sign-in otherwise. The /editor/run path is left auth'd --
        // public anonymous editing is not a thing.
        //
        // #321 / #91: /items/:id/responses is the per-form Response
        // Viewer; same read-only public-share semantics as Viewer.
        // (The legacy /survey/run runtime was folded onto this route
        // when the survey item type was retired in #91.)
        //
        // /items/:id/custom/run is the Custom Web App runtime
        // (#261 / #341). It uses publicApiFetch under
        // !hasSession() so anonymous access against a public-shared
        // app already does the right thing on the page side; this
        // matcher entry just stops the middleware from short-
        // circuiting it to /signin.
        //
        // UUID-shape required so the anon allowance is bounded to
        // routes that can actually resolve to an item.  Without this,
        // a `:id` like `..` or `something-else-with-a-slash` would
        // pass the regex and the anon allowance would extend to
        // arbitrary subpaths beneath /items/.  Defense in depth; the
        // public.controller.ts UUID-shape gate is the load-bearing
        // check, this one just narrows the matcher.
        const uuid =
          '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
        const viewerRe = new RegExp(
          `^\\/items\\/${uuid}\\/viewer\\/run(?:\\/|$)`,
          'i',
        );
        const responsesRe = new RegExp(
          `^\\/items\\/${uuid}\\/responses(?:\\/|$)`,
          'i',
        );
        const customRe = new RegExp(
          `^\\/items\\/${uuid}\\/custom\\/run(?:\\/|$)`,
          'i',
        );
        // /items/:id/field is the data_collection PWA runtime. The
        // page renders against publicApiFetch / hasSession() so an
        // anonymous visitor on a public-shared data_collection
        // sees the read-only Add-disabled view; private items 401
        // server-side and the page falls back to the error
        // boundary. Same anonymous-public model as the viewer +
        // responses + custom routes above.
        const fieldRe = new RegExp(
          `^\\/items\\/${uuid}\\/field(?:\\/|$)`,
          'i',
        );
        if (
          viewerRe.test(req.nextUrl.pathname) ||
          responsesRe.test(req.nextUrl.pathname) ||
          customRe.test(req.nextUrl.pathname) ||
          fieldRe.test(req.nextUrl.pathname)
        ) {
          return true;
        }
        return !!token;
      },
    },
  },
);

export const config = {
  matcher: [
    '/items/:path*',
    '/groups/:path*',
    '/reports/:path*',
    '/recently-deleted/:path*',
    '/profile/:path*',
    '/field/:path*',
    // /settings/* is user-scoped and must redirect to sign-in rather
    // than render an error boundary when the session is gone. It was
    // missing here while /settings/notifications was the only page,
    // which worked only because apiFetch's redirect is a backstop.
    '/settings/:path*',
  ],
};
