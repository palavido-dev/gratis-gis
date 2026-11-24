// SPDX-License-Identifier: AGPL-3.0-or-later
import { ItemsService } from './items.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';
import { resolveClipBoundaryGeometry } from './clip-boundary.js';
import { ORG_A, ORG_B, makeAuthUser, makeItem } from '../testing/org-fixtures.js';

/**
 * Which boundary a `?clip=` read applies. A boundary counts when the
 * caller can read it or it is in the layer's org; otherwise the read
 * runs as if no clip was named. Same rule on the v3 feature routes and
 * the item-level GeoJSON read, including derived layers.
 */

const LAYER_A = '00000000-0000-4000-8000-0000000000a1';
const LAYER_B = '00000000-0000-4000-8000-0000000000b1';
const DERIVED_B = '00000000-0000-4000-8000-0000000000b2';
const BOUNDARY_A = '00000000-0000-4000-8000-0000000000a9';
const BOUNDARY_A_PUBLIC = '00000000-0000-4000-8000-0000000000a8';
const BOUNDARY_B = '00000000-0000-4000-8000-0000000000b9';

const POLY = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

const userA = makeAuthUser({ id: 'user-a-1', orgId: ORG_A, orgSlug: ORG_A });
const userB = makeAuthUser({ id: 'user-b-1', orgId: ORG_B, orgSlug: ORG_B });

function withShares<T>(item: T): T & { shares: unknown[] } {
  return { ...item, shares: [] };
}

function boundary(id: string, orgId: string, access: 'private' | 'org' | 'public') {
  return withShares(
    makeItem({
      id,
      orgId,
      ownerId: `owner-of-${id}`,
      type: 'geo_boundary' as never,
      access: access as never,
      data: { geometry: POLY } as never,
    }),
  );
}

function dataLayer(id: string, orgId: string, ownerId: string) {
  return withShares(
    makeItem({
      id,
      orgId,
      ownerId,
      data: { version: 2, storageType: 'postgis' } as never,
      ...({ orgGeoBoundaryId: null, publicGeoBoundaryId: null } as object),
    }),
  );
}

function derivedLayer(id: string, orgId: string, ownerId: string, sourceId: string) {
  return withShares(
    makeItem({
      id,
      orgId,
      ownerId,
      type: 'derived_layer' as never,
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: sourceId, layerKey: 'l' },
        pipeline: [],
        featureLimit: 100,
      } as never,
    }),
  );
}

const ITEMS: Record<string, unknown> = {
  [BOUNDARY_A]: boundary(BOUNDARY_A, ORG_A, 'private'),
  [BOUNDARY_A_PUBLIC]: boundary(BOUNDARY_A_PUBLIC, ORG_A, 'public'),
  [BOUNDARY_B]: boundary(BOUNDARY_B, ORG_B, 'private'),
  [LAYER_A]: dataLayer(LAYER_A, ORG_A, userA.id),
  [LAYER_B]: dataLayer(LAYER_B, ORG_B, userB.id),
};

function fakePrisma(items: Record<string, unknown>) {
  return {
    item: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; type?: string } }) => {
        const row = items[where.id] as { type?: string; deletedAt?: unknown } | undefined;
        if (!row || row.deletedAt != null) return null;
        if (where.type && row.type !== where.type) return null;
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => items[where.id] ?? null),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => items[id]).filter(Boolean),
      ),
    },
    itemShare: { findMany: async () => [] },
    $queryRawUnsafe: jest.fn(async () => []),
  };
}

const sharing = () => new SharingService(undefined as never, new PolicyService());

function service(layer: unknown, items: Record<string, unknown> = ITEMS) {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const prisma = fakePrisma(items);
  const derivedGetGeoJson = jest.fn(async () => ({
    type: 'FeatureCollection',
    features: [],
  }));
  Object.assign(svc, {
    get: jest.fn(async () => layer),
    prisma,
    sharing: sharing(),
    derivedLayers: { getGeoJson: derivedGetGeoJson },
  });
  return { svc, prisma, derivedGetGeoJson };
}

/** True when the read SQL carried the boundary polygon. */
function clipped(prisma: ReturnType<typeof fakePrisma>): boolean {
  const call = prisma.$queryRawUnsafe.mock.calls[0] as unknown as unknown[];
  return call.slice(1).includes(JSON.stringify(POLY));
}

