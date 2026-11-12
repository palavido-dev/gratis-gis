// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';

/**
 * A derived layer runs its inputs through SQL with no way to carry a
 * reader's own-rows or geo limit. A reader limited on any input must
 * get nothing, not the whole input: otherwise a geo-limited grantee
 * builds a 0 m buffer of the layer and reads every feature.
 */

const SOURCE = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b1';
const DERIVED = '00000000-0000-4000-8000-0000000000c1';
const POLY = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const reader = {
  id: 'reader',
  orgId: 'org-1',
  orgRole: 'contributor',
  groupIds: [],
};

function dataLayer(id: string, shares: unknown[]) {
  return {
    id,
    type: 'data_layer',
    orgId: 'org-1',
    ownerId: 'owner',
    access: 'private',
    deletedAt: null,
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
    data: { version: 3, storageType: 'postgis', layers: [{ id: 'l' }] },
    shares,
  };
}

function viewShare(extra: Record<string, unknown> = {}) {
  return {
    principalType: 'user',
    principalId: 'reader',
    permission: 'view',
    rowScope: 'all',
    editRowScope: null,
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    ...extra,
  };
}

function derivedItem(pipeline: unknown[] = []) {
  return {
    id: DERIVED,
    type: 'derived_layer',
    ownerId: 'reader',
    data: {
      version: 1,
      source: { kind: 'data_layer', itemId: SOURCE, layerKey: 'l' },
      pipeline,
      featureLimit: 50_000,
    },
  };
}

function service(items: Record<string, unknown>) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const derivedGetGeoJson = jest.fn(async () => ({
    type: 'FeatureCollection',
    features: [{ id: 'leaked' }],
  }));
  Object.assign(svc, {
    prisma: {
      item: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) => items[where.id] ?? null,
        ),
        findMany: jest.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.map((id) => items[id]).filter(Boolean),
        ),
      },
    },
    sharing: new SharingService(undefined as never, new PolicyService()),
    derivedLayers: { getGeoJson: derivedGetGeoJson },
  });
  return { svc, derivedGetGeoJson };
}

