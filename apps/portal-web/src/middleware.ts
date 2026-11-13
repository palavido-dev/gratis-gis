// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Route-level auth guard. Redirects unauthenticated users to sign-in and
 * preserves the originally requested URL as callbackUrl, so they land
 * where they intended after authenticating.
 *
 * The `matcher` below is the list of routes that require a session. Public
 * pages (the home page, the /api/auth/* routes) are intentionally excluded.
 */
import { withAuth, type NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

import { APP_RUNTIME_PATH_RE, appRuntimeCsp } from './lib/app-runtime-csp';

const API_BASE = process.env.PORTAL_API_URL ?? 'http://localhost:4000';
/** How long this server trusts its copy of the embed allow-list. An
 *  admin's change shows up on app pages within this long. */
const EMBED_ORIGINS_TTL_MS = 30_000;
let embedOrigins: { list: string[]; at: number } | null = null;

/** The admin's embed allow-list, cached. A failed read keeps the last
 *  good list, or none, so the page always gets a policy. */
async function loadEmbedOrigins(): Promise<string[]> {
  if (embedOrigins && Date.now() - embedOrigins.at < EMBED_ORIGINS_TTL_MS) {
    return embedOrigins.list;
  }
  try {
    const res = await fetch(`${API_BASE}/api/public/embed-origins`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { origins?: unknown };
      const list = Array.isArray(body.origins)
        ? body.origins.filter((o): o is string => typeof o === 'string')
        : [];
      embedOrigins = { list, at: Date.now() };
      return list;
    }
  } catch {
    /* fall through to the last good list */
  }
  return embedOrigins?.list ?? [];
}

// Authorized requests go through unchanged, except the custom app
// runtime, which gets its Content-Security-Policy here: the page
// policy plus the admin's allowed embed sites in frame-src (review
// 28b-5). next.config skips that path so its header cannot win.
export default withAuth(
  async function middleware(req: NextRequestWithAuth) {
    if (!APP_RUNTIME_PATH_RE.test(req.nextUrl.pathname)) {
      return NextResponse.next();
    }
    // Loaded here rather than at the top: the policy lives in an .mjs
    // shared with next.config, and the CommonJS jest runner that
    // imports this module for its matcher cannot load ESM.
    const { PAGE_CSP } = await import('./lib/content-security-policy.mjs');
    const res = NextResponse.next();
    res.headers.set(
      'Content-Security-Policy',
      appRuntimeCsp(PAGE_CSP, await loadEmbedOrigins()),
    );
    return res;
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
    '/recently-deleted/:path*',
    // Signed-in sections. Outside the matcher a signed-out visit drew
    // the page shell and relied on apiFetch's redirect as a backstop.
    // /feedback (anonymous feedback) and /print, /print-preview (used
    // by public custom apps) stay out on purpose.
    '/admin/:path*',
    '/assistant/:path*',
    '/maps/:path*',
    '/profile/:path*',
    '/field/:path*',
    // /settings/* is user-scoped and must redirect to sign-in rather
    // than render an error boundary when the session is gone. It was
    // missing here while /settings/notifications was the only page,
    // which worked only because apiFetch's redirect is a backstop.
    '/settings/:path*',
    // /forms/<id>/respond is the link a form hands out. Outside the
    // matcher, a signed-out respondent hit apiFetch's bare redirect to
    // /signin and landed on /items after signing in, not on the form.
    '/forms/:path*',
  ],
};
