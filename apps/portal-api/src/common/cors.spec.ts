// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  corsOptionsFor,
  isPublicCorsPath,
  parseAllowedOrigins,
  PUBLIC_CORS,
} from './cors.js';

describe('isPublicCorsPath', () => {
  it('matches the open-data prefixes and the health probe', () => {
    expect(isPublicCorsPath('/api/public/ogc/collections')).toBe(true);
    expect(isPublicCorsPath('/api/public/items/abc/layers/l/geojson?limit=5')).toBe(true);
    expect(isPublicCorsPath('/api/public')).toBe(true);
    expect(isPublicCorsPath('/health')).toBe(true);
  });

  it('does not match authenticated routes or look-alike prefixes', () => {
    expect(isPublicCorsPath('/api/items')).toBe(false);
    expect(isPublicCorsPath('/api/ogc/collections')).toBe(false);
    expect(isPublicCorsPath('/api/publicity')).toBe(false);
    expect(isPublicCorsPath('/api/items/public/x')).toBe(false);
    expect(isPublicCorsPath('/healthz')).toBe(false);
    expect(isPublicCorsPath('')).toBe(false);
  });
});

describe('parseAllowedOrigins', () => {
  it('trims, dedupes, and normalises entries to bare origins', () => {
    expect(
      parseAllowedOrigins(
        ' https://portal.example.org/ , https://portal.example.org/some/path,http://localhost:3000',
      ),
    ).toEqual(['https://portal.example.org', 'http://localhost:3000']);
  });

  it('returns an empty list for unset or blank input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins(' , ')).toEqual([]);
  });

  it('drops entries that are not URLs and reports each one', () => {
    const bad: string[] = [];
    expect(
      parseAllowedOrigins('example.org, https://ok.example, *, file.txt', (e) =>
        bad.push(e),
      ),
    ).toEqual(['https://ok.example']);
    expect(bad).toEqual(['example.org', '*', 'file.txt']);
  });
});

describe('corsOptionsFor', () => {
  it('opens public routes to any origin, read methods only', () => {
    expect(corsOptionsFor({ url: '/api/public/stac' }, [])).toBe(PUBLIC_CORS);
    expect(PUBLIC_CORS).toEqual({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS'] });
  });

  it('restricts everything else to the configured list, empty by default', () => {
    // An empty `origin` array never matches, so the cors middleware
    // writes no Access-Control-Allow-Origin and the browser refuses
    // the call at preflight. That is the deliberate default: nothing
    // first-party calls this process cross-origin.
    expect(corsOptionsFor({ url: '/api/items' }, [])).toEqual({ origin: [] });
    expect(corsOptionsFor({ url: '/api/items' }, ['https://a.example'])).toEqual({
      origin: ['https://a.example'],
    });
    expect(corsOptionsFor({}, ['https://a.example'])).toEqual({
      origin: ['https://a.example'],
    });
  });

  it('hands the middleware a copy, not the live list', () => {
    const allowed = ['https://a.example'];
    const opts = corsOptionsFor({ url: '/api/items' }, allowed);
    (opts.origin as string[]).push('https://evil.example');
    expect(allowed).toEqual(['https://a.example']);
  });
});
