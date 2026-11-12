// SPDX-License-Identifier: AGPL-3.0-or-later
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
    thumbnailDesign: null,
    license: null,
    data: data as unknown as Item['data'],
    storageRef: null,
    access: 'private' as Item['access'],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    deletedCohortId: null,
    bbox: data.bbox,
    bboxSrs: 'EPSG:4326',
    publicGeoBoundaryId: null,
    orgGeoBoundaryId: null,
    lastUsageAt: null,
    seedKind: null,
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
    // 11132m / 111320 m/deg ~= 0.1 deg of latitude. Longitude is
    // divided by cos of the most poleward padded edge (1.1 deg).
    const lon = 0.1 / Math.cos((1.1 * Math.PI) / 180);
    expect(padded[0]).toBeCloseTo(-lon, 6);
    expect(padded[1]).toBeCloseTo(-0.1, 5);
    expect(padded[2]).toBeCloseTo(1 + lon, 6);
    expect(padded[3]).toBeCloseTo(1.1, 5);
  });

  it('pads longitude by 1/cos(latitude) so the east-west pad is never short', () => {
    // At 60 N a degree of longitude is about half as long, so the same
    // 10 km needs about twice as many degrees east and west.
    const padded = padBboxByMeters([10, 59, 11, 60], 10_000);
    const lat = 10_000 / 111_320;
    const lonMeters = (10 - padded[0]!) * 111_320 * Math.cos(((60 + lat) * Math.PI) / 180);
    expect(lonMeters).toBeCloseTo(10_000, 0);
    expect(10 - padded[0]!).toBeGreaterThan(1.9 * lat);
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
    // bbox padded by ~0.1 deg of latitude; longitude by 0.1 / cos(38.1)
    expect(enriched.bbox[0]).toBeCloseTo(-122.5 - 0.1 / Math.cos((38.1 * Math.PI) / 180), 4);
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
    // Phase 2.7: source CTE reads from the engine's observation log
    // for the layer's canonical scope, not the legacy fs_ table.
    expect(sql).toMatch(/FROM observation/);
    expect(sql).toMatch(
      /scope = 'data_layer:11111111-1111-1111-1111-111111111111:default'/,
    );
    expect(sql).toMatch(/DISTINCT ON \(entity\)/);
    expect(sql).toMatch(/kind <> 'delete'/);
    // Pipeline produces step_1.
    expect(sql).toMatch(/step_1 AS \(/);
    // Final SELECT consumes the last step.
    expect(sql).toMatch(/FROM step_1/);
    expect(sql).toMatch(/LIMIT \$2/);
    // Default temporal filter is `valid_to IS NULL`.
    expect(sql).toMatch(/valid_to IS NULL/);
    expect(params).toEqual([250, 1000]);
  });

  it('uses the v3 sublayer scope when source.layerKey is set', () => {
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
      /scope = 'data_layer:22222222-2222-2222-2222-222222222222:sites'/,
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
    expect(params[0]).toBeCloseTo(-0.1, 3);
    expect(params[1]).toBeCloseTo(-0.1, 5);
    expect(params[2]).toBeCloseTo(1.1, 3);
    expect(params[3]).toBeCloseTo(1.1, 5);
    expect(params[4]).toBe(11132);
    expect(params[5]).toBe(500);
  });
});

// -----------------------------------------------------------------
// #78 -- derived_layer as a valid source kind (chaining)
// -----------------------------------------------------------------

