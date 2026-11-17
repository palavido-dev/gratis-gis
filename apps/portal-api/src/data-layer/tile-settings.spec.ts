// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { optsFingerprint } from '../engine/tile-cache.service.js';
import {
  buildTileJson,
  declaredTileFields,
  normalizeTileSettings,
  normalizeTileSettingsInData,
  parseIncludeParam,
  planTile,
  readTileSettings,
  storedLayerBounds,
  tileCacheControl,
  tileJsonBase,
} from './tile-settings.js';

const DECLARED = ['name', 'pop', 'zone'];
const FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'pop', type: 'number' },
  { name: 'zone', type: 'string' },
];

describe('normalizeTileSettings (write side)', () => {
  it('drops an absent or null setting', () => {
    expect(normalizeTileSettings(undefined, DECLARED, 'L')).toBeUndefined();
    expect(normalizeTileSettings(null, DECLARED, 'L')).toBeUndefined();
    expect(normalizeTileSettings({}, DECLARED, 'L')).toBeUndefined();
  });

  it('keeps valid values and orders fields as declared', () => {
    expect(
      normalizeTileSettings(
        {
          fields: ['zone', 'name', 'zone'],
          minZoom: 4,
          maxZoom: 16,
          maxFeatures: 1000,
          cacheMaxAge: 600,
        },
        DECLARED,
        'L',
      ),
    ).toEqual({
      fields: ['name', 'zone'],
      minZoom: 4,
      maxZoom: 16,
      maxFeatures: 1000,
      cacheMaxAge: 600,
    });
  });

  it('prunes field names the layer no longer declares', () => {
    // A schema edit that removes a field must still save.
    expect(
      normalizeTileSettings({ fields: ['name', 'gone'] }, DECLARED, 'L'),
    ).toEqual({ fields: ['name'] });
  });

  it.each([
    [{ fields: 'name' }],
    [{ fields: ['bad name'] }],
    [{ fields: [1] }],
    [{ minZoom: -1 }],
    [{ maxZoom: 25 }],
    [{ minZoom: 2.5 }],
    [{ minZoom: 10, maxZoom: 5 }],
    [{ maxFeatures: 0 }],
    [{ maxFeatures: 5001 }],
    [{ cacheMaxAge: -1 }],
    [{ cacheMaxAge: 3601 }],
    [{ cacheMaxAge: '60' }],
    [{ public: true }],
    [[]],
    ['x'],
  ])('refuses %j', (raw) => {
    expect(() => normalizeTileSettings(raw, DECLARED, 'L')).toThrow(
      BadRequestException,
    );
  });
});

describe('normalizeTileSettingsInData', () => {
  it('returns the same object when no layer has tile settings', () => {
    const data = { version: 3, layers: [{ id: 'a', fields: [] }] };
    expect(normalizeTileSettingsInData(data)).toBe(data);
  });

  it('ignores non-v3 payloads', () => {
    const data = { version: 1, tiles: { cacheMaxAge: 99999 } };
    expect(normalizeTileSettingsInData(data)).toBe(data);
  });

  it('normalizes each layer and drops empty settings', () => {
    const out = normalizeTileSettingsInData({
      version: 3,
      layers: [
        { id: 'a', fields: [{ name: 'name' }], tiles: { fields: ['name', 'x'] } },
        { id: 'b', fields: [], tiles: {} },
        { id: 'c', fields: [] },
      ],
    }) as { layers: Array<Record<string, unknown>> };
    expect(out.layers[0]!.tiles).toEqual({ fields: ['name'] });
    expect('tiles' in out.layers[1]!).toBe(false);
    expect(out.layers[2]).toEqual({ id: 'c', fields: [] });
  });

  it('refuses an invalid setting on any layer', () => {
    expect(() =>
      normalizeTileSettingsInData({
        version: 3,
        layers: [{ id: 'a', label: 'Parcels', fields: [], tiles: { maxZoom: 99 } }],
      }),
    ).toThrow(/Parcels/);
  });
});

describe('readTileSettings (tile side)', () => {
  it('never throws and ignores bad values key by key', () => {
    expect(readTileSettings(undefined)).toEqual({});
    expect(readTileSettings('x')).toEqual({});
    expect(
      readTileSettings({
        fields: ['ok', 'not ok', 3],
        minZoom: 30,
        maxZoom: 12,
        maxFeatures: 99999,
        cacheMaxAge: 99999,
      }),
    ).toEqual({
      fields: ['ok'],
      maxZoom: 12,
      // Clamped to the server ceiling rather than trusted.
      maxFeatures: 5000,
      cacheMaxAge: 3600,
    });
  });

  it('drops an inverted zoom range rather than emptying every tile', () => {
    expect(readTileSettings({ minZoom: 12, maxZoom: 4 })).toEqual({});
  });
});

