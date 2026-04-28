/**
 * Route-level auth guard. Redirects unauthenticated users to sign-in and
 * preserves the originally requested URL as callbackUrl, so they land
 * where they intended after authenticating.
 *
 * The `matcher` below is the list of routes that require a session. Public
 * pages (the home page, the /api/auth/* routes) are intentionally excluded.
 */
import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: {
    // Mirror authOptions.pages.signIn so middleware redirects skip
    // the default provider picker and go straight to /signin, which
    // immediately calls signIn('keycloak'). One provider == one less
    // click for the user.
    signIn: '/signin',
  },
});

export const config = {
  matcher: [
    '/items/:path*',
    '/groups/:path*',
    '/reports/:path*',
    '/recently-deleted/:path*',
    '/profile/:path*',
  ],
};
