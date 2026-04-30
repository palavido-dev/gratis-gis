import type { Item } from '@prisma/client';
import {
  type DerivedLayerData,
  type FeatureField,
} from '@gratis-gis/shared-types';

import {
  DerivedLayersService,
  padBboxByMeters,
  readSourceSchema,
  readSourceVersion,
  resolveSublayer,
} from './derived-layers.service.js';

// The service we test here only exercises pure / DB-free helpers.
// `validateAndEnrich` and `buildReadSql` need a fake Prisma object so
// the constructor is satisfied; neither helper actually queries.
const fakePrisma = {} as never;
const service = new DerivedLayersService(fakePrisma);

const STRING_FIELD: FeatureField = {
  name: 'name',
  label: 'Name',
  type: 'string',
  nullable: false,
};

function makeSource(
  overrides: Partial<Item> = {},
): Pick<Item, 'id' | 'type' | 'data' | 'bbox'> {
  // Default fixture is a v2 single-table source. v3 multi-layer
  // tests construct their own data inline via makeV3Source below
  // so each one is explicit about which sublayer it's exercising.
  return {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'data_layer' as Item['type'],
    data: {
      version: 2,
      storageType: 'postgis',
      fields: [STRING_FIELD],
    } as unknown as Item['data'],
    bbox: [-122.5, 37.5, -122.0, 38.0] as Item['bbox'],
    ...overrides,
  };
}

function makeV3Source(
  layerId: string,
  overrides: Partial<Item> = {},
): Pick<Item, 'id' | 'type' | 'data' | 'bbox'> {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    type: 'data_layer' as Item['type'],
    data: {
      version: 3,
      storageType: 'postgis',
      layers: [
        {
          id: layerId,
          label: layerId,
          name: layerId,
          geometryType: 'point',
          fields: [STRING_FIELD],
          editingEnabled: true,
          attachmentsEnabled: false,
        },
      ],
    } as unknown as Item['data'],
    bbox: [-122.5, 37.5, -122.0, 38.0] as Item['bbox'],
    ...overrides,
  };
}

function makeDerivedItem(data: DerivedLayerData): Item {
  return {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    orgId: 'oooooooo-oooo-oooo-oooo-oooooooooooo',
    ownerId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu',
    type: 'derived_layer' as Item['type'],
    title: 'Test',
    description: '',
    tags: [],
    thumbnailUrl: null,
    license: null,
    data: data as unknown as Item['data'],
    storageRef: null,
    access: 'private' as Item['access'],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    bbox: data.bbox,
    bboxSrs: 'EPSG:4326',
    lastUsageAt: null,
  };
}

describe('readSourceSchema', () => {
  it('reads top-level fields when present', () => {
    const fields = readSourceSchema({ fields: [STRING_FIELD] });
    expect(fields).toEqual([STRING_FIELD]);
  });

  it('returns an empty array for unrecognized shapes', () => {
    expect(readSourceSchema(null)).toEqual([]);
    expect(readSourceSchema('not an object')).toEqual([]);
    expect(readSourceSchema({})).toEqual([]);
  });
});

describe('readSourceVersion', () => {
  it('reads a numeric version off the data blob', () => {
    expect(readSourceVersion({ version: 3 })).toBe(3);
    expect(readSourceVersion({ version: 1 })).toBe(1);
  });

  it('returns 0 for unknown shapes', () => {
    expect(readSourceVersion(null)).toBe(0);
    expect(readSourceVersion({})).toBe(0);
    expect(readSourceVersion({ version: '3' })).toBe(0);
  });
});

describe('resolveSublayer', () => {
  it('returns null for v2 with no layerKey', () => {
    expect(resolveSublayer({ fields: [STRING_FIELD] }, 2, undefined)).toBeNull();
  });

  it('rejects layerKey on a v2 source', () => {
    expect(() =>
      resolveSublayer({ fields: [STRING_FIELD] }, 2, 'L1'),
    ).toThrow(/only valid against v3/);
  });

  it('auto-selects the only spatial sublayer of a v3 source', () => {
    const data = {
      version: 3,
      layers: [
        {
          id: 'L1',
          geometryType: 'point',
          fields: [STRING_FIELD],
        },
      ],
    };
    const r = resolveSublayer(data, 3, undefined);
    expect(r?.id).toBe('L1');
    expect(r?.fields).toEqual([STRING_FIELD]);
  });

  it('requires layerKey when there are multiple spatial sublayers', () => {
    const data = {
      version: 3,
      layers: [
        { id: 'A', geometryType: 'point', fields: [] },
        { id: 'B', geometryType: 'polygon', fields: [] },
      ],
    };
    expect(() => resolveSublayer(data, 3, undefined)).toThrow(
      /required because the source has multiple sublayers/,
    );
  });

  it('rejects an unknown layerKey', () => {
    const data = {
      version: 3,
      layers: [{ id: 'A', geometryType: 'point', fields: [] }],
    };
    expect(() => resolveSublayer(data, 3, 'B')).toThrow(
      /does not match any sublayer/,
    );
  });

  it('drops attribute-only sublayers from consideration', () => {
    const data = {
      version: 3,
      layers: [
        { id: 'related', geometryType: null, fields: [] },
      ],
    };
    expect(() => resolveSublayer(data, 3, undefined)).toThrow(
      /no spatial sublayers/,
    );
  });
});