describe('parseIncludeParam', () => {
  it('reads names, a star, or nothing', () => {
    expect(parseIncludeParam(undefined)).toBeNull();
    expect(parseIncludeParam('')).toBeNull();
    expect(parseIncludeParam('a,b')).toEqual(['a', 'b']);
    expect(parseIncludeParam('a,*')).toBe('*');
    expect(parseIncludeParam("a,b c,d;drop,'x'")).toEqual(['a']);
  });
});

describe('planTile', () => {
  it('keeps today\'s behaviour with no settings, whatever the map asks for', () => {
    const plan = planTile({ declared: FIELDS, settings: {}, include: ['pop'] });
    expect(plan).toEqual({ fields: FIELDS });
  });

  it('trims to the owner selection and adds back what the map reads', () => {
    expect(
      planTile({ declared: FIELDS, settings: { fields: ['name'] } }).fields,
    ).toEqual([FIELDS[0]]);
    expect(
      planTile({
        declared: FIELDS,
        settings: { fields: ['name'] },
        include: ['zone', 'notdeclared'],
      }).fields,
    ).toEqual([FIELDS[0], FIELDS[2]]);
    expect(
      planTile({ declared: FIELDS, settings: { fields: [] }, include: '*' }).fields,
    ).toEqual(FIELDS);
  });

  it('passes a lowered cap and the zoom range', () => {
    expect(
      planTile({
        declared: FIELDS,
        settings: { maxFeatures: 100, minZoom: 8 },
      }),
    ).toEqual({
      fields: FIELDS,
      maxFeaturesPerTile: 100,
      zoomRange: { min: 8, max: 24 },
    });
    // The ceiling itself is not an option: no needless cache split.
    expect(
      planTile({ declared: FIELDS, settings: { maxFeatures: 5000 } })
        .maxFeaturesPerTile,
    ).toBeUndefined();
  });

  it('changes the tile cache fingerprint when a byte-changing setting changes', () => {
    // The cache key is how stale tiles are avoided: no explicit
    // invalidation exists, so each setting that changes the bytes has
    // to reach the fingerprint.
    const fp = (settings: Parameters<typeof planTile>[0]['settings']) => {
      const plan = planTile({ declared: FIELDS, settings });
      return optsFingerprint({
        fields: plan.fields,
        ...(plan.maxFeaturesPerTile !== undefined
          ? { maxFeaturesPerTile: plan.maxFeaturesPerTile }
          : {}),
      });
    };
    const base = fp({});
    expect(fp({ fields: ['name'] })).not.toBe(base);
    expect(fp({ fields: ['name', 'pop'] })).not.toBe(fp({ fields: ['name'] }));
    expect(fp({ maxFeatures: 10 })).not.toBe(base);
    expect(fp({ maxFeatures: 10 })).not.toBe(fp({ maxFeatures: 11 }));
    // Header-only settings do not split the cache.
    expect(fp({ cacheMaxAge: 30 })).toBe(base);
  });
});

describe('tileCacheControl', () => {
  it('keeps each route\'s defaults', () => {
    expect(tileCacheControl({}, 'private')).toBe('private, max-age=60');
    expect(tileCacheControl({}, 'public')).toBe('public, max-age=300');
  });

  it('changes only the max-age, never the visibility', () => {
    expect(tileCacheControl({ cacheMaxAge: 3600 }, 'private')).toBe(
      'private, max-age=3600',
    );
    expect(tileCacheControl({ cacheMaxAge: 0 }, 'public')).toBe(
      'public, max-age=0',
    );
  });
});

