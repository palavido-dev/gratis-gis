// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';
import { type Observation, isUuid, uuidv7 } from '@gratis-gis/engine';

import {
  DataLayerEngine,
  dataLayerScope,
  type CreateFeatureArgs,
  type DataLayerFeature,
  type DeleteFeatureArgs,
  type UpdateFeatureArgs,
} from './data-layer.js';
import type { EngineService } from './engine.service.js';
import { TileCacheService } from './tile-cache.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LensPolicyService } from '../policy/lens-policy.service.js';

// Single shared instance is fine for unit tests; the cache is
// scoped per (z, x, y, ...) and the spec doesn't exercise the
// MVT read path, so the cache stays empty.
const makeTileCache = (): TileCacheService => new TileCacheService();

const PRINCIPAL = { sub: 'user-1', displayName: 'User One' };
const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = '22222222-2222-7222-8222-222222222222';

/**
 * Capture-and-return fake EngineService. `write` and `writeMany` echo
 * back inputs with `id`, `txTime`, and `cell` filled in so callers can
 * assert the full Observation shape that the adapter produced.
 */
function makeFakeEngine() {
  const writes: Observation[] = [];
  const fillBookkeeping = (input: Observation): Observation => ({
    ...input,
    id: input.id ?? uuidv7(),
    txTime: input.txTime ?? new Date(),
    cell: input.cell ?? null,
  });
  return {
    writes,
    fake: {
      async write(input: Observation): Promise<Observation> {
        const filled = fillBookkeeping(input);
        writes.push(filled);
        return filled;
      },
      async writeMany(inputs: Observation[]): Promise<Observation[]> {
        const filled = inputs.map(fillBookkeeping);
        writes.push(...filled);
        return filled;
      },
      // The adapter subscribes to writes at construction so its caches
      // drop in-process; the fake never fires it.
      onWrite() {},
    } as unknown as EngineService,
  };
}

/**
 * Fake PrismaService whose `$queryRaw` returns whatever the test
 * loaded into `rows`. listFeatures issues a single combined query;
 * tests load the expected shape directly.
 */
interface FakeFeatureRow {
  entity: string;
  observation_id: string;
  attrs: Record<string, unknown> | null;
  geom_geojson: unknown;
  edited_by: string;
  edited_at: Date;
  created_by: string;
  created_at: Date;
}
function makeFakePrisma() {
  let rows: FakeFeatureRow[] = [];
  return {
    setRows(next: FakeFeatureRow[]) {
      rows = next;
    },
    fake: {
      async $queryRaw() {
        return rows;
      },
    } as unknown as PrismaService,
  };
}

/**
 * Fake LensPolicyService for tests that don't exercise the lens
 * filter (the existing pre-Phase-D suite). The default no-op
 * `checkFeature` returns true so passthrough is identical to the
 * pre-Phase-D shape; tests that DO want to drive policy filtering
 * supply their own checker via `makeFakeLensPolicy({ checkFeature })`.
 */
function makeFakeLensPolicy(
  override: Partial<{
    checkFeature: LensPolicyService['checkFeature'];
  }> = {},
): LensPolicyService {
  return {
    checkFeature: override.checkFeature ?? (() => true),
  } as unknown as LensPolicyService;
}

function createArgs(overrides: Partial<CreateFeatureArgs> = {}): CreateFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    properties: { name: 'feature-a', value: 42 },
    geometry: { type: 'Point', coordinates: [-111.65, 40.6] },
    ...overrides,
  };
}

function updateArgs(overrides: Partial<UpdateFeatureArgs> = {}): UpdateFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    globalId: uuidv7(),
    properties: { name: 'updated' },
    ...overrides,
  };
}

function deleteArgs(overrides: Partial<DeleteFeatureArgs> = {}): DeleteFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    globalId: uuidv7(),
    ...overrides,
  };
}

describe('dataLayerScope', () => {
  it('encodes (itemId, layerId) into a canonical scope string', () => {
    expect(dataLayerScope('item-x', 'layer-y')).toBe('data_layer:item-x:layer-y');
  });
});

