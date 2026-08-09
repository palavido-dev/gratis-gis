// SPDX-License-Identifier: AGPL-3.0-or-later
import { publicTierGeoLimit } from './public-geo-limit.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The public mirrors gate on `access: 'public'` in their where clause
 * instead of going through SharingService, so they never saw
 * item.publicGeoBoundaryId (#80). An owner who clipped a public layer
 * to one county got the clip on the authenticated read and the whole
 * layer on /api/public/... , which also meant a signed-in reader who
 * was being clipped could bypass their own clip by calling the public
 * mirror.
 */
describe('publicTierGeoLimit', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };

  function prismaWith(row: unknown): PrismaService {
    return {
      item: { findFirst: jest.fn().mockResolvedValue(row) },
    } as unknown as PrismaService;
  }

  it('returns the boundary geometry when the reference resolves', async () => {
    const prisma = prismaWith({ data: { geometry } });
    await expect(publicTierGeoLimit(prisma, 'boundary-1')).resolves.toEqual(
      geometry,
    );
  });

  it('scopes the lookup to a live geo_boundary item', async () => {
    const prisma = prismaWith({ data: { geometry } });
    await publicTierGeoLimit(prisma, 'boundary-1');
    expect(prisma.item.findFirst).toHaveBeenCalledWith({
      where: { id: 'boundary-1', type: 'geo_boundary', deletedAt: null },
      select: { data: true },
    });
  });

  it('is a no-op when the item carries no tier boundary', async () => {
    // The common case: most public layers are not clipped at all, and
    // this must not cost a query.
    const prisma = prismaWith(null);
    for (const v of [null, undefined, '']) {
      await expect(publicTierGeoLimit(prisma, v)).resolves.toBeUndefined();
    }
    expect(prisma.item.findFirst).not.toHaveBeenCalled();
  });

  it('fails open on a broken reference, matching geoLimitFor', async () => {
    // sharing.service.ts treats missing / wrong-type / geometry-less as
    // hasUnrestrictedPath. Diverging here would make the public surface
    // stricter than the authenticated one for the same item. If that
    // fail-open is ever revisited, both paths change together.
    for (const row of [null, {}, { data: null }, { data: {} }, { data: { geometry: null } }]) {
      await expect(
        publicTierGeoLimit(prismaWith(row), 'boundary-1'),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects a non-object geometry rather than passing it downstream', async () => {
    // A string here would reach the engine's ST_Intersects arg.
    await expect(
      publicTierGeoLimit(prismaWith({ data: { geometry: 'POLYGON(...)' } }), 'b'),
    ).resolves.toBeUndefined();
  });
});
