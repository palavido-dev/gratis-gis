// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * IndexedDB-backed offline store for field-mode deployments.
 *
 * Implements the schema described in docs/field-offline-recovery.md:
 * five object stores (deployments, features, forms, pickLists, queue)
 * keyed by composite paths so multiple deployments cached on one
 * device don't collide. Promise-based wrapper over the native
 * IndexedDB API; no third-party dependencies.
 *
 * Critical design choices the doc settled:
 *   - Records are JSON, never opaque sqlite or geodatabase blobs.
 *   - Filenames + admin-facing labels avoid GUIDs.
 *   - Recovery never depends on sync succeeding; the queue is its
 *     own export-able artifact.
 */

import {
  foldQueuedChain,
  type FoldableEdit,
  type QueueOp,
} from '@gratis-gis/shared-types';
import type { FeatureField, PickListData } from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';

/** Database name for the portal-web origin. One DB across all
 *  deployments cached on this device; the store keys carry the
 *  deployment id so multi-deployment users don't collide.
 *
 * !!! LOCKSTEP WARNING (public/sw.js) !!!
 * The service worker replays the `queue` store during Background
 * Sync (so captures still upload after the tab closes) and reads
 * `deployments` bboxes to pin downloaded tiles against cache
 * eviction. A service worker cannot import this module, so sw.js
 * duplicates BY HAND: this DB name, the 'queue' and 'deployments'
 * store names and key paths, the QueueRecord fields it touches
 * (syncStatus, lastAttemptAt, retryCount, failureReason, op,
 * dataLayerId, layerKey, globalId, geometry, properties, queuedAt,
 * dataCollectionId, id), CachedDeployment.bbox, and the replay
 * endpoints from offline-sync.ts. If you rename a store, change a
 * key path, add a syncStatus value, or move an endpoint, update
 * public/sw.js in the same change or background replay silently
 * stops matching this schema.
 *
 * `id` is an OPERATION id, not the feature's globalId (see QueueRecord
 * below), so the queue can hold more than one outstanding edit per
 * feature. Both drains must therefore replay a feature's rows in
 * queuedAt order and stop that feature's chain at the first failure,
 * or an update overtakes the insert it depends on and takes a 404.
 * `queueChainHeads` here and `chainHeads` in sw.js are the two copies
 * of that rule. */
export const OFFLINE_DB_NAME = 'gratisgis-offline';

/**
 * Schema version. Bump when adding stores or changing key paths;
 * `onupgradeneeded` migrates forward. Old caches are best-effort
 * preserved; if a deployment was cached on v1 and the user updates
 * to v2 with a breaking change, we'd issue a notice that they need
 * to re-download (better than silently truncating).
 */
const SCHEMA_VERSION = 1;

/** Cached feature row stored in the `features` object store. */
export interface CachedFeature {
  dataCollectionId: string;
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  /** Full GeoJSON feature payload as we received it from the server. */
  feature: GeoJSON.Feature;
  /** Wall-clock when this row was cached. ISO 8601. */
  cachedAt: string;
}

/** Cached form schema with the deployment scope it belongs to. */
export interface CachedForm {
  dataCollectionId: string;
  formItemId: string;
  schema: FormSchema;
  cachedAt: string;
}

/** Cached pick list with the deployment scope it belongs to. */
export interface CachedPickList {
  dataCollectionId: string;
  pickListItemId: string;
  data: PickListData;
  cachedAt: string;
}

/** Per-layer schema snapshot captured at download time. Sync time
 *  hashes the live layer schema and compares against this so we can
 *  surface "your edit was authored against an old shape" cleanly. */
export interface CachedLayerSchema {
  dataLayerId: string;
  layerKey: string;
  /** SHA-256 of the canonical-JSON serialised fields list. */
  schemaHash: string;
  /** The fields themselves, i.e. what the client saw at download time.
   *  Stored alongside the hash so the admin recovery console can
   *  show diffs without re-fetching the original. */
  fields: FeatureField[];
}

