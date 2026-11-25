// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';

/**
 * The engine scopes of a v3 data layer item's sublayers and tables,
 * `data_layer:<itemId>:<layerId>`. Anything that is not a v3 data
 * layer has none: legacy layers keep their own tables.
 */
export function dataLayerScopes(itemId: string, data: unknown): string[] {
  const d = data as { version?: unknown; layers?: unknown } | null;
  if (!d || d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: string[] = [];
  for (const l of d.layers as Array<{ id?: unknown }>) {
    if (typeof l?.id === 'string' && l.id.length > 0) out.push(`data_layer:${itemId}:${l.id}`);
  }
  return out;
}

/**
 * Forget the ObjectIDs and FeatureServer layer numbers of a purged item. Run beside the
 * observation delete in item teardown, in the same transaction.
 */
export async function forgetItemOids(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  itemId: string,
): Promise<void> {
  const prefix = `data_layer:${itemId}:%`;
  await db.$executeRaw(Prisma.sql`DELETE FROM feature_oid WHERE scope LIKE ${prefix}`);
  await db.$executeRaw(Prisma.sql`DELETE FROM feature_oid_scope WHERE scope LIKE ${prefix}`);
  await db.$executeRaw(Prisma.sql`DELETE FROM featureserver_layer WHERE item_id = ${itemId}`);
}
