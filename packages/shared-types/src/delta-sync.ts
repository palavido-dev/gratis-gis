// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client rules for walking `GET .../delta` (docs/sync-protocol.md).
 *
 * Pure, so the web drain, the field engine bundle (and through it the
 * Android app) and their tests share one copy. Two rules live here:
 *
 * - How to step from one delta page to the next. A write batch shares
 *   one syncVersion and can span pages, so the next request resumes
 *   from `(nextSince, nextAfter)`, not from the last row's version.
 * - What properties a cached row gets from a change, so a row
 *   refreshed by delta carries the same `_observation_id` conflict
 *   token and editor fields a full read gives it.
 */

/** One observation row of a delta page, as far as clients read it. */
export interface DeltaChangeLike {
  observationId: string;
  entity: string;
  kind: 'create' | 'update' | 'delete' | 'derive' | 'observe' | string;
  syncVersion: number;
  txTime?: string | null;
  authorSub?: string | null;
  /** Author of the entity's create observation. Absent from servers
   *  older than the composite cursor. */
  createdBy?: string | null;
  createdAt?: string | null;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

export interface DeltaPageLike {
  syncVersion: number;
  changes: DeltaChangeLike[];
  truncated: boolean;
  nextSince?: number;
  nextAfter?: string;
}

/**
 * What to do after applying a page.
 *
 * - `done`: store `cursor` as the layer's syncVersion.
 * - `next`: request `since` (and `after` when set) next. If the walk
 *   has to stop before the next page is applied, store `safeCursor`,
 *   the last version applied completely, never `since`.
 * - `stalled`: an older server truncated a page that is all one
 *   version and gave no `nextAfter`, so paging cannot make progress.
 *   Store `safeCursor` and do a full pull instead.
 */
export type DeltaStep =
  | { kind: 'done'; cursor: number }
  | { kind: 'next'; since: number; after?: string; safeCursor: number }
  | { kind: 'stalled'; safeCursor: number };

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * The step after applying `page`, which was requested with `since`.
 */
export function nextDeltaStep(page: DeltaPageLike, since: number): DeltaStep {
  if (!page.truncated) {
    return { kind: 'done', cursor: finite(page.syncVersion) ? page.syncVersion : since };
  }
  if (finite(page.nextSince) && typeof page.nextAfter === 'string' && page.nextAfter !== '') {
    // Every row before (nextSince, nextAfter) is applied, so every
    // version below nextSince is complete.
    return {
      kind: 'next',
      since: page.nextSince,
      after: page.nextAfter,
      safeCursor: Math.max(since, page.nextSince - 1),
    };
  }
  // A server without the composite cursor. Re-reading the last
  // version from its start is safe (applying is idempotent) and makes
  // progress as long as the page held more than one version.
  const last = page.changes[page.changes.length - 1];
  if (last && finite(last.syncVersion) && last.syncVersion - 1 > since) {
    return {
      kind: 'next',
      since: last.syncVersion - 1,
      safeCursor: last.syncVersion - 1,
    };
  }
  return { kind: 'stalled', safeCursor: since };
}

/**
 * Properties for the cached row a non-delete change upserts.
 *
 * Mirrors the extra keys a full read inlines (`rowToFeature` in
 * portal-api engine/data-layer.ts). `prior` is the row's cached
 * properties, used only for `_created_*` when the server did not send
 * `createdBy` (older servers).
 */
export function deltaChangeProperties(
  change: DeltaChangeLike,
  prior?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(change.properties ?? {}) };
  out._global_id = change.entity;
  out._observation_id = change.observationId;
  if (change.authorSub != null) out._edited_by = change.authorSub;
  if (change.txTime != null) out._edited_at = change.txTime;
  if (change.createdBy != null) {
    out._created_by = change.createdBy;
    if (change.createdAt != null) out._created_at = change.createdAt;
  } else if (prior && prior._created_by !== undefined) {
    out._created_by = prior._created_by;
    if (prior._created_at !== undefined) out._created_at = prior._created_at;
  } else if (change.kind === 'create') {
    if (change.authorSub != null) out._created_by = change.authorSub;
    if (change.txTime != null) out._created_at = change.txTime;
  }
  return out;
}