/** Top-level manifest entry for one cached deployment. */
export interface CachedDeployment {
  /** data_collection item id; primary key for this store. */
  dataCollectionId: string;
  /** Human-friendly label for the deployment, copied from the item
   *  title at download time. Used in admin-facing labels and the
   *  exported queue filename. */
  title: string;
  /** Slug derived from the title for the export filename. Lower-case,
   *  alphanumeric + hyphens, max 60 chars. */
  slug: string;
  /** Bound map item id for context. */
  mapId: string;
  /**
   * EPSG:4326 envelope cached, [west, south, east, north]. When the
   * deployment's offline config didn't specify one, the manifest
   * records the union of all layer extents we sized against.
   */
  bbox?: [number, number, number, number];
  /** Per-editable-layer schema snapshots, keyed by `<dataLayerId>:<layerKey>`. */
  layerSchemas: Record<string, CachedLayerSchema>;
  /** ISO timestamp of the most recent successful download / refresh. */
  cachedAt: string;
  /**
   * Estimated bytes occupied across all this deployment's stores
   * (features + forms + pickLists). Updated at download time so the
   * UI can show "this deployment uses ~5 MB" without iterating.
   */
  estimatedSize: number;
  /**
   * Set when the download did not cache everything it set out to.
   *
   * The manifest used to be written unconditionally, so a run that
   * skipped a layer on an HTTP error, or hit the storage quota
   * halfway through the tiles, still ended as "Ready for offline"
   * over a cache with holes in it. A collector then drove somewhere
   * with no signal on the strength of that badge. A partial cache is
   * still worth keeping, so the run persists what it got; it just has
   * to say so.
   */
  partial?: {
    /** Short reasons, one per thing that did not make it. */
    reasons: string[];
    /** True when at least one reason was the device running out of
     *  storage, which is the reason the user can actually act on. */
    outOfSpace: boolean;
  };
}

/** Pending operation queued offline. Mirrors the doc's QueueRecord
 *  shape exactly. LOCKSTEP: public/sw.js replays these rows during
 *  Background Sync; see the warning on OFFLINE_DB_NAME above before
 *  changing any field or status value. */
export interface QueueRecord {
  /**
   * Identity of the OPERATION, not of the feature.
   *
   * This used to be the feature's globalId, which made the store's
   * composite key one-row-per-feature and turned a second offline edit
   * into a `put` over the first. An insert edited before it synced was
   * silently replaced by an update, which replayed as a PATCH against
   * a globalId the server had never seen, 404'd, and parked as
   * terminally rejected. See `enqueueEdit`.
   *
   * The key path did not have to change to fix that: nothing outside
   * the store ever read `id` as a feature id (the drains use it only
   * to address the row, and the UI reads `globalId`). Making it an
   * operation id therefore needs no IndexedDB migration, which matters
   * because the rows at risk are unsynced field captures and a
   * botched `onupgradeneeded` would destroy exactly what this fix
   * exists to protect. Rows written by the old build carry
   * `id === globalId`, which is still a valid unique operation id.
   */
  id: string;
  dataCollectionId: string;
  op: 'insert' | 'update' | 'delete';
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  geometry: GeoJSON.Geometry | null;
  properties: Record<string, unknown> | null;
  queuedAt: string;
  schemaHash: string;
  /**
   * 'pending' and 'failed' are retried by every drain; 'failed' just
   * carries the last reason and a count. 'rejected' is terminal: the
   * server refused the edit deterministically (validator, sharing, a
   * conflict), so no drain touches it again until a person retries it
   * (back to 'pending') or discards it. 'synced' is unused in
   * practice, since a synced row is deleted, but the service worker
   * still recognises it.
   */
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed' | 'rejected';
  failureReason?: string;
  lastAttemptAt?: string;
  retryCount?: number;
  /** Slice 6 attachment refs; empty in slice 5. */
  attachments?: Array<{
    blobId: string;
    mimeType: string;
  }>;
}

const STORES = {
  deployments: 'deployments',
  features: 'features',
  forms: 'forms',
  pickLists: 'pickLists',
  queue: 'queue',
} as const;

type StoreName = (typeof STORES)[keyof typeof STORES];

/**
 * Open the offline database, running migrations as needed. The
 * caller almost always wants `withStore` / the helpers below; opening
 * directly is exposed for tests and for the rare case where a long-
 * running task needs to hold the connection.
 */
