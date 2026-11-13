// SPDX-License-Identifier: AGPL-3.0-or-later
import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { CLOSED_GEO_LIMIT } from '../common/closed-geo-limit.js';

/**
 * The item-level GET /items/:id/geojson route. It used to query a
 * per-sublayer fs_ table that v3 layers do not have (500), resolve the
 * reader scope without the layer's own-rows policy, and pass a closed
 * geo limit to ST_GeomFromGeoJSON.
 */

const reader = { id: 'reader', orgId: 'org-1', orgRole: 'contributor', groupIds: [] };

function share(extra: Record<string, unknown> = {}) {
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

function layer(data: unknown, shares: unknown[]) {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    type: 'data_layer',
    orgId: 'org-1',
    ownerId: 'owner',
    access: 'private',
    deletedAt: null,
    orgGeoBoundaryId: null,
    publicGeoBoundaryId: null,
    data,
    shares,
  };
}

function service(item: unknown, sharing?: Partial<SharingService>) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const $queryRawUnsafe = jest.fn(async () => []);
  const real = new SharingService(undefined as never, new PolicyService());
  Object.assign(svc, {
    get: jest.fn(async () => item),
    prisma: { $queryRawUnsafe, itemShare: { findMany: async () => [] } },
    sharing: Object.assign(real, sharing ?? {}),
  });
  return { svc, $queryRawUnsafe };
}

const FC = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: null, properties: { _created_by: 'reader' } },
    { type: 'Feature', geometry: null, properties: { _created_by: 'other' } },
  ],
};

describe('legacy item-level GeoJSON', () => {
  it('returns an empty collection for a v3 layer without querying', async () => {
    const { svc, $queryRawUnsafe } = service(
      layer({ version: 3, storageType: 'postgis', layers: [{ id: 'l', geometryType: 'point' }] }, [share()]),
    );
    const fc = await svc.getGeoJson(reader as never, 'x');
    expect(fc.features).toEqual([]);
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('applies the layer own-rows policy to a share grantee', async () => {
    const { svc } = service(
      layer({ version: 1, editingPolicy: 'own-rows-only', data: FC }, [share()]),
    );
    const fc = await svc.getGeoJson(reader as never, 'x');
    expect(fc.features).toHaveLength(1);
  });

  it('answers a closed geo limit with an empty collection', async () => {
    const { svc, $queryRawUnsafe } = service(
      layer({ version: 1, data: FC }, [share()]),
      {
        featureScopeFor: (async () => ({
          rowScope: 'all',
          geoLimit: CLOSED_GEO_LIMIT,
        })) as never,
      },
    );
    const fc = await svc.getGeoJson(reader as never, 'x');
    expect(fc.features).toEqual([]);
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('caps the rows at the requested limit (45-13)', async () => {
    const v1 = await service(layer({ version: 1, data: FC }, [share()])).svc.getGeoJson(
      reader as never,
      'x',
      { limit: 1 },
    );
    expect(v1.features).toHaveLength(1);

    const { svc, $queryRawUnsafe } = service(
      layer({ version: 2, storageType: 'postgis' }, [share()]),
    );
    await svc.getGeoJson(reader as never, '00000000-0000-4000-8000-0000000000a1', {
      limit: 500,
    });
    const call = $queryRawUnsafe.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(call[0]).toMatch(/LIMIT \$\d+/);
    expect(call.slice(1)).toContain(500);
  });
});
