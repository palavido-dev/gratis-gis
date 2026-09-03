// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Classify the HTTP status of a replayed offline edit.
 *
 * The offline queue used to have one failure state, and every failed
 * row was retried on every sync run forever. That is right for a
 * flaky network or a 5xx, and wrong for a 400 from the schema
 * validator or a 403 from sharing: the same bytes get the same answer
 * every time, the row never clears, and the badge count never drops.
 * Those need a person to decide (fix and retry, or discard), so they
 * get a terminal state the drain leaves alone.
 *
 * Used by the in-app drain (offline-sync.ts). The service worker
 * (portal-web/public/sw.js) cannot import this module and duplicates
 * the same table by hand; change both together.
 */

export type ReplayOutcome =
  /** The server accepted it, or it was already done. Drop the row. */
  | 'done'
  /** Transient. Keep the row retryable ('failed'). */
  | 'retry'
  /** Deterministic refusal. Park the row ('rejected') for a person. */
  | 'rejected';

/**
 * Statuses in the 4xx range that describe the moment rather than the
 * request: an expired session, a timeout, a rate limit, or a retry-
 * after. The same request can succeed later, so they stay retryable.
 */
const TRANSIENT_4XX = new Set([401, 408, 425, 429]);

export function replayOutcomeForStatus(
  status: number,
  op: 'insert' | 'update' | 'delete',
): ReplayOutcome {
  if (status >= 200 && status < 300) return 'done';
  // A delete whose target is already gone has nothing left to do:
  // a prior replay probably succeeded and lost its response.
  if (op === 'delete' && status === 404) return 'done';
  if (status >= 400 && status < 500) {
    return TRANSIENT_4XX.has(status) ? 'retry' : 'rejected';
  }
  return 'retry';
}