describe('DerivedLayersService.validateAndEnrich (chained source)', () => {
  /**
   * Stand-in Prisma for the chain tests.  Tests that exercise the
   * read path build a Map of itemId -> Item-shape and resolve
   * findUnique against it; the service's walkSourceChain reads
   * type/data/deletedAt off each node.
   */
  function makeFakePrisma(items: Map<string, unknown>) {
    return {
      item: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) => {
            return items.get(where.id) ?? null;
          },
        ),
        findFirst: jest.fn(async () => null),
      },
      $queryRawUnsafe: jest.fn(async () => []),
    } as unknown as ConstructorParameters<typeof DerivedLayersService>[0];
  }

  /** A persisted derived_layer item with the given source + schema. */
  function makeDerivedSource(args: {
    id: string;
    sourceItemId: string;
    sourceKind?: 'data_layer' | 'derived_layer';
    outputSchema?: FeatureField[];
    bbox?: number[];
  }): {
    id: string;
    type: 'derived_layer';
    data: unknown;
    deletedAt: null;
    bbox: number[];
  } {
    const data: DerivedLayerData = {
      version: 1,
      source: {
        kind: args.sourceKind ?? 'data_layer',
        itemId: args.sourceItemId,
      },
      pipeline: [
        {
          tool: 'buffer',
          params: { mode: 'fixed', distance: 1, unit: 'meters' },
        },
      ],
      featureLimit: 100,
      outputSchema: args.outputSchema ?? [STRING_FIELD],
      bbox: args.bbox ?? [-1, -1, 1, 1],
    };
    return {
      id: args.id,
      type: 'derived_layer',
      data: data as unknown,
      deletedAt: null,
      bbox: args.bbox ?? [-1, -1, 1, 1],
    };
  }

  it('accepts a derived_layer source and inherits its cached outputSchema', async () => {
    const dataLayer = makeSource();
    const parentDerived = makeDerivedSource({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sourceItemId: dataLayer.id,
      outputSchema: [STRING_FIELD],
      bbox: [-2, -2, 2, 2],
    });
    const items = new Map<string, unknown>([
      [dataLayer.id, { ...dataLayer, deletedAt: null }],
      [parentDerived.id, parentDerived],
    ]);
    const svc = new DerivedLayersService(makeFakePrisma(items));
    const enriched = await svc.validateAndEnrich(
      {
        version: 1,
        source: { kind: 'derived_layer', itemId: parentDerived.id },
        pipeline: [
          { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
        ],
      },
      parentDerived as unknown as Item,
    );
    expect(enriched.source.kind).toBe('derived_layer');
    expect(enriched.outputSchema).toEqual([STRING_FIELD]);
    // bbox starts from parent's [-2, -2, 2, 2] and is padded by reach.
    expect(enriched.bbox[0]).toBeLessThanOrEqual(-2);
    expect(enriched.bbox[3]).toBeGreaterThanOrEqual(2);
  });

  it('rejects layerKey on a derived_layer source', async () => {
    const dataLayer = makeSource();
    const parentDerived = makeDerivedSource({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      sourceItemId: dataLayer.id,
    });
    const items = new Map<string, unknown>([
      [dataLayer.id, { ...dataLayer, deletedAt: null }],
      [parentDerived.id, parentDerived],
    ]);
    const svc = new DerivedLayersService(makeFakePrisma(items));
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: {
            kind: 'derived_layer',
            itemId: parentDerived.id,
            layerKey: 'L1',
          },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
        },
        parentDerived as unknown as Item,
      ),
    ).rejects.toThrow(/layerKey is not valid for a derived_layer source/);
  });

  it('rejects a derived_layer source whose chain root is missing', async () => {
    const orphan = makeDerivedSource({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      sourceItemId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    });
    const items = new Map<string, unknown>([[orphan.id, orphan]]);
    const svc = new DerivedLayersService(makeFakePrisma(items));
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'derived_layer', itemId: orphan.id },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
        },
        orphan as unknown as Item,
      ),
    ).rejects.toThrow(/missing or trashed/);
  });

  it('detects a cycle in the chain', async () => {
    // A points at B, B points at A.  validateAndEnrich starts at A
    // (the immediate source).  walkSourceChain steps to B, then
    // tries to step back to A -> cycle.
    const a = makeDerivedSource({
      id: '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sourceItemId: '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      sourceKind: 'derived_layer',
    });
    const b = makeDerivedSource({
      id: '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      sourceItemId: '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sourceKind: 'derived_layer',
    });
    const items = new Map<string, unknown>([
      [a.id, a],
      [b.id, b],
    ]);
    const svc = new DerivedLayersService(makeFakePrisma(items));
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'derived_layer', itemId: a.id },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
        },
        a as unknown as Item,
      ),
    ).rejects.toThrow(/cycle/);
  });

  it('caps the chain at MAX_CHAIN_DEPTH derived hops', async () => {
    // Build a chain longer than the cap.  Each derived item
    // references the next via source.itemId; the deepest references
    // a (missing) terminal id to keep the chain pure derived.
    const ids = Array.from({ length: 7 }).map(
      (_, i) =>
        `eeeeeeee-eeee-eeee-eeee-${i.toString().padStart(12, '0')}`,
    );
    const items = new Map<string, unknown>();
    for (let i = 0; i < ids.length - 1; i++) {
      const node = makeDerivedSource({
        id: ids[i]!,
        sourceItemId: ids[i + 1]!,
        sourceKind: 'derived_layer',
      });
      items.set(ids[i]!, node);
    }
    // Make the terminal a data_layer so the chain can resolve --
    // depth check should still trip before we get there.
    const term = makeSource({
      id: ids[ids.length - 1]!,
      deletedAt: null,
    } as unknown as Partial<Item>);
    items.set(term.id!, term);
    const head = items.get(ids[0]!) as { id: string };
    const svc = new DerivedLayersService(makeFakePrisma(items));
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'derived_layer', itemId: head.id },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
        },
        items.get(head.id) as unknown as Item,
      ),
    ).rejects.toThrow(/exceeds the maximum depth/);
  });

  it('rejects a derived_layer source with no cached outputSchema', async () => {
    // The source claims to be a derived_layer but its data blob has
    // no outputSchema array (which validateAndEnrich would stamp on
    // any clean save).  This catches stale rows from before the
    // outputSchema field landed.
    const broken = {
      id: '99999999-9999-9999-9999-999999999999',
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: makeSource().id },
        pipeline: [],
      } as unknown,
      deletedAt: null,
      bbox: [],
    };
    const items = new Map<string, unknown>([
      [broken.id, broken],
      [makeSource().id, { ...makeSource(), deletedAt: null }],
    ]);
    const svc = new DerivedLayersService(makeFakePrisma(items));
    await expect(
      svc.validateAndEnrich(
        {
          version: 1,
          source: { kind: 'derived_layer', itemId: broken.id },
          pipeline: [
            { tool: 'buffer', params: { distance: 1, unit: 'meters' } },
          ],
        },
        broken as unknown as Item,
      ),
    ).rejects.toThrow(/no cached outputSchema/);
  });
});
