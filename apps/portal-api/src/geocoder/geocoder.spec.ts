// SPDX-License-Identifier: AGPL-3.0-or-later
import { coversUnitedStates, parseGeofabrikIndex } from './geocoder-regions.js';
import { buildArgs, extractFileName, lineSplitter } from './geocoder-runner.js';
import {
  isGeofabrikPbfUrl,
  parseGeocoderSettings,
  refreshDue,
} from './geocoder-settings.js';
import {
  managedGeocoderBase,
  managedGeocoderReady,
  resetManagedProbe,
} from '../ingest/open-geocode.js';
import { resolveAddressGeocoder } from '../ingest/ingest.service.js';

const WV = 'https://download.geofabrik.de/north-america/us/west-virginia-latest.osm.pbf';

describe('isGeofabrikPbfUrl', () => {
  it('accepts an https Geofabrik extract', () => {
    expect(isGeofabrikPbfUrl(WV)).toBe(true);
  });

  it('refuses other hosts, plain http, queries and other files', () => {
    expect(isGeofabrikPbfUrl('https://evil.example/west-virginia-latest.osm.pbf')).toBe(false);
    expect(isGeofabrikPbfUrl(WV.replace('https:', 'http:'))).toBe(false);
    expect(isGeofabrikPbfUrl(`${WV}?x=1`)).toBe(false);
    expect(isGeofabrikPbfUrl('https://download.geofabrik.de/index-v1.json')).toBe(false);
  });
});

describe('parseGeocoderSettings', () => {
  it('fills defaults for an empty row', () => {
    const s = parseGeocoderSettings(undefined);
    expect(s.status).toBe('none');
    expect(s.tiger).toBe(true);
    expect(s.regions).toEqual([]);
  });

  it('drops regions whose download is not on Geofabrik', () => {
    const s = parseGeocoderSettings({
      regions: [
        { id: 'us/west-virginia', name: 'West Virginia', pbfUrl: WV },
        { id: 'x', name: 'X', pbfUrl: 'https://example.com/x.osm.pbf' },
      ],
      status: 'bogus',
    });
    expect(s.regions.map((r) => r.id)).toEqual(['us/west-virginia']);
    expect(s.status).toBe('none');
  });
});

describe('refreshDue', () => {
  const base = parseGeocoderSettings({ status: 'ready', builtAt: '2026-01-01T00:00:00Z' });

  it('is never due when refresh is off', () => {
    expect(refreshDue({ ...base, refresh: 'off' }, Date.parse('2027-01-01'))).toBe(false);
  });

  it('is due a month after a monthly build', () => {
    expect(refreshDue({ ...base, refresh: 'monthly' }, Date.parse('2026-01-20'))).toBe(false);
    expect(refreshDue({ ...base, refresh: 'monthly' }, Date.parse('2026-02-01'))).toBe(true);
  });
});

describe('parseGeofabrikIndex', () => {
  const index = {
    features: [
      { properties: { id: 'north-america', name: 'North America', urls: { pbf: 'https://download.geofabrik.de/north-america-latest.osm.pbf' } } },
      { properties: { id: 'us', parent: 'north-america', name: 'United States of America', 'iso3166-1:alpha2': ['US'], urls: { pbf: 'https://download.geofabrik.de/north-america/us-latest.osm.pbf' } } },
      { properties: { id: 'us/west-virginia', parent: 'us', name: 'West Virginia', 'iso3166-2': ['US-WV'], urls: { pbf: WV } } },
      { properties: { id: 'bad', name: 'Bad', urls: { pbf: 'https://example.com/bad.osm.pbf' } } },
    ],
  };

  it('flattens the index with each region path', () => {
    const regions = parseGeofabrikIndex(index);
    const wv = regions.find((r) => r.id === 'us/west-virginia');
    expect(wv?.path).toEqual(['North America', 'United States of America']);
    expect(regions.some((r) => r.id === 'bad')).toBe(false);
  });

  it('knows which picks are in the United States', () => {
    const regions = parseGeofabrikIndex(index);
    expect(coversUnitedStates([{ id: 'us/west-virginia' }], regions)).toBe(true);
    expect(coversUnitedStates([{ id: 'north-america' }], regions)).toBe(false);
  });
});

describe('geocoder runner helpers', () => {
  it('builds pack arguments from the choices', () => {
    expect(
      buildArgs(['/g/input/a.osm.pbf', '/g/input/b.osm.pbf'], '/g/pack', {
        tiger: true,
        openAddresses: false,
        memoryBudgetMb: 1024,
      }),
    ).toEqual([
      'pack', 'build',
      '--input', '/g/input/a.osm.pbf',
      '--input', '/g/input/b.osm.pbf',
      '--pack', '/g/pack', '--fresh', '--memory-budget-mb', '1024',
      '--tiger',
    ]);
  });

  it('keeps region ids out of the path', () => {
    expect(extractFileName('us/west-virginia')).toBe('us_west-virginia.osm.pbf');
    expect(extractFileName('../../etc')).toBe('_etc.osm.pbf');
  });

  it('splits output on newlines and carriage returns and strips colour codes', () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed('Scanned 10%\rScanned 20%\r\nBuilt\x1b[32m ok\x1b[0m\npart');
    feed('ial\n');
    expect(lines).toEqual(['Scanned 10%', 'Scanned 20%', 'Built ok', 'partial']);
  });
});

describe('managed geocoder resolution', () => {
  afterEach(() => resetManagedProbe());

  it('reads MANAGED_GEOCODER_URL', () => {
    expect(managedGeocoderBase({ MANAGED_GEOCODER_URL: 'http://portal-worker:8091/' })).toBe(
      'http://portal-worker:8091',
    );
    expect(managedGeocoderBase({})).toBeNull();
  });

  it('caches the readiness probe', async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    expect(await managedGeocoderReady(f, 'http://w:8091', 1000)).toBe(true);
    expect(await managedGeocoderReady(f, 'http://w:8091', 2000)).toBe(true);
    expect(calls).toBe(1);
  });

  it('uses the managed geocoder only while it answers', async () => {
    const up = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const down = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    const env = { MANAGED_GEOCODER_URL: 'http://w:8091', NOMINATIM_URL: 'http://nominatim:8080' };
    expect((await resolveAddressGeocoder(env, up))?.kind).toBe('open-geocode');
    resetManagedProbe();
    expect((await resolveAddressGeocoder(env, down))?.kind).toBe('nominatim');
  });

  it('prefers an explicit OPEN_GEOCODE_URL', async () => {
    const f = (async () => {
      throw new Error('should not probe');
    }) as typeof fetch;
    const g = await resolveAddressGeocoder(
      { OPEN_GEOCODE_URL: 'http://og:8080', MANAGED_GEOCODER_URL: 'http://w:8091' },
      f,
    );
    expect(g?.base).toBe('http://og:8080');
  });
});
