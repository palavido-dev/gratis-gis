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
 *     `replayOutcomeForStatus` so it is unit tested.
 *
 *   - **Backoff.** A failed row waits out a ladder before it is picked
 *     up again (shared-types `queueRetryDelayMs`), so a 500 is no
 *     longer retried at full speed on every trigger forever. A
 *     network-level failure is exempt: it means the radio is down, not
 *     that the row is bad, and charging it to the ladder would make a
 *     worker who just walked back into coverage wait. A person
 *     pressing "Sync now" passes `manual` and skips the wait.
 *
 *   - **Per-feature ordering.** The queue can hold more than one
 *     outstanding edit for a feature, so each pass replays only that
 *     feature's OLDEST claimable row, and skips the feature entirely
 *     while its oldest row is parked or in flight. Without that, an
 *     update overtakes the insert it depends on, 404s, and parks as
 *     terminally rejected. `queueChainHeads` is the rule; the service
 *     worker mirrors it.
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
  claimQueueRow,
  deleteQueueRecord,
  listQueue,
  listQueueByStatus,
  newUuid,
  updateQueueRecord,
  type QueueRecord,
} from './offline-store';
import { parseApiError } from './api-error';
import {
  isQueueRowClaimable,
  queueChainHeads,
  replayOutcomeForStatus,
} from '@gratis-gis/shared-types';

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
 * Thrown when the request never reached a server at all: fetch itself
 * rejected because the radio is down or we are at the edge of
 * coverage. Distinct from an HTTP failure because it must not count
 * against the row's retry budget; see the handler in syncQueue.
 */
class ReplayUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayUnreachable';
  }
}

/** fetch, with a network-level rejection relabelled so the drain can
 *  tell "no signal" from "the server said no". */
async function replayFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    throw new ReplayUnreachable(
      err instanceof Error && err.message
        ? `Network unavailable: ${err.message}`
        : 'Network unavailable',
    );
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
    /**
     * Set when a person pressed "Sync now". Skips the retry backoff:
     * they are watching, and a button that silently declines to do
     * anything because a ladder they cannot see says "not yet" reads
     * as broken. Automatic triggers leave it unset.
     */
    manual?: boolean;
  } = {},
): Promise<SyncResult> {
  const now = Date.now();
  const claimOpts = { ignoreBackoff: opts.manual === true };
  // One list, one policy. `queueChainHeads` picks at most ONE row per
  // feature (the oldest) and only when that row is claimable, which
  // is what keeps an update from overtaking the insert it depends on
  // and taking a 404. It also decides stale-claim reclamation and the
  // retry backoff, so this drain and the service worker's cannot
  // disagree about any of the three. Rows stranded in 'syncing' by a
  // page that died mid-drain are reclaimed by the same rule; on iOS
  // and Firefox, where Background Sync does not exist, this drain is
  // the only path that will ever free them.
  const all = await listQueue(dataCollectionId);
  const todo = queueChainHeads(all, now, claimOpts);
  const result: SyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    rejected: 0,
    remaining: 0,
    errors: [],
  };
  for (const record of todo) {
    // Claim atomically. Listing and then writing in two transactions
    // left a window where this drain and the service worker both
    // replayed the same edit; only server-side idempotency hid it.
    const claimed = await claimQueueRow(dataCollectionId, record.id, (row) =>
      isQueueRowClaimable(row, Date.now(), claimOpts),
    );
    if (!claimed) continue; // another drain took it
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
      if (err instanceof ReplayUnreachable) {
        // fetch itself threw: the radio is down or we are at the edge
        // of coverage. That is not the row's fault, so it does NOT
        // count as a failure. Counting it would climb the backoff
        // ladder during an outage and then make a worker who has just
        // walked back into signal wait fifteen minutes for data they
        // can see is queued. Restore the pre-claim status and leave
        // the attempt bookkeeping alone.
        await updateQueueRecord({
          ...record,
          syncStatus: record.syncStatus === 'failed' ? 'failed' : 'pending',
        });
        result.failed += 1;
        result.errors.push({
          recordId: record.id,
          op: record.op,
          layerLabel: record.layerKey,
          reason,
          terminal: false,
        });
        result.processed += 1;
        opts.onProgress?.(result.processed, todo.length);
        continue;
      }
      const terminal = err instanceof ReplayRejected;
      await updateQueueRecord({
        ...record,
        syncStatus: terminal ? 'rejected' : 'failed',
        failureReason: reason,
        retryCount: (record.retryCount ?? 0) + 1,
        // Stamped so the backoff has something to measure from. The
        // claim already wrote one; re-stamping here keeps the wait
        // anchored to when the attempt finished rather than started.
        lastAttemptAt: new Date().toISOString(),
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
    const res = await replayFetch(layerPath, {
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
    const res = await replayFetch(`${layerPath}/${r.globalId}`, {
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
    const res = await replayFetch(`${layerPath}/${r.globalId}`, {
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
  return newUuid();
}
