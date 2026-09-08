// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ProxyPathError,
  composeUpstreamUrl,
  extractSubPath,
  isUnsafeProxySegment,
} from './proxy-subpath.js';

const BASE = 'https://gis.example.org/arcgis/rest/services/Parcels/MapServer';
const ITEM = '/api/items/11111111-1111-7111-8111-111111111111/proxy';

describe('isUnsafeProxySegment', () => {
  it.each(['', '.', '..', '%2e', '%2E', '%2e%2e', '.%2e', '%2e.', '%2E%2E'])(
    'refuses %j',
    (segment) => {
      expect(isUnsafeProxySegment(segment)).toBe(true);
    },
  );

  it.each(['..\\', 'a\\b', '%5c', 'x%5C..'])('refuses a backslash spelling %j', (segment) => {
    expect(isUnsafeProxySegment(segment)).toBe(true);
  });

  it.each(['0', 'query', '...', '.hidden', 'a.b', '%2ex', 'MapServer'])(
    'accepts %j',
    (segment) => {
      expect(isUnsafeProxySegment(segment)).toBe(false);
    },
  );
});

describe('extractSubPath', () => {
  it('returns the nested path with its query string attached', () => {
    expect(extractSubPath(`${ITEM}/0/query?where=1%3D1&f=json`)).toBe(
      '0/query?where=1%3D1&f=json',
    );
  });

  it('returns an empty string for a bare /proxy', () => {
    expect(extractSubPath(ITEM)).toBe('');
    expect(extractSubPath(`${ITEM}/`)).toBe('');
  });

  it('keeps a query-only sub-path (the detail page Probe call)', () => {
    expect(extractSubPath(`${ITEM}?f=json`)).toBe('?f=json');
  });

  it('does not treat a route segment that merely starts with proxy as the marker', () => {
    expect(extractSubPath('/api/items/x/proxyfoo/proxy/layers')).toBe('layers');
  });

  it.each([
    `${ITEM}/../../admin`,
    `${ITEM}/0/../../../admin`,
    `${ITEM}/%2e%2e/%2e%2e/admin`,
    `${ITEM}/%2E%2E/admin`,
    `${ITEM}/.%2e/admin`,
    `${ITEM}/./0/query`,
    `${ITEM}//admin`,
    `${ITEM}/0/query/`,
    `${ITEM}/..%5c..%5cadmin`,
    `${ITEM}/..\\..\\admin`,
  ])('refuses traversal shape %s', (url) => {
    expect(() => extractSubPath(url)).toThrow(ProxyPathError);
  });

  it('does not inspect the query string for dot segments', () => {
    expect(extractSubPath(`${ITEM}/0/query?path=../../x`)).toBe('0/query?path=../../x');
  });
});

describe('composeUpstreamUrl', () => {
  it('joins a nested path and keeps its query string', () => {
    expect(composeUpstreamUrl(BASE, '0/query?where=1%3D1&f=json', null)).toBe(
      `${BASE}/0/query?where=1%3D1&f=json`,
    );
  });

  it('tolerates a trailing slash on the stored URL', () => {
    expect(composeUpstreamUrl(`${BASE}/`, '0', null)).toBe(`${BASE}/0`);
  });

  it('appends a query-only sub-path without an empty segment', () => {
    expect(composeUpstreamUrl(BASE, '?f=json', null)).toBe(`${BASE}?f=json`);
  });

  it('returns the bare stored URL for an empty sub-path', () => {
    expect(composeUpstreamUrl(BASE, '', null)).toBe(BASE);
  });

  it('injects an arcgis_token credential as a query param', () => {
    const out = new URL(
      composeUpstreamUrl(BASE, '0/query?f=json', { kind: 'arcgis_token', token: 'abc' }),
    );
    expect(out.pathname).toBe('/arcgis/rest/services/Parcels/MapServer/0/query');
    expect(out.searchParams.get('f')).toBe('json');
    expect(out.searchParams.get('token')).toBe('abc');
  });

  it('refuses a composition whose pathname leaves the stored URL', () => {
    // Belt and braces: extractSubPath already refuses these, but the
    // containment check must hold on its own for any future caller.
    expect(() => composeUpstreamUrl(BASE, '../../admin', null)).toThrow(ProxyPathError);
    expect(() => composeUpstreamUrl(BASE, '%2e%2e/%2e%2e/admin', null)).toThrow(
      ProxyPathError,
    );
    expect(() => composeUpstreamUrl(BASE, '..\\..\\admin', null)).toThrow(ProxyPathError);
  });

  it('refuses a sibling that merely shares the stored pathname as a prefix', () => {
    // A plain startsWith on the pathname would accept this: the
    // normalised path begins with the stored one as a string but is
    // not under it as a directory.
    expect(() =>
      composeUpstreamUrl(BASE, '0/../../MapServerEvil/0', null),
    ).toThrow(ProxyPathError);
  });

  it('refuses a stored URL that does not parse', () => {
    expect(() => composeUpstreamUrl('not a url', '0', null)).toThrow(ProxyPathError);
  });
});
