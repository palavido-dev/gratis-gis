// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prisma } from '@prisma/client';

/**
 * One way to read-modify-write an item's `data` (column `data_json`).
 *
 * Every writer that builds the next blob from the current one must
 * read the current one under the row lock, inside the transaction that
 * writes it. Otherwise two writers read the same version, both write,
 * and the second silently drops the first one's change. This is the
 * same lock commitLayerSync takes before it bumps a layer's
 * syncVersion, so data_layer writers also serialize with feature sync.
 */

/** The row as seen under the lock. */
export interface LockedItemRow {
  data: Prisma.JsonValue;
  /** `updated_at` in epoch milliseconds, comparable to Date#getTime. */
  updatedAtMs: number;
}

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Lock the item row (`SELECT ... FOR UPDATE`) and return its current
 * data. Must run inside a transaction. Null when the row is gone.
 */
export async function lockItemRow(
  tx: RawClient,
  id: string,
): Promise<LockedItemRow | null> {
  // updated_at is timestamp(3) holding UTC, which is how Prisma reads
  // it, so the epoch of the stored value is what Date#getTime returns
  // for item.updatedAt. extract() returns numeric, so the * 1000 and
  // round() are exact.
  const rows = await tx.$queryRaw<
    Array<{ data: Prisma.JsonValue; updated_at_ms: number | null }>
  >`
    SELECT data_json AS data,
           round(extract(epoch FROM updated_at) * 1000)::float8 AS updated_at_ms
    FROM item
    WHERE id = ${id}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;
  return { data: row.data, updatedAtMs: Number(row.updated_at_ms ?? NaN) };
}

/**
 * Run `fn` in a transaction with the item row locked and its current
 * data in hand. Whatever `fn` writes through `tx` commits with the lock
 * still held, so no other locked writer can interleave.
 */
export async function withLockedItem<T>(
  prisma: {
    $transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R>;
  },
  id: string,
  fn: (tx: Prisma.TransactionClient, row: LockedItemRow | null) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx, await lockItemRow(tx, id)));
}

/**
 * Pure half of carryLayerSyncVersions: keep the stored per-layer
 * syncVersion from `currentData` (read under the row lock) on every
 * layer of `next`, and drop whatever value `next` carried.
 */
export function carryLayerSyncVersionsFrom(
  currentData: unknown,
  next: Prisma.InputJsonValue,
): Prisma.InputJsonValue {
  const current = currentData as
    | { layers?: Array<{ id?: unknown; syncVersion?: unknown }> }
    | null
    | undefined;
  const incoming = next as { layers?: unknown };
  if (!current || !Array.isArray(incoming.layers)) return next;
  const stored = new Map<string, unknown>();
  for (const layer of current.layers ?? []) {
    if (typeof layer.id === 'string') stored.set(layer.id, layer.syncVersion);
  }
  const layers = (incoming.layers as Array<Record<string, unknown>>).map(
    (layer) => {
      if (!layer || typeof layer !== 'object') return layer;
      const layerId = layer.id;
      const { syncVersion: _clientValue, ...rest } = layer;
      void _clientValue;
      if (typeof layerId !== 'string' || !stored.has(layerId)) return rest;
      const keep = stored.get(layerId);
      return keep === undefined ? rest : { ...rest, syncVersion: keep };
    },
  );
  return { ...(next as object), layers } as Prisma.InputJsonValue;
}

/**
 * A map's markup (`drawings`) and its `allowAnonymousDrawings` flag
 * have their own write routes, which take the row lock. A map Save
 * sends the whole MapData from the browser, whose copy of the markup
 * can be stale, so writing it as is would drop sets other people
 * added since the editor loaded the map, or bring back ones they
 * deleted. Both keys always keep the stored value.
 */
export function carryMapDrawingsFrom(
  currentData: unknown,
  next: Prisma.InputJsonValue,
): Prisma.InputJsonValue {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next;
  const current = (currentData ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(next as Record<string, unknown>) };
  for (const key of ['drawings', 'allowAnonymousDrawings']) {
    if (current[key] === undefined) delete out[key];
    else out[key] = current[key];
  }
  return out as Prisma.InputJsonValue;
}