describe('padBboxByMeters', () => {
  it('returns an empty array when bbox is empty', () => {
    expect(padBboxByMeters([], 100)).toEqual([]);
  });

  it('returns the bbox unchanged when reach is zero', () => {
    expect(padBboxByMeters([0, 0, 1, 1], 0)).toEqual([0, 0, 1, 1]);
  });

  it('pads outward in degrees proportional to meters', () => {
    const padded = padBboxByMeters([0, 0, 1, 1], 11132);
    // 11132m / 111320 m/deg ~= 0.1 deg
    expect(padded[0]).toBeCloseTo(-0.1, 5);
    expect(padded[1]).toBeCloseTo(-0.1, 5);
    expect(padded[2]).toBeCloseTo(1.1, 5);
    expect(padded[3]).toBeCloseTo(1.1, 5);
  });

  it('treats malformed bboxes as empty', () => {
    expect(padBboxByMeters([0, 0, 1] as unknown as number[], 100)).toEqual([]);
    expect(padBboxByMeters([0, 0, 1, NaN], 100)).toEqual([]);
  });
});

describe('DerivedLayersService.validateAndEnrich', () => {
  it('rejects non-object data', async () => {
    await expect(
      service.validateAndEnrich(null, makeSource()),
    ).rejects.toThrow(/must be an object/);
  });

  it('rejects an empty pipeline', async () => {
    await expect(
      service.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'data_layer', itemId: makeSource().id },
          pipeline: [],
          featureLimit: 1000,
          outputSchema: [],
          bbox: [],
        },
        makeSource(),
      ),
    ).rejects.toThrow(/non-empty array/);
  });

  it('rejects a mismatched source.itemId vs the resolved source', async () => {
    const source = makeSource();
    await expect(
      service.validateAndEnrich(
        {
          version: 1,
          source: {
            kind: 'data_layer',
            itemId: '00000000-0000-0000-0000-000000000000',
          },
          pipeline: [{ tool: 'buffer', params: { distance: 1, unit: 'meters' } }],
        },
        source,
      ),
    ).rejects.toThrow(/match the resolved source/);
  });

  it('produces an enriched DerivedLayerData with bbox padded by reach', async () => {
    const source = makeSource();
    const enriched = await service.validateAndEnrich(
      {
        version: 1,
        source: { kind: 'data_layer', itemId: source.id },
        pipeline: [
          { tool: 'buffer', params: { distance: 11132, unit: 'meters' } },
        ],
      },
      source,
    );
    expect(enriched.featureLimit).toBe(1000);
    expect(enriched.outputSchema).toEqual([STRING_FIELD]);
    // bbox padded by ~0.1 deg in each axis
    expect(enriched.bbox[0]).toBeCloseTo(-122.6, 4);
    expect(enriched.bbox[3]).toBeCloseTo(38.1, 4);
  });

  it('rejects featureLimit values outside the allowed range', async () => {
    const source = makeSource();
    await expect(
      service.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'data_layer', itemId: source.id },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
          featureLimit: 0,
        },
        source,
      ),
    ).rejects.toThrow(/positive integer/);
  });

  it('runs a tool generator enrich hook at save time and persists its output', async () => {
    // Source that exposes a numeric field named `radius_m`. The
    // buffer field-mode generator looks it up in the source schema,
    // then calls `queryRaw` on the (fake) Prisma to find MAX(radius_m).
    const NUMBER_FIELD: FeatureField = {
      name: 'radius_m',
      label: 'Radius (m)',
      type: 'number',
      nullable: true,
    };
    const source = makeSource({
      data: {
        version: 2,
        storageType: 'postgis',
        fields: [STRING_FIELD, NUMBER_FIELD],
      } as unknown as Item['data'],
    });
    // Stand-in Prisma whose $queryRawUnsafe returns a single row
    // with max_value: 250. The service is constructed with this
    // fake; the generator's enrich hook calls through.
    const queryCalls: string[] = [];
    const fake = {
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        queryCalls.push(sql);
        return [{ max_value: 250 }] as unknown[];
      }),
    } as unknown as ConstructorParameters<typeof DerivedLayersService>[0];
    const svc = new DerivedLayersService(fake);
    const enriched = await svc.validateAndEnrich(
      {
        version: 1,
        source: { kind: 'data_layer', itemId: source.id },
        pipeline: [
          {
            tool: 'buffer',
            params: { mode: 'field', field: 'radius_m', unit: 'meters' },
          },
        ],
      },
      source,
    );
    // Enrich populated cachedMaxMeters from the MAX query; the
    // recipe persists with that cap baked in for future reads.
    const step = enriched.pipeline[0]!;
    expect(step.tool).toBe('buffer');
    if (step.tool === 'buffer' && step.params.mode === 'field') {
      expect(step.params.cachedMaxMeters).toBe(250);
    } else {
      throw new Error('expected a field-mode buffer step');
    }
    // bbox is padded by the cached cap, not zero, so map reads in
    // tile-edge regions still see the buffer halo.
    expect(enriched.bbox[0]).toBeLessThan(-122.5);
    expect(queryCalls[0]).toMatch(/SELECT COALESCE\(\s*MAX\(/);
  });

  it('rejects field-mode buffer when the named field is not on the source schema', async () => {
    const source = makeSource();
    await expect(
      service.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'data_layer', itemId: source.id },
          pipeline: [
            {
              tool: 'buffer',
              params: { mode: 'field', field: 'nope', unit: 'meters' },
            },
          ],
        },
        source,
      ),
    ).rejects.toThrow(/does not exist on the source schema/);
  });

  it('rejects field-mode buffer pointing at a non-numeric field', async () => {
    // STRING_FIELD is name: 'name', type: 'string', so picking it for
    // a buffer distance should be rejected up front.
    const source = makeSource();
    await expect(
      service.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'data_layer', itemId: source.id },
          pipeline: [
            {
              tool: 'buffer',
              params: { mode: 'field', field: 'name', unit: 'meters' },
            },
          ],
        },
        source,
      ),
    ).rejects.toThrow(/must be a number field/);
  });
});

