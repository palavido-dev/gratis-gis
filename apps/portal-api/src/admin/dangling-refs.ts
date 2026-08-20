// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure grouping for the housekeeping dangling-reference check
 * (#217 companion). The parcels incident class: a live item whose
 * data references item ids that no longer resolve renders silently
 * broken (a map just stops drawing that layer, with no error
 * anywhere). The service extracts every referenced id and resolves
 * which exist; this module turns that into per-referrer rows,
 * split into hard-missing (no row at all; the reference can only
 * be repointed or removed) and trashed (recoverable by restoring
 * the target from trash).
 *
 * Referrers come from two places, and the second is the reason this
 * module takes a descriptor rather than an item row (#238):
 *
 *   - 'item'     the reference lives in item.data (or a geo-limit
 *                column on the item row).
 *   - 'settings' the reference lives somewhere else entirely: the
 *                organization's landing config, a share row's geo
 *                boundary. Scanning only item.data reported "every
 *                reference resolves" while /admin/branding was
 *                openly rendering two "Unknown item ..." rows.
 *
 * Both kinds carry their own `href`, because the place a reference
 * is fixed is not derivable from the referrer id once the referrer
 * stops being an item.
 */

export type DanglingRefScope = 'item' | 'settings';

export interface DanglingRefReferrer {
  /**
   * Item id for `scope: 'item'`. For `scope: 'settings'` this is a
   * synthetic key unique per holder (e.g. `org:landing-featured`),
   * used only for React keys and stable ordering.
   */
  id: string;
  /**
   * ItemType for `scope: 'item'` (the client renders it through
   * getItemTypeLabel). A ready-to-display holder label for
   * `scope: 'settings'`, which has no item type to look up.
   */
  type: string;
  title: string;
  scope: DanglingRefScope;
  /** Portal route where an admin repoints or removes the reference. */
  href: string;
  /**
   * Consequence of the dangle, when it is not self-evident. Set on
   * settings rows, where "a share lost its boundary" reads as
   * harmless unless you know it silently widens the grant.
   */
  note?: string;
  /** Referenced ids with no item row at all. */
  missing: string[];
  /** Referenced ids whose target sits in the trash. */
  trashed: string[];
}

/** A referrer plus the raw ids it points at, before resolution. */
export type DanglingRefCandidate = Omit<
  DanglingRefReferrer,
  'missing' | 'trashed'
> & { refs: string[] };

export function groupDanglingRefs(
  referrers: readonly DanglingRefCandidate[],
  liveIds: ReadonlySet<string>,
  trashedIds: ReadonlySet<string>,
): DanglingRefReferrer[] {
  const out: DanglingRefReferrer[] = [];
  for (const r of referrers) {
    const missing: string[] = [];
    const trashed: string[] = [];
    for (const ref of new Set(r.refs)) {
      if (liveIds.has(ref)) continue;
      if (trashedIds.has(ref)) trashed.push(ref);
      else missing.push(ref);
    }
    if (missing.length > 0 || trashed.length > 0) {
      // Spread the descriptor rather than naming each field: under
      // exactOptionalPropertyTypes an absent `note` and a `note:
      // undefined` are different types, and naming fields one by one
      // is how optional config silently turns into a present-but-
      // undefined key. It also means a new descriptor field reaches
      // the output without an edit here.
      const { refs: _refs, ...descriptor } = r;
      out.push({ ...descriptor, missing: missing.sort(), trashed: trashed.sort() });
    }
  }
  // Hard breakage first, then alphabetical for a stable admin list.
  return out.sort(
    (a, b) =>
      Number(b.missing.length > 0) - Number(a.missing.length > 0) ||
      a.title.localeCompare(b.title),
  );
}
