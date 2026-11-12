// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cacheSet,
  passwordDigest,
  reusableToken,
  tokenCacheKey,
  tokenCacheSize,
} from './arcgis-auth.js';

/**
 * The exchanged token is sent to the item's service URL. The cache was
 * keyed by item, username and token endpoint only, so after the URL
 * was changed to a host advertising the same token endpoint, the
 * cached token was sent to the new host.
 */
describe('tokenCacheKey', () => {
  const TOKEN_URL = 'https://gis.example.org/portal/sharing/rest/generateToken';
  const base = {
    cacheKey: 'item-1',
    username: 'svc',
    password: 'pw',
    serviceUrl: 'https://gis.example.org/arcgis/rest/services/x/FeatureServer',
  };

  it('differs when the service URL changes', () => {
    expect(tokenCacheKey(base, TOKEN_URL)).not.toBe(
      tokenCacheKey(
        { ...base, serviceUrl: 'https://other.example/arcgis/rest/services/x/FeatureServer' },
        TOKEN_URL,
      ),
    );
  });

  it('never puts the password in the key', () => {
    const key = tokenCacheKey(base, TOKEN_URL);
    expect(key).not.toContain(base.password);
    expect(tokenCacheKey(base, TOKEN_URL)).toBe(key);
  });
});

describe('reusableToken', () => {
  const now = 1_000_000;
  const entry = { token: 'tok', expires: now + 10 * 60_000, passwordDigest: passwordDigest('pw') };

  it('reuses a live token minted with the same password', () => {
    expect(reusableToken(entry, 'pw', now)).toBe('tok');
  });

  it('refuses the token after the password is replaced', () => {
    expect(reusableToken(entry, 'new', now)).toBeNull();
    expect(reusableToken(entry, 'pwx', now)).toBeNull();
  });

  it('refuses a token within 60 seconds of expiry', () => {
    expect(reusableToken({ ...entry, expires: now + 59_000 }, 'pw', now)).toBeNull();
  });

  it('refuses when nothing is cached', () => {
    expect(reusableToken(undefined, 'pw', now)).toBeNull();
  });
});

describe('token cache bounds', () => {
  it('does not keep the password itself', () => {
    expect(passwordDigest('pw').toString('utf8')).not.toContain('pw');
  });

  it('never holds more than its ceiling', () => {
    for (let i = 0; i < 700; i++) {
      cacheSet(`k${i}`, { token: 't', expires: Date.now() + 60 * 60_000, passwordDigest: passwordDigest('x') });
    }
    expect(tokenCacheSize()).toBeLessThanOrEqual(500);
  });
});