export function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      // v1: bootstrap every store. Future schema bumps gate on
      // `e.oldVersion` to migrate forward.
      if (e.oldVersion < 1) {
        if (!db.objectStoreNames.contains(STORES.deployments)) {
          db.createObjectStore(STORES.deployments, {
            keyPath: 'dataCollectionId',
          });
        }
        if (!db.objectStoreNames.contains(STORES.features)) {
          const s = db.createObjectStore(STORES.features, {
            keyPath: ['dataCollectionId', 'dataLayerId', 'layerKey', 'globalId'],
          });
          // Index for "give me every feature for layer X in deployment Y".
          s.createIndex(
            'by_layer',
            ['dataCollectionId', 'dataLayerId', 'layerKey'],
            { unique: false },
          );
          // Index for "everything cached for this deployment".
          s.createIndex('by_deployment', 'dataCollectionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.forms)) {
          db.createObjectStore(STORES.forms, {
            keyPath: ['dataCollectionId', 'formItemId'],
          });
        }
        if (!db.objectStoreNames.contains(STORES.pickLists)) {
          db.createObjectStore(STORES.pickLists, {
            keyPath: ['dataCollectionId', 'pickListItemId'],
          });
        }
        if (!db.objectStoreNames.contains(STORES.queue)) {
          const s = db.createObjectStore(STORES.queue, {
            keyPath: ['dataCollectionId', 'id'],
          });
          // Lets the queue review drawer filter by status without a
          // full scan.
          s.createIndex(
            'by_status',
            ['dataCollectionId', 'syncStatus'],
            { unique: false },
          );
          s.createIndex('by_deployment', 'dataCollectionId', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => {
      // Another tab is holding an old version. Surface a recoverable
      // error rather than hanging.
      reject(
        new Error(
          'Offline cache is in use by another tab; close other tabs and retry.',
        ),
      );
    };
  });
}

/**
 * Run a callback inside an IDB transaction, awaiting completion.
 * Most helpers below thin-wrap this with a hardcoded mode + store.
 */
async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const db = await openOfflineDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = Promise.resolve(fn(store));
    tx.oncomplete = () => {
      void result.then(resolve).catch(reject);
    };
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
}

/** Promisify an IDBRequest. */
function reqAsPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IDB request failed'));
  });
}

// ---------------------------------------------------------------------------
// Deployments manifest
// ---------------------------------------------------------------------------

export async function putDeployment(d: CachedDeployment): Promise<void> {
  await withStore(STORES.deployments, 'readwrite', (s) => {
    s.put(d);
  });
}

export async function getDeployment(
  dataCollectionId: string,
): Promise<CachedDeployment | null> {
  return withStore(STORES.deployments, 'readonly', async (s) => {
    const r = await reqAsPromise(s.get(dataCollectionId));
    return (r as CachedDeployment | undefined) ?? null;
  });
}

export async function listDeployments(): Promise<CachedDeployment[]> {
  return withStore(STORES.deployments, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    return (r as CachedDeployment[] | undefined) ?? [];
  });
}

export async function deleteDeployment(
  dataCollectionId: string,
): Promise<void> {
  // Cascade: remove every record across stores keyed by this deployment.
  // Done as separate transactions because IndexedDB doesn't support
  // multi-store deletes via index range natively. Each store is
  // walked via its by_deployment index where present.
  await deleteByDeploymentIndex(STORES.features, dataCollectionId);
  await deleteByDeploymentIndex(STORES.queue, dataCollectionId);
  await deleteByPrefix(STORES.forms, dataCollectionId);
  await deleteByPrefix(STORES.pickLists, dataCollectionId);
  await withStore(STORES.deployments, 'readwrite', (s) => {
    s.delete(dataCollectionId);
  });
}

/**
 * Drop every cached READ, across all deployments, keeping the write
 * queue and the deployment manifests.
 *
 * For sign-out on a shared device. Cached features, form schemas and
 * pick lists are the departing user's org data, fetched with their
 * session, and left in place the next person to pick up the tablet
 * could read all of it without ever signing in. The service worker
 * already purged its tile and geojson caches on sign-out; the
 * IndexedDB half was simply never joined to it.
 *
 * Two things are deliberately KEPT:
 *
 *   - The write queue. Those are captures that have not reached the
 *     server, and destroying someone's unsynced field work to tidy up
 *     a cache is a far worse outcome than the leak it closes. The
 *     sign-out flow warns when any exist instead.
 *   - The deployment manifests. They carry a title and a size, not
 *     feature data, and dropping them would hide any queued rows from
 *     every screen that could still drain them. Keeping them is what
 *     makes leaving the queue in place useful rather than a trap.
 */
