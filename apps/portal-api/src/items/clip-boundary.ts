// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUuid } from '@gratis-gis/engine';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SharingService } from './sharing.service.js';

/**
 * Resolve the geo_boundary item a read names as its clip (`?clip=`,
 * #34) and return its geometry, or null for "no clip".
 *
 * The clip is layer content scope that a map author picks, so the
 * caller does not need read access to the boundary itself. The
 * boundary must still belong with the layer: the caller can read it,
 * or it is in the same org as the layer being read. Anything else is
 * treated like a missing boundary.
 *
 * Also null when the id is not a UUID, the item is missing, trashed,
 * the wrong type, or has no geometry yet, so a stale layer config
 * never blocks a read.
 *
 * `layer.orgId` saves a lookup when the caller already has the layer
 * row; without it the layer's org is read only when needed.
 */
export async function resolveClipBoundaryGeometry(
  deps: {
    prisma: Pick<PrismaService, 'item'>;
    sharing: Pick<SharingService, 'canRead'>;
  },
  user: AuthUser,
  layer: { id: string; orgId?: string },
  boundaryItemId: string | null | undefined,
): Promise<object | null> {
  if (!boundaryItemId || !isUuid(boundaryItemId)) return null;
  const row = await deps.prisma.item.findFirst({
    where: { id: boundaryItemId, type: 'geo_boundary', deletedAt: null },
    include: { shares: true },
  });
  if (!row) return null;
  if (!deps.sharing.canRead(user, row, row.shares)) {
    const layerOrgId =
      layer.orgId ??
      (
        await deps.prisma.item.findUnique({
          where: { id: layer.id },
          select: { orgId: true },
        })
      )?.orgId;
    if (!layerOrgId || layerOrgId !== row.orgId) return null;
  }
  const geom = (row.data as { geometry?: unknown } | null)?.geometry;
  if (!geom || typeof geom !== 'object') return null;
  return geom;
}
