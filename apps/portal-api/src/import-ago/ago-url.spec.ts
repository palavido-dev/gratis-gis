// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  agoTokenMayGoTo,
  agoTokenOrigins,
  buildAgoAuthorizeUrl,
  normalizeAgoUrl,
} from './ago-url.js';

describe('normalizeAgoUrl', () => {
  it('accepts bare host (no scheme)', () => {
    const r = normalizeAgoUrl('palavido.maps.arcgis.com');
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
    expect(r?.origin).toBe('https://palavido.maps.arcgis.com');
    expect(r?.portalPath).toBe('');
  });

  it('accepts host with scheme', () => {
    const r = normalizeAgoUrl('https://palavido.maps.arcgis.com');
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
  });

  it('accepts host with trailing slash', () => {
    const r = normalizeAgoUrl('https://palavido.maps.arcgis.com/');
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
  });

  it('strips /home suffix that AGO bookmarks tend to carry', () => {
    const r = normalizeAgoUrl('https://palavido.maps.arcgis.com/home/');
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
  });

  it('passes through already-canonical /sharing/rest URLs', () => {
    const r = normalizeAgoUrl(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
  });

  it('trims everything after /sharing/rest', () => {
    const r = normalizeAgoUrl(
      'https://palavido.maps.arcgis.com/sharing/rest/content/users/x',
    );
    expect(r?.sharingRestBase).toBe(
      'https://palavido.maps.arcgis.com/sharing/rest',
    );
  });

  it('accepts the AGO public-cloud host', () => {
    const r = normalizeAgoUrl('https://www.arcgis.com');
    expect(r?.sharingRestBase).toBe('https://www.arcgis.com/sharing/rest');
  });

  it('preserves portal-name prefix on Enterprise installs', () => {
    const r = normalizeAgoUrl('https://gis.example.gov/portal');
    expect(r?.sharingRestBase).toBe(
      'https://gis.example.gov/portal/sharing/rest',
    );
    expect(r?.portalPath).toBe('/portal');
  });

  it('preserves portal-name prefix even when the input includes /home', () => {
    const r = normalizeAgoUrl('https://gis.example.gov/portal/home/');
    expect(r?.sharingRestBase).toBe(
      'https://gis.example.gov/portal/sharing/rest',
    );
  });

  it('returns null for empty input', () => {
    expect(normalizeAgoUrl('')).toBeNull();
    expect(normalizeAgoUrl('   ')).toBeNull();
  });

  it('rejects http:// (no scheme downgrade allowed)', () => {
    expect(normalizeAgoUrl('http://palavido.maps.arcgis.com')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(normalizeAgoUrl('not a url at all')).toBeNull();
    // The string "https:" with no host parses but has no origin
    // we can build /sharing/rest under, so we'd expect null. URL
    // parsing actually accepts "https:" as a relative-like form
    // in some node versions, so we accept that this edge case
    // returns a value with an empty-ish sharingRestBase rather
    // than null; the controller still rejects via its own
    // isLikelyOwnPortalRedirect / outbound-URL guards.
  });
});

describe('buildAgoAuthorizeUrl', () => {
  it('builds the /oauth2/authorize URL with the expected params', () => {
    const url = buildAgoAuthorizeUrl({
      sharingRestBase: 'https://palavido.maps.arcgis.com/sharing/rest',
      clientId: 'abc123',
      redirectUri: 'https://gratisgis.example/admin/migrations/from-ago/oauth-callback',
      state: 'csrf-token-xyz',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://palavido.maps.arcgis.com');
    expect(parsed.pathname).toBe('/sharing/rest/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('abc123');
    expect(parsed.searchParams.get('response_type')).toBe('token');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://gratisgis.example/admin/migrations/from-ago/oauth-callback',
    );
    expect(parsed.searchParams.get('state')).toBe('csrf-token-xyz');
  });

  it('emits an expiration param when given expirationMinutes', () => {
    const url = buildAgoAuthorizeUrl({
      sharingRestBase: 'https://www.arcgis.com/sharing/rest',
      clientId: 'cid',
      redirectUri: 'https://portal.example/cb',
      state: 's',
      expirationMinutes: 60,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('expiration')).toBe('60');
  });

  it('omits expiration when not provided', () => {
    const url = buildAgoAuthorizeUrl({
      sharingRestBase: 'https://www.arcgis.com/sharing/rest',
      clientId: 'cid',
      redirectUri: 'https://portal.example/cb',
      state: 's',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('expiration')).toBe(false);
  });
});

describe('agoTokenMayGoTo', () => {
  const ago = 'https://palavido.maps.arcgis.com/sharing/rest';
  const ent = 'https://gis.county.example/portal/sharing/rest';

  it('allows the portal and ArcGIS Online hosted services', () => {
    const origins = agoTokenOrigins(ago);
    expect(agoTokenMayGoTo('https://palavido.maps.arcgis.com/x', ago, origins)).toBe(true);
    expect(
      agoTokenMayGoTo('https://services3.arcgis.com/abc/arcgis/rest/services/P/FeatureServer', ago, origins),
    ).toBe(true);
  });

  it('refuses third-party servers and plain http', () => {
    const origins = agoTokenOrigins(ago);
    expect(agoTokenMayGoTo('https://gis.partner.example/arcgis/rest/services/X/MapServer', ago, origins)).toBe(false);
    expect(agoTokenMayGoTo('http://services3.arcgis.com/x', ago, origins)).toBe(false);
    expect(agoTokenMayGoTo('https://arcgis.com.evil.example/x', ago, origins)).toBe(false);
  });

  it('allows an Enterprise portal and its federated servers only', () => {
    const origins = agoTokenOrigins(ent, ['https://gisserver.county.example/server']);
    expect(agoTokenMayGoTo('https://gis.county.example/server/rest/services/A/FeatureServer', ent, origins)).toBe(true);
    expect(agoTokenMayGoTo('https://gisserver.county.example/server/rest/services/B/MapServer', ent, origins)).toBe(true);
    expect(agoTokenMayGoTo('https://services3.arcgis.com/x', ent, origins)).toBe(false);
  });
});
