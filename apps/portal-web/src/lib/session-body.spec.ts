// SPDX-License-Identifier: AGPL-3.0-or-later
import { sessionWithoutAccessToken } from './auth';

describe('sessionWithoutAccessToken', () => {
  it('removes the access token and leaves the rest of the session', () => {
    const out = sessionWithoutAccessToken({
      user: { name: 'Ada' },
      accessToken: 'secret-token',
      error: 'RefreshAccessTokenError',
    }) as Record<string, unknown>;
    expect(out.accessToken).toBeUndefined();
    expect(out.user).toEqual({ name: 'Ada' });
    expect(out.error).toBe('RefreshAccessTokenError');
  });

  it('leaves a session that has no access token unchanged in shape', () => {
    expect(sessionWithoutAccessToken({ user: { name: 'Ada' } })).toEqual({
      user: { name: 'Ada' },
    });
    expect(sessionWithoutAccessToken(null)).toBeNull();
  });
});
