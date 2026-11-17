// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '@prisma/client';
import {
  type BufferParams,
  type BufferStep,
  type DerivedLayerData,
  type FeatureField,
  type ToolStep,
} from '@gratis-gis/shared-types';

import {
  DerivedLayerCacheRefreshService,
  growCachedCaps,
} from './cache-refresh.service.js';

/**
 * Narrow a generic ToolStep down to its BufferParams. The ToolStep
 * union now spans a dozen tool kinds, several of which carry no
 * `mode` discriminator at all, so accessing `step.params.mode` from
 * outside this narrowing is a TS error. The tests below use this
 * helper to assert "this step is a buffer" once and then read the
 * buffer-specific params freely.
 */
function bufferParamsOf(step: ToolStep): BufferParams {
  if (step.tool !== 'buffer') {
    throw new Error(`expected a buffer step; got ${step.tool}`);
  }
  return step.params;
}

const NUMBER_FIELD: FeatureField = {
  name: 'radius_m',
  label: 'Radius (m)',
  type: 'number',
  nullable: true,
};

function fieldStep(
  field: string,
  unit: 'meters' | 'kilometers' | 'feet' | 'yards' | 'miles',
  cachedMaxMeters: number,
): BufferStep {
  return {
    tool: 'buffer',
    params: { mode: 'field', field, unit, cachedMaxMeters },
  };
}

function fixedStep(distance: number): BufferStep {
  return {
    tool: 'buffer',
    params: { mode: 'fixed', distance, unit: 'meters' },
  };
}

function recipe(pipeline: BufferStep[]): DerivedLayerData {
  return {
    version: 1,
    source: { kind: 'data_layer', itemId: 'src-1' },
    pipeline,
    featureLimit: 1000,
    outputSchema: [NUMBER_FIELD],
    bbox: [-122.5, 37.5, -122.0, 38.0],
  };
}

describe('growCachedCaps', () => {
  it('returns null when no buffer step needs to grow', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 500)]);
    expect(growCachedCaps(r, [{ radius_m: 100 }])).toBeNull();
  });

  it('returns null when the recipe has no field-mode buffer step', () => {
    const r = recipe([fixedStep(100)]);
    expect(growCachedCaps(r, [{ radius_m: 1_000_000 }])).toBeNull();
  });

  it('returns null when the changed key is not the buffer field', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 500)]);
    expect(growCachedCaps(r, [{ unrelated: 9999 }])).toBeNull();
  });

  it('grows the cap when a payload value exceeds it', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 100)]);
    const next = growCachedCaps(r, [{ radius_m: 250 }]);
    expect(next).not.toBeNull();
    const params = bufferParamsOf(next!.pipeline[0]!);
    expect(params.mode === 'field' ? params.cachedMaxMeters : null).toBe(250);
  });

  it('uses the largest value across the batch of payloads', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 100)]);
    const next = growCachedCaps(r, [
      { radius_m: 150 },
      { radius_m: 999 },
      { radius_m: 50 },
    ]);
    const params = bufferParamsOf(next!.pipeline[0]!);
    expect(params.mode === 'field' ? params.cachedMaxMeters : null).toBe(999);
  });

  it('converts the payload value through the recipe unit', () => {
    // Recipe stores radius in feet; payload value is 1000 ft = 304.8 m.
    const r = recipe([fieldStep('radius_m', 'feet', 100)]);
    const next = growCachedCaps(r, [{ radius_m: 1000 }]);
    const params = bufferParamsOf(next!.pipeline[0]!);
    if (params.mode !== 'field') throw new Error('expected field mode');
    expect(params.cachedMaxMeters).toBeCloseTo(304.8, 4);
  });

  it('clamps the grown cap to MAX_BUFFER_DISTANCE_METERS', () => {
    // 100 km recipe unit, payload 1000 km = 1_000_000 m, ceiling 100_000 m.
    const r = recipe([fieldStep('radius_m', 'kilometers', 50_000)]);
    const next = growCachedCaps(r, [{ radius_m: 1000 }]);
    const params = bufferParamsOf(next!.pipeline[0]!);
    if (params.mode !== 'field') throw new Error('expected field mode');
    expect(params.cachedMaxMeters).toBe(100_000);
  });

  it('does not rewrite a cap already at the ceiling for an oversized value', () => {
    const r = recipe([fieldStep('radius_m', 'kilometers', 100_000)]);
    expect(growCachedCaps(r, [{ radius_m: 1000 }])).toBeNull();
  });

  it('ignores null, missing, and non-numeric values', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 100)]);
    expect(
      growCachedCaps(r, [
        { radius_m: null },
        { radius_m: 'unknown' },
        {},
      ]),
    ).toBeNull();
  });

  it('coerces numeric strings ("250") to numbers', () => {
    const r = recipe([fieldStep('radius_m', 'meters', 100)]);
    const next = growCachedCaps(r, [{ radius_m: '250' }]);
    const params = bufferParamsOf(next!.pipeline[0]!);
    expect(params.mode === 'field' ? params.cachedMaxMeters : null).toBe(250);
  });

  it('only grows the steps that are field-mode and matched on the changed key', () => {
    // Two buffer steps in the pipeline: one fixed, one field. Only
    // the field one should grow.
    const r = recipe([fixedStep(50), fieldStep('radius_m', 'meters', 100)]);
    const next = growCachedCaps(r, [{ radius_m: 250 }]);
    expect(next).not.toBeNull();
    expect(next!.pipeline[0]!.params).toEqual({
      mode: 'fixed',
      distance: 50,
      unit: 'meters',
    });
    const second = bufferParamsOf(next!.pipeline[1]!);
    if (second.mode !== 'field') throw new Error('expected field mode');
    expect(second.cachedMaxMeters).toBe(250);
  });
});

