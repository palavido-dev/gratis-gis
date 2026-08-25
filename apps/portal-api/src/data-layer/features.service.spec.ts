// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { DataLayerFeaturesService } from './features.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { DataLayerEngine } from '../engine/data-layer.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import type { ItemBboxRefreshService } from '../items/item-bbox-refresh.service.js';

/**
 * Calculate Field scope coverage (#83 regression).
 *
 * The 'selection' scope used to pass `entityIds` into an engine args
 * type that had no such member, so the filter was silently dropped
 * and a selection-scoped calculate rewrote EVERY row in the layer.
 * These specs pin the repaired contract at the service boundary:
 * the engine read receives the selection as `entityIds`, and only
 * the rows the engine returned for that selection are written back.
 * The engine-side SQL threading is pinned separately in
 * `engine/data-layer.spec.ts`.
 */

const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = '22222222-2222-7222-8222-222222222222';

const E1 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa1';
const E2 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa2';
const E3 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa3';
const E4 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa4';

function feature(id: string, value: number) {
  return {
    type: 'Feature' as const,
    id,
    geometry: { type: 'Point', coordinates: [-80.5, 39.2] },
    properties: {
      value,
      _global_id: id,
      _created_by: 'creator',
      _created_at: '2026-01-01T00:00:00.000Z',
      _edited_by: 'editor',
      _edited_at: '2026-02-01T00:00:00.000Z',
    },
  };
}

const ALL_FEATURES = [
  feature(E1, 1),
  feature(E2, 2),
  feature(E3, 3),
  feature(E4, 4),
];

function makeUser(): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'calc-user',
    email: 'calc@example.test',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  } as unknown as AuthUser;
}

/**
 * Fake engine that honors the `entityIds` read filter the same way
 * the real SQL does (subset by id), so the assertion "only selected
 * entities get written" exercises the service's threading rather
 * than echoing its own inputs.
 */
function makeService() {
  const listFeatures = jest.fn(
    async (args: { entityIds?: string[] }) => ({
      type: 'FeatureCollection' as const,
      features:
        args.entityIds !== undefined && args.entityIds.length > 0
          ? ALL_FEATURES.filter((f) => args.entityIds!.includes(f.id))
          : ALL_FEATURES,
    }),
  );
  const writeFeaturesUpdate = jest.fn(
    async (updates: Array<{ globalId: string }>) =>
      updates.map(() => ({ observationId: 'obs' })),
  );
  const engine = { listFeatures, writeFeaturesUpdate };
  const cacheRefresh = {
    notifySourceWrite: jest.fn(() => Promise.resolve()),
  };
  const bboxRefresh = {
    refreshItemBbox: jest.fn(() => Promise.resolve()),
  };
  const service = new DataLayerFeaturesService(
    {} as unknown as PrismaService,
    cacheRefresh as unknown as DerivedLayerCacheRefreshService,
    engine as unknown as DataLayerEngine,
    bboxRefresh as unknown as ItemBboxRefreshService,
  );
  return { service, listFeatures, writeFeaturesUpdate };
}

function calcArgs(
  overrides: Partial<Parameters<DataLayerFeaturesService['calculateField']>[0]> = {},
): Parameters<DataLayerFeaturesService['calculateField']>[0] {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    expression: '{{value}} * 2',
    outputName: 'doubled',
    outputType: 'number',
    scope: 'all',
    dryRun: false,
    user: makeUser(),
    ...overrides,
  };
}

/**
 * Aggregate option forwarding.
 *
 * This wrapper forwards to the engine by naming each key, so a key it
 * does not know about is silently dropped. TypeScript does not catch
 * it: the controllers pass a variable rather than an object literal,
 * so excess-property checking never runs. That is how `where` first
 * shipped as a filter that validated its input correctly, returned
 * 200, and answered with unfiltered numbers, and it is the same shape
 * as the #83 `entityIds` bug pinned above.
 *
 * Asserting on the object the engine RECEIVED, rather than on a
 * returned figure, is the point: a dropped option is invisible in the
 * result.
 */
