/**
 * Drains the offline write queue against the live API. Slice 5 of the
 * Field Maps arc (#199) — the part that turns the runtime from
 * "offline-readable" into "offline-editable with eventual consistency."
 *
 * Pairs with offline-store's queue store: feature edits captured while
 * offline (or that failed online) land there as QueueRecord rows with
 * syncStatus='pending'. This module walks the pending/failed set,
 * replays each record's original API call, and updates each row's
 * status based on the outcome.
 *
 * Design notes:
 *
 *   - **Per-record isolation.** Each record syncs in its own try/catch.
 *     One stuck record never blocks the others; a 409 conflict on one
 *     edit doesn't strand a different layer's insert behind it.
 *
 *   - **Idempotent inserts.** Inserts carry a client-generated
 *     globalId so a re-drained queue (or a sync that succeeded
 *     server-side but lost the success response) doesn't double-create
 *     the feature. The portal-api v3 features service accepts the
 *     client-supplied globalId via the COALESCE($1::uuid,
 *     gen_random_uuid()) shape.
 *
 *   - **Retry policy.** Failed records keep their failureReason +
 *     retryCount and stay in the queue. The next sync run picks them
 *     up again. This module does NOT exponential-back-off internally;
 *     callers throttle at the trigger level (auto-sync-on-online +
 *     manual "Sync now" button) which is enough in practice.
 *
 *   - **No conflict resolution UI here.** That belongs to the runtime
 *     (it has the FormRuntime, the user, and the original record's
 *     view of the world). This module surfaces failures via
 *     QueueRecord.failureReason; the runtime renders them.
 *
 *   - **Best-effort ordering.** Pending records are drained in
 *     queuedAt order so the user's edits play back in roughly the
 *     same sequence the server would have seen had they been online.
 *     A single failed record doesn't pause the run; subsequent
 *     records still attempt. This means a delete that depends on a
 *     prior insert can in theory race; we accept that risk in v1
 *     because the alternative (full transaction-style ordering) adds
 *     significant complexity for an edge case that field workflows
 *     rarely hit.
 */

import {
  deleteQueueRecord,
  listQueueByStatus,
  updateQueueRecord,
  type QueueRecord,
} from './offline-store';

/**
 * Outcome of a single sync run. `processed` includes both successes
 * and failures; `synced` is the slice that made it to the server.
 * `remaining` is what's still in the queue (pending or failed) when
 * the run ends.
 */
export interface SyncResult {
  processed: number;
  synced: number;
  failed: number;
  remaining: number;
  errors: Array<{
    recordId: string;
    op: QueueRecord['op'];
    layerLabel: string;
    reason: string;
  }>;
}

/**
 * Drain the queue for a single deployment. Caller decides when to
 * fire (online-event listener, manual button, etc). Returns a
 * structured summary so the UI can render success / mixed-result /
 * all-failed states.
 *
 * The optional `onProgress` callback is invoked as each record
 * completes so a long sync (50+ records) can show a live counter.
 */
export async function syncQueue(
  dataCollectionId: string,
  opts: {
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<SyncResult> {
  // Pull both pending and previously-failed records. failed records
  // are intentional retries; the user pressing "Sync now" expects
  // them to be tried again. New records get queueStatus='pending' on
  // enqueue; the syncing intermediate state is set by this run only.
  const pending = await listQueueByStatus(dataCollectionId, 'pending');
  const failed = await listQueueByStatus(dataCollectionId, 'failed');
  const todo = [...pending, ...failed].sort((a, b) =>
    a.queuedAt.localeCompare(b.queuedAt),
  );
  const result: SyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };
  for (const record of todo) {
    // Mark syncing so a parallel run (rare but possible if the user
    // navigates away mid-sync) doesn't re-attempt the same record.
    await updateQueueRecord({
      ...record,
      syncStatus: 'syncing',
      lastAttemptAt: new Date().toISOString(),
    });
    try {
      await replayRecord(record);
      // Synced: drop from the queue. There's no archive; once it's on
      // the server the queue row's job is done. (The server-side
      // queue manifest mirror in Tier 4 of the resilience design is
      // a separate beacon, not a reconciliation log.)
      await deleteQueueRecord(record.dataCollectionId, record.id);
      result.synced += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await updateQueueRecord({
        ...record,
        syncStatus: 'failed',
        failureReason: reason,
        retryCount: (record.retryCount ?? 0) + 1,
      });
      result.failed += 1;
      result.errors.push({
        recordId: record.id,
        op: record.op,
        layerLabel: record.layerKey,
        reason,
      });
    }
    result.processed += 1;
    opts.onProgress?.(result.processed, todo.length);
  }
  // Re-count what's still queued (in case parallel runs added new
  // pending records during this drain).
  const stillPending = await listQueueByStatus(dataCollectionId, 'pending');
  const stillFailed = await listQueueByStatus(dataCollectionId, 'failed');
  result.remaining = stillPending.length + stillFailed.length;
  return result;
}

/**
 * Replay a single queue record against the live API. Throws on any
 * non-2xx response; the caller (syncQueue) translates that into a
 * 'failed' update on the queue row.
 *
 * The call shape mirrors what field-runtime's online write path does
 * directly, so behaviour stays consistent regardless of which path
 * the record took. Insert carries the client globalId so a successful
 * server-side write that lost its response doesn't double-create.
 */
async function replayRecord(r: QueueRecord): Promise<void> {
  const layerPath = `/api/portal/items/${r.dataLayerId}/layers/${encodeURIComponent(
    r.layerKey,
  )}/features`;
  if (r.op === 'insert') {
    const res = await fetch(layerPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        features: [
          {
            globalId: r.globalId,
            geometry: r.geometry,
            properties: r.properties ?? {},
          },
        ],
      }),
    });
    await throwIfNotOk(res, 'POST');
    return;
  }
  if (r.op === 'update') {
    const res = await fetch(`${layerPath}/${r.globalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: r.properties ?? {},
        ...(r.geometry !== null ? { geometry: r.geometry } : {}),
      }),
    });
    await throwIfNotOk(res, 'PATCH');
    return;
  }
  if (r.op === 'delete') {
    const res = await fetch(`${layerPath}/${r.globalId}`, {
      method: 'DELETE',
    });
    // 404 on delete is benign: the feature is already gone server-
    // side (perhaps because a prior sync succeeded but its response
    // was lost). Treat as success rather than blocking the queue
    // forever on a row that's effectively done.
    if (res.status === 404) return;
    await throwIfNotOk(res, 'DELETE');
    return;
  }
  // Unknown op (shouldn't happen — type union exhausted above). Fail
  // explicitly so the queue row gets flagged for admin attention.
  throw new Error(`Unknown queue op: ${(r as { op: string }).op}`);
}

async function throwIfNotOk(res: Response, verb: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${verb} failed (${res.status}): ${body || res.statusText}`);
}

/**
 * Generate a v4 UUID for the client-side globalId on a queued
 * insert. Cheap; uses crypto.randomUUID where available and falls
 * back to a Math.random-based RFC4122 shape on older browsers.
 *
 * Exposed here (rather than inline in the runtime) so tests can
 * deterministically stub it and so the queue + runtime use the
 * same generator.
 */
export function newGlobalId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback. Not cryptographically strong; only used on
  // very old browsers where crypto.randomUUID isn't available.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