describe('DataLayerEngine.searchFeatures', () => {
  const makeAdapter = (prisma: PrismaService) =>
    new DataLayerEngine(
      makeFakeEngine().fake,
      prisma,
      makeFakeLensPolicy(),
      makeTileCache(),
    );

  it('returns empty without querying when the query is blank', async () => {
    let queried = false;
    const spyPrisma = {
      async $queryRaw() {
        queried = true;
        return [];
      },
    } as unknown as PrismaService;
    const adapter = makeAdapter(spyPrisma);

    const out = await adapter.searchFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      q: '   ',
      limit: 8,
    });

    expect(out).toEqual({ results: [], truncated: false });
    expect(queried).toBe(false);
  });

  it('maps rows to id + properties + interior point + bbox', async () => {
    const prisma = makeFakePrisma();
    prisma.setRows([
      {
        entity: '33333333-3333-7333-8333-333333333333',
        attrs: { FULLOWNERNAME: 'CARLSON CHRISTAL' },
        px: -79.9,
        py: 38.8,
        minx: -80,
        miny: 38.7,
        maxx: -79.8,
        maxy: 38.9,
      },
    ] as unknown as FakeFeatureRow[]);
    const adapter = makeAdapter(prisma.fake);

    const out = await adapter.searchFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      q: 'CARLSON',
      fields: ['FULLOWNERNAME'],
      limit: 8,
    });

    expect(out.truncated).toBe(false);
    expect(out.results).toHaveLength(1);
    const hit = out.results[0]!;
    expect(hit.id).toBe('33333333-3333-7333-8333-333333333333');
    expect(hit.properties.FULLOWNERNAME).toBe('CARLSON CHRISTAL');
    // The entity is surfaced as _global_id so callers can key off it.
    expect(hit.properties._global_id).toBe(hit.id);
    expect(hit.point).toEqual([-79.9, 38.8]);
    expect(hit.bbox).toEqual([-80, 38.7, -79.8, 38.9]);
  });

  it('flags truncation when more than `limit` rows come back', async () => {
    const prisma = makeFakePrisma();
    prisma.setRows([
      { entity: 'a', attrs: {}, px: 1, py: 1, minx: 1, miny: 1, maxx: 1, maxy: 1 },
      { entity: 'b', attrs: {}, px: 2, py: 2, minx: 2, miny: 2, maxx: 2, maxy: 2 },
      { entity: 'c', attrs: {}, px: 3, py: 3, minx: 3, miny: 3, maxx: 3, maxy: 3 },
    ] as unknown as FakeFeatureRow[]);
    const adapter = makeAdapter(prisma.fake);

    const out = await adapter.searchFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      q: 'x',
      limit: 2,
    });

    expect(out.truncated).toBe(true);
    expect(out.results).toHaveLength(2);
  });

  it('returns null point + bbox for geometryless (table) rows', async () => {
    const prisma = makeFakePrisma();
    prisma.setRows([
      {
        entity: '44444444-4444-7444-8444-444444444444',
        attrs: { name: 'no-geom' },
        px: null,
        py: null,
        minx: null,
        miny: null,
        maxx: null,
        maxy: null,
      },
    ] as unknown as FakeFeatureRow[]);
    const adapter = makeAdapter(prisma.fake);

    const out = await adapter.searchFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      q: 'no-geom',
      limit: 8,
    });

    expect(out.results[0]!.point).toBeNull();
    expect(out.results[0]!.bbox).toBeNull();
  });
});

