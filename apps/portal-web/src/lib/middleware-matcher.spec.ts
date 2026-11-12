// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Routes a signed-out visitor is sent to sign-in from, with the page
 * they asked for kept as the callback. A route left out of the
 * matcher falls back to apiFetch's bare redirect and the visitor
 * lands on /items after signing in.
 */
import { config } from '../middleware';

describe('middleware matcher', () => {
  it('covers the form respond link', () => {
    expect(config.matcher).toContain('/forms/:path*');
  });
});