describe('DataLayerFeaturesService.aggregateFeatures option forwarding', () => {
  function makeAggService() {
    // The parameter is declared even though the fake ignores it:
    // without it jest types mock.calls as an empty tuple and the
    // assertions below cannot reach the argument, which is the only
    // thing worth asserting on here.
    const aggregateFeatures = jest.fn(
      async (_args: Record<string, unknown>) => ({
        groups: [] as Array<never>,
        truncated: false,
      }),
    );
    const service = new DataLayerFeaturesService(
      {} as unknown as PrismaService,
      { notifySourceWrite: jest.fn() } as unknown as DerivedLayerCacheRefreshService,
      { aggregateFeatures } as unknown as DataLayerEngine,
      { refreshItemBbox: jest.fn() } as unknown as ItemBboxRefreshService,
    );
    return { service, aggregateFeatures };
  }

  const WHERE = {
    combinator: 'all' as const,
    clauses: [{ field: 'status', op: '==', value: 'open' }],
  };

  it('passes every option through to the engine, including where', async () => {
    const { service, aggregateFeatures } = makeAggService();
    const asOf = new Date('2026-01-01T00:00:00.000Z');

    await service.aggregateFeatures(ITEM_ID, LAYER_ID, {
      aggs: [{ op: 'count', as: 'count' }],
      groupBy: ['status'],
      bbox: [-81, 38, -79, 40],
      where: WHERE,
      ownRowsOnly: { userId: 'user-1' },
      limit: 25,
      asOf,
    });

    expect(aggregateFeatures).toHaveBeenCalledTimes(1);
    expect(aggregateFeatures.mock.calls[0]![0]).toEqual({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      aggs: [{ op: 'count', as: 'count' }],
      groupBy: ['status'],
      bbox: [-81, 38, -79, 40],
      where: WHERE,
      ownRowsOnly: { userId: 'user-1' },
      limit: 25,
      asOf,
    });
  });

  it('omits the options the caller did not set rather than sending undefined', async () => {
    const { service, aggregateFeatures } = makeAggService();

    await service.aggregateFeatures(ITEM_ID, LAYER_ID, {
      aggs: [{ op: 'count', as: 'count' }],
    });

    const sent = aggregateFeatures.mock.calls[0]![0];
    expect(Object.keys(sent).sort()).toEqual(['aggs', 'itemId', 'layerId']);
  });

  // #27. Third time on this wrapper, after #83's entityIds and the
  // `where` incident: a new option is only actually wired once it is
  // named in BOTH the arg type and the spread. Dropped, the request
  // still returns 200, and the chart draws one bar per distinct
  // reading while the author believes they asked for a histogram.
  it('passes bin through to the engine', async () => {
    const { service, aggregateFeatures } = makeAggService();
    const bin = { field: 'iron', mode: 'count' as const, count: 20 };

    await service.aggregateFeatures(ITEM_ID, LAYER_ID, {
      aggs: [{ op: 'count', as: 'count' }],
      bin,
    });

    expect(aggregateFeatures.mock.calls[0]![0]).toMatchObject({ bin });
  });

  it('passes via through to the engine', async () => {
    const { service, aggregateFeatures } = makeAggService();
    const via = {
      myField: 'site_id',
      parentField: 'site_id',
      parentItemId: ITEM_ID,
      parentLayerId: LAYER_ID,
    };

    await service.aggregateFeatures(ITEM_ID, LAYER_ID, {
      aggs: [{ op: 'count', as: 'count' }],
      via,
    });

    expect(aggregateFeatures.mock.calls[0]![0]).toMatchObject({ via });
  });
});

