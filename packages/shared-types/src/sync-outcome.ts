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

/** The parts of a queued edit and of a 409's `current` feature that
 *  `isOwnEditEcho` compares. */
export interface EchoEdit {
  op: 'insert' | 'update' | 'delete';
  geometry: unknown | null;
  properties: Record<string, unknown> | null;
}

export interface EchoFeature {
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

/** Geometry the server returns went through PostGIS, which prints at
 *  most 9 decimals. Anything closer than this is the same point. */
const COORD_TOLERANCE = 1e-8;

function sameValue(a: unknown, b: unknown, coords: boolean): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (typeof a === 'number' && typeof b === 'number') {
    return coords ? Math.abs(a - b) <= COORD_TOLERANCE : a === b;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i], coords));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!sameValue(ao[k], bo[k], coords)) return false;
  }
  return true;
}

/**
 * Whether a 409 `feature-conflict` on a replayed update is the
 * device's own earlier write coming back.
 *
 * An update can commit on the server and its response be lost (a
 * timeout in poor coverage). The row stays queued with its old
 * `baseObservationId`, and the retry gets 409 because the head is now
 * that same write. When the server's `current` feature already holds
 * every value the queued edit sends (ignoring `_` keys, which the
 * server owns) and the queued geometry, the edit landed: the row is
 * done, not a conflict. Anything else stays a conflict for a person.
 */
export function isOwnEditEcho(edit: EchoEdit, current: EchoFeature | null): boolean {
  if (edit.op !== 'update' || current === null) return false;
  const now = current.properties ?? {};
  for (const [key, value] of Object.entries(edit.properties ?? {})) {
    if (key.startsWith('_')) continue;
    if (!sameValue(value, now[key], false)) return false;
  }
  if (edit.geometry !== null && edit.geometry !== undefined) {
    if (!sameValue(edit.geometry, current.geometry ?? null, true)) return false;
  }
  return true;
}
