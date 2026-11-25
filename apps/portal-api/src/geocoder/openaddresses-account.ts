// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Get an OpenAddresses API token from inside Admin -> Geocoding, using
 * the public API of batch.openaddresses.io:
 *
 * - Create account: POST /api/user. OpenAddresses emails a link the
 *   admin must click before the account can sign in.
 * - Connect: POST /api/login (username or email, password) returns a
 *   short-lived session, then POST /api/token creates an API token.
 *
 * The password is sent once to OpenAddresses and never stored. Only the
 * resulting token is kept, encrypted, on the geocoder setting.
 */

export const OA_API = 'https://batch.openaddresses.io/api';
const USER_AGENT = 'GratisGIS (https://github.com/palavido-dev/gratis-gis)';
const TIMEOUT_MS = 15_000;

/** A failure the admin should read, with OpenAddresses' own reason where it gave one. */
export class OpenAddressesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpenAddressesError';
  }
}

async function call(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${OA_API}${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OpenAddressesError('Could not reach OpenAddresses. Try again in a minute.', 502);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const reason = (parsed as { message?: unknown } | null)?.message;
    throw new OpenAddressesError(
      friendlyReason(typeof reason === 'string' ? reason : '', res.status),
      res.status,
    );
  }
  return parsed;
}

/** OpenAddresses' error text, reworded where it helps. */
export function friendlyReason(reason: string, status: number): string {
  if (/not confirmed email/i.test(reason)) {
    return 'OpenAddresses has not confirmed this account yet. Click the link in the email they sent, then connect again.';
  }
  if (/invalid username or pass/i.test(reason)) {
    return 'OpenAddresses did not accept that username or password.';
  }
  if (/disabled/i.test(reason)) {
    return 'This OpenAddresses account is disabled. Contact OpenAddresses.';
  }
  if (reason) return `OpenAddresses said: ${reason.slice(0, 200)}`;
  return `OpenAddresses answered HTTP ${status}.`;
}

const USERNAME = /^[A-Za-z0-9._-]{2,40}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export interface SignupInput {
  username: string;
  email: string;
  password: string;
}

/** Check the sign-up fields before anything is sent. Returns an error message or null. */
export function signupProblem(input: Partial<SignupInput>): string | null {
  if (!input.username || !USERNAME.test(input.username)) {
    return 'Pick a username of 2 to 40 letters, numbers, dots, dashes or underscores.';
  }
  if (!input.email || !EMAIL.test(input.email)) return 'Enter a valid email address.';
  if (!input.password || input.password.length < 8 || input.password.length > 200) {
    return 'Use a password of at least 8 characters.';
  }
  return null;
}

/** Create an OpenAddresses account. They email a confirmation link. */
export async function createOpenAddressesAccount(
  input: SignupInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await call(fetchImpl, '/user', {
    username: input.username,
    email: input.email,
    password: input.password,
  });
}

/** Sign in and create an API token. Returns the token and the account's username. */
export async function connectOpenAddresses(
  login: { username: string; password: string },
  tokenName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; username: string }> {
  const session = (await call(fetchImpl, '/login', {
    username: login.username,
    password: login.password,
  })) as { token?: unknown; username?: unknown } | null;
  const jwt = typeof session?.token === 'string' ? session.token : null;
  if (!jwt) throw new OpenAddressesError('OpenAddresses did not return a session.', 502);
  const created = (await call(fetchImpl, '/token', { name: tokenName.slice(0, 80) }, jwt)) as {
    token?: unknown;
  } | null;
  const token = typeof created?.token === 'string' ? created.token : null;
  if (!token) throw new OpenAddressesError('OpenAddresses did not return a token.', 502);
  return {
    token,
    username: typeof session?.username === 'string' ? session.username : login.username,
  };
}