export async function purgeCachedReadData(): Promise<void> {
  await clearStore(STORES.features);
  await clearStore(STORES.forms);
  await clearStore(STORES.pickLists);
}

/** Empty one store, tolerating a database that does not exist yet. */
async function clearStore(storeName: StoreName): Promise<void> {
  await withStore(storeName, 'readwrite', (s) => {
    s.clear();
  });
}

/** How many edits are still waiting to reach the server, across every
 *  deployment on this device. Read by the sign-out flow so it can warn
 *  before a person walks away from unsynced work. */
export async function countUnsyncedEdits(): Promise<number> {
  return withStore(STORES.queue, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    const rows = (r as QueueRecord[] | undefined) ?? [];
    return rows.filter((row) => row.syncStatus !== 'synced').length;
  });
}

/** Walk a store's `by_deployment` index and delete every match. */
async function deleteByDeploymentIndex(
  storeName: StoreName,
  dataCollectionId: string,
): Promise<void> {
  await withStore(storeName, 'readwrite', async (s) => {
    const idx = s.index('by_deployment');
    const cursor = idx.openCursor(IDBKeyRange.only(dataCollectionId));
    return new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve();
          return;
        }
        c.delete();
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('cursor failed'));
    });
  });
}

/** For stores keyed by `[dataCollectionId, ...]` without a
 *  by_deployment index, delete with an open cursor scoped to the
 *  deployment-id prefix. */
async function deleteByPrefix(
  storeName: StoreName,
  dataCollectionId: string,
): Promise<void> {
  await withStore(storeName, 'readwrite', async (s) => {
    const range = IDBKeyRange.bound(
      [dataCollectionId, ''],
      [dataCollectionId, '￿'],
    );
    const cursor = s.openCursor(range);
    return new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve();
          return;
        }
        c.delete();
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('cursor failed'));
    });
  });
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export async function putFeatures(rows: CachedFeature[]): Promise<void> {
  if (rows.length === 0) return;
  await withStore(STORES.features, 'readwrite', (s) => {
    for (const r of rows) s.put(r);
  });
}

export async function listFeaturesForLayer(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
): Promise<GeoJSON.Feature[]> {
  return withStore(STORES.features, 'readonly', async (s) => {
    const idx = s.index('by_layer');
    const r = await reqAsPromise(
      idx.getAll(IDBKeyRange.only([dataCollectionId, dataLayerId, layerKey])),
    );
    const rows = (r as CachedFeature[] | undefined) ?? [];
    return rows.map((row) => row.feature);
  });
}

// ---------------------------------------------------------------------------
// Forms + pick lists
// ---------------------------------------------------------------------------

export async function putForm(row: CachedForm): Promise<void> {
  await withStore(STORES.forms, 'readwrite', (s) => {
    s.put(row);
  });
}

export async function getForm(
  dataCollectionId: string,
  formItemId: string,
): Promise<FormSchema | null> {
  return withStore(STORES.forms, 'readonly', async (s) => {
    const r = await reqAsPromise(s.get([dataCollectionId, formItemId]));
    const row = r as CachedForm | undefined;
    return row?.schema ?? null;
  });
}

export async function putPickList(row: CachedPickList): Promise<void> {
  await withStore(STORES.pickLists, 'readwrite', (s) => {
    s.put(row);
  });
}

