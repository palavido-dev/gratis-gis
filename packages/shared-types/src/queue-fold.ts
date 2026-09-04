// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fold two consecutive offline edits to the SAME feature into one.
 *
 * The offline queue used to key a row by the feature's globalId, so a
 * second edit to a feature that had not synced yet was an IndexedDB
 * `put` over the first. Capture a point offline, tap it to fix a typo,
 * and the insert was gone: replay PATCHed a globalId the server had
 * never seen, took a 404, and parked the row as terminally rejected.
 * The dialog then offered Retry (404s forever) and Discard (throws the
 * capture away). That is silent data loss in the one part of the
 * product whose entire job is not losing data.
 *
 * Rows are keyed by an operation id now, so two edits can coexist. But
 * two rows for one feature also mean two requests, an ordering
 * dependency between them, and a cascade when the first is refused.
 * Folding at enqueue keeps the common case to a single row: N edits of
 * an unsynced capture stay one insert carrying the newest values.
 *
 * This is the pure decision table. The IndexedDB side (portal-web
 * `offline-store.ts`, `enqueueEdit`) applies it inside one readwrite
 * transaction, and only ever over a row that is still claimable:
 * a row already in flight ('syncing') or parked for a person
 * ('rejected') is never folded into, because the drain that owns it
 * would delete the merged result on success.
 *
 * It lives in shared-types because portal-web has no test runner, and
 * an untested decision table about data loss is not worth much.
 */

/** The three things a field edit can be. */
export type QueueOp = 'insert' | 'update' | 'delete';

/** The parts of a queued edit that folding actually reasons about. */
export interface FoldableEdit {
  op: QueueOp;
  /** Null for a delete, and for an update that changed no geometry. */
  geometry: unknown | null;
  /** Null for a delete. */
  properties: Record<string, unknown> | null;
}

/**
 * The result of folding `next` onto `prior`.
 *
 * `annihilated` is its own outcome rather than a null edit because the
 * two mean different things to the caller: 'replace the row with this'
 * versus 'delete the row and write nothing'. Collapsing them would let
 * a caller that forgot the distinction leave an insert in the queue
 * for a feature the user has since deleted.
 */
export type FoldResult =
  | { kind: 'replace'; edit: FoldableEdit }
  | { kind: 'annihilated' };

/**
 * Fold `next` onto an unsynced `prior` for the same feature.
 *
 * Property merge is a shallow spread, `next` winning, because an edit
 * carries the form's whole answer set rather than a sparse patch: the
 * spread preserves keys the later form did not render (a preset
 * parent FK, a server-stamped column) instead of dropping them.
 *
 * Geometry falls back to `prior` when `next` carries none, since an
 * attribute-only edit sends `geometry: null` and must not erase the
 * position the capture was made at.
 */
export function foldQueuedEdits(
  prior: FoldableEdit,
  next: FoldableEdit,
): FoldResult {
  const mergedProperties = {
    ...(prior.properties ?? {}),
    ...(next.properties ?? {}),
  };
  const geometry = next.geometry ?? prior.geometry;

  // A capture that was never sent and has now been deleted has no
  // business reaching the server at all. Dropping the row is the whole
  // point: replaying insert-then-delete would create the feature just
  // to delete it, and a refusal on either half would strand the other.
  if (prior.op === 'insert' && next.op === 'delete') {
    return { kind: 'annihilated' };
  }

  // The feature does not exist server-side yet, so every later edit is
  // still part of the same create. Staying an insert also keeps the
  // client-generated globalId as the idempotency key.
  if (prior.op === 'insert') {
    return {
      kind: 'replace',
      edit: { op: 'insert', geometry, properties: mergedProperties },
    };
  }

  // A pending delete over a row that exists server-side wins outright:
  // there is nothing to carry forward from an update that is about to
  // be irrelevant.
  if (next.op === 'delete') {
    return {
      kind: 'replace',
      edit: { op: 'delete', geometry: null, properties: null },
    };
  }

  // Delete-then-write. Only reachable when the delete has not drained
  // yet, which means the server still holds the row, so the net effect
  // is an update rather than a re-create. Sending an insert here would
  // depend on the server tolerating a globalId it already knows.
  if (prior.op === 'delete') {
    return {
      kind: 'replace',
      edit: { op: 'update', geometry, properties: mergedProperties },
    };
  }

  // update + update.
  return {
    kind: 'replace',
    edit: { op: 'update', geometry, properties: mergedProperties },
  };
}

/**
 * Fold a whole chain of unsynced edits for one feature, oldest first.
 *
 * `enqueueEdit` maintains the invariant that at most one claimable row
 * exists per feature, so in practice this folds one prior row and the
 * incoming edit. It takes a list anyway so a queue written by an older
 * build, which could hold several rows per feature, heals on the next
 * edit instead of replaying them in an order nothing enforces.
 *
 * Returns `annihilated` if the chain cancels out at any point, even if
 * later edits follow: an insert and a delete that meet leave the
 * server having never heard of the feature, and anything after them
 * describes a feature the user has deleted.
 */
export function foldQueuedChain(chain: FoldableEdit[]): FoldResult {
  if (chain.length === 0) {
    throw new Error('foldQueuedChain requires at least one edit');
  }
  let acc: FoldableEdit = chain[0]!;
  for (let i = 1; i < chain.length; i += 1) {
    const folded = foldQueuedEdits(acc, chain[i]!);
    if (folded.kind === 'annihilated') return folded;
    acc = folded.edit;
  }
  return { kind: 'replace', edit: acc };
}
