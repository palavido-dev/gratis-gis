// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  activeOpenGeocodeUrl,
  openGeocodeUrl,
  resetManagedProbe,
  toNominatimRows,
} from './open-geocode';

describe('openGeocodeUrl', () => {
  it('is null when unset, blank or not http(s)', () => {
    expect(openGeocodeUrl({})).toBeNull();
    expect(openGeocodeUrl({ OPEN_GEOCODE_URL: '' })).toBeNull();
    expect(openGeocodeUrl({ OPEN_GEOCODE_URL: 'ftp://og' })).toBeNull();
  });

  it('trims a trailing slash', () => {
    expect(openGeocodeUrl({ OPEN_GEOCODE_URL: 'http://og:8080/' })).toBe('http://og:8080');
  });
});

describe('toNominatimRows', () => {
  it('reshapes an address match', () => {
    const rows = toNominatimRows({
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-79.85, 38.92] },
          properties: {
            label: '10 Main St, 26241',
            address_lines: ['10 Main St', 'Elkins, WV 26241', 'United States'],
            layer: 'address',
            accuracy: 'rooftop',
          },
        },
      ],
    });
    expect(rows).toEqual([
      {
        display_name: '10 Main St, Elkins, WV 26241, United States',
        lat: '38.92',
        lon: '-79.85',
        boundingbox: ['38.92', '38.92', '-79.85', '-79.85'],
        class: 'address',
        type: 'rooftop',
      },
    ]);
  });

  it('turns a west, south, east, north box into Nominatim order', () => {
    const [row] = toNominatimRows({
      features: [
        {
          geometry: { coordinates: [-79.85, 38.92] },
          properties: { label: 'Elkins', layer: 'locality', bbox: [-79.9, 38.9, -79.8, 39.0] },
        },
      ],
    });
    expect(row?.boundingbox).toEqual(['38.9', '39', '-79.9', '-79.8']);
    expect(row?.display_name).toBe('Elkins');
  });

  it('skips features without usable coordinates', () => {
    expect(toNominatimRows({ features: [{ geometry: { coordinates: ['x', 1] } }] })).toEqual([]);
    expect(toNominatimRows(null)).toEqual([]);
    expect(toNominatimRows({ features: [] })).toEqual([]);
  });
});

describe('activeOpenGeocodeUrl', () => {
  afterEach(() => resetManagedProbe());
  const up = (async () => new Response('ok', { status: 200 })) as typeof fetch;
  const down = (async () => {
    throw new Error('down');
  }) as typeof fetch;

  it('prefers OPEN_GEOCODE_URL without probing', async () => {
    expect(
      await activeOpenGeocodeUrl(
        { OPEN_GEOCODE_URL: 'http://og:8080', MANAGED_GEOCODER_URL: 'http://w:8091' },
        down,
      ),
    ).toBe('http://og:8080');
  });

  it('uses the managed geocoder only while it answers', async () => {
    const env = { MANAGED_GEOCODER_URL: 'http://w:8091' };
    expect(await activeOpenGeocodeUrl(env, up, 1000)).toBe('http://w:8091');
    resetManagedProbe();
    expect(await activeOpenGeocodeUrl(env, down, 1000)).toBeNull();
  });

  it('is null when nothing is configured', async () => {
    expect(await activeOpenGeocodeUrl({}, up)).toBeNull();
  });
});
