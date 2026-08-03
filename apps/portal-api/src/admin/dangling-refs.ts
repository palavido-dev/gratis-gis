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
 */

export interface DanglingRefReferrer {
  id: string;
  type: string;
  title: string;
  /** Referenced ids with no item row at all. */
  missing: string[];
  /** Referenced ids whose target sits in the trash. */
  trashed: string[];
}

export function groupDanglingRefs(
  referrers: Array<{
    id: string;
    type: string;
    title: string;
    refs: string[];
  }>,
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
      out.push({
        id: r.id,
        type: r.type,
        title: r.title,
        missing: missing.sort(),
        trashed: trashed.sort(),
      });
    }
  }
  // Hard breakage first, then alphabetical for a stable admin list.
  return out.sort(
    (a, b) =>
      Number(b.missing.length > 0) - Number(a.missing.length > 0) ||
      a.title.localeCompare(b.title),
  );
}
