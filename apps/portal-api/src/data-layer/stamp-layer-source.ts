// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prisma } from '@prisma/client';

/** Provenance block written to `data.layers[].source` after an import. */
export interface V3LayerSourceStamp {
  fileName: string;
  format: string;
  sizeBytes: number;
  importedAt: string;
  importedBy: string;
  note?: string;
  sourceSrs?: string | null;
}

/** The slice of PrismaClient this helper needs. */
export interface StampLayerSourcePrisma {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Merge a `source` block onto one layer of a v3 data_layer item.
 *
 * ONE implementation, shared by the streaming ingest endpoint and the
 * import-jobs worker. Both used to read the whole `data` document and
 * write it all back without a lock. A syncVersion bump committed by
 * commitLayerSync or commitCopiedLayer in between was then overwritten
 * with the older value, the cursor went backwards, and delta clients
 * skipped edits for good.
 *
 * Now the row is re-read under the same `FOR UPDATE` lock those
 * writers take, and only `source` on the named layer changes. Every
 * other key on the current row, syncVersion included, is kept as is.
 *
 * Returns true when a write happened. Non-v3 items, missing items and
 * unknown layers are left untouched.
 */
export async function stampV3LayerSource(
  prisma: StampLayerSourcePrisma,
  itemId: string,
  layerId: string,
  source: V3LayerSourceStamp,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ data: unknown }>>`
      SELECT data_json AS data FROM item WHERE id = ${itemId}::uuid FOR UPDATE
    `;
    const current = locked[0]?.data as
      | { version?: number; layers?: Array<Record<string, unknown>> }
      | null
      | undefined;
    if (!current || current.version !== 3 || !Array.isArray(current.layers)) {
      return false;
    }
    let changed = false;
    const nextLayers = current.layers.map((layer) => {
      if ((layer as { id?: unknown }).id !== layerId) return layer;
      changed = true;
      return { ...layer, source };
    });
    if (!changed) return false;
    await tx.item.update({
      where: { id: itemId },
      data: {
        data: {
          ...(current as object),
          layers: nextLayers,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  });
}
