// SPDX-License-Identifier: AGPL-3.0-or-later
import { tokenCacheKey } from './arcgis-auth.js';

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

  it('differs when the password changes and never contains it', () => {
    const key = tokenCacheKey(base, TOKEN_URL);
    expect(key).not.toBe(tokenCacheKey({ ...base, password: 'new' }, TOKEN_URL));
    expect(key).not.toContain('pw|');
    expect(tokenCacheKey(base, TOKEN_URL)).toBe(key);
  });
});