describe('DerivedLayerCacheRefreshService.notifySourceWrite', () => {
  function makeFakePrisma(opts: {
    dependents: Array<Pick<Item, 'id' | 'data'>>;
    sourceBbox?: number[];
    sourceOrgId?: string;
  }) {
    const updates: Array<{ where: unknown; data: unknown }> = [];
    // findMany is called with the orgId-scoped where clause now.
    // The stub returns the fixture rows verbatim; assertions on
    // org-scoping live in dedicated tests below.
    const findMany = jest.fn(async () => opts.dependents);
    // The service loads {orgId, bbox} from the source upfront so it
    // can scope the dependent search to the same tenant; the stub
    // returns both shapes so individual tests don't have to.
    const findUnique = jest.fn(async () => ({
      orgId: opts.sourceOrgId ?? 'org-1',
      bbox: opts.sourceBbox ?? [-122.5, 37.5, -122.0, 38.0],
    }));
    const update = jest.fn(async (args: unknown) => {
      updates.push(args as { where: unknown; data: unknown });
      return {};
    });
    // The write runs under the item lock; the locked read returns the
    // same fixture row, so these tests see no concurrent change.
    const tx = {
      $queryRaw: jest.fn(async (_strings: TemplateStringsArray, id: string) => {
        const row = opts.dependents.find((d) => d.id === id);
        return row ? [{ data: row.data, updated_at_ms: 1 }] : [];
      }),
      item: { update },
    };
    const prisma = {
      item: { findMany, findUnique, update },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    // Cast through unknown to the constructor parameter type so
    // PrismaService's massive type doesn't bleed into the test
    // fixture. We only call `prisma.item.{findMany, findUnique,
    // update}` from the service so the narrow stub above is
    // sufficient at runtime.
    return {
      updates,
      findMany,
      findUnique,
      update,
      prisma: prisma as unknown as ConstructorParameters<
        typeof DerivedLayerCacheRefreshService
      >[0],
    };
  }

  it('writes an update when a payload value exceeds the cached cap', async () => {
    const dep = {
      id: 'der-1',
      data: recipe([fieldStep('radius_m', 'meters', 100)]) as unknown as Item['data'],
    };
    const { prisma, updates } = makeFakePrisma({ dependents: [dep] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 250 }]);
    expect(updates).toHaveLength(1);
    const u = updates[0]! as { where: { id: string }; data: { data: DerivedLayerData; bbox: number[] } };
    expect(u.where.id).toBe('der-1');
    const params = bufferParamsOf(u.data.data.pipeline[0]!);
    expect(params.mode === 'field' ? params.cachedMaxMeters : null).toBe(250);
    // bbox repad happens too: the new total reach is 250 m, so the
    // padded bbox is wider than the source bbox.
    expect(u.data.bbox[0]).toBeLessThan(-122.5);
  });

  it('skips dependents whose source.itemId does not match', async () => {
    const dep = {
      id: 'der-1',
      data: {
        ...recipe([fieldStep('radius_m', 'meters', 100)]),
        source: { kind: 'data_layer' as const, itemId: 'other-source' },
      } as unknown as Item['data'],
    };
    const { prisma, updates } = makeFakePrisma({ dependents: [dep] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 9999 }]);
    expect(updates).toHaveLength(0);
  });

  it('respects layerKey when matching a v3 source against a dependent', async () => {
    const dep = {
      id: 'der-1',
      data: {
        ...recipe([fieldStep('radius_m', 'meters', 100)]),
        source: { kind: 'data_layer' as const, itemId: 'src-1', layerKey: 'sites' },
      } as unknown as Item['data'],
    };
    const { prisma, updates } = makeFakePrisma({ dependents: [dep] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    // Write to a different sublayer: should not refresh.
    await svc.notifySourceWrite('src-1', 'other-sublayer', [{ radius_m: 9999 }]);
    expect(updates).toHaveLength(0);
    // Write to the matching sublayer: should refresh.
    await svc.notifySourceWrite('src-1', 'sites', [{ radius_m: 9999 }]);
    expect(updates).toHaveLength(1);
  });

  it('does nothing when properties is empty', async () => {
    const dep = {
      id: 'der-1',
      data: recipe([fieldStep('radius_m', 'meters', 100)]) as unknown as Item['data'],
    };
    const { prisma, updates, findMany } = makeFakePrisma({ dependents: [dep] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, []);
    expect(updates).toHaveLength(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('swallows errors from the database so a feature write is not rolled back', async () => {
    // findUnique throws now (it runs before findMany in the
    // refactored service). Whichever query fails first, the
    // service must swallow rather than propagate.
    const prisma = {
      item: {
        findUnique: jest.fn(async () => {
          throw new Error('oh no');
        }),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as ConstructorParameters<
      typeof DerivedLayerCacheRefreshService
    >[0];
    const svc = new DerivedLayerCacheRefreshService(prisma);
    // Must NOT throw.
    await expect(
      svc.notifySourceWrite('src-1', null, [{ radius_m: 250 }]),
    ).resolves.toBeUndefined();
  });

  it('scopes the dependents query to the source orgId', async () => {
    const dep = {
      id: 'der-1',
      data: recipe([fieldStep('radius_m', 'meters', 100)]) as unknown as Item['data'],
    };
    const { prisma, findMany } = makeFakePrisma({
      dependents: [dep],
      sourceOrgId: 'org-tenant-A',
    });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 250 }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    // jest.fn typed as a no-arg async function records calls as [][]
    // tuples; cast through unknown to read the actual where clause.
    const callArgs = findMany.mock.calls as unknown as Array<
      [{ where?: { orgId?: string } } | undefined]
    >;
    expect(callArgs[0]?.[0]?.where?.orgId).toBe('org-tenant-A');
  });

  it('matches the source id in the query instead of loading every recipe', async () => {
    const { prisma, findMany } = makeFakePrisma({ dependents: [] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 250 }]);
    const callArgs = findMany.mock.calls as unknown as Array<
      [{ where?: { data?: unknown } } | undefined]
    >;
    expect(callArgs[0]?.[0]?.where?.data).toEqual({
      path: ['source', 'itemId'],
      equals: 'src-1',
    });
  });

  it('returns silently when the source has been deleted', async () => {
    const prisma = {
      item: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as ConstructorParameters<
      typeof DerivedLayerCacheRefreshService
    >[0];
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await expect(
      svc.notifySourceWrite('src-gone', null, [{ radius_m: 250 }]),
    ).resolves.toBeUndefined();
    // findMany must NOT run when the source is missing -- there's
    // nothing useful to scope against.
    expect(
      (prisma as unknown as { item: { findMany: jest.Mock } }).item.findMany,
    ).not.toHaveBeenCalled();
  });

  it('updates several dependents in one call when each crosses its cap', async () => {
    const a = {
      id: 'der-a',
      data: recipe([fieldStep('radius_m', 'meters', 100)]) as unknown as Item['data'],
    };
    const b = {
      id: 'der-b',
      data: recipe([fieldStep('radius_m', 'kilometers', 0.05)]) as unknown as Item['data'],
    };
    const { prisma, updates } = makeFakePrisma({ dependents: [a, b] });
    const svc = new DerivedLayerCacheRefreshService(prisma);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 250 }]);
    expect(updates).toHaveLength(2);
    const ids = updates.map((u) => (u.where as { id: string }).id).sort();
    expect(ids).toEqual(['der-a', 'der-b']);
  });
});

describe('DerivedLayerCacheRefreshService.notifySourceWrite under the item lock', () => {
  it('grows the cap on the recipe as it is under the lock, not the stale list read', async () => {
    const stale = recipe([fieldStep('radius_m', 'meters', 500)]);
    // A recipe PATCH saved after findMany: new field limit and an
    // extra fixed step. The refresh must keep both.
    const current: DerivedLayerData = {
      ...recipe([fieldStep('radius_m', 'meters', 500), fixedStep(10)]),
      featureLimit: 50,
    };
    const update = jest.fn(async () => undefined);
    const tx = {
      $queryRaw: jest.fn(async () => [{ data: current, updated_at_ms: 1 }]),
      item: { update },
    };
    const prisma = {
      item: {
        findUnique: jest.fn(async () => ({ orgId: 'org-1', bbox: [-122.5, 37.5, -122.0, 38.0] })),
        findMany: jest.fn(async () => [{ id: 'dl-1', data: stale }]),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const svc = new DerivedLayerCacheRefreshService(prisma as never);
    await svc.notifySourceWrite('src-1', null, [{ radius_m: 900 }]);

    expect(update).toHaveBeenCalledTimes(1);
    const written = (update.mock.calls[0] as unknown as [{ data: { data: DerivedLayerData } }])[0]
      .data.data;
    expect(written.featureLimit).toBe(50);
    expect(written.pipeline).toHaveLength(2);
    expect(bufferParamsOf(written.pipeline[0]!)).toMatchObject({ cachedMaxMeters: 900 });
  });
});
