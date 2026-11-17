// SPDX-License-Identifier: AGPL-3.0-or-later

// Pin DNS to a public address so the SSRF guard runs without network.
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '151.101.1.1', family: 4 })),
}));

import {
  ARCGIS_TOKEN_REFERER,
  exchangeBasicForArcgisToken,
  resetArcgisAuthCaches,
} from './arcgis-auth.js';
import { composeUpstreamHeaders } from './item-proxy.controller.js';

const SERVICE = 'https://gis.example.com/arcgis/rest/services/X/FeatureServer';
const TOKEN_URL = 'https://gis.example.com/arcgis/tokens/generateToken';

let originalFetch: typeof globalThis.fetch;
let calls: string[];
let tokenOk: boolean;

beforeEach(() => {
  resetArcgisAuthCaches();
  originalFetch = globalThis.fetch;
  calls = [];
  tokenOk = true;
  globalThis.fetch = jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/info')) {
      return new Response(
        JSON.stringify({ authInfo: { tokenServicesUrl: TOKEN_URL } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const body = tokenOk
      ? { token: `t${calls.length}`, expires: Date.now() + 3_600_000 }
      : { error: { message: 'Invalid username or password.' } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function exchange(cacheKey: string, password = 'pw') {
  return exchangeBasicForArcgisToken({
    serviceUrl: SERVICE,
    username: 'u',
    password,
    cacheKey,
  });
}

describe('exchangeBasicForArcgisToken', () => {
  it('discovers the token endpoint once, not on every request', async () => {
    await exchange('a');
    await exchange('a');
    // A second item on the same server reuses the discovered endpoint.
    await exchange('b');
    expect(calls.filter((u) => u.includes('/info'))).toHaveLength(1);
    expect(calls.filter((u) => u === TOKEN_URL)).toHaveLength(2);
  });

  it('remembers a failed login briefly instead of retrying it upstream', async () => {
    tokenOk = false;
    await expect(exchange('a')).rejects.toThrow('Invalid username');
    await expect(exchange('a')).rejects.toThrow('Invalid username');
    expect(calls.filter((u) => u === TOKEN_URL)).toHaveLength(1);
    // A new password is tried at once.
    tokenOk = true;
    await expect(exchange('a', 'new')).resolves.toMatch(/^t/);
  });
});

describe('composeUpstreamHeaders', () => {
  it('sends the bound referer with an exchanged token', () => {
    expect(
      composeUpstreamHeaders({
        kind: 'arcgis_token',
        token: 't',
        referer: ARCGIS_TOKEN_REFERER,
      }).referer,
    ).toBe(ARCGIS_TOKEN_REFERER);
  });

  it('sends no referer with a pasted token', () => {
    expect(
      composeUpstreamHeaders({ kind: 'arcgis_token', token: 't' }).referer,
    ).toBeUndefined();
  });
});