describe('DataLayerEngine.writeFeatureCreate', () => {
  it('writes a kind=create observation with a fresh entity id', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    const result = await adapter.writeFeatureCreate(createArgs());

    expect(engine.writes).toHaveLength(1);
    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('create');
    expect(obs.scope).toBe(dataLayerScope(ITEM_ID, LAYER_ID));
    expect(isUuid(obs.entity)).toBe(true);
    expect(result.globalId).toBe(obs.entity);
    expect(isUuid(result.observationId)).toBe(true);
  });

  it('passes properties through as attrs and geometry through as geom', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    await adapter.writeFeatureCreate(createArgs());

    const obs = engine.writes[0]!;
    expect(obs.attrs).toEqual({ name: 'feature-a', value: 42 });
    expect(obs.geom).toEqual({ type: 'Point', coordinates: [-111.65, 40.6] });
  });

  it('defaults source.kind to data_layer:write when not given', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    await adapter.writeFeatureCreate(createArgs());

    expect(engine.writes[0]!.source.kind).toBe('data_layer:write');
  });

  it('respects an explicit source override', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    await adapter.writeFeatureCreate(
      createArgs({ source: { kind: 'ingest:shapefile' } }),
    );

    expect(engine.writes[0]!.source.kind).toBe('ingest:shapefile');
  });

  it('handles missing properties and geometry as null', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    await adapter.writeFeatureCreate({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      principal: PRINCIPAL,
    });

    const obs = engine.writes[0]!;
    expect(obs.attrs).toBe(null);
    expect(obs.geom).toBe(null);
  });

  it('uses an explicit globalId as the entity id when provided', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const globalId = uuidv7();

    const result = await adapter.writeFeatureCreate(createArgs({ globalId }));

    expect(engine.writes[0]!.entity).toBe(globalId);
    expect(result.globalId).toBe(globalId);
  });
});

describe('DataLayerEngine.writeFeaturesCreate', () => {
  it('returns an empty array on empty input', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    const out = await adapter.writeFeaturesCreate([]);
    expect(out).toEqual([]);
    expect(engine.writes).toHaveLength(0);
  });

  it('writes one create observation per input and returns aligned ids', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    const inputs = [
      createArgs({ properties: { i: 0 } }),
      createArgs({ properties: { i: 1 } }),
      createArgs({ properties: { i: 2 } }),
    ];
    const out = await adapter.writeFeaturesCreate(inputs);

    expect(out).toHaveLength(3);
    expect(engine.writes).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(engine.writes[i]!.kind).toBe('create');
      expect(isUuid(engine.writes[i]!.entity)).toBe(true);
      expect(out[i]!.globalId).toBe(engine.writes[i]!.entity);
      expect((engine.writes[i]!.attrs as { i: number }).i).toBe(i);
    }
  });

  it('every entity id is unique', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());

    const inputs = Array.from({ length: 20 }, () => createArgs());
    const out = await adapter.writeFeaturesCreate(inputs);
    const ids = new Set(out.map((r) => r.globalId));
    expect(ids.size).toBe(20);
  });

  it('honors per-input globalId when provided, generates fresh ones otherwise', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const supplied = uuidv7();

    const out = await adapter.writeFeaturesCreate([
      createArgs({ globalId: supplied }),
      createArgs(), // no globalId, should get a fresh one
    ]);

    expect(out[0]!.globalId).toBe(supplied);
    expect(isUuid(out[1]!.globalId)).toBe(true);
    expect(out[1]!.globalId).not.toBe(supplied);
  });
});

describe('DataLayerEngine.writeFeatureUpdate', () => {
  it('writes a kind=update observation that preserves the entity id', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const args = updateArgs();

    await adapter.writeFeatureUpdate(args);

    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('update');
    expect(obs.entity).toBe(args.globalId);
    expect(obs.attrs).toEqual({ name: 'updated' });
  });
});

describe('DataLayerEngine.writeFeatureDelete', () => {
  it('writes a kind=delete observation with null attrs and geom', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const args = deleteArgs();

    await adapter.writeFeatureDelete(args);

    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('delete');
    expect(obs.entity).toBe(args.globalId);
    expect(obs.attrs).toBe(null);
    expect(obs.geom).toBe(null);
  });
});

