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
 *   - Recovery never depends on sync succeeding -- the queue is its
 *     own export-able artifact.
 */

import type { FeatureField, PickListData } from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';

/** Database name for the portal-web origin. One DB across all
 *  deployments cached on this device; the store keys carry the
 *  deployment id so multi-deployment users don't collide. */
export const OFFLINE_DB_NAME = 'gratisgis-offline';

/**
 * Schema version. Bump when adding stores or changing key paths;
 * `onupgradeneeded` migrates forward. Old caches are best-effort
 * preserved -- if a deployment was cached on v1 and the user updates
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
  /** The fields themselves -- what the client saw at download time.
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
}

/** Pending operation queued offline. Mirrors the doc's QueueRecord
 *  shape exactly. */
export interface QueueRecord {
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
  syncStatus: 'pending' | 'syncing' | 'synced' | 'failed';
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
// Queue
// ---------------------------------------------------------------------------

export async function enqueueRecord(record: QueueRecord): Promise<void> {
  await withStore(STORES.queue, 'readwrite', (s) => {
    s.put(record);
  });
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

/**
 * Format a byte count for display ("4.2 MB", "1.1 GB"). Used in the
 * download-progress UI and the cached-deployments list.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

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
