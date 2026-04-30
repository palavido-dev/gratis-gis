/**
 * Persistent-storage and quota helpers for the field offline path.
 *
 * Slice 6 ("persistence floor") of the field offline arc; see
 * docs/field-offline-areas.md for the full design. The premise is
 * that field data must never silently disappear, and the default
 * IndexedDB tier ("best effort" storage) is one cache-clear or one
 * disk-pressure eviction away from gone. These helpers harden that
 * tier in three ways:
 *
 *   1. requestPersistentStorage() asks the browser to mark our
 *      origin's storage as "important." Once granted, the browser
 *      will not auto-evict under disk pressure; only an explicit
 *      "Clear browsing data" by the user removes it.
 *
 *   2. estimateStorage() reports how much we've used vs. the quota
 *      the browser has carved out for our origin. The field UI
 *      uses this for a usage bar and a pre-download guard so a
 *      user doesn't kick off a 500 MB download that will fail at
 *      the 200 MB mark.
 *
 *   3. checkDownloadFits() is the guard that pairs an estimated
 *      download size against the remaining quota and tells the
 *      caller whether the download can proceed, with a structured
 *      reason if it can't (so the UI can render a useful "Free up
 *      X MB to download" dialog rather than a generic failure).
 *
 * All three are designed to fail open: if a browser doesn't expose
 * `navigator.storage` (older Safari, locked-down WebViews), the
 * helpers return reasonable best-effort defaults rather than
 * blocking the user. The cost is reduced visibility on those
 * browsers, not loss of function.
 */

/**
 * Result of a persistence request. Distinguishes the three real
 * outcomes (granted, denied, API not supported) so callers can
 * surface different UI for each. The "denied" case in particular
 * matters because the user actively chose not to grant; we should
 * not pester them on every page load.
 */
export type PersistResult =
  | { ok: true; persistent: true }
  | { ok: true; persistent: false; reason: 'denied' | 'unsupported' };

/**
 * Ask the browser to mark this origin's storage as persistent. The
 * call is a no-op on browsers that don't expose
 * `navigator.storage.persist`, returning { persistent: false,
 * reason: 'unsupported' } so the caller can decide whether to fall
 * back (e.g. surface a softer "your data may be evicted" warning).
 *
 * Once granted, the browser persists this decision; subsequent
 * calls return immediately with the stored value. We still call
 * persist() rather than only persisted() because some browsers
 * upgrade silently after the first user gesture and persist() is
 * the canonical way to confirm.
 *
 * Recommended call timing: at the moment the user starts an offline
 * download, NOT on cold page load. The "Allow [site] to keep data
 * on your device?" prompt reads as natural after a download click;
 * on a generic page load it reads as a permissions ambush and
 * gets denied disproportionately.
 */
export async function requestPersistentStorage(): Promise<PersistResult> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persist !== 'function'
  ) {
    return { ok: true, persistent: false, reason: 'unsupported' };
  }
  try {
    // Already persistent? Skip the prompt round-trip.
    if (typeof navigator.storage.persisted === 'function') {
      const already = await navigator.storage.persisted();
      if (already) return { ok: true, persistent: true };
    }
    const granted = await navigator.storage.persist();
    return granted
      ? { ok: true, persistent: true }
      : { ok: true, persistent: false, reason: 'denied' };
  } catch {
    // Some browsers throw rather than reject (older Edge); treat
    // as unsupported. The user can still use the field tool, they
    // just don't get the persistence guarantee.
    return { ok: true, persistent: false, reason: 'unsupported' };
  }
}

/**
 * Read the current persistence state without prompting. Cheap to
 * call from a useEffect at field-runtime mount so the UI can show
 * a "Persistent" or "Best effort" badge alongside the storage
 * usage bar.
 */
export async function isPersistent(): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persisted !== 'function'
  ) {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Snapshot of the browser's quota for our origin. `usage` and
 * `quota` are bytes. `usagePercent` is the convenience derived
 * field for UI gauges; it's NaN-safe (returns 0 when quota is 0
 * or missing).
 *
 * Browsers vary widely on quota size:
 *   - Chrome desktop:  ~80% of free disk (effectively unlimited
 *                      for our use cases)
 *   - Chrome Android:  ~6-10% of free disk (often 1-3 GB)
 *   - Firefox:         50% of free disk
 *   - iOS Safari:      ~1 GB until installed as PWA, then much
 *                      higher
 *
 * Treat the number as advisory; don't pre-divide it among caches
 * because the OS may shrink it under disk pressure between the
 * estimate and the next write.
 */
