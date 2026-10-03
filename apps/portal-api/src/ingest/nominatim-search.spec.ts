// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  geocodeOne,
  geocodeQueries,
  localNominatimBase,
  parseNominatimHit,
} from './nominatim-search.js';

describe('localNominatimBase', () => {
  it('defaults to the compose Nominatim', () => {
    expect(localNominatimBase({})).toBe('http://localhost:8081');
  });

  it('uses a configured private host', () => {
    expect(
      localNominatimBase({ NOMINATIM_URL: 'http://nominatim:8080/' }),
    ).toBe('http://nominatim:8080');
  });

  it('refuses the public Nominatim service', () => {
    expect(
      localNominatimBase({
        NOMINATIM_URL: 'https://nominatim.openstreetmap.org',
      }),
    ).toBeNull();
  });
});

describe('parseNominatimHit', () => {
  it('reads the first hit', () => {
    expect(parseNominatimHit([{ lat: '38.9', lon: '-77.0' }])).toEqual({
      lat: 38.9,
      lon: -77.0,
    });
  });

  it('returns null for an empty result', () => {
    expect(parseNominatimHit([])).toBeNull();
  });
});

describe('geocodeQueries', () => {
  it('keeps result order and skips blank queries', async () => {
    const seen: string[] = [];
    const hits = await geocodeQueries(
      ['', '123 Main'],
      async (query) => {
        seen.push(query);
        return { lat: 1, lon: 2 };
      },
      2,
    );
    expect(seen).toEqual(['123 Main']);
    expect(hits).toEqual([null, { lat: 1, lon: 2 }]);
  });
});

describe('geocodeOne', () => {
  it('asks the given host and parses the hit', async () => {
    let called = '';
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      called = String(input);
      return new Response(JSON.stringify([{ lat: '10', lon: '20' }]), {
        status: 200,
      });
    }) as typeof fetch;
    const hit = await geocodeOne(fetchImpl, 'http://nominatim.internal', '123 Main');
    expect(hit).toEqual({ lat: 10, lon: 20 });
    expect(called.startsWith('http://nominatim.internal/search?')).toBe(true);
    expect(called).toContain('q=123+Main');
  });
});
