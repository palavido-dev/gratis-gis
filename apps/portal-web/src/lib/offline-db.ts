/**
 * Typed wrapper over the GratisGIS IndexedDB schema.
 *
 * The database is shared with the service worker (sw.js) which writes to
 * sync_queue and reads from it during Background Sync. This module provides
 * the same schema from the main thread with proper TypeScript types.
 *
 * Schema (must stay in sync with sw.js openDb()):
 *   sync_queue   : pending write ops queued while offline
 *   feature_cache: local copy of last-seen features per item
 *   sync_cursors : per-item delta-sync cursors (ISO timestamps)
 */

const DB_NAME = 'gratis-gis';
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncQueueOp {
  id: string;
  itemId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Path after /items/:itemId, e.g. "/features" or "/features/:globalId" */
  path: string;
  body?: unknown;
  queuedAt: string;
  retries: number;
}

export interface CachedFeature {
  itemId: string;
  globalId: string;
  geometry: unknown;
  properties: Record<string, unknown>;
  syncedAt: string;
  /** True for features created offline that have not yet reached the server. */
  localOnly: boolean;
}

export interface SyncCursor {
  itemId: string;
  lastSyncAt: string;
}

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

let _dbPromise: Promise<IDBDatabase> | null = null;

export function openGratisDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB is only available in the browser'));
  }
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('sync_queue')) {
        const sq = db.createObjectStore('sync_queue', { keyPath: 'id' });
        sq.createIndex('itemId', 'itemId', { unique: false });
        sq.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('feature_cache')) {
        const fc = db.createObjectStore('feature_cache', { keyPath: ['itemId', 'globalId'] });
        fc.createIndex('itemId', 'itemId', { unique: false });
        fc.createIndex('syncedAt', 'syncedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('sync_cursors')) {
        db.createObjectStore('sync_cursors', { keyPath: 'itemId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null; // allow retry on next call
      reject(req.error);
    };
  });

  return _dbPromise;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('IDB transaction aborted'));
  });
}

// ---------------------------------------------------------------------------
// sync_queue
// ---------------------------------------------------------------------------

export async function queueOp(op: Omit<SyncQueueOp, 'retries'>): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  tx.objectStore('sync_queue').put({ ...op, retries: 0 } satisfies SyncQueueOp);
  await idbDone(tx);
}

export async function dequeueOp(id: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  tx.objectStore('sync_queue').delete(id);
  await idbDone(tx);
}

export async function getPendingOps(): Promise<SyncQueueOp[]> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_queue', 'readonly');
  return idbReq<SyncQueueOp[]>(tx.objectStore('sync_queue').getAll());
}

export async function bumpRetries(id: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  const store = tx.objectStore('sync_queue');
  const op = await idbReq<SyncQueueOp | undefined>(store.get(id));
  if (op) {
    store.put({ ...op, retries: op.retries + 1 });
  }
  await idbDone(tx);
}

export async function clearQueue(): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_queue', 'readwrite');
  tx.objectStore('sync_queue').clear();
  await idbDone(tx);
}

// ---------------------------------------------------------------------------
// feature_cache
// ---------------------------------------------------------------------------

export async function upsertCachedFeature(feat: CachedFeature): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('feature_cache', 'readwrite');
  tx.objectStore('feature_cache').put(feat);
  await idbDone(tx);
}

export async function deleteCachedFeature(itemId: string, globalId: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('feature_cache', 'readwrite');
  tx.objectStore('feature_cache').delete([itemId, globalId]);
  await idbDone(tx);
}

export async function getCachedFeatures(itemId: string): Promise<CachedFeature[]> {
  const db = await openGratisDb();
  const tx = db.transaction('feature_cache', 'readonly');
  const idx = tx.objectStore('feature_cache').index('itemId');
  return idbReq<CachedFeature[]>(idx.getAll(IDBKeyRange.only(itemId)));
}

export async function clearItemCache(itemId: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('feature_cache', 'readwrite');
  const idx = tx.objectStore('feature_cache').index('itemId');
  // Collect keys then delete: IDB cursors don't support delete-while-iterating cleanly.
  const keys = await idbReq<IDBValidKey[]>(idx.getAllKeys(IDBKeyRange.only(itemId)));
  for (const key of keys) {
    tx.objectStore('feature_cache').delete(key);
  }
  await idbDone(tx);
}

// ---------------------------------------------------------------------------
// sync_cursors
// ---------------------------------------------------------------------------

export async function getCursor(itemId: string): Promise<string | null> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_cursors', 'readonly');
  const row = await idbReq<SyncCursor | undefined>(tx.objectStore('sync_cursors').get(itemId));
  return row?.lastSyncAt ?? null;
}

export async function setCursor(itemId: string, ts: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_cursors', 'readwrite');
  tx.objectStore('sync_cursors').put({ itemId, lastSyncAt: ts } satisfies SyncCursor);
  await idbDone(tx);
}

export async function deleteCursor(itemId: string): Promise<void> {
  const db = await openGratisDb();
  const tx = db.transaction('sync_cursors', 'readwrite');
  tx.objectStore('sync_cursors').delete(itemId);
  await idbDone(tx);
}