export async function listPickListsForDeployment(
  dataCollectionId: string,
): Promise<Record<string, PickListData>> {
  return withStore(STORES.pickLists, 'readonly', async (s) => {
    const range = IDBKeyRange.bound(
      [dataCollectionId, ''],
      [dataCollectionId, '￿'],
    );
    const r = await reqAsPromise(s.getAll(range));
    const rows = (r as CachedPickList[] | undefined) ?? [];
    const out: Record<string, PickListData> = {};
    for (const row of rows) out[row.pickListItemId] = row.data;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Background Sync arming
// ---------------------------------------------------------------------------

/** One-shot Background Sync tag the service worker listens for.
 *  LOCKSTEP: must match SYNC_TAG in public/sw.js. */
export const BACKGROUND_SYNC_TAG = 'gg-offline-queue';

/** Narrow structural type for the Background Sync surface so this
 *  compiles regardless of whether the ambient DOM lib ships
 *  SyncManager typings. */
type SyncCapableRegistration = ServiceWorkerRegistration & {
  sync?: { register(tag: string): Promise<void> };
};

/**
 * Ask the browser to fire the service worker's 'sync' event when
 * connectivity returns, so queued captures replay even if every tab
 * closes first. Fire-and-forget on purpose:
 *   - navigator.serviceWorker.ready never resolves in dev (the
 *     SwRegistrar unregisters the worker there), and an enqueue must
 *     never block on service worker state;
 *   - Background Sync is Chromium-only. Firefox/Safari fail the
 *     feature checks and fall back silently to the existing in-app
 *     online drains (offline-sync.ts and the forms respond page),
 *     which remain the primary replay path everywhere.
 */
export function requestBackgroundSync(): void {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    if (typeof window === 'undefined' || !('SyncManager' in window)) return;
    void navigator.serviceWorker.ready
      .then((reg) =>
        (reg as SyncCapableRegistration).sync?.register(BACKGROUND_SYNC_TAG),
      )
      .catch(() => {
        // Registration can be denied (permissions policy, private
        // mode). The in-app drain still covers those sessions.
      });
  } catch {
    // Arming sync must never break a queue write.
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * Generate a v4 UUID. Used for both operation ids and the client-side
 * globalId on a queued insert, so the two share one generator.
 */
export function newUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 shape. Not cryptographically strong; only reached on
  // browsers without crypto.randomUUID, and on a non-secure origin,
  // where the whole offline arc is unavailable anyway.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** One field edit, as the runtime hands it over. The store assigns the
 *  operation id, the timestamp and the initial status. */
export interface FeatureEditInput {
  dataCollectionId: string;
  op: QueueOp;
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  geometry: GeoJSON.Geometry | null;
  properties: Record<string, unknown> | null;
  schemaHash: string;
  attachments?: QueueRecord['attachments'];
}

/**
 * What `enqueueEdit` did. `annihilated` means the queue now holds
 * nothing for this feature: it was captured and deleted without ever
 * reaching the server, so there is no work left to replay.
 */
export type EnqueueResult =
  | { kind: 'queued'; record: QueueRecord }
  | { kind: 'folded'; record: QueueRecord; replaced: number }
  | { kind: 'annihilated'; replaced: number };

/** A row this edit is allowed to fold into. Deliberately excludes
 *  'syncing' (a drain owns it and would delete the merged result when
 *  its own replay succeeds) and 'rejected' (parked for a person to
 *  decide about; quietly rewriting it would discard their pending
 *  decision). Both cases fall through to a second row, and the drains
 *  order the pair per feature. */
function isFoldable(row: QueueRecord): boolean {
  return row.syncStatus === 'pending' || row.syncStatus === 'failed';
}

/**
 * Queue one field edit, folding it into this feature's outstanding
 * edit when there is one.
 *
 * The read-modify-write runs inside a SINGLE readwrite transaction.
 * IndexedDB serialises readwrite transactions per store, so two
 * enqueues racing (two taps, or a tap during a drain) cannot both read
 * the same prior row and each write a fold of it, which would drop one
 * of the two edits. Doing this as a separate read then write is the
 * bug in miniature.
 *
 * Returns what happened so the caller can keep its badge count honest
 * without re-listing the queue.
 */
export async function enqueueEdit(
  edit: FeatureEditInput,
): Promise<EnqueueResult> {
  const now = new Date().toISOString();
  const result = await withStore(STORES.queue, 'readwrite', async (store) => {
    // Every row for this deployment, then narrowed to this feature.
    // The queue holds tens of rows, not thousands, so a scan costs
    // less than the schema version bump an extra index would need.
    const idx = store.index('by_deployment');
    const all =
      ((await reqAsPromise(
        idx.getAll(IDBKeyRange.only(edit.dataCollectionId)),
      )) as QueueRecord[] | undefined) ?? [];
    const sameFeature = all.filter(
      (r) =>
        r.globalId === edit.globalId &&
        r.dataLayerId === edit.dataLayerId &&
        r.layerKey === edit.layerKey,
    );
    const foldable = sameFeature
      .filter(isFoldable)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

    const incoming: FoldableEdit = {
      op: edit.op,
      geometry: edit.geometry,
      properties: edit.properties,
    };

    if (foldable.length === 0) {
      // Either the first edit for this feature, or every existing row
      // is in flight or parked. A fresh row; the drains will replay
      // this feature's rows in order.
      const record: QueueRecord = {
        id: newUuid(),
        dataCollectionId: edit.dataCollectionId,
        op: edit.op,
        dataLayerId: edit.dataLayerId,
        layerKey: edit.layerKey,
        globalId: edit.globalId,
        geometry: edit.geometry,
        properties: edit.properties,
        queuedAt: now,
        schemaHash: edit.schemaHash,
        syncStatus: 'pending',
        ...(edit.attachments ? { attachments: edit.attachments } : {}),
      };
      store.put(record);
      return { kind: 'queued', record } as EnqueueResult;
    }

    const folded = foldQueuedChain([
      ...foldable.map(
        (r): FoldableEdit => ({
          op: r.op,
          geometry: r.geometry,
          properties: r.properties,
        }),
      ),
      incoming,
    ]);

    // The surviving row keeps the OLDEST row's id and queuedAt, so the
    // feature's place in replay order is where the user first touched
    // it, and any UI holding the id still resolves. Everything else in
    // the chain goes; normally there is nothing else, but a queue
    // written by a build without folding can hold several and heals
    // here.
    const keep = foldable[0]!;
    for (const row of foldable) {
      if (row.id !== keep.id) {
        store.delete([row.dataCollectionId, row.id]);
      }
    }

    if (folded.kind === 'annihilated') {
      store.delete([keep.dataCollectionId, keep.id]);
      return { kind: 'annihilated', replaced: foldable.length } as EnqueueResult;
    }

    // Destructured off rather than set to undefined: the workspace
    // compiles with exactOptionalPropertyTypes, so an explicit
    // undefined is not assignable to an optional field. Dropping the
    // keys is also what we mean, since a row that has been rewritten
    // has no last failure and no last attempt.
    const {
      failureReason: _priorReason,
      lastAttemptAt: _priorAttempt,
      ...keepRest
    } = keep;
    void _priorReason;
    void _priorAttempt;
    const record: QueueRecord = {
      ...keepRest,
      op: folded.edit.op,
      geometry: (folded.edit.geometry as GeoJSON.Geometry | null) ?? null,
      properties: folded.edit.properties,
      // The edit was authored against the schema the user is looking
      // at now, so the newer hash is the truthful one.
      schemaHash: edit.schemaHash,
      // New bytes deserve a fresh attempt: a row that had backed off
      // after failures should not inherit that delay once the user has
      // changed what it sends.
      syncStatus: 'pending',
      retryCount: 0,
      ...(edit.attachments ? { attachments: edit.attachments } : {}),
    };
    store.put(record);
    return {
      kind: 'folded',
      record,
      replaced: foldable.length,
    } as EnqueueResult;
  });

  // Arm a background replay so the edit reaches the server even if the
  // worker pockets the phone and the tab dies before coverage returns.
  // After the write, so a registration that fires instantly still
  // finds the row. Nothing to replay when the edit annihilated.
  if (result.kind !== 'annihilated') requestBackgroundSync();
  return result;
}

/**
 * Raw put of a queue row, bypassing the fold.
 *
 * Retained for callers that are rewriting a row they already hold (the
 * drains' status bookkeeping). New EDITS must go through
 * `enqueueEdit`: this function is where the insert-then-edit data loss
 * lived, and calling it with a fresh edit reintroduces it.
 */
export async function enqueueRecord(record: QueueRecord): Promise<void> {
  await withStore(STORES.queue, 'readwrite', (s) => {
    s.put(record);
  });
  requestBackgroundSync();
}

export async function listQueue(
  dataCollectionId: string,
): Promise<QueueRecord[]> {
  return withStore(STORES.queue, 'readonly', async (s) => {
    const idx = s.index('by_deployment');
    const r = await reqAsPromise(idx.getAll(IDBKeyRange.only(dataCollectionId)));
    return (r as QueueRecord[] | undefined) ?? [];
  });
}

export async function listQueueByStatus(
  dataCollectionId: string,
  status: QueueRecord['syncStatus'],
): Promise<QueueRecord[]> {
  return withStore(STORES.queue, 'readonly', async (s) => {
    const idx = s.index('by_status');
    const r = await reqAsPromise(
      idx.getAll(IDBKeyRange.only([dataCollectionId, status])),
    );
    return (r as QueueRecord[] | undefined) ?? [];
  });
}

/**
 * Claim one queue row for replay: re-read it and flip it to 'syncing'
 * inside ONE readwrite transaction.
 *
 * IndexedDB serialises readwrite transactions per store, so of two
 * concurrent claimants exactly one sees the row in a claimable state.
 * The in-app drain used to list rows and then write them in separate
 * transactions, which left a window where it and the service worker
 * both replayed the same edit; only server-side idempotency kept that
 * from double-creating features. Returns the claimed row, or null when
 * the row is gone or someone else took it first.
 *
 * Mirrors `claimRow` in public/sw.js.
 */
export async function claimQueueRow(
  dataCollectionId: string,
  id: string,
  canClaim: (row: QueueRecord) => boolean,
): Promise<QueueRecord | null> {
  return withStore(STORES.queue, 'readwrite', async (store) => {
    const existing = (await reqAsPromise(
      store.get([dataCollectionId, id]),
    )) as QueueRecord | undefined;
    if (!existing || !canClaim(existing)) return null;
    const claimed: QueueRecord = {
      ...existing,
      syncStatus: 'syncing',
      lastAttemptAt: new Date().toISOString(),
    };
    store.put(claimed);
    return claimed;
  });
}

export async function updateQueueRecord(record: QueueRecord): Promise<void> {
  await withStore(STORES.queue, 'readwrite', (s) => {
    s.put(record);
  });
}

export async function deleteQueueRecord(
  dataCollectionId: string,
  id: string,
): Promise<void> {
  await withStore(STORES.queue, 'readwrite', (s) => {
    s.delete([dataCollectionId, id]);
  });
}

export async function clearQueue(dataCollectionId: string): Promise<void> {
  await deleteByDeploymentIndex(STORES.queue, dataCollectionId);
}

// ---------------------------------------------------------------------------
// Storage estimate helpers
// ---------------------------------------------------------------------------

/**
 * Wrap navigator.storage.estimate so callers can read the runtime's
 * available offline budget. Returns null when the API isn't available
 * (Safari pre-15.4, some non-secure contexts).
 */
export async function getStorageEstimate(): Promise<{
  quota: number;
  usage: number;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null;
  }
  const e = await navigator.storage.estimate();
  if (typeof e.quota !== 'number' || typeof e.usage !== 'number') return null;
  return { quota: e.quota, usage: e.usage };
}

// Byte formatting for the download-progress UI and the
// cached-deployments list moved to lib/format-bytes.ts (shared with
// every other size-rendering surface); import it from there.

// ---------------------------------------------------------------------------
// Schema hashing
// ---------------------------------------------------------------------------

/**
 * Stable hash of a layer's field list. The doc-mandated schema-diff
 * detection at sync time keys on this, so the algorithm needs to be
 * deterministic across browser sessions and across server / client.
 *
 * We canonicalise the field list (sort keys, drop optional fields with
 * undefined values, stringify with stable JSON.stringify), then SHA-256
 * via the SubtleCrypto API. The SHA truncates to 16 hex chars (8 bytes
 * of entropy) for header-friendly compactness; collisions are
 * astronomically unlikely on the small input universe.
 */
export async function hashLayerSchema(
  fields: FeatureField[],
): Promise<string> {
  const canon = fields
    .map((f) => ({
      name: f.name,
      type: f.type,
      nullable: f.nullable === true,
      domain: f.domain ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const text = JSON.stringify(canon);
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // Fallback for non-secure contexts: simple FNV-1a 32-bit. NOT a
    // real cryptographic hash, but good enough as a change-detector
    // when SubtleCrypto isn't available.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return `fnv1a:${h.toString(16).padStart(8, '0')}`;
  }
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Build a slug from a deployment title. Used for the human-readable
 * filename of an exported queue. Falls back to "deployment" when the
 * title is empty or all-non-alphanumeric.
 */
export function deploymentSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'deployment';
}
