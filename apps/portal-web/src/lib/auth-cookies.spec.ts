// SPDX-License-Identifier: AGPL-3.0-or-later
import { authCookieNaming } from './auth-cookies';

describe('authCookieNaming', () => {
  it('uses the hardened prefixes on https', () => {
    const n = authCookieNaming('https://demo.gratisgis.org');
    expect(n.useSecureCookies).toBe(true);
    expect(n.sessionTokenName).toBe('__Secure-next-auth.session-token');
    expect(n.callbackUrlName).toBe('__Secure-next-auth.callback-url');
    expect(n.csrfTokenName).toBe('__Host-next-auth.csrf-token');
  });

  // The regression this file exists for. A browser will not store a
  // `__Secure-` cookie without the secure flag, so over http the
  // prefixed names produce no cookie at all, and middleware's getToken
  // looks for the unprefixed name regardless. Either half alone leaves
  // the portal in an endless redirect to /signin.
  it('drops the prefixes on http so middleware finds the cookie', () => {
    const n = authCookieNaming('http://localhost:3000');
    expect(n.useSecureCookies).toBe(false);
    expect(n.sessionTokenName).toBe('next-auth.session-token');
    expect(n.callbackUrlName).toBe('next-auth.callback-url');
    expect(n.csrfTokenName).toBe('next-auth.csrf-token');
  });

  it('treats a missing NEXTAUTH_URL as http', () => {
    expect(authCookieNaming(undefined).useSecureCookies).toBe(false);
    expect(authCookieNaming('').useSecureCookies).toBe(false);
  });

  // getToken does a plain `startsWith('https://')`, so anything that is
  // not exactly that prefix has to come out insecure or the two sides
  // disagree again.
  it.each([
    'HTTPS://demo.gratisgis.org',
    '//demo.gratisgis.org',
    'demo.gratisgis.org',
    'http://https://weird',
  ])('treats %s as http, matching getToken', (url) => {
    expect(authCookieNaming(url).useSecureCookies).toBe(false);
  });

  // The prefix and the flag have to move together: a `__Secure-` name
  // without the flag is refused by the browser, and the flag without
  // the name is merely wasteful. Pin the pairing rather than the two
  // values separately.
  it.each(['https://x.test', 'http://x.test', undefined])(
    'keeps prefix and secure flag consistent for %s',
    (url) => {
      const n = authCookieNaming(url);
      expect(n.sessionTokenName.startsWith('__Secure-')).toBe(n.useSecureCookies);
      expect(n.callbackUrlName.startsWith('__Secure-')).toBe(n.useSecureCookies);
      expect(n.csrfTokenName.startsWith('__Host-')).toBe(n.useSecureCookies);
    },
  );
});
