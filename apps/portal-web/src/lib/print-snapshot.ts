// SPDX-License-Identifier: AGPL-3.0-or-later
// Hand-off of a map snapshot from an app's Print widget to the print
// tab, through sessionStorage.
//
// Each snapshot is a full-canvas PNG data URL, often several MB, and
// sessionStorage holds about 5 MiB per origin. Nothing used to remove
// an old snapshot (the print page cannot: it may be reloaded), so the
// second or third print in a tab hit the quota and the print page
// silently showed a placeholder map. Only the newest snapshot is
// kept now.

export const PRINT_SNAPSHOT_PREFIX = 'print-snap-';

/**
 * Store `value` under `token`, dropping every earlier print snapshot
 * first. Returns false when the browser still refuses to store it
 * (for example a snapshot larger than the whole quota), so the caller
 * can tell the user rather than only logging.
 */
export function storePrintSnapshot(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem' | 'setItem'>,
  token: string,
  value: string,
): boolean {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PRINT_SNAPSHOT_PREFIX) && k !== token) stale.push(k);
  }
  for (const k of stale) storage.removeItem(k);
  try {
    storage.setItem(token, value);
    return true;
  } catch {
    return false;
  }
}