describe('buildTileJson', () => {
  it('never advertises a maxzoom below the minzoom', () => {
    const doc = buildTileJson({
      name: 'Detail',
      tileUrl: 'https://portal.example/t/{z}/{x}/{y}.mvt',
      settings: { minZoom: 23 },
      fields: [],
    });
    expect(doc.minzoom).toBe(23);
    expect(doc.maxzoom).toBe(23);
  });

  it('emits TileJSON 3.0.0 with only the tile fields', () => {
    const doc = buildTileJson({
      name: 'Parcels',
      tileUrl: 'https://portal.example/api/public/items/x/layers/a/tile/{z}/{x}/{y}.mvt',
      settings: { minZoom: 6, maxZoom: 18 },
      fields: [FIELDS[0]!, FIELDS[1]!],
      bounds: [-80, 38, -79, 39],
      attribution: '<a href="https://x.example">X</a><script>alert(1)</script>',
    });
    expect(doc).toMatchObject({
      tilejson: '3.0.0',
      name: 'Parcels',
      scheme: 'xyz',
      tiles: ['https://portal.example/api/public/items/x/layers/a/tile/{z}/{x}/{y}.mvt'],
      minzoom: 6,
      maxzoom: 18,
      bounds: [-80, 38, -79, 39],
      vector_layers: [
        {
          id: 'features',
          fields: { _global_id: 'String', name: 'String', pop: 'Number' },
          minzoom: 6,
          maxzoom: 18,
        },
      ],
    });
    expect(String(doc.attribution)).not.toContain('<script');
  });

  it('omits bounds and attribution when there are none', () => {
    const doc = buildTileJson({
      name: 'P',
      tileUrl: 'u',
      settings: {},
      fields: [],
      bounds: null,
    });
    expect('bounds' in doc).toBe(false);
    expect('attribution' in doc).toBe(false);
    expect(doc.minzoom).toBe(0);
    expect(doc.maxzoom).toBe(22);
  });
});

describe('storedLayerBounds and declaredTileFields', () => {
  it('prefers the layer extent and rejects junk', () => {
    expect(storedLayerBounds([1, 2, 3, 4], [0, 0, 9, 9])).toEqual([1, 2, 3, 4]);
    expect(storedLayerBounds(null, [0, 0, 9, 9])).toEqual([0, 0, 9, 9]);
    expect(storedLayerBounds([], [])).toBeNull();
    expect(storedLayerBounds([3, 0, 1, 1], null)).toBeNull();
  });

  it('keeps named fields with their type', () => {
    expect(
      declaredTileFields([{ name: 'a', type: 'number' }, { name: '' }, { type: 'x' }, { name: 'b' }]),
    ).toEqual([{ name: 'a', type: 'number' }, { name: 'b' }]);
    expect(declaredTileFields(undefined)).toEqual([]);
  });
});

describe('tileJsonBase', () => {
  const prev = process.env.PORTAL_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = prev;
  });

  it('uses PORTAL_BASE_URL and never a request header', () => {
    process.env.PORTAL_BASE_URL = 'https://maps.example.org/';
    expect(tileJsonBase()).toBe('https://maps.example.org');
    delete process.env.PORTAL_BASE_URL;
    // It takes no request at all, so no Host can reach it.
    expect(tileJsonBase()).toBe('http://localhost:3000');
  });
});

describe('label points setting', () => {
  it('stores only true and refuses a non-boolean', () => {
    expect(normalizeTileSettings({ labelPoints: true }, DECLARED, 'L')).toEqual({
      labelPoints: true,
    });
    expect(normalizeTileSettings({ labelPoints: false }, DECLARED, 'L')).toBeUndefined();
    expect(() =>
      normalizeTileSettings({ labelPoints: 'yes' }, DECLARED, 'L'),
    ).toThrow(BadRequestException);
    expect(readTileSettings({ labelPoints: 'yes' })).toEqual({});
    expect(readTileSettings({ labelPoints: true })).toEqual({ labelPoints: true });
  });

  it('is off by default and only applies to lines and polygons', () => {
    expect(planTile({ declared: FIELDS, settings: {}, geometryType: 'polygon' }).labelPoints).toBeUndefined();
    const on = { labelPoints: true } as const;
    expect(planTile({ declared: FIELDS, settings: on, geometryType: 'polygon' }).labelPoints).toBe(true);
    expect(planTile({ declared: FIELDS, settings: on, geometryType: 'MultiLineString' }).labelPoints).toBe(true);
    expect(planTile({ declared: FIELDS, settings: on, geometryType: 'point' }).labelPoints).toBeUndefined();
    expect(planTile({ declared: FIELDS, settings: on, geometryType: null }).labelPoints).toBeUndefined();
  });

  it('adds the labels layer to TileJSON only when on', () => {
    const off = buildTileJson({ name: 'P', tileUrl: 'u', settings: {}, fields: [FIELDS[0]!] });
    expect((off.vector_layers as unknown[]).length).toBe(1);
    const on = buildTileJson({
      name: 'P',
      tileUrl: 'u',
      settings: {},
      fields: [FIELDS[0]!],
      labelPoints: true,
    });
    expect(on.vector_layers).toEqual([
      expect.objectContaining({
        id: 'features',
        fields: { _global_id: 'String', name: 'String', _label_point: 'Boolean' },
      }),
      expect.objectContaining({
        id: 'labels',
        fields: { _global_id: 'String', name: 'String' },
      }),
    ]);
  });
});
