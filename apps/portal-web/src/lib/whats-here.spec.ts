// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AreaExpiredError,
  DISTANCE_PRESETS,
  initialUnits,
  measureOpFor,
  percentOfArea,
  pickedAreaGeometry,
  profileUnitSystem,
  rememberUnits,
  screenCsv,
  screenLayer,
  toMeters,
  type ScreenLayer,
} from './whats-here';
import { SQM_PER_ACRE } from './measure';

const landCover: ScreenLayer = {
  mapLayerId: 'm1',
  title: 'Land Cover',
  itemId: '11111111-1111-1111-1111-111111111111',
  layerKey: 'landcover',
  geometry: 'polygon',
  categoryFields: [{ name: 'CLASS', label: 'Class' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('whats-here units and shares', () => {
  it('converts distances to meters', () => {
    expect(toMeters(500, 'feet')).toBeCloseTo(152.4, 6);
    expect(toMeters(0.25, 'miles')).toBeCloseTo(402.336, 6);
    expect(toMeters(2, 'kilometers')).toBe(2000);
  });

  it('measures area for polygons, length for lines, nothing for points', () => {
    expect(measureOpFor('polygon')).toBe('area');
    expect(measureOpFor('line')).toBe('length');
    expect(measureOpFor('point')).toBeNull();
    expect(measureOpFor(null)).toBeNull();
  });

  it('gives a percent of the area for polygons only, capped at 100', () => {
    expect(percentOfArea(50, 200, 'polygon')).toBe(25);
    expect(percentOfArea(300, 200, 'polygon')).toBe(100);
    expect(percentOfArea(50, 200, 'line')).toBeNull();
    expect(percentOfArea(50, 0, 'polygon')).toBeNull();
  });

  it('sends one picked shape as is and several as a collection', () => {
    const a: GeoJSON.Point = { type: 'Point', coordinates: [0, 0] };
    expect(pickedAreaGeometry([])).toBeNull();
    expect(pickedAreaGeometry([a])).toBe(a);
    expect(pickedAreaGeometry([a, a])).toEqual({
      type: 'GeometryCollection',
      geometries: [a, a],
    });
  });
});

describe('screenLayer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('asks for count and area with the area id, and sorts a breakdown by area', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('groupBy=')) {
        return jsonResponse({
          truncated: false,
          groups: [
            { key: { CLASS: 'Urban' }, values: { count: 5, area: 100 } },
            { key: { CLASS: 'Crop' }, values: { count: 2, area: 900 } },
          ],
        });
      }
      return jsonResponse({ truncated: false, groups: [{ key: {}, values: { count: 7, area: 1000 } }] });
    }) as typeof fetch;

    const out = await screenLayer({
      layer: landCover,
      areaId: '0123456789abcdef0123456789abcdef',
      breakdownField: 'CLASS',
    });
    expect(out.total).toEqual({ value: null, count: 7, measure: 1000 });
    expect(out.breakdown!.rows.map((r) => r.value)).toEqual(['Crop', 'Urban']);
    const totals = new URL(urls.find((u) => !u.includes('groupBy='))!, 'http://x');
    expect(totals.searchParams.getAll('agg')).toEqual(['count', 'area']);
    expect(totals.searchParams.get('area')).toBe('0123456789abcdef0123456789abcdef');
  });

  it('turns a 410 into AreaExpiredError so the caller can register again', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ message: 'This area has expired. Pick it again.' }, 410),
    ) as typeof fetch;
    await expect(
      screenLayer({ layer: landCover, areaId: '0123456789abcdef0123456789abcdef' }),
    ).rejects.toBeInstanceOf(AreaExpiredError);
  });
});

describe('screenCsv', () => {
  it('writes layers and their breakdowns in the units on screen', () => {
    const csv = screenCsv({
      area: { squareMeters: 2 * SQM_PER_ACRE, distanceMeters: 0 },
      layers: [
        {
          layer: landCover,
          screen: {
            total: { value: null, count: 3, measure: SQM_PER_ACRE },
            breakdown: {
              field: 'CLASS',
              truncated: false,
              rows: [{ value: '=cmd|calc', count: 1, measure: SQM_PER_ACRE }],
            },
          },
        },
      ],
      areaUnit: 'acres',
      lengthUnit: 'feet',
      areaPerUnit: SQM_PER_ACRE,
      headers: {
        layer: 'Layer',
        category: 'Category',
        count: 'Count',
        area: 'Area',
        length: 'Length',
        percent: 'Percent of area',
      },
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Layer,Category,Count,Area (acres),Length (feet),Percent of area');
    expect(lines[1]).toBe('Land Cover,,3,1,,50');
    // A value that a spreadsheet would run as a formula stays text.
    expect(lines[2]).toBe(`Land Cover,"'=cmd|calc",1,1,,50`);
  });
});

describe('screen units', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('follows the profile system, imperial when unset', () => {
    expect(profileUnitSystem()).toBe('imperial');
    store.set('gg-profile-units', 'metric');
    expect(profileUnitSystem()).toBe('metric');
    expect(initialUnits({ system: 'metric' })).toEqual({
      areaUnit: 'hectares',
      lengthUnit: 'meters',
    });
  });

  it('takes the author default over the system, and the user choice over both', () => {
    expect(
      initialUnits({ system: 'imperial', author: { areaUnit: 'square-miles' } }),
    ).toEqual({ areaUnit: 'square-miles', lengthUnit: 'feet' });
    rememberUnits({ areaUnit: 'hectares', lengthUnit: 'kilometers' });
    expect(
      initialUnits({ system: 'imperial', author: { areaUnit: 'square-miles' } }),
    ).toEqual({ areaUnit: 'hectares', lengthUnit: 'kilometers' });
  });

  it('ignores a stored unit it does not know', () => {
    store.set('gg-whats-here-units', JSON.stringify({ areaUnit: 'furlongs', lengthUnit: 'miles' }));
    expect(initialUnits({ system: 'imperial' })).toEqual({ areaUnit: 'acres', lengthUnit: 'miles' });
  });

  it('works with no storage at all', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(initialUnits({ system: 'metric' })).toEqual({ areaUnit: 'hectares', lengthUnit: 'meters' });
  });

  it('offers metric distances to metric users', () => {
    expect(DISTANCE_PRESETS.metric.map((p) => p.meters)).toEqual([0, 25, 100, 500, 1000]);
  });
});
