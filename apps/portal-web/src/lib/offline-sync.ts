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
  deletePendingBlob,
  deletePendingBlobsForFeature,
  deleteQueueRecord,
  listPendingBlobs,
  listPendingBlobsForFeature,
  listQueue,
  listQueueByStatus,
  newUuid,
  updateQueueRecord,
  type PendingBlob,
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
  // Orphaned files: captured against a feature that has no queue row.
  //
  // The obvious way to get one is an ONLINE save. That path writes the
  // feature straight to the API and never touches the queue, so a
  // photo taken during it had nothing to ride along with and would
  // have sat on the device forever. The other way is an online upload
  // that failed after the feature landed. Both mean the feature is on
  // the server already, so the upload is safe to attempt on its own.
  //
  // Deliberately not fatal to the run: these are best-effort, and a
  // failure leaves the file exactly where it was for the next sync.
  await sweepOrphanedBlobs(dataCollectionId);

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
  // Anything captured against this feature goes with it. Without
  // this, discarding a refused capture would leave its photos with no
  // queue row to carry them and no feature to attach to: the orphan
  // sweep would then try to upload them against a feature the server
  // has never seen, forever.
  await deletePendingBlobsForFeature(
    record.dataCollectionId,
    record.dataLayerId,
    record.layerKey,
    record.globalId,
  );
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
    // The feature exists now, so anything captured against it can go.
    await uploadPendingBlobsForFeature(r);
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
    // An edit can carry new photos too: the collector opens a record
    // they captured earlier and adds the shot they could not get on
    // the first visit.
    await uploadPendingBlobsForFeature(r);
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
    // The feature is gone, so its captured files have nowhere to be
    // attached. Dropping them is the only option that does not leak
    // the largest rows in the database forever.
    await deletePendingBlobsForFeature(
      r.dataCollectionId,
      r.dataLayerId,
      r.layerKey,
      r.globalId,
    );
    return;
  }
  // Unknown op (the type union is exhausted above, so only a row
  // written by a newer client could get here). Park it: retrying
  // cannot teach this build a new op.
  throw new ReplayRejected(`Unknown queue op: ${(r as { op: string }).op}`);
}

/**
 * Upload the files captured against a feature, now that the feature
 * itself exists on the server.
 *
 * Three steps per file, the same walk the online uploader does:
 * presign, PUT the bytes straight to object storage, then register
 * the metadata. The API never buffers the bytes.
 *
 * Ordering is the whole point. An attachment endpoint is keyed by
 * feature id, so none of this can run until the insert has replayed;
 * that is why it lives here, after the feature write succeeded,
 * rather than as its own queue row.
 *
 * A file that fails is LEFT IN PLACE and the error propagates, so the
 * queue row goes back to failed and the whole feature is retried.
 * Losing the photo silently while reporting the record as synced
 * would be the worst available outcome: the record would look
 * complete and be missing the evidence it was collected for.
 */
/**
 * Upload files whose feature has no queue row left.
 *
 * Their feature is necessarily on the server: either it was written
 * directly by the online path, or its queue row already drained. So
 * the attachment endpoint will accept them, and leaving them would
 * mean a record that looks complete on the server while the photo it
 * exists to carry sits on a phone.
 *
 * Errors are swallowed per feature. This runs at the tail of a drain
 * whose real work has already succeeded, and a failed photo upload
 * must not turn a successful sync into a reported failure; the file
 * stays put and the next sync tries again.
 */
async function sweepOrphanedBlobs(dataCollectionId: string): Promise<void> {
  let pending: Awaited<ReturnType<typeof listPendingBlobs>>;
  try {
    pending = await listPendingBlobs(dataCollectionId);
  } catch {
    return;
  }
  if (pending.length === 0) return;
  const queued = await listQueue(dataCollectionId).catch(() => []);
  const hasRow = new Set(
    queued.map((r) => `${r.dataLayerId} ${r.layerKey} ${r.globalId}`),
  );
  const seen = new Set<string>();
  for (const file of pending) {
    const key = `${file.dataLayerId} ${file.layerKey} ${file.globalId}`;
    if (hasRow.has(key) || seen.has(key)) continue;
    seen.add(key);
    try {
      await uploadPendingBlobsForFeature({
        dataCollectionId: file.dataCollectionId,
        dataLayerId: file.dataLayerId,
        layerKey: file.layerKey,
        globalId: file.globalId,
      });
    } catch {
      // Still offline, or the server refused. The file is untouched.
    }
  }
}

export interface FeatureRef {
  dataCollectionId: string;
  dataLayerId: string;
  layerKey: string;
  globalId: string;
}

export async function uploadPendingBlobsForFeature(
  ref: FeatureRef,
): Promise<void> {
  const pending = await listPendingBlobsForFeature(
    ref.dataCollectionId,
    ref.dataLayerId,
    ref.layerKey,
    ref.globalId,
  );
  for (const file of pending) {
    await uploadOneBlob(ref, file);
    // Only after the register call returned 2xx. A blob deleted
    // before that is gone from a device that may have no way back to
    // the subject of the photograph.
    await deletePendingBlob(file.blobId);
  }
}

async function uploadOneBlob(
  ref: FeatureRef,
  file: PendingBlob,
): Promise<void> {
  // The op only affects how a failure is CLASSIFIED, and an
  // attachment failure means the same thing whatever the feature
  // write was, so 'update' stands in for all of them here.
  const op: QueueRecord['op'] = 'update';
  const presignRes = await replayFetch('/api/portal/storage/presign-upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'feature-attachment',
      contentType: file.mimeType || 'application/octet-stream',
    }),
  });
  await throwIfNotOk(presignRes, 'Attachment presign', op);
  const presign = (await presignRes.json()) as {
    uploadUrl: string;
    publicUrl: string;
    key: string;
    maxBytes: number;
  };
  if (file.sizeBytes > presign.maxBytes) {
    // Deterministic: the same bytes will be too large forever, so
    // park the row rather than retrying a file the server will never
    // take. The collector can delete it and re-shoot smaller.
    throw new ReplayRejected(
      `${file.fileName} is ${(file.sizeBytes / 1024 / 1024).toFixed(
        1,
      )} MB and the limit is ${(presign.maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  const putRes = await replayFetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.mimeType || 'application/octet-stream' },
    body: file.blob,
  });
  await throwIfNotOk(putRes, 'Attachment upload', op);

  const registerRes = await replayFetch(
    `/api/portal/items/${ref.dataLayerId}/layers/${encodeURIComponent(
      ref.layerKey,
    )}/features/${ref.globalId}/attachments`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: file.fileName,
        mime: file.mimeType || 'application/octet-stream',
        sizeBytes: file.sizeBytes,
        storageKey: presign.key,
        storageUrl: presign.publicUrl,
      }),
    },
  );
  await throwIfNotOk(registerRes, 'Attachment register', op);
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