describe('DataLayerEngine.listFeatures', () => {
  function row(
    entity: string,
    overrides: Partial<FakeFeatureRow> = {},
  ): FakeFeatureRow {
    return {
      entity,
      observation_id: uuidv7(),
      attrs: { name: 'feature-a' },
      geom_geojson: { type: 'Point', coordinates: [-111.65, 40.6] },
      edited_by: 'editor-user',
      edited_at: new Date('2026-04-01T00:00:00Z'),
      created_by: 'creator-user',
      created_at: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('returns an empty FeatureCollection when the query returns no rows', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    prisma.setRows([]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('returns a FeatureCollection with surfaced editor tracking', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const entity = uuidv7();
    prisma.setRows([row(entity)]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out.type).toBe('FeatureCollection');
    expect(out.features).toHaveLength(1);
    const feat = out.features[0]!;
    expect(feat.id).toBe(entity);
    expect(feat.geometry).toEqual({
      type: 'Point',
      coordinates: [-111.65, 40.6],
    });
    expect(feat.properties._global_id).toBe(entity);
    expect(feat.properties._created_by).toBe('creator-user');
    expect(feat.properties._created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(feat.properties._edited_by).toBe('editor-user');
    expect(feat.properties._edited_at).toBe('2026-04-01T00:00:00.000Z');
    expect(feat.properties.name).toBe('feature-a');
  });

  it('passes through null geometry and null attrs without crashing', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    const entity = uuidv7();
    prisma.setRows([row(entity, { attrs: null, geom_geojson: null })]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out.features[0]!.geometry).toBe(null);
    expect(out.features[0]!.properties._global_id).toBe(entity);
  });

  it('honors a limit override', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake, makeFakeLensPolicy(), makeTileCache());
    prisma.setRows([row(uuidv7())]);

    // Just verify the call shape; the SQL contains LIMIT but we are
    // not asserting on raw SQL here because the fake $queryRaw does
    // not capture the template strings. The SQL composition is
    // exercised end-to-end by the integration round-trip script.
    const out = await adapter.listFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      limit: 50,
    });
    expect(out.features).toHaveLength(1);
  });

  it('threads entityIds into the WHERE clause as a uuid-cast ANY filter', async () => {
    // Capturing fake: flatten the tagged-template call back through
    // Prisma.sql so nested fragments (the entityIds filter travels
    // inside `currentExtras`) surface in one inspectable text +
    // bind-values pair. This pins the regression where a caller's
    // entityIds was silently dropped because the args type had no
    // such member, turning a selection-scoped Calculate Field into
    // a whole-layer rewrite.
    const captured: Prisma.Sql[] = [];
    const capturingPrisma = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        captured.push(Prisma.sql(strings, ...values));
        return [];
      },
    } as unknown as PrismaService;
    const engine = makeFakeEngine();
    const adapter = new DataLayerEngine(
      engine.fake,
      capturingPrisma,
      makeFakeLensPolicy(),
      makeTileCache(),
    );
    const a = uuidv7();
    const b = uuidv7();

    await adapter.listFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      entityIds: [a, b],
    });

    expect(captured).toHaveLength(1);
    const q = captured[0]!;
    expect(q.sql).toContain('entity = ANY(ARRAY[');
    expect(q.sql).toContain('::uuid');
    expect(q.values).toEqual(expect.arrayContaining([a, b]));
  });

  it('issues no entity ANY filter when entityIds is absent or empty', async () => {
    const captured: Prisma.Sql[] = [];
    const capturingPrisma = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        captured.push(Prisma.sql(strings, ...values));
        return [];
      },
    } as unknown as PrismaService;
    const engine = makeFakeEngine();
    const adapter = new DataLayerEngine(
      engine.fake,
      capturingPrisma,
      makeFakeLensPolicy(),
      makeTileCache(),
    );

    await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    await adapter.listFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      entityIds: [],
    });

    for (const q of captured) {
      expect(q.sql).not.toContain('entity = ANY(ARRAY[');
    }
  });

  // -----------------------------------------------------------------
  // Phase D: lens-policy filtering. The fake LensPolicyService is
  // the load-bearing piece here; we drive its `checkFeature` to
  // simulate a Cedar-evaluated allow / deny per row and confirm the
  // engine's filter wiring respects the decision.
  // -----------------------------------------------------------------
  describe('lens-policy filtering (Phase D)', () => {
    // Minimal AuthUser-shaped fixture for the policy fake. The
    // engine's lensPolicy parameter forwards this verbatim to
    // LensPolicyService; the fake checker we install ignores the
    // user, so the only invariant is that the engine doesn't
    // crash building the entity store reference.
    const FAKE_USER = {
      id: 'user-1',
      orgId: 'org-1',
      orgSlug: 'org-1',
      username: 'alice',
      email: 'alice@example.com',
      orgRole: 'contributor',
      groupIds: [],
      capabilities: new Set(),
    } as unknown as import('../auth/auth-sync.service.js').AuthUser;

    it('passes through every row when no lensPolicy is supplied', async () => {
      const engine = makeFakeEngine();
      const prisma = makeFakePrisma();
      let calls = 0;
      const policy = makeFakeLensPolicy({
        checkFeature: () => {
          calls += 1;
          return false; // would-deny if invoked
        },
      });
      const adapter = new DataLayerEngine(engine.fake, prisma.fake, policy, makeTileCache());
      prisma.setRows([row(uuidv7()), row(uuidv7())]);

      const out = await adapter.listFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
      });
      expect(out.features).toHaveLength(2);
      expect(calls).toBe(0); // never consulted when lensPolicy is absent
    });

    it('passes through every row when lens.policy is empty', async () => {
      const engine = makeFakeEngine();
      const prisma = makeFakePrisma();
      let calls = 0;
      const policy = makeFakeLensPolicy({
        checkFeature: () => {
          calls += 1;
          return false;
        },
      });
      const adapter = new DataLayerEngine(engine.fake, prisma.fake, policy, makeTileCache());
      prisma.setRows([row(uuidv7())]);

      const out = await adapter.listFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        lensPolicy: {
          lens: { id: 'lens-1', policy: '' },
          user: FAKE_USER,
        },
      });
      expect(out.features).toHaveLength(1);
      expect(calls).toBe(0);
    });

    it('drops rows that fail the policy check', async () => {
      const engine = makeFakeEngine();
      const prisma = makeFakePrisma();
      const allowList = new Set<string>();
      const policy = makeFakeLensPolicy({
        checkFeature: ({ feature }) => allowList.has(feature.entityId),
      });
      const adapter = new DataLayerEngine(engine.fake, prisma.fake, policy, makeTileCache());
      const e1 = uuidv7();
      const e2 = uuidv7();
      const e3 = uuidv7();
      allowList.add(e1);
      allowList.add(e3);
      prisma.setRows([row(e1), row(e2), row(e3)]);

      const out = await adapter.listFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        lensPolicy: {
          lens: { id: 'lens-1', policy: 'forbid (...);' },
          user: FAKE_USER,
        },
      });
      expect(out.features.map((f) => f.id)).toEqual([e1, e3]);
    });

    it('passes spatial keys from spatialKeysFor through to the policy', async () => {
      const engine = makeFakeEngine();
      const prisma = makeFakePrisma();
      const seenSpatial: string[][] = [];
      const policy = makeFakeLensPolicy({
        checkFeature: ({ feature }) => {
          seenSpatial.push([...feature.spatial]);
          return true;
        },
      });
      const adapter = new DataLayerEngine(engine.fake, prisma.fake, policy, makeTileCache());
      const e1 = uuidv7();
      const e2 = uuidv7();
      prisma.setRows([row(e1), row(e2)]);

      await adapter.listFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        lensPolicy: {
          lens: { id: 'lens-spatial', policy: 'forbid (...);' },
          user: FAKE_USER,
          spatialKeysFor: (f) =>
            f.id === e1 ? ['assigned_area'] : [],
        },
      });
      expect(seenSpatial).toEqual([['assigned_area'], []]);
    });

    it('forwards the feature\'s attrs payload (sans tracking fields are still present)', async () => {
      const engine = makeFakeEngine();
      const prisma = makeFakePrisma();
      const seenAttrs: Record<string, unknown>[] = [];
      const policy = makeFakeLensPolicy({
        checkFeature: ({ feature }) => {
          seenAttrs.push(feature.attrs);
          return true;
        },
      });
      const adapter = new DataLayerEngine(engine.fake, prisma.fake, policy, makeTileCache());
      const e1 = uuidv7();
      prisma.setRows([
        row(e1, { attrs: { cost: 99, classification: 'A' } }),
      ]);

      await adapter.listFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        lensPolicy: {
          lens: { id: 'lens-attrs', policy: 'forbid (...);' },
          user: FAKE_USER,
        },
      });
      expect(seenAttrs).toHaveLength(1);
      // Engine forwards the full properties bag (caller-attrs +
      // editor-tracking underscore fields). Lens authors who only
      // care about user-set attrs reach for `resource.attrs.cost`
      // (the unprefixed names); the engine fields are namespaced
      // under `_*` and don't collide.
      expect(seenAttrs[0]?.cost).toBe(99);
      expect(seenAttrs[0]?.classification).toBe('A');
      expect(seenAttrs[0]?._global_id).toBe(e1);
    });
  });
});

