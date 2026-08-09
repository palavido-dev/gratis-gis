// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * Fail-open on a broken reference is deliberate and mirrors
 * `geoLimitFor` (sharing.service.ts, "missing / wrong type / empty"
 * sets hasUnrestrictedPath): a boundary item that was deleted or has
 * no geometry yet resolves to no clip rather than to an empty result.
 * Diverging here would make the public surface stricter than the
 * authenticated one for the same item, which is its own bug class.
 * Whether that fail-open is the right default at all is a live
 * question, but it belongs to both paths at once, not to this one.
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
  return geom && typeof geom === 'object' ? geom : undefined;
}

/** The select fragment every public data_layer lookup needs. */
export const PUBLIC_TIER_SELECT = { publicGeoBoundaryId: true } as const;
