// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  openGeocodeBase,
  openGeocodeQueries,
  parseOpenGeocodeFeature,
} from './open-geocode.js';
import { addressGeocoder } from './ingest.service.js';
import { ADDRESS_GEOCODE_LIMITS } from './csv-address.js';

function feature(layer: string, accuracy: string, lon = -79.85, lat = 38.92) {
  return {
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { layer, accuracy },
      },
    ],
  };
}

describe('openGeocodeBase', () => {
  it('is null when unset or blank', () => {
    expect(openGeocodeBase({})).toBeNull();
    expect(openGeocodeBase({ OPEN_GEOCODE_URL: '  ' })).toBeNull();
  });

  it('trims a trailing slash', () => {
    expect(openGeocodeBase({ OPEN_GEOCODE_URL: 'http://og:8080/' })).toBe(
      'http://og:8080',
    );
  });

  it('refuses a non-http URL', () => {
    expect(openGeocodeBase({ OPEN_GEOCODE_URL: 'file:///etc/passwd' })).toBeNull();
    expect(openGeocodeBase({ OPEN_GEOCODE_URL: 'not a url' })).toBeNull();
  });
});

describe('parseOpenGeocodeFeature', () => {
  it('reads an address hit with its accuracy', () => {
    expect(parseOpenGeocodeFeature(feature('address', 'rooftop'))).toEqual({
      lat: 38.92,
      lon: -79.85,
      accuracy: 'rooftop',
    });
  });

  it('keeps interpolated and street answers', () => {
    expect(parseOpenGeocodeFeature(feature('interpolation', 'interpolated'))).not.toBeNull();
    expect(parseOpenGeocodeFeature(feature('street', 'street'))).not.toBeNull();
  });

  it('drops answers that only name an area', () => {
    expect(parseOpenGeocodeFeature(feature('locality', 'centroid'))).toBeNull();
    expect(parseOpenGeocodeFeature(feature('postcode', 'centroid'))).toBeNull();
    expect(parseOpenGeocodeFeature(feature('address', 'approximate'))).toBeNull();
  });

  it('returns null for no features or bad coordinates', () => {
    expect(parseOpenGeocodeFeature({ features: [] })).toBeNull();
    expect(parseOpenGeocodeFeature(null)).toBeNull();
    expect(parseOpenGeocodeFeature(feature('address', 'rooftop', 200, 10))).toBeNull();
  });
});

describe('openGeocodeQueries', () => {
  it('batches, skips blanks and maps results back by id', async () => {
    const bodies: Array<Array<{ id: string; q: string }>> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('http://og.internal/geocode');
      const items = JSON.parse(String(init?.body)) as Array<{ id: string; q: string }>;
      bodies.push(items);
      return new Response(
        JSON.stringify({
          results: items.map((item) => ({
            id: item.id,
            response:
              item.q === 'nowhere'
                ? { features: [] }
                : feature('address', 'rooftop', -80, 39),
          })),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const hits = await openGeocodeQueries(
      fetchImpl,
      'http://og.internal',
      ['1 Main St', '', 'nowhere', '2 Main St'],
      2,
    );
    expect(bodies.map((b) => b.map((i) => i.q))).toEqual([
      ['1 Main St', 'nowhere'],
      ['2 Main St'],
    ]);
    expect(hits).toEqual([
      { lat: 39, lon: -80, accuracy: 'rooftop' },
      null,
      null,
      { lat: 39, lon: -80, accuracy: 'rooftop' },
    ]);
  });

  it('leaves a failed batch unplaced instead of throwing', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    expect(await openGeocodeQueries(fetchImpl, 'http://og.internal', ['1 Main St'])).toEqual([
      null,
    ]);
  });
});

describe('addressGeocoder', () => {
  it('prefers open-geocode and lifts the row cap', () => {
    const g = addressGeocoder({
      OPEN_GEOCODE_URL: 'http://og:8080',
      NOMINATIM_URL: 'http://nominatim:8080',
    });
    expect(g?.kind).toBe('open-geocode');
    expect(g?.maxRows).toBe(ADDRESS_GEOCODE_LIMITS.OPEN_GEOCODE_MAX_ROWS);
  });

  it('falls back to the local Nominatim with the old cap', () => {
    const g = addressGeocoder({ NOMINATIM_URL: 'http://nominatim:8080' });
    expect(g?.kind).toBe('nominatim');
    expect(g?.maxRows).toBe(ADDRESS_GEOCODE_LIMITS.MAX_ROWS);
  });

  it('is null when only the public Nominatim is configured', () => {
    expect(
      addressGeocoder({ NOMINATIM_URL: 'https://nominatim.openstreetmap.org' }),
    ).toBeNull();
  });
});