describe('DerivedLayersService.buildReadSql', () => {
  it('wraps the source PostGIS table in a CTE and chains buffer downstream', () => {
    const source = makeSource();
    const data: DerivedLayerData = {
      version: 1,
      source: { kind: 'data_layer', itemId: source.id },
      pipeline: [
        {
          tool: 'buffer',
          params: { mode: 'fixed', distance: 250, unit: 'meters' },
        },
      ],
      featureLimit: 1000,
      outputSchema: [STRING_FIELD],
      bbox: [-122.6, 37.4, -121.9, 38.1],
    };
    const item = makeDerivedItem(data);
    const { sql, params } = service.buildReadSql(item, source);
    // Source CTE references the well-known table name.
    expect(sql).toMatch(
      /"fs_11111111111111111111111111111111"/,
    );
    // Pipeline produces step_1.
    expect(sql).toMatch(/step_1 AS \(/);
    // Final SELECT consumes the last step.
    expect(sql).toMatch(/FROM step_1/);
    expect(sql).toMatch(/LIMIT \$2/);
    // Default temporal filter is `valid_to IS NULL`.
    expect(sql).toMatch(/valid_to IS NULL/);
    expect(params).toEqual([250, 1000]);
  });

  it('uses the v3 per-sublayer table name when source.layerKey is set', () => {
    const source = makeV3Source('sites');
    const data: DerivedLayerData = {
      version: 1,
      source: {
        kind: 'data_layer',
        itemId: source.id,
        layerKey: 'sites',
      },
      pipeline: [
        {
          tool: 'buffer',
          params: { mode: 'fixed', distance: 25, unit: 'meters' },
        },
      ],
      featureLimit: 100,
      outputSchema: [STRING_FIELD],
      bbox: [],
    };
    const item = makeDerivedItem(data);
    const { sql } = service.buildReadSql(item, source);
    expect(sql).toMatch(
      /"fs_22222222222222222222222222222222_sites"/,
    );
  });

  it('expands the request bbox by the pipeline reach for buffer halos', () => {
    const source = makeSource();
    const data: DerivedLayerData = {
      version: 1,
      source: { kind: 'data_layer', itemId: source.id },
      pipeline: [
        {
          tool: 'buffer',
          params: { mode: 'fixed', distance: 11132, unit: 'meters' },
        },
      ],
      featureLimit: 500,
      outputSchema: [STRING_FIELD],
      bbox: [],
    };
    const item = makeDerivedItem(data);
    const { params } = service.buildReadSql(item, source, {
      bbox: [0, 0, 1, 1],
    });
    // Order: padded bbox (4 numbers), then buffer distance, then limit.
    expect(params).toHaveLength(6);
    expect(params[0]).toBeCloseTo(-0.1, 5);
    expect(params[1]).toBeCloseTo(-0.1, 5);
    expect(params[2]).toBeCloseTo(1.1, 5);
    expect(params[3]).toBeCloseTo(1.1, 5);
    expect(params[4]).toBe(11132);
    expect(params[5]).toBe(500);
  });
});
