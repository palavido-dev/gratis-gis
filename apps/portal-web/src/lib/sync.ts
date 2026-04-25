/**
 * Client-side sync engine for offline feature data.
 *
 * Responsibilities:
 *   1. Queue offline writes into IndexedDB (queueFeatureWrite).
 *   2. Replay queued writes against the portal API when online (pushPending).
 *   3. Pull delta changes from the server using the ?since= cursor (pullDelta).
 *
 * The service worker handles Background Sync: it calls /api/portal/items/:id/...
 * for queued ops. This module handles the same logic from the main thread for
 * browsers that don't support the Background Sync API and for immediate pushes
 * on reconnect.
 */

import {
  bumpRetries,
  clearItemCache,
  dequeueOp,
  deleteCachedFeature,
  deleteCursor,
  getCursor,
  getPendingOps,
  queueOp,
  setCursor,
  upsertCachedFeature,
  type CachedFeature,
  type SyncQueueOp,
} from './offline-db';

const SYNC_TAG = 'gratis-feature-sync';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushResult {
  replayed: number;
  failed: number;
}

export interface DeltaResult {
  upserted: number;
  removed: number;
}

export type SyncResult = PushResult & DeltaResult;

// ---------------------------------------------------------------------------
// Write queueing
// ---------------------------------------------------------------------------

/**
 * Queue a feature write for deferred sync. Stores the op in IndexedDB and
 * requests a Background Sync event (fires immediately if online, deferred
 * until connectivity returns).
 *
 * @param itemId   The feature-service item UUID.
 * @param method   HTTP verb.
 * @param path     Path suffix after /items/:itemId, e.g. "/features" or
 *                 "/features/550e8400-e29b-41d4-a716-446655440000".
 * @param body     Request body (will be JSON-stringified).
 */
export async function queueFeatureWrite(
  itemId: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<void> {
  const op: Omit<SyncQueueOp, 'retries'> = {
    id: crypto.randomUUID(),
    itemId,
    method,
    path,
    body,
    queuedAt: new Date().toISOString(),
  };
  await queueOp(op);

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    // Background Sync: browser fires the sync event when it deems the
    // device online, even if this tab is closed.
    const reg = await navigator.serviceWorker.ready;
    await (reg as ServiceWorkerRegistration & { sync: { register(tag: string): Promise<void> } }).sync.register(SYNC_TAG);
  } else {
    // Fallback: push immediately on best-effort basis.
    pushPending().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Push (upload pending ops)
// ---------------------------------------------------------------------------

/**
 * Replay all pending ops from the sync queue against the portal API proxy.
 * Successfully replayed ops are removed from the queue. Failed ops have their
 * retry count incremented and remain for the next attempt.
 */
export async function pushPending(): Promise<PushResult> {
  const ops = await getPendingOps();
  let replayed = 0;
  let failed = 0;

  for (const op of ops) {
    try {
      const url = `/api/portal/items/${op.itemId}${op.path}`;
      const init: RequestInit = { method: op.method };
      if (op.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(op.body);
      }
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await dequeueOp(op.id);
      replayed++;
    } catch {
      await bumpRetries(op.id);
      failed++;
    }
  }

  return { replayed, failed };
}

// ---------------------------------------------------------------------------
// Pull (delta sync from server)
// ---------------------------------------------------------------------------

/**
 * Pull delta changes for a feature-service item since the last sync cursor.
 *
 * Uses ?since=<ISO timestamp> to fetch only rows that changed since the cursor.
 * The server returns both live features and tombstones (expired rows); this
 * function upserts live features into the local feature_cache and removes
 * tombstones. The cursor is advanced to NOW() on success.
 *
 * On first pull (no cursor), fetches up to 2 000 current features as a
 * baseline: callers should page if needed for very large datasets.
 */
export async function pullDelta(itemId: string): Promise<DeltaResult> {
  const cursor = await getCursor(itemId);
  const syncedAt = new Date().toISOString();

  const qs = cursor
    ? `?since=${encodeURIComponent(cursor)}&meta=true`
    : `?limit=2000&meta=true`;

  const res = await fetch(`/api/portal/items/${itemId}/features${qs}`);
  if (!res.ok) {
    throw new Error(`pullDelta failed for item ${itemId}: HTTP ${res.status}`);
  }

  type RawFeature = {
    id: string;
    geometry: unknown;
    properties: Record<string, unknown>;
    _meta?: { validTo?: string | null };
  };

  const fc = (await res.json()) as { type: string; features: RawFeature[] };
  let upserted = 0;
  let removed = 0;

  for (const f of fc.features ?? []) {
    const isExpired = f._meta?.validTo != null;
    if (isExpired) {
      // Tombstone: feature was deleted or superseded: remove from local cache.
      await deleteCachedFeature(itemId, f.id);
      removed++;
    } else {
      const cached: CachedFeature = {
        itemId,
        globalId: f.id,
        geometry: f.geometry,
        properties: f.properties,
        syncedAt,
        localOnly: false,
      };
      await upsertCachedFeature(cached);
      upserted++;
    }
  }

  await setCursor(itemId, syncedAt);
  return { upserted, removed };
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

/**
 * Full sync for a single item: push pending writes, then pull the latest
 * delta. Safe to call at app startup or when the browser comes back online.
 */
export async function syncItem(itemId: string): Promise<SyncResult> {
  const pushed = await pushPending();
  const pulled = await pullDelta(itemId);
  return { ...pushed, ...pulled };
}

/**
 * Wipe the local cache for an item and reset its cursor so the next pull
 * fetches a fresh baseline. Useful after a bulk import that replaced all
 * server-side features.
 */
export async function resetItemCache(itemId: string): Promise<void> {
  await clearItemCache(itemId);
  await deleteCursor(itemId);
}

// ---------------------------------------------------------------------------
// Online / offline listener helpers
// ---------------------------------------------------------------------------

/**
 * Register a one-time handler that pushes pending ops when the browser
 * reports coming online. Returns a cleanup function.
 *
 * Typical usage: call in a top-level React effect.
 */
export function listenForOnline(onSync?: (result: PushResult) => void): () => void {
  const handler = () => {
    pushPending()
      .then(onSync)
      .catch(() => undefined);
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
