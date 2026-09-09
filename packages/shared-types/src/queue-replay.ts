// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * When a queued offline edit may be replayed, and in what order.
 *
 * Two drains replay the same queue: the in-app one (portal-web
 * `offline-sync.ts`), which is the ONLY path on iOS and Firefox
 * because Background Sync is Chromium-only, and the service worker's
 * (`public/sw.js`), which runs with no tab open. They had drifted into
 * three separate disagreements, each of which is a real defect:
 *
 *   - Different stale-claim windows (60 s in-app, 120 s in the worker),
 *     so each could steal a row the other was mid-flight on.
 *   - No backoff at all. `retryCount` was incremented and never read,
 *     so a 500 was retried at full speed on every trigger forever.
 *   - No per-feature ordering. Since the queue can hold more than one
 *     outstanding edit per feature, an update could overtake the
 *     insert it depends on, take a 404, and park as terminally
 *     rejected: the same data loss the fold exists to prevent, arrived
 *     at from the other side.
 *
 * This module is the single answer to all three. The worker cannot
 * import it and mirrors it by hand; the mirror is marked there.
 */

/** Status values a queued row can hold. Mirrors QueueRecord in
 *  portal-web `offline-store.ts`. */
export type QueueSyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'rejected';

/** The fields replay policy reads. Both the app's QueueRecord and the
 *  worker's plain objects satisfy it. */
export interface ReplayableRow {
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  queuedAt: string;
  syncStatus: QueueSyncStatus;
  lastAttemptAt?: string;
  retryCount?: number;
}

/**
 * A row claimed ('syncing') this long ago is treated as abandoned by a
 * page that died mid-drain or a worker the browser killed, and becomes
 * claimable again. Two minutes comfortably exceeds one replay fetch.
 *
 * ONE value for both drains. When these differed, the shorter-windowed
 * drain would reclaim a row the longer-windowed one still had in
 * flight, and both would replay it. Server-side idempotency absorbed
 * the duplicate, which is exactly why the mismatch survived unnoticed.
 */
export const QUEUE_CLAIM_STALE_MS = 120_000;

/** Backoff ladder, indexed by how many times the row has already
 *  failed. Held flat rather than computed so the schedule is legible
 *  and testable: no wait on the first retry, then seconds, then
 *  minutes, capped so a row that will succeed after a long outage
 *  still retries within a shift. */
const RETRY_BACKOFF_MS = [
  0,
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
] as const;

/** How long a row must wait after `retryCount` failures. */
export function queueRetryDelayMs(retryCount: number | undefined): number {
  const n = typeof retryCount === 'number' && retryCount > 0 ? retryCount : 0;
  const capped = Math.min(n, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[capped]!;
}

export interface ClaimOptions {
  /**
   * Skip the backoff wait. Set when a person pressed "Sync now": they
   * are standing there watching, and making them wait out a ladder
   * they cannot see reads as the button being broken. Never set for
   * an automatic trigger, which is what the ladder is for.
   */
  ignoreBackoff?: boolean;
}

/**
 * Whether this row may be picked up right now.
 *
 * 'rejected' is terminal: the server refused deterministically and a
 * person has to fix or discard it. 'synced' should not be on disk at
 * all (a synced row is deleted) but is recognised for completeness.
 */
export function isQueueRowClaimable(
  row: ReplayableRow,
  nowMs: number,
  opts: ClaimOptions = {},
): boolean {
  if (row.syncStatus === 'rejected' || row.syncStatus === 'synced') {
    return false;
  }
  if (row.syncStatus === 'syncing') {
    // Only reclaimable once the claim has gone stale, so a drain
    // running right now keeps its row.
    const at = row.lastAttemptAt ? Date.parse(row.lastAttemptAt) : NaN;
    if (Number.isFinite(at) && nowMs - at < QUEUE_CLAIM_STALE_MS) return false;
    return true;
  }
  // pending or failed.
  if (opts.ignoreBackoff) return true;
  const delay = queueRetryDelayMs(row.retryCount);
  if (delay === 0) return true;
  const at = row.lastAttemptAt ? Date.parse(row.lastAttemptAt) : NaN;
  // Never attempted, or an unparseable timestamp: let it through
  // rather than stranding a row on a clock problem.
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= delay;
}

/** The one ownership field a queued row or pending file carries. Both
 *  the app's QueueRecord / PendingBlob and the worker's plain objects
 *  satisfy it. */
export interface OwnedRow {
  /** Portal user id of the account that captured this row. Absent on
   *  rows written before ownership existed (offline-store schema v2
   *  and earlier). */
  ownerUserId?: string;
}

/**
 * Whether the account signed in on this device may see, count, or send
 * this row.
 *
 * The queue survives sign-out on purpose (destroying unsynced field
 * work to tidy a cache is the worse outcome), which used to mean that
 * whoever signed in next replayed it under THEIR session: the server
 * stamps `submitted_by` from the caller, so one person's captures were
 * attributed to another. A row now records who captured it, and a
 * drain claims only rows that belong to the identity it is running as.
 *
 * A row with no owner predates ownership. It is treated as belonging to
 * whoever is current, because the alternative is stranding captures
 * that were made in good faith on a build that could not record who
 * made them; that population is finite and gone after its first sync.
 * With no identity at all (nobody has signed in on this device since
 * the store was created, or sign-out cleared it) only those legacy
 * rows are visible, so an owned row can never be sent under the wrong
 * account or under no account.
 *
 * MIRRORED by hand in portal-web/public/sw.js; sw-contract.spec.ts
 * compares the two.
 */
export function isQueueRowOwnedBy(
  row: OwnedRow,
  currentUserId: string | null,
): boolean {
  if (row.ownerUserId === undefined) return true;
  return currentUserId !== null && row.ownerUserId === currentUserId;
}

/** Features are identified by layer plus globalId; the same globalId
 *  under a different layer is a different feature. NUL is the separator
 *  because it cannot occur in any of the three ids, so no combination
 *  of ids can collide with another. */
function featureKey(row: ReplayableRow): string {
  return `${row.dataLayerId}\0${row.layerKey}\0${row.globalId}`;
}

/**
 * Pick the rows to replay this pass: at most ONE per feature, the
 * oldest, and only when that oldest row is itself claimable.
 *
 * The gate matters more than the ordering. If a feature's oldest row
 * is parked ('rejected') or in flight elsewhere ('syncing' and fresh),
 * every later row for that feature is skipped too. Replaying the later
 * one would send an update for a feature whose insert has not landed,
 * which 404s and parks a second row: one refused insert would cascade
 * into every subsequent edit of that feature being thrown away.
 *
 * Returned in queuedAt order across features, so replay still roughly
 * follows capture order.
 */
export function queueChainHeads<T extends ReplayableRow>(
  rows: T[],
  nowMs: number,
  opts: ClaimOptions = {},
): T[] {
  const oldestPerFeature = new Map<string, T>();
  for (const row of rows) {
    const key = featureKey(row);
    const held = oldestPerFeature.get(key);
    if (!held || row.queuedAt.localeCompare(held.queuedAt) < 0) {
      oldestPerFeature.set(key, row);
    }
  }
  return [...oldestPerFeature.values()]
    .filter((row) => isQueueRowClaimable(row, nowMs, opts))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}
