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
});
