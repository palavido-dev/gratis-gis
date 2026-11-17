// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';

/**
 * Buckets per scope for the advisory locks that serialise online
 * writes to the same entity. Same count as the COPY path's
 * APPEND_LOCK_BUCKETS, with its own key namespace.
 */
export const FEATURE_WRITE_LOCK_BUCKETS = 64;

/**
 * One statement that takes the advisory locks for a set of
 * (scope, entity) pairs: one lock per entity BUCKET, not per entity.
 *
 * Postgres keeps advisory locks in the shared lock table, about
 * max_locks_per_transaction x max_connections entries (6,400 by
 * default) for the whole server. A per-entity lock let one 10,000-row
 * Calculate Field, or two 5,000-feature POSTs at once, fill it and
 * fail with "out of shared memory" (the COPY path hit the same wall
 * and moved to buckets first). Two writes of the same entity still
 * share a bucket and so still wait for each other; unrelated entities
 * in the same bucket just wait too. Keys are taken in ascending order
 * inside one statement, so overlapping batches cannot deadlock.
 *
 * Every online path that guards a write per entity must use this, so
 * they all agree on the key for a given entity.
 *
 * Run with $executeRaw: pg_advisory_xact_lock returns void, which the
 * driver adapter cannot deserialise.
 */
export function featureWriteLocksSql(
  scopes: readonly string[],
  entities: readonly string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(k)
    FROM (
      SELECT DISTINCT hashtextextended(
        'feature-write|' || u.s || '|' ||
          (hashtextextended(u.e, 0) & ${FEATURE_WRITE_LOCK_BUCKETS - 1}::bigint)::text,
        0
      ) AS k
      FROM unnest(${[...scopes]}::text[], ${[...entities]}::text[]) AS u(s, e)
      ORDER BY 1
    ) locks
  `;
}
