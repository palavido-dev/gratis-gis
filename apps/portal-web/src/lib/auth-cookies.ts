// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cookie naming for the NextAuth session, in one place because two
 * independent pieces of code have to agree on it.
 *
 * `lib/auth.ts` sets the cookies. `middleware.ts` reads them, through
 * `withAuth`, whose internal `getToken()` picks the name from its own
 * `useSecureCookies` default: `NEXTAUTH_URL.startsWith('https://')`.
 * Nothing makes the two agree at compile time, so the rule lives here
 * and is pinned by a spec.
 *
 * Hardcoding the `__Secure-` names made them disagree on any http
 * deployment. The session cookie was written as
 * `__Secure-next-auth.session-token` while middleware looked for the
 * unprefixed name, found nothing, and bounced every request to
 * /signin. Sign-in then succeeded and returned into the same guard, so
 * the portal was an infinite redirect loop that surfaced no error.
 * Production is https behind Caddy and never saw it; local dev and any
 * self-hosted install running over plain http on an internal network
 * saw nothing else.
 *
 * The prefixes are not decoration. A browser refuses a `__Secure-`
 * cookie that lacks the `secure` flag, and refuses a `__Host-` cookie
 * that lacks `secure`, sets a Domain, or uses a path other than `/`.
 * So the prefix and the flag have to move together, which is why this
 * returns both.
 */

export interface AuthCookieNaming {
  /** Whether cookies get the secure flag and the hardened prefixes. */
  useSecureCookies: boolean;
  sessionTokenName: string;
  callbackUrlName: string;
  csrfTokenName: string;
}

/**
 * Derive the cookie naming from the app's public URL.
 *
 * @param nextAuthUrl - the NEXTAUTH_URL value; missing is treated as
 *   http, which is the safe direction: unprefixed names still work
 *   over https, whereas prefixed names over http do not work at all.
 */
export function authCookieNaming(nextAuthUrl: string | undefined): AuthCookieNaming {
  const useSecureCookies = (nextAuthUrl ?? '').startsWith('https://');
  const securePrefix = useSecureCookies ? '__Secure-' : '';
  const hostPrefix = useSecureCookies ? '__Host-' : '';
  return {
    useSecureCookies,
    sessionTokenName: `${securePrefix}next-auth.session-token`,
    callbackUrlName: `${securePrefix}next-auth.callback-url`,
    csrfTokenName: `${hostPrefix}next-auth.csrf-token`,
  };
}
