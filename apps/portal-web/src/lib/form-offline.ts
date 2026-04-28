/**
 * Offline-first submission queue for the Data Collection runtime
 * (#131). Submissions are persisted to IndexedDB on capture and
 * drained when network returns. Each queued row carries:
 *
 *   - clientId     stable client-generated UUID (idempotency key)
 *   - formId       the form item the response was captured against
 *   - schemaVersion of that form at capture time, so a forward-rolled
 *                  schema can still resolve the submission server-side
 *   - response     the pruned Response object
 *   - capturedAt   ISO timestamp
 *   - status       'queued' | 'sending' | 'sent' | 'failed'
 *   - lastError    last failure reason for the Outbox UI
 *   - attempts     number of send attempts so far
 *
 * The Phase 1 implementation here keeps the API surface small. We use
 * the browser's native IndexedDB API directly (no `idb` package) so
 * the runtime works without a network round-trip on first paint and
 * doesn't pull in another dep just to wrap promises.
 */

const DB_NAME = 'gratisgis-forms';
const DB_VERSION = 1;
const STORE = 'submissions';

export interface QueuedSubmission {
  clientId: string;
  formId: string;
  schemaVersion: number;
  response: Record<string, unknown>;
  capturedAt: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  lastError?: string;
  attempts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'clientId' });
        store.createIndex('byForm', 'formId');
        store.createIndex('byStatus', 'status');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function genClientId(): string {
  // RFC 4122 v4 via crypto when available; otherwise a high-entropy
  // fallback. Either way it's idempotency-strong enough for our use.
  if (
    typeof crypto !== 'undefined' &&
    typeof (crypto as Crypto & { randomUUID?: () => string }).randomUUID === 'function'
  ) {
    return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
  }
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Queue a fresh submission. Returns the assigned clientId so the
 * caller can show "saved" feedback before any network attempt.
 */
export async function queueSubmission(opts: {
  formId: string;
  schemaVersion: number;
  response: Record<string, unknown>;
}): Promise<QueuedSubmission> {
  const db = await openDb();
  const row: QueuedSubmission = {
    clientId: genClientId(),
    formId: opts.formId,
    schemaVersion: opts.schemaVersion,
    response: opts.response,
    capturedAt: new Date().toISOString(),
    status: 'queued',
    attempts: 0,
  };
  await new Promise<void>((resolve, reject) => {
    const r = tx(db, 'readwrite').add(row);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
  return row;
}

export async function listQueued(): Promise<QueuedSubmission[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly').getAll();
    r.onsuccess = () => resolve((r.result as QueuedSubmission[]) ?? []);
    r.onerror = () => reject(r.error);
  });
}

export async function markSent(clientId: string): Promise<void> {
  const db = await openDb();
  await update(db, clientId, (row) => ({ ...row, status: 'sent' }));
}

export async function markFailed(
  clientId: string,
  error: string,
): Promise<void> {
  const db = await openDb();
  await update(db, clientId, (row) => ({
    ...row,
    status: 'failed',
    lastError: error,
    attempts: row.attempts + 1,
  }));
}

export async function clearSent(): Promise<void> {
  const db = await openDb();
  const all = (await listQueued()).filter((r) => r.status === 'sent');
  await Promise.all(all.map((r) => del(db, r.clientId)));
}

function del(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readwrite').delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function update(
  db: IDBDatabase,
  key: string,
  patch: (row: QueuedSubmission) => QueuedSubmission,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const get = store.get(key);
    get.onsuccess = () => {
      const row = get.result as QueuedSubmission | undefined;
      if (!row) {
        resolve();
        return;
      }
      const next = patch(row);
      const put = store.put(next);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}

/**
 * Drain all queued submissions for a given form against the supplied
 * sender. The sender is responsible for authentication; this helper
 * only manages queue state. Errors per row don't abort the drain --
 * the failed row stays queued for the next attempt.
 *
 * Returns counts so the caller can update the UI.
 */
export async function drain(
  formId: string,
  send: (s: QueuedSubmission) => Promise<void>,
): Promise<{ sent: number; failed: number; remaining: number }> {
  const all = await listQueued();
  const mine = all.filter((r) => r.formId === formId && r.status !== 'sent');
  let sent = 0;
  let failed = 0;
  for (const row of mine) {
    try {
      await send(row);
      await markSent(row.clientId);
      sent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      await markFailed(row.clientId, msg);
      failed += 1;
    }
  }
  return { sent, failed, remaining: mine.length - sent };
}
