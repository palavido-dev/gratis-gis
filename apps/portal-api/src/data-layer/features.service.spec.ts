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
