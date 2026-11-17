// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLOSED_GEO_LIMIT } from '../common/closed-geo-limit.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Resolve the clip polygon for a data_layer reached through the
 * PUBLIC access tier (#80, `item.public_geo_boundary_id`).
 *
 * Every anonymous mirror of a v3 read has to call this. The
 * authenticated path gets the same clip for free through
 * `SharingService.geoLimitFor`, which treats `access: 'public'` as a
 * real access path with its own tier boundary. The public mirrors
 * bypass SharingService entirely (they gate on `access: 'public'` in
 * the where clause instead), so without this they return the whole
 * layer for an item the owner deliberately clipped to a region "for
 * everyone on the internet", which is what the column is for.
 *
 * That was not only an anonymous problem: a signed-in reader who was
 * being clipped could simply call the /api/public mirror instead and
 * get the unclipped layer, so the tier boundary was advisory on every
 * caller.
 *
 * A configured boundary that is missing, the wrong type, or has no
 * geometry does not widen the public layer. Callers receive a closed
 * clip and the read matches no rows. The signed-in public tier uses
 * the same closed clip. No boundary id still means the layer is not
 * clipped.
 */
export async function publicTierGeoLimit(
  prisma: PrismaService,
  boundaryId: string | null | undefined,
): Promise<unknown | undefined> {
  if (typeof boundaryId !== 'string' || boundaryId.length === 0) {
    return undefined;
  }
  const row = await prisma.item.findFirst({
    where: { id: boundaryId, type: 'geo_boundary', deletedAt: null },
    select: { data: true },
  });
  const geom = (row?.data as { geometry?: unknown } | null)?.geometry;
  return geom && typeof geom === 'object' ? geom : CLOSED_GEO_LIMIT;
}

export const PUBLIC_BOUNDARY_WARNING =
  'The public geographic boundary is missing or has no geometry. Public readers see no features until you choose a boundary that still exists.';

/** The select fragment every public data_layer lookup needs. */
export const PUBLIC_TIER_SELECT = { publicGeoBoundaryId: true } as const;
