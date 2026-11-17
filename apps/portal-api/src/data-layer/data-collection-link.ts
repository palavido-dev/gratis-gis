// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { extractDependencies } from '../items/dependency-extractor.js';
import type { ItemsService } from '../items/items.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Resolve the `x-data-collection-id` header on a feature append.
 *
 * The header only decides who gets a "feature created" notification,
 * but it comes from the client. Trusting it let any editor of any
 * layer make the server notify (and email) the owner of an arbitrary
 * data_collection, with text taken from the posted properties. It is
 * honoured only when the caller can read the data_collection and the
 * data_collection's map shows the layer being written.
 */
export async function linkedDataCollection(
  prisma: Pick<PrismaService, 'item'>,
  items: Pick<ItemsService, 'get'>,
  user: AuthUser,
  dataCollectionId: string,
  dataLayerId: string,
): Promise<{ id: string; title: string; ownerId: string } | null> {
  let dc: Awaited<ReturnType<ItemsService['get']>>;
  try {
    // Applies canRead and hides items the caller cannot see.
    dc = await items.get(user, dataCollectionId);
  } catch {
    return null;
  }
  if (dc.type !== 'data_collection') return null;
  const mapId = (dc.data as { mapId?: unknown } | null)?.mapId;
  if (typeof mapId !== 'string' || mapId.length === 0) return null;
  const map = await prisma.item.findUnique({
    where: { id: mapId },
    select: { type: true, data: true, deletedAt: true },
  });
  if (!map || map.deletedAt !== null || map.type !== 'map') return null;
  const deps = extractDependencies({ type: 'map', data: map.data });
  if (!deps.itemIds.includes(dataLayerId)) return null;
  return { id: dc.id, title: dc.title, ownerId: dc.ownerId };
}