describe('DataLayerEngine.iterateFeatures', () => {
  // Fixed, readable, ascending entity ids so cursor assertions are
  // eyeball-able. The fake prisma doesn't order anything; the SQL
  // does in production, and the JS walk only relies on "last row of
  // the page is the page maximum," which these uphold.
  const E = [
    '00000000-0000-7000-8000-00000000000a',
    '00000000-0000-7000-8000-00000000000b',
    '00000000-0000-7000-8000-00000000000c',
    '00000000-0000-7000-8000-00000000000d',
    '00000000-0000-7000-8000-00000000000e',
  ] as const;

  type FakeIterRow = FakeFeatureRow & { kind: string };

  function iterRow(
    entity: string,
    overrides: Partial<FakeIterRow> = {},
  ): FakeIterRow {
    return {
      entity,
      observation_id: uuidv7(),
      attrs: { name: `feature-${entity.slice(-1)}` },
      geom_geojson: { type: 'Point', coordinates: [-79.85, 38.92] },
      edited_by: 'editor-user',
      edited_at: new Date('2026-04-01T00:00:00Z'),
      created_by: 'creator-user',
      created_at: new Date('2026-01-01T00:00:00Z'),
      kind: 'create',
      ...overrides,
    };
  }

  /**
   * Scripted fake: each $queryRaw call consumes the next page and
   * records the tagged-template arguments so tests can assert the
   * keyset cursor actually reached the SQL. Off-script calls get an
   * empty page, which the iterator treats as end-of-data.
   */
  function makeScriptedPrisma(pages: FakeIterRow[][]) {
    const calls: Array<{ values: unknown[] }> = [];
    let next = 0;
    return {
      calls,
      fake: {
        async $queryRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
          calls.push({ values });
          const page = pages[next] ?? [];
          next += 1;
          return page;
        },
      } as unknown as PrismaService,
    };
  }

  /** Recursively unwrap nested Prisma.Sql fragments down to their
   *  bound primitives, so a cursor bound inside the `AND entity >
   *  ${cursor}::uuid` sub-fragment is visible to assertions. */
  function flattenBoundValues(values: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const v of values) {
      if (
        v !== null &&
        typeof v === 'object' &&
        'strings' in v &&
        'values' in v
      ) {
        out.push(...flattenBoundValues((v as { values: unknown[] }).values));
      } else {
        out.push(v);
      }
    }
    return out;
  }

  function makeAdapter(prisma: PrismaService): DataLayerEngine {
    return new DataLayerEngine(
      makeFakeEngine().fake,
      prisma,
      makeFakeLensPolicy(),
      makeTileCache(),
    );
  }

  async function collect(
    gen: AsyncGenerator<
      Array<{ id: string }>,
      void,
      undefined
    >,
  ): Promise<string[]> {
    const ids: string[] = [];
    for await (const batch of gen) {
      ids.push(...batch.map((f) => f.id));
    }
    return ids;
  }

  it('crosses page boundaries without dropping or duplicating rows', async () => {
    const prisma = makeScriptedPrisma([
      [iterRow(E[0]), iterRow(E[1])],
      [iterRow(E[2]), iterRow(E[3])],
      [iterRow(E[4])], // short page = end of data
    ]);
    const adapter = makeAdapter(prisma.fake);

    const ids = await collect(
      adapter.iterateFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        pageSize: 2,
      }),
    );

    // Every scripted entity exactly once, in walk order.
    expect(ids).toEqual([E[0], E[1], E[2], E[3], E[4]]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(prisma.calls).toHaveLength(3);
    // Page 1 has no cursor; pages 2 and 3 must carry the previous
    // page's last entity as the strict lower bound.
    expect(flattenBoundValues(prisma.calls[0]!.values)).not.toContain(E[1]);
    expect(flattenBoundValues(prisma.calls[1]!.values)).toContain(E[1]);
    expect(flattenBoundValues(prisma.calls[2]!.values)).toContain(E[3]);
  });

  it('skips tombstones without ending the walk early', async () => {
    // Page 2 is 100% tombstones: nothing to yield, but the cursor
    // must still advance past it or the walk would either stop
    // short (treating an empty yield as done) or spin forever.
    const prisma = makeScriptedPrisma([
      [iterRow(E[0]), iterRow(E[1], { kind: 'delete' })],
      [
        iterRow(E[2], { kind: 'delete' }),
        iterRow(E[3], { kind: 'delete' }),
      ],
      [iterRow(E[4])],
    ]);
    const adapter = makeAdapter(prisma.fake);

    const ids = await collect(
      adapter.iterateFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        pageSize: 2,
      }),
    );

    expect(ids).toEqual([E[0], E[4]]);
    expect(prisma.calls).toHaveLength(3);
    // The all-tombstone page still moved the cursor to its last
    // scanned entity.
    expect(flattenBoundValues(prisma.calls[2]!.values)).toContain(E[3]);
  });

  it('stops after a short page without an extra round-trip', async () => {
    const prisma = makeScriptedPrisma([[iterRow(E[0])]]);
    const adapter = makeAdapter(prisma.fake);

    const ids = await collect(
      adapter.iterateFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        pageSize: 2,
      }),
    );

    expect(ids).toEqual([E[0]]);
    expect(prisma.calls).toHaveLength(1);
  });

  it('issues one follow-up query when the final page is exactly full', async () => {
    // A full page cannot distinguish "done" from "more"; the walk
    // must probe once more and terminate on the empty result.
    const prisma = makeScriptedPrisma([[iterRow(E[0]), iterRow(E[1])]]);
    const adapter = makeAdapter(prisma.fake);

    const ids = await collect(
      adapter.iterateFeatures({
        itemId: ITEM_ID,
        layerId: LAYER_ID,
        pageSize: 2,
      }),
    );

    expect(ids).toEqual([E[0], E[1]]);
    expect(prisma.calls).toHaveLength(2);
  });

  it('maps rows to the v3 wire shape with editor tracking', async () => {
    const prisma = makeScriptedPrisma([[iterRow(E[0])]]);
    const adapter = makeAdapter(prisma.fake);

    const pages: DataLayerFeature[][] = [];
    for await (const batch of adapter.iterateFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      pageSize: 2,
    })) {
      pages.push(batch);
    }
    expect(pages).toHaveLength(1);
    const feat = pages[0]![0]!;
    expect(feat.id).toBe(E[0]);
    expect(feat.properties._global_id).toBe(E[0]);
    expect(feat.properties._created_by).toBe('creator-user');
    expect(feat.properties._edited_by).toBe('editor-user');
    expect(feat.geometry).toEqual({
      type: 'Point',
      coordinates: [-79.85, 38.92],
    });
  });
});
