/**
 * Module-level user-name cache for resolving editor-tracking UUIDs
 * (_created_by, _edited_by on PostGIS-backed feature properties)
 * to human-readable display names.
 *
 * The popup renderer is synchronous (it stamps an HTML string on
 * click), so we need a cache the renderer can hit instantly. The
 * cache is populated lazily:
 *
 *   - The metadata probe (discoverLayerMetadata) scans every feature
 *     collection it loads and queues UUIDs through `prefetchUserNames`.
 *     By the time a user opens a popup, the cache is usually warm.
 *   - The popup renderer also calls `prefetchUserNames` for any UUID
 *     it encounters, so a layer that somehow bypassed the probe
 *     still gets resolved on first click; a follow-up render will
 *     show the name (today the popup doesn't auto-refresh; users
 *     close and reopen).
 *
 * Single batched flight: requests within a 50ms window dedupe + go
 * out as one /api/portal/users?ids= call. Matches the existing
 * pattern in sharing-panel and the popup metadata footer for
 * resolving principals.
 *
 * Failure mode: a missing or errored fetch leaves the UUID
 * unresolved. The fallback in `getCachedUserName` returns a short
 * "8c4f2..." form so the popup still says something the author can
 * recognise as "yes, that's a user id we just couldn't name".
 */

const cache = new Map<string, string>();
const inFlight = new Set<string>();
let pending: Set<string> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY_MS = 50;

function flush() {
  pendingTimer = null;
  if (!pending || pending.size === 0) {
    pending = null;
    return;
  }
  const ids = Array.from(pending);
  pending = null;
  for (const id of ids) inFlight.add(id);
  void (async () => {
    try {
      const res = await fetch(
        `/api/portal/users?ids=${encodeURIComponent(ids.join(','))}`,
      );
      if (!res.ok) return;
      const rows = (await res.json()) as Array<{
        id: string;
        username: string;
        fullName: string | null;
      }>;
      for (const u of rows) {
        cache.set(u.id, u.fullName || u.username);
      }
    } catch {
      /* non-fatal: UUID stays in fallback form until next attempt */
    } finally {
      for (const id of ids) inFlight.delete(id);
    }
  })();
}

/**
 * Queue a batch of UUIDs for resolution. Already-cached + currently
 * in-flight ids are skipped. The actual fetch is debounced 50ms so
 * a layer that walks 5000 features doesn't spam the BFF -- one
 * request covers them all.
 */
export function prefetchUserNames(uuids: Iterable<string>): void {
  let queuedAny = false;
  for (const raw of uuids) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (cache.has(raw) || inFlight.has(raw)) continue;
    if (!pending) pending = new Set();
    pending.add(raw);
    queuedAny = true;
  }
  if (!queuedAny) return;
  if (pendingTimer === null) {
    pendingTimer = setTimeout(flush, BATCH_DELAY_MS);
  }
}

/**
 * Synchronous lookup. Returns the cached display name when known,
 * otherwise a short fallback like "8c4f2eaa..." so the popup says
 * something instead of dumping a 36-char UUID. Also opportunistically
 * queues the id for resolution so a *next* render gets the name.
 */
export function getCachedUserName(uuid: string): string {
  if (typeof uuid !== 'string' || uuid.length === 0) return '';
  const hit = cache.get(uuid);
  if (hit) return hit;
  // Touch the queue so even direct callers (the popup, the attribute
  // table) eventually get resolution without each having to call
  // prefetchUserNames separately.
  prefetchUserNames([uuid]);
  // Best-effort fallback: 8-char prefix + ellipsis. Plain string
  // (no HTML) so the caller can decide how to escape.
  return uuid.length > 8 ? `${uuid.slice(0, 8)}...` : uuid;
}
