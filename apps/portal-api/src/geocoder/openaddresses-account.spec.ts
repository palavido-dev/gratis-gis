// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  connectOpenAddresses,
  createOpenAddressesAccount,
  friendlyReason,
  OA_API,
  OpenAddressesError,
  signupProblem,
} from './openaddresses-account.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('signupProblem', () => {
  it('accepts a normal sign-up', () => {
    expect(
      signupProblem({ username: 'matt_p', email: 'matt@example.com', password: 'longenough' }),
    ).toBeNull();
  });

  it('refuses a bad username, email or short password', () => {
    expect(signupProblem({ username: 'a b', email: 'x@y.com', password: 'longenough' })).toMatch(/username/);
    expect(signupProblem({ username: 'ab', email: 'nope', password: 'longenough' })).toMatch(/email/);
    expect(signupProblem({ username: 'ab', email: 'x@y.com', password: 'short' })).toMatch(/password/);
  });
});

describe('friendlyReason', () => {
  it('rewords the unconfirmed-email error', () => {
    expect(friendlyReason('User has not confirmed email', 403)).toMatch(/link in the email/);
  });

  it('rewords a bad password', () => {
    expect(friendlyReason('Invalid Username or Pass', 403)).toMatch(/did not accept/);
  });
});

describe('createOpenAddressesAccount', () => {
  it('posts the account to /api/user', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return json({ username: 'matt_p', email: 'matt@example.com' });
    }) as unknown as typeof fetch;
    await createOpenAddressesAccount(
      { username: 'matt_p', email: 'matt@example.com', password: 'longenough' },
      f,
    );
    expect(calls).toEqual([
      {
        url: `${OA_API}/user`,
        body: { username: 'matt_p', email: 'matt@example.com', password: 'longenough' },
      },
    ]);
  });
});

describe('connectOpenAddresses', () => {
  it('signs in, then creates a token with the session', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get('Authorization') });
      if (String(url).endsWith('/login')) return json({ token: 'jwt.abc', username: 'matt_p' });
      return json({ id: 1, name: 'GratisGIS geocoder', token: 'oa.123', created: 0 });
    }) as unknown as typeof fetch;
    const out = await connectOpenAddresses({ username: 'matt@example.com', password: 'pw' }, 'GratisGIS geocoder', f);
    expect(out).toEqual({ token: 'oa.123', username: 'matt_p' });
    expect(seen).toEqual([
      { url: `${OA_API}/login`, auth: null },
      { url: `${OA_API}/token`, auth: 'Bearer jwt.abc' },
    ]);
  });

  it('turns an unconfirmed account into a readable error', async () => {
    const f = (async () => json({ status: 403, message: 'User has not confirmed email' }, 403)) as unknown as typeof fetch;
    await expect(connectOpenAddresses({ username: 'u', password: 'p' }, 'n', f)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/link in the email/),
    });
  });

  it('reports an unreachable service', async () => {
    const f = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(connectOpenAddresses({ username: 'u', password: 'p' }, 'n', f)).rejects.toBeInstanceOf(
      OpenAddressesError,
    );
  });
});