describe('resolveClipBoundaryGeometry', () => {
  const deps = () => ({ prisma: fakePrisma(ITEMS) as never, sharing: sharing() });

  it('applies a boundary in the layer org that the caller cannot read', async () => {
    const geom = await resolveClipBoundaryGeometry(
      deps(),
      userB,
      { id: LAYER_B, orgId: ORG_B },
      BOUNDARY_B,
    );
    expect(geom).toEqual(POLY);
  });

  it('ignores an unreadable boundary from another org', async () => {
    const geom = await resolveClipBoundaryGeometry(
      deps(),
      userB,
      { id: LAYER_B, orgId: ORG_B },
      BOUNDARY_A,
    );
    expect(geom).toBeNull();
  });

  it('applies a public boundary from another org', async () => {
    const geom = await resolveClipBoundaryGeometry(
      deps(),
      userB,
      { id: LAYER_B, orgId: ORG_B },
      BOUNDARY_A_PUBLIC,
    );
    expect(geom).toEqual(POLY);
  });

  it('reads the layer org only when the caller cannot read the boundary', async () => {
    const d = deps();
    const prisma = d.prisma as unknown as ReturnType<typeof fakePrisma>;
    expect(await resolveClipBoundaryGeometry(d, userB, { id: LAYER_B }, BOUNDARY_B)).toEqual(POLY);
    expect(prisma.item.findUnique).toHaveBeenCalledTimes(1);
    expect(await resolveClipBoundaryGeometry(d, userB, { id: LAYER_B }, BOUNDARY_A)).toBeNull();
    prisma.item.findUnique.mockClear();
    expect(await resolveClipBoundaryGeometry(d, userB, { id: LAYER_B }, BOUNDARY_A_PUBLIC)).toEqual(
      POLY,
    );
    expect(prisma.item.findUnique).not.toHaveBeenCalled();
  });

  it('treats a malformed id as no clip without a lookup', async () => {
    const d = deps();
    expect(await resolveClipBoundaryGeometry(d, userB, { id: LAYER_B }, 'not-a-uuid')).toBeNull();
    expect(
      (d.prisma as unknown as ReturnType<typeof fakePrisma>).item.findFirst,
    ).not.toHaveBeenCalled();
  });
});

describe('item-level GeoJSON read with a boundary clip', () => {
  it('clips with a boundary in the same org (single org install)', async () => {
    const { svc, prisma } = service(ITEMS[LAYER_A]);
    await svc.getGeoJson(userA, LAYER_A, { boundaryClipId: BOUNDARY_A });
    expect(clipped(prisma)).toBe(true);
  });

  it('clips with an unreadable boundary in the layer org', async () => {
    const { svc, prisma } = service(ITEMS[LAYER_B]);
    await svc.getGeoJson(userB, LAYER_B, { boundaryClipId: BOUNDARY_B });
    expect(clipped(prisma)).toBe(true);
  });

  it('reads unclipped when the boundary is in another org and not readable', async () => {
    const { svc, prisma } = service(ITEMS[LAYER_B]);
    await svc.getGeoJson(userB, LAYER_B, { boundaryClipId: BOUNDARY_A });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(clipped(prisma)).toBe(false);
  });

  it('clips with a public boundary from another org', async () => {
    const { svc, prisma } = service(ITEMS[LAYER_B]);
    await svc.getGeoJson(userB, LAYER_B, { boundaryClipId: BOUNDARY_A_PUBLIC });
    expect(clipped(prisma)).toBe(true);
  });
});

describe('derived layer GeoJSON read with a boundary clip', () => {
  const derived = derivedLayer(DERIVED_B, ORG_B, userB.id, LAYER_B);

  it('passes a same-org boundary geometry to the derived read', async () => {
    const { svc, derivedGetGeoJson } = service(derived);
    await svc.getGeoJson(userB, DERIVED_B, { boundaryClipId: BOUNDARY_B });
    const opts = (derivedGetGeoJson.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(opts.boundaryGeometry).toEqual(POLY);
    expect(opts).not.toHaveProperty('boundaryClipId');
  });

  it('passes no clip for an unreadable boundary from another org', async () => {
    const { svc, derivedGetGeoJson } = service(derived);
    await svc.getGeoJson(userB, DERIVED_B, { boundaryClipId: BOUNDARY_A });
    expect(derivedGetGeoJson).toHaveBeenCalledTimes(1);
    const opts = (derivedGetGeoJson.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('boundaryGeometry');
    expect(opts).not.toHaveProperty('boundaryClipId');
  });

  it('passes a public boundary geometry from another org', async () => {
    const { svc, derivedGetGeoJson } = service(derived);
    await svc.getGeoJson(userB, DERIVED_B, { boundaryClipId: BOUNDARY_A_PUBLIC });
    const opts = (derivedGetGeoJson.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(opts.boundaryGeometry).toEqual(POLY);
  });
});