export interface StorageEstimate {
  usage: number;
  quota: number;
  /** 0..1 ratio of used to total. Rounded to 4 decimal places. */
  usagePercent: number;
  /** True when the browser supplied real numbers, false when we
   *  fell back to {0, 0, 0} because the API isn't available. */
  available: boolean;
}

/**
 * Read the current usage / quota for our origin. Wraps
 * navigator.storage.estimate() with the same fail-open posture as
 * the persistence helpers: returns a zeroed shape on unsupported
 * browsers so the UI can render a "storage info unavailable" state
 * rather than crashing.
 */
export async function estimateStorage(): Promise<StorageEstimate> {
  const empty: StorageEstimate = {
    usage: 0,
    quota: 0,
    usagePercent: 0,
    available: false,
  };
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== 'function'
  ) {
    return empty;
  }
  try {
    const est = await navigator.storage.estimate();
    const usage = typeof est.usage === 'number' ? est.usage : 0;
    const quota = typeof est.quota === 'number' ? est.quota : 0;
    const usagePercent =
      quota > 0 ? Math.round((usage / quota) * 10_000) / 10_000 : 0;
    return { usage, quota, usagePercent, available: quota > 0 };
  } catch {
    return empty;
  }
}

/**
 * Outcome of a pre-download quota check. The `reason` payload on
 * 'wont-fit' carries the numbers the UI needs to render a "free up
 * X MB to download Y MB" dialog without re-estimating.
 *
 * 'unknown' means we couldn't tell (no quota data); the caller
 * should let the download proceed but warn the user. We err on
 * permissive here because some browsers report quota=0 even when
 * they have plenty of space.
 */
export type QuotaCheck =
  | { fits: true; freeBytes: number; quota: number }
  | {
      fits: false;
      reason: 'wont-fit';
      shortfallBytes: number;
      usage: number;
      quota: number;
      estimatedDownloadBytes: number;
    }
  | { fits: true; reason: 'unknown' };

/**
 * Default headroom we leave between a planned download and the
 * quota ceiling. Browsers can shrink quota at any time, and
 * IndexedDB writes have overhead beyond the raw payload (B-tree
 * index pages, key prefixes, etc.). 10% headroom is a reasonable
 * floor; tunable per call.
 */
const DEFAULT_HEADROOM_RATIO = 0.1;

/**
 * Decide whether a planned download will fit in remaining quota.
 * Pass the manager's pre-download size estimate; the helper checks
 * it against the live quota and reports back. Use as the gate
 * before opening the download progress modal so the user sees a
 * clear "you'd run out of space" message instead of a mid-download
 * abort.
 *
 * Returns { fits: true } in the unknown case (no quota data) so
 * the field tool stays usable on browsers that don't expose the
 * API. Surface that as a softer "we couldn't verify free space"
 * notice rather than blocking.
 */
export async function checkDownloadFits(
  estimatedDownloadBytes: number,
  opts: { headroomRatio?: number } = {},
): Promise<QuotaCheck> {
  const est = await estimateStorage();
  if (!est.available) {
    return { fits: true, reason: 'unknown' };
  }
  const headroomRatio = opts.headroomRatio ?? DEFAULT_HEADROOM_RATIO;
  const headroom = Math.floor(est.quota * headroomRatio);
  const free = est.quota - est.usage - headroom;
  if (estimatedDownloadBytes > free) {
    return {
      fits: false,
      reason: 'wont-fit',
      shortfallBytes: estimatedDownloadBytes - free,
      usage: est.usage,
      quota: est.quota,
      estimatedDownloadBytes,
    };
  }
  return { fits: true, freeBytes: free, quota: est.quota };
}

/**
 * Format a byte count for display in compact UI surfaces (badges,
 * progress bars, dialogs). Mirrors the format the existing offline
 * download manager uses internally so usage labels and "estimated
 * size" labels read consistently.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}