describe('DataLayerFeaturesService.calculateField scope', () => {
  it('selection scope threads entityIds into the engine read and only writes the selected entities', async () => {
    const { service, listFeatures, writeFeaturesUpdate } = makeService();

    const out = await service.calculateField(
      calcArgs({ scope: 'selection', selectedIds: [E2, E4] }),
    );

    // The engine read carried the selection filter...
    expect(listFeatures).toHaveBeenCalledTimes(1);
    expect(listFeatures.mock.calls[0]![0]).toMatchObject({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      entityIds: [E2, E4],
    });
    // ...and the write-back touched exactly the selected entities,
    // nothing else in the layer.
    expect(writeFeaturesUpdate).toHaveBeenCalledTimes(1);
    const written = writeFeaturesUpdate.mock.calls[0]![0] as Array<{
      globalId: string;
      properties?: Record<string, unknown>;
    }>;
    expect(written.map((w) => w.globalId).sort()).toEqual([E2, E4]);
    expect(written.map((w) => w.properties?.doubled).sort()).toEqual([4, 8]);
    expect(out.totalRows).toBe(2);
    expect(out.appliedRows).toBe(2);
  });

  it("scope 'all' reads without an entityIds filter and touches every row", async () => {
    const { service, listFeatures, writeFeaturesUpdate } = makeService();

    const out = await service.calculateField(calcArgs());

    expect(listFeatures.mock.calls[0]![0]).not.toHaveProperty('entityIds');
    const written = writeFeaturesUpdate.mock.calls[0]![0] as Array<{
      globalId: string;
    }>;
    expect(written).toHaveLength(4);
    expect(out.appliedRows).toBe(4);
  });

  it('rejects selection scope with an empty or missing selection instead of widening to the whole layer', async () => {
    const { service, listFeatures, writeFeaturesUpdate } = makeService();

    await expect(
      service.calculateField(calcArgs({ scope: 'selection' })),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.calculateField(calcArgs({ scope: 'selection', selectedIds: [] })),
    ).rejects.toThrow(BadRequestException);

    // The guard fired before any read or write could happen.
    expect(listFeatures).not.toHaveBeenCalled();
    expect(writeFeaturesUpdate).not.toHaveBeenCalled();
  });

  it('rejects non-UUID selection ids before they can reach the SQL layer', async () => {
    const { service, writeFeaturesUpdate } = makeService();

    await expect(
      service.calculateField(
        calcArgs({ scope: 'selection', selectedIds: [E1, 'not-a-uuid'] }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(writeFeaturesUpdate).not.toHaveBeenCalled();
  });

  it('dry run with a selection still reads only the selection and writes nothing', async () => {
    const { service, listFeatures, writeFeaturesUpdate } = makeService();

    const out = await service.calculateField(
      calcArgs({ scope: 'selection', selectedIds: [E3], dryRun: true }),
    );

    expect(listFeatures.mock.calls[0]![0]).toMatchObject({
      entityIds: [E3],
    });
    expect(writeFeaturesUpdate).not.toHaveBeenCalled();
    expect(out.totalRows).toBe(1);
    expect(out.appliedRows).toBe(0);
    expect(out.sample).toEqual([{ id: E3, oldValue: undefined, newValue: 6 }]);
  });
});

/**
 * The forwarding contract for pageFeatures.
 *
 * `DataLayerFeaturesService.pageFeatures` rebuilds the engine's
 * argument object key by key, so an option can be added to the
 * signature and never reach the engine. That has happened three
 * times, and it does not fail loudly: the query runs, returns rows,
 * and answers a slightly different question than the caller asked.
 * TypeScript cannot catch it, because dropping an optional key still
 * type checks.
 *
 * So these assert on the object the ENGINE RECEIVED, not on the rows
 * that came back. A test that checked the rows would pass against a
 * stub that ignores its arguments entirely.
 */
describe('pageFeatures forwards every option to the engine', () => {
  function makePager() {
    // The parameter is typed so `mock.calls[0][0]` is inspectable:
    // asserting on the object the engine RECEIVED is the entire point
    // of these cases, and an untyped mock records `never[]`.
    const pageFeatures = jest.fn(async (_args: Record<string, unknown>) => ({
      features: [] as Array<{ id: string; properties: Record<string, unknown> }>,
      count: 0,
      truncated: false,
    }));
    const service = new DataLayerFeaturesService(
      {} as unknown as PrismaService,
      { notifySourceWrite: jest.fn() } as unknown as DerivedLayerCacheRefreshService,
      { pageFeatures } as unknown as DataLayerEngine,
      { refreshItemBbox: jest.fn() } as unknown as ItemBboxRefreshService,
    );
    return { service, pageFeatures };
  }

  const WHERE = {
    combinator: 'all' as const,
    clauses: [{ field: 'status', op: '==' as const, value: 'open' }],
  };

  it('passes the attribute predicate through', async () => {
    const { service, pageFeatures } = makePager();
    await service.pageFeatures(ITEM_ID, LAYER_ID, { where: WHERE });
    expect(pageFeatures.mock.calls[0]![0]).toMatchObject({ where: WHERE });
    expect(pageFeatures).toHaveBeenCalledTimes(1);
  });

  it('omits the key entirely when there is no predicate', async () => {
    // exactOptionalPropertyTypes: an explicit `where: undefined` is
    // not the same as an absent key, and the engine branches on
    // `!== undefined`.
    const { service, pageFeatures } = makePager();
    await service.pageFeatures(ITEM_ID, LAYER_ID, {});
    expect('where' in (pageFeatures.mock.calls[0]![0] as object)).toBe(false);
  });

  it('carries every other option in the same call', async () => {
    const { service, pageFeatures } = makePager();
    // The fourth occurrence of the dropped-key trap was `via` and
    // `asOf` on THIS wrapper (2026-08-25): engine correct, both
    // controllers correct, pg specs green, and the live endpoint
    // answered the whole layer. If you add a key to the wrapper,
    // add it here in the SAME commit.
    const via = {
      myField: 'site',
      parentField: 'key',
      parentItemId: ITEM_ID,
      parentLayerId: 'parent-layer',
      parentWhere: WHERE,
    };
    const asOf = new Date('2026-08-01T00:00:00Z');
    await service.pageFeatures(ITEM_ID, LAYER_ID, {
      bbox: [-81, 38, -79, 40],
      q: 'creek',
      sort: 'name',
      dir: 'desc',
      limit: 250,
      entityIds: [E1],
      isTable: true,
      where: WHERE,
      ownRowsOnly: { userId: 'user-1' },
      asOf,
      via,
    });
    expect(pageFeatures.mock.calls[0]![0]).toEqual({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      bbox: [-81, 38, -79, 40],
      q: 'creek',
      sort: 'name',
      dir: 'desc',
      limit: 250,
      entityIds: [E1],
      isTable: true,
      where: WHERE,
      ownRowsOnly: { userId: 'user-1' },
      asOf,
      via,
    });
  });
});

/**
 * The same forwarding contract for filteredExtent (#77). Written in
 * the same commit that adds the wrapper, per the rule the via/asOf
 * incident bought: a key added to a wrapper is added to its
 * forwarding spec before anything else calls it.
 */
describe('filteredExtent forwards every option to the engine', () => {
  it('carries every option in the same call', async () => {
    const filteredExtent = jest.fn(
      async (_args: Record<string, unknown>) => null,
    );
    const service = new DataLayerFeaturesService(
      {} as unknown as PrismaService,
      { notifySourceWrite: jest.fn() } as unknown as DerivedLayerCacheRefreshService,
      { filteredExtent } as unknown as DataLayerEngine,
      { refreshItemBbox: jest.fn() } as unknown as ItemBboxRefreshService,
    );
    const WHERE = {
      combinator: 'all' as const,
      clauses: [{ field: 'status', op: '==' as const, value: 'open' }],
    };
    const via = {
      myField: 'site',
      parentField: 'key',
      parentItemId: ITEM_ID,
      parentLayerId: 'parent-layer',
    };
    const asOf = new Date('2026-08-01T00:00:00Z');
    const geoLimit = { type: 'Point', coordinates: [0, 0] };
    const boundaryClip = { type: 'Point', coordinates: [1, 1] };
    await service.filteredExtent(ITEM_ID, LAYER_ID, {
      where: WHERE,
      via,
      geoLimit,
      boundaryClip,
      ownRowsOnly: { userId: 'user-1' },
      asOf,
    });
    expect(filteredExtent.mock.calls[0]![0]).toEqual({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      where: WHERE,
      via,
      geoLimit,
      boundaryClip,
      ownRowsOnly: { userId: 'user-1' },
      asOf,
    });
  });
});

/**
 * The same forwarding contract for mvtTile.
 *
 * This one is not hypothetical. `where` and `via` were threaded
 * through both controllers, both validated the input and both set
 * `opts.where`, and the tile still came back byte-for-byte identical
 * to the unfiltered one, because this method rebuilds the engine's
 * argument object key by key and the new keys were not in the list.
 *
 * TypeScript cannot catch it: `opts` reaches the method as a variable
 * rather than a fresh object literal, so excess property checking
 * does not apply and the extra keys are simply ignored. Nothing
 * throws, the endpoint answers 200, and the map draws a tile that is
 * quietly wrong.
 *
 * It was caught by comparing the byte count of a filtered tile
 * against an unfiltered one over an area that actually has features.
 * A zero-byte tile compares equal to a zero-byte tile, so the first
 * version of that check proved nothing either.
 */
describe('mvtTile forwards every option to the engine', () => {
  function makeTiler() {
    const mvtTile = jest.fn(async (_args: Record<string, unknown>) => ({
      mvt: Buffer.alloc(0),
      etag: '"x"',
    }));
    const service = new DataLayerFeaturesService(
      {} as unknown as PrismaService,
      { notifySourceWrite: jest.fn() } as unknown as DerivedLayerCacheRefreshService,
      { mvtTile } as unknown as DataLayerEngine,
      { refreshItemBbox: jest.fn() } as unknown as ItemBboxRefreshService,
    );
    return { service, mvtTile };
  }

  const WHERE = {
    combinator: 'all' as const,
    clauses: [{ field: 'status', op: '==' as const, value: 'open' }],
  };
  const VIA = {
    myField: 'site',
    parentField: 'key',
    parentItemId: ITEM_ID,
    parentLayerId: 'sites',
  };

  it('passes the attribute predicate through', async () => {
    const { service, mvtTile } = makeTiler();
    await service.mvtTile(ITEM_ID, LAYER_ID, 9, 141, 194, { where: WHERE });
    expect(mvtTile.mock.calls[0]![0]).toMatchObject({ where: WHERE });
  });

  it('passes the relate through', async () => {
    const { service, mvtTile } = makeTiler();
    await service.mvtTile(ITEM_ID, LAYER_ID, 9, 141, 194, { via: VIA });
    expect(mvtTile.mock.calls[0]![0]).toMatchObject({ via: VIA });
  });

  it('omits both keys entirely when neither is given', async () => {
    // exactOptionalPropertyTypes: an explicit `undefined` is not the
    // same as an absent key, and the engine branches on `!== undefined`.
    const { service, mvtTile } = makeTiler();
    await service.mvtTile(ITEM_ID, LAYER_ID, 9, 141, 194, {});
    const args = mvtTile.mock.calls[0]![0] as object;
    expect('where' in args).toBe(false);
    expect('via' in args).toBe(false);
  });

  it('carries every option in the same call', async () => {
    const { service, mvtTile } = makeTiler();
    await service.mvtTile(ITEM_ID, LAYER_ID, 9, 141, 194, {
      isTable: true,
      fields: [{ name: 'status', type: 'text' }],
      ownRowsOnly: { userId: 'user-1' },
      where: WHERE,
      via: VIA,
    });
    expect(mvtTile.mock.calls[0]![0]).toEqual({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      z: 9,
      x: 141,
      y: 194,
      isTable: true,
      fields: [{ name: 'status', type: 'text' }],
      ownRowsOnly: { userId: 'user-1' },
      where: WHERE,
      via: VIA,
    });
  });
});
