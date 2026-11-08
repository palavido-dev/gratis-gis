// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *   - ownerUserId  the portal account that captured it (absent on rows
 *                  written before ownership, and on anonymous captures)
 *
 * The Phase 1 implementation here keeps the API surface small. We use
 * the browser's native IndexedDB API directly (no `idb` package) so
 * the runtime works without a network round-trip on first paint and
 * doesn't pull in another dep just to wrap promises.
 */

import { isQueueRowOwnedBy } from '@gratis-gis/shared-types';
import { clientUuid } from './uuid';

// LOCKSTEP: public/sw.js duplicates this DB name, the store name, and
// the queued-submission record shape for its Background Sync drain (a
// service worker cannot import TS). Any change here must be mirrored
// there, and vice versa.
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
  /**
   * Who captured it, from the device identity at capture time. A row
   * is listed and sent only under that account (isQueueRowOwnedBy), so
   * on a shared device one person's answers are never posted under the
   * next person's session. Additive, so no database version bump: a
   * row without it keeps the pre-ownership behaviour.
   */
  ownerUserId?: string;
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
    req.onsuccess = () => {
      const db = req.result;
      // A newer build asking for a higher version must not be blocked
      // by this cached connection. Close it and let the next call
      // reopen at whatever version is current.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
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
  // Idempotency key for a queued submission. clientUuid works on
  // the plain-HTTP address a NAS uses; a direct randomUUID does not.
  return clientUuid();
}

/**
 * Queue a fresh submission. Returns the assigned clientId so the
 * caller can show "saved" feedback before any network attempt.
 */
export async function queueSubmission(opts: {
  formId: string;
  schemaVersion: number;
  response: Record<string, unknown>;
  /** The device identity (getOfflineIdentity), or null when nobody
   *  is signed in. */
  ownerUserId: string | null;
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
  if (opts.ownerUserId) row.ownerUserId = opts.ownerUserId;
  await new Promise<void>((resolve, reject) => {
    const r = tx(db, 'readwrite').add(row);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
  return row;
}

async function listAll(): Promise<QueuedSubmission[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = tx(db, 'readonly').getAll();
    r.onsuccess = () => resolve((r.result as QueuedSubmission[]) ?? []);
    r.onerror = () => reject(r.error);
  });
}

/** Queued submissions the given account may see and send. */
export async function listQueued(
  currentUserId: string | null,
): Promise<QueuedSubmission[]> {
  return (await listAll()).filter((r) => isQueueRowOwnedBy(r, currentUserId));
}

/** Unsent submissions that belong to `currentUserId` (or to nobody).
 *  The sign-out guard adds these to its unsynced count. */
export async function countUnsentSubmissions(
  currentUserId: string | null,
): Promise<number> {
  return (await listQueued(currentUserId)).filter((r) => r.status !== 'sent')
    .length;
}

function isForeign(row: QueuedSubmission, currentUserId: string): boolean {
  return row.ownerUserId !== undefined && row.ownerUserId !== currentUserId;
}

/** Unsent submissions another account left on this device. */
export async function countForeignSubmissions(
  currentUserId: string,
): Promise<number> {
  return (await listAll()).filter(
    (r) => r.status !== 'sent' && isForeign(r, currentUserId),
  ).length;
}

/** Delete every submission another account left on this device.
 *  Only after the person chose to remove that account's data. */
export async function removeForeignSubmissions(
  currentUserId: string,
): Promise<number> {
  const db = await openDb();
  const foreign = (await listAll()).filter((r) => isForeign(r, currentUserId));
  await Promise.all(foreign.map((r) => del(db, r.clientId)));
  return foreign.filter((r) => r.status !== 'sent').length;
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
  const all = (await listAll()).filter((r) => r.status === 'sent');
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
 * Drain the queued submissions for a given form that belong to
 * `currentUserId`, against the supplied sender. The sender is responsible for authentication; this helper
 * only manages queue state. Errors per row don't abort the drain --
 * the failed row stays queued for the next attempt.
 *
 * Returns counts so the caller can update the UI.
 */
export async function drain(
  formId: string,
  currentUserId: string | null,
  send: (s: QueuedSubmission) => Promise<void>,
): Promise<{ sent: number; failed: number; remaining: number }> {
  const all = await listQueued(currentUserId);
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

/** Test hook: drop the cached connection. */
export function resetFormOfflineDbForTests(): void {
  dbPromise = null;
}