describe('derived layers honour the reader scope on their inputs', () => {
  it('a geo-limited reader of the source gets an empty collection', async () => {
    const { svc, derivedGetGeoJson } = service({
      [SOURCE]: dataLayer(SOURCE, [viewShare({ geoLimit: POLY })]),
    });
    (svc as unknown as { get: unknown }).get = jest.fn(async () => derivedItem());
    const fc = await svc.getGeoJson(reader as never, DERIVED);
    expect(fc.features).toEqual([]);
    expect(derivedGetGeoJson).not.toHaveBeenCalled();
  });

  it('an own-rows reader of an otherSource gets an empty collection', async () => {
    const { svc, derivedGetGeoJson } = service({
      [SOURCE]: dataLayer(SOURCE, [viewShare()]),
      [OTHER]: dataLayer(OTHER, [viewShare({ rowScope: 'own' })]),
    });
    (svc as unknown as { get: unknown }).get = jest.fn(async () =>
      derivedItem([
        {
          tool: 'clip',
          params: { otherSource: { kind: 'data_layer', itemId: OTHER } },
        },
      ]),
    );
    const fc = await svc.getGeoJson(reader as never, DERIVED);
    expect(fc.features).toEqual([]);
    expect(derivedGetGeoJson).not.toHaveBeenCalled();
  });

  it('an unscoped reader still gets the derived features', async () => {
    const { svc, derivedGetGeoJson } = service({
      [SOURCE]: dataLayer(SOURCE, [viewShare()]),
    });
    (svc as unknown as { get: unknown }).get = jest.fn(async () => derivedItem());
    const fc = await svc.getGeoJson(reader as never, DERIVED);
    expect(fc.features).toHaveLength(1);
    expect(derivedGetGeoJson).toHaveBeenCalledTimes(1);
  });

  it('the recipe preview refuses a scoped input', async () => {
    const { svc } = service({
      [SOURCE]: dataLayer(SOURCE, [viewShare({ geoLimit: POLY })]),
    });
    await expect(
      (svc as unknown as {
        assertDerivedInputsUnscoped: (u: unknown, d: unknown) => Promise<void>;
      }).assertDerivedInputsUnscoped(reader, derivedItem().data),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when the input walk hits its cap', async () => {
    // A chain longer than the walk cap with the limited source at the
    // far end: inputs past the cap were never checked, so the reader
    // gets nothing rather than the unchecked tail.
    const chain: Record<string, unknown> = {};
    const ids = Array.from(
      { length: 30 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    ids.forEach((id, i) => {
      const next = ids[i + 1];
      chain[id] = next
        ? {
            id,
            type: 'derived_layer',
            deletedAt: null,
            shares: [],
            data: {
              version: 1,
              source: { kind: 'derived_layer', itemId: next, layerKey: 'l' },
              pipeline: [],
            },
          }
        : dataLayer(id, [viewShare({ geoLimit: POLY })]);
    });
    const { svc } = service(chain);
    const limited = await (svc as unknown as {
      derivedInputScopeLimit: (u: unknown, d: unknown) => Promise<string | null>;
    }).derivedInputScopeLimit(reader, {
      source: { kind: 'derived_layer', itemId: ids[0], layerKey: 'l' },
      pipeline: [],
    });
    expect(limited).not.toBeNull();
  });

  it('a trashed leaf under a shared parent is refused, not skipped', async () => {
    // C over P over D. The reader holds P and C but never D. Once D is
    // in the trash the walk used to skip it and call the chain clean.
    const PARENT = '00000000-0000-4000-8000-0000000000d1';
    const { svc, derivedGetGeoJson } = service({
      [PARENT]: {
        id: PARENT,
        type: 'derived_layer',
        orgId: 'org-1',
        ownerId: 'owner',
        access: 'private',
        deletedAt: null,
        shares: [viewShare()],
        data: {
          version: 1,
          source: { kind: 'data_layer', itemId: SOURCE, layerKey: 'l' },
          pipeline: [],
        },
      },
      [SOURCE]: { ...dataLayer(SOURCE, []), deletedAt: new Date() },
    });
    const limited = await (svc as unknown as {
      derivedInputScopeLimit: (u: unknown, d: unknown) => Promise<string | null>;
    }).derivedInputScopeLimit(reader, {
      source: { kind: 'derived_layer', itemId: PARENT },
      pipeline: [],
    });
    expect(limited).toBe(SOURCE);
    expect(derivedGetGeoJson).not.toHaveBeenCalled();
  });

  it('a limited reader does not see the derived extent or buffer cap', async () => {
    const stored = {
      ...derivedItem([
        {
          tool: 'buffer',
          params: { mode: 'field', field: 'r', unit: 'm', cachedMaxMeters: 900 },
        },
      ]),
      access: 'private',
      orgId: 'org-1',
      deletedAt: null,
      shares: [],
      bbox: [10, 10, 20, 20],
    };
    (stored.data as Record<string, unknown>).bbox = [10, 10, 20, 20];
    const { svc } = service({
      [SOURCE]: dataLayer(SOURCE, [viewShare({ geoLimit: POLY })]),
      [DERIVED]: stored,
    });
    const got = (await svc.get(reader as never, DERIVED)) as unknown as {
      bbox: unknown;
      data: { bbox?: unknown; pipeline: Array<{ params: Record<string, unknown> }> };
    };
    expect(got.bbox).toEqual([]);
    expect(got.data.bbox).toBeUndefined();
    expect(got.data.pipeline[0]!.params.cachedMaxMeters).toBeUndefined();
    expect(got.data.pipeline[0]!.params.field).toBe('r');

    const rows = (await (svc as unknown as {
      redactLimitedDerivedRows: (u: unknown, r: unknown[]) => Promise<unknown[]>;
    }).redactLimitedDerivedRows(reader, [
      { id: DERIVED, type: 'derived_layer', bbox: [10, 10, 20, 20] },
    ])) as Array<{ bbox: unknown }>;
    expect(rows[0]!.bbox).toEqual([]);
  });
});
