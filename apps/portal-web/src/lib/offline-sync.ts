// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *   - **Retry policy.** A transient failure (network, 5xx, expired
 *     session, rate limit) marks the record 'failed', keeping its
 *     failureReason + retryCount, and the next sync run picks it up
 *     again. A deterministic refusal (validator 400, sharing 403, a
 *     409, and other 4xx) marks it 'rejected' instead: the same bytes
 *     would get the same answer, so no drain retries it. The runtime
 *     shows rejected records with their reason and offers retry
 *     (`retryRejected`, back to 'pending') or discard
 *     (`discardRejected`). The split lives in shared-types
 *     `replayOutcomeForStatus` so it is unit tested. This module does
 *     NOT exponential-back-off internally; callers throttle at the
 *     trigger level (auto-sync-on-online + manual "Sync now" button)
 *     which is enough in practice.
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
import { parseApiError } from './api-error';
import { replayOutcomeForStatus } from '@gratis-gis/shared-types';

/**
 * Outcome of a single sync run. `processed` includes successes,
 * transient failures and rejections; `synced` is the slice that made
 * it to the server. `remaining` is what's still retryable (pending or
 * failed) when the run ends; `rejected` counts the parked rows, both
 * from this run and earlier ones, since they need a person either way.
 */
export interface SyncResult {
  processed: number;
  synced: number;
  failed: number;
  rejected: number;
  remaining: number;
  errors: Array<{
    recordId: string;
    op: QueueRecord['op'];
    layerLabel: string;
    reason: string;
    terminal: boolean;
  }>;
}

/**
 * Thrown by replayRecord when the server refused the edit for a
 * reason a retry cannot change. syncQueue parks the row instead of
 * marking it failed.
 */
class ReplayRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayRejected';
  }
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
  // Reclaim rows stranded in 'syncing' by a page that died between
  // marking a record 'syncing' and writing its result. The service
  // worker replay does this too, but Background Sync is Chromium-only,
  // so on Firefox / Safari this in-app drain is the only replay path
  // and must reclaim them itself, or the edit is stuck (and not even
  // counted as remaining) until the user re-enqueues. Only rows older
  // than the stale window are reclaimed so a concurrent drain's
  // in-flight record is left alone. Replays are idempotent server-side
  // (client globalId + advisory-lock dedupe), so a reclaim at worst
  // causes a harmless retry.
  const STALE_SYNCING_MS = 60_000;
  const staleCutoff = Date.now() - STALE_SYNCING_MS;
  const stranded = await listQueueByStatus(dataCollectionId, 'syncing');
  for (const record of stranded) {
    const attemptedAt = record.lastAttemptAt
      ? Date.parse(record.lastAttemptAt)
      : 0;
    if (!Number.isFinite(attemptedAt) || attemptedAt < staleCutoff) {
      await updateQueueRecord({ ...record, syncStatus: 'pending' });
    }
  }

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
    rejected: 0,
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
      const terminal = err instanceof ReplayRejected;
      await updateQueueRecord({
        ...record,
        syncStatus: terminal ? 'rejected' : 'failed',
        failureReason: reason,
        retryCount: (record.retryCount ?? 0) + 1,
      });
      if (terminal) result.rejected += 1;
      else result.failed += 1;
      result.errors.push({
        recordId: record.id,
        op: record.op,
        layerLabel: record.layerKey,
        reason,
        terminal,
      });
    }
    result.processed += 1;
    opts.onProgress?.(result.processed, todo.length);
  }
  // Re-count what's still queued (in case parallel runs added new
  // pending records during this drain). Rejected rows are reported
  // as their own total rather than folded into `remaining`: nothing
  // automatic will ever clear them.
  const stillPending = await listQueueByStatus(dataCollectionId, 'pending');
  const stillFailed = await listQueueByStatus(dataCollectionId, 'failed');
  const allRejected = await listQueueByStatus(dataCollectionId, 'rejected');
  result.remaining = stillPending.length + stillFailed.length;
  result.rejected = allRejected.length;
  return result;
}

/** Rows parked by a deterministic server refusal, oldest first. */
export async function listRejected(dataCollectionId: string): Promise<QueueRecord[]> {
  const rows = await listQueueByStatus(dataCollectionId, 'rejected');
  return rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * Put a rejected row back in line for the next sync. The reason and
 * attempt count are kept so the runtime can still show why it was
 * parked if the server says no again.
 */
export async function retryRejected(record: QueueRecord): Promise<void> {
  if (record.syncStatus !== 'rejected') return;
  await updateQueueRecord({ ...record, syncStatus: 'pending' });
}

/** Drop a rejected row. The edit is gone; nothing reaches the server. */
export async function discardRejected(record: QueueRecord): Promise<void> {
  if (record.syncStatus !== 'rejected') return;
  await deleteQueueRecord(record.dataCollectionId, record.id);
}

/**
 * Replay a single queue record against the live API. Throws on any
 * non-2xx response; the caller (syncQueue) translates a ReplayRejected
 * into a 'rejected' row and anything else into 'failed'.
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
    await throwIfNotOk(res, 'POST', r.op);
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
    await throwIfNotOk(res, 'PATCH', r.op);
    return;
  }
  if (r.op === 'delete') {
    const res = await fetch(`${layerPath}/${r.globalId}`, {
      method: 'DELETE',
    });
    // A 404 here is classified as done by replayOutcomeForStatus: the
    // feature is already gone server-side (perhaps because a prior
    // sync succeeded but its response was lost).
    await throwIfNotOk(res, 'DELETE', r.op);
    return;
  }
  // Unknown op (the type union is exhausted above, so only a row
  // written by a newer client could get here). Park it: retrying
  // cannot teach this build a new op.
  throw new ReplayRejected(`Unknown queue op: ${(r as { op: string }).op}`);
}

async function throwIfNotOk(
  res: Response,
  verb: string,
  op: QueueRecord['op'],
): Promise<void> {
  const outcome = replayOutcomeForStatus(res.status, op);
  if (outcome === 'done') return;
  // The message lands in the queue row's failureReason and on the
  // sync screen. A refused write now usually means the schema
  // validator said no, and its sentence names the field; the raw JSON
  // envelope around it does not help anyone in the field.
  const reason = await parseApiError(res, `${verb} failed`);
  if (outcome === 'rejected') throw new ReplayRejected(reason);
  throw new Error(reason);
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
