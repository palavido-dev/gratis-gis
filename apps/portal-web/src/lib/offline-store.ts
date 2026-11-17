// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * IndexedDB-backed offline store for field-mode deployments.
 *
 * Implements the schema described in docs/field-offline-recovery.md:
 * seven object stores (deployments, features, forms, pickLists, queue,
 * since schema v2 blobs, and since schema v3 meta) keyed by composite
 * paths so multiple deployments cached on one device don't collide.
 * Promise-based wrapper over the native IndexedDB API; no third-party
 * dependencies.
 *
 * Critical design choices the doc settled:
 *   - Records are JSON, never opaque sqlite or geodatabase blobs.
 *   - Filenames + admin-facing labels avoid GUIDs.
 *   - Recovery never depends on sync succeeding; the queue is its
 *     own export-able artifact.
 */

import {
  canonicalLayerSchema,
  foldQueuedChain,
  isQueueRowOwnedBy,
  type FoldableEdit,
  type OfflineMessage,
  type QueueOp,
} from '@gratis-gis/shared-types';
import type { FeatureField, PickListData } from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import { clientUuid } from './uuid';
import {
  countForeignSubmissions,
  countUnsentSubmissions,
  removeForeignSubmissions,
} from './form-offline';

/** Database name for the portal-web origin. One DB across all
 *  deployments cached on this device; the store keys carry the
 *  deployment id so multi-deployment users don't collide.
 *
 * !!! LOCKSTEP WARNING (public/sw.js) !!!
 * The service worker replays the `queue` store during Background
 * Sync (so captures still upload after the tab closes) and reads
 * `deployments` bboxes to pin downloaded tiles against cache
 * eviction. A service worker cannot import this module, so sw.js
 * duplicates BY HAND: this DB name, the 'queue', 'deployments' and
 * 'meta' store names and key paths, the identity row's key, the
 * QueueRecord fields it touches (syncStatus, lastAttemptAt,
 * retryCount, failure, op, dataLayerId, layerKey, globalId,
 * geometry, properties, queuedAt, dataCollectionId, id, ownerUserId),
 * CachedDeployment.bbox, and the replay endpoints from
 * offline-sync.ts. If you rename a store, change a key path, add a
 * syncStatus value, or move an endpoint, update public/sw.js in the
 * same change or background replay silently stops matching this
 * schema.
 *
 * `failure` is an `OfflineMessage` (schema v4), not a sentence: the row
 * is read back days later by a different person on a different device,
 * possibly in a different language, so the code is stored and the text
 * is produced at the render site by `lib/offline-message.ts`. The worker
 * writes the same shape and declares the codes it can produce; the two
 * lists are pinned in shared-types `sw-contract.spec.ts`. The v4 upgrade
 * below rewrote every `failureReason` string a v3 device was holding.
 *
 * `id` is an OPERATION id, not the feature's globalId (see QueueRecord
 * below), so the queue can hold more than one outstanding edit per
 * feature. Both drains must therefore replay a feature's rows in
 * queuedAt order and stop that feature's chain at the first failure,
 * or an update overtakes the insert it depends on and takes a 404.
 * `queueChainHeads` here and `chainHeads` in sw.js are the two copies
 * of that rule.
 *
 * The worker also reads the 'blobs' store, but only to know which
 * features still owe a file upload so it can leave those rows alone.
 * It never uploads: that needs the page's presign + PUT + register
 * walk. Same division the forms outbox already uses. */
export const OFFLINE_DB_NAME = 'gratisgis-offline';

/**
 * Schema version. Bump when adding stores or changing key paths;
 * `onupgradeneeded` migrates forward. Old caches are best-effort
 * preserved; if a deployment was cached on v1 and the user updates
 * to v2 with a breaking change, we'd issue a notice that they need
 * to re-download (better than silently truncating).
 */
const SCHEMA_VERSION = 4;

/** Store holding device-wide state that is not scoped to a deployment.
 *  Today that is one row: which portal account this device currently
 *  belongs to. LOCKSTEP: public/sw.js and public/field/offline.html
 *  read the same store and key. */
export const OFFLINE_META_STORE = 'meta';
/** Key of the identity row in the meta store. */
export const OFFLINE_IDENTITY_KEY = 'identity';

/** The identity row. Written on every authenticated page load by the
 *  identity guard, cleared by sign-out, read by both drains. */
interface OfflineIdentityRow {
  key: typeof OFFLINE_IDENTITY_KEY;
  /** Portal user id (the `id` /users/me returns, and what the server
   *  stamps into `submitted_by`). */
  userId: string;
  updatedAt: string;
  /** Set when the identity changed from another account and that
   *  account's cached reads have not been purged yet. Written in the
   *  same put as the new identity and cleared only after the purge, so
   *  a purge that fails is run again on the next load. */
  purgePending?: boolean;
}

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
  /**
   * Layer syncVersion cursor for incremental offline refresh
   * (`GET .../delta?since=N`). Set after a full GeoJSON pull seeds
   * it, and advanced on every successful delta page. Absent on
   * caches written before R3-field-delta-sync; those refresh with
   * a full pull once, then start tracking.
   */
  syncVersion?: number;
  /**
   * The area `syncVersion` is good for: [west, south, east, north],
   * or null for the whole layer. The delta endpoint has no area
   * filter, so a cursor only says "every feature inside this area is
   * cached as of version N". A refresh for an area outside it has to
   * pull those features in full first. Absent on caches written
   * before this field; those fall back to the manifest's `bbox`.
   */
  syncBbox?: [number, number, number, number] | null;
  /** Approximate bytes of this layer's cached features, carried from
   *  run to run so an incremental refresh does not report only the
   *  size of the changes it fetched. */
  bytes?: number;
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
    /** One per thing that did not make it, as a code rather than a
     *  sentence: this manifest outlives the download that wrote it and
     *  is read by whoever picks the device up, so the words are chosen
     *  at render time. Rows written before schema v4 hold
     *  `legacy.text`. */
    reasons: OfflineMessage[];
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
  /**
   * Why the last attempt did not land, as a code plus params.
   *
   * Was `failureReason: string` through schema v3, which meant the
   * English the drain happened to compose was frozen onto the device:
   * the rejected-edits dialog, the field runtime and the admin
   * field-queues view all render it, and none of them is necessarily
   * the person or the language that wrote it. The rename is deliberate,
   * so a row carrying the old shape is impossible to mistake for the
   * new one; the v4 upgrade rewrites the strings it finds into
   * `legacy.text`.
   */
  failure?: OfflineMessage;
  lastAttemptAt?: string;
  retryCount?: number;
  /**
   * Portal user id of the account that captured this edit. The drains
   * send a row only under the identity that owns it, so a shared
   * tablet cannot attribute one person's captures to whoever signs in
   * next (the server stamps `submitted_by` from the caller).
   *
   * Optional in the TYPE because rows written before schema v3 have no
   * owner and cannot be given one truthfully: the meta store that would
   * have recorded who was signed in is created by the same upgrade, so
   * there is nothing to stamp them from. Those rows drain under
   * whoever is current, exactly as they did before ownership existed;
   * see `isQueueRowOwnedBy`. Every row `enqueueEdit` writes carries it.
   */
  ownerUserId?: string;
  /**
   * The server observation this update or delete was made against:
   * the cached feature's `_observation_id` when the edit was queued.
   * Replay sends it as `baseObservationId` on both the checkOnly dry
   * run and the real write, so the server answers 409 when someone
   * else changed the feature meanwhile instead of silently taking the
   * last writer. A folded chain keeps the first row's base. Absent on
   * inserts, on rows written before this field existed, and when the
   * cached row had no token; those replay unguarded, as before.
   * docs/sync-protocol.md.
   */
  baseObservationId?: string;
  /**
   * Set once a drain has claimed this row, and when the online submit
   * fell back to the queue after its request was sent. Either way the
   * server may already hold this edit. Such a row is never folded
   * into: an insert that landed would be re-sent, deduplicated by the
   * server's idempotent create, and the folded correction thrown away
   * (and an insert plus delete would annihilate a feature the server
   * keeps). A later edit becomes its own row behind this one.
   */
  mayHaveReachedServer?: boolean;
}

/**
 * A file captured in the field before it could be uploaded.
 *
 * Stored as a real Blob, not base64. The forms outbox encodes its
 * attachments as data URLs because they ride inside the submission
 * JSON; a feature attachment has no such constraint, and base64 costs
 * a third more bytes of a quota that photographs exhaust quickly.
 * IndexedDB has stored Blobs natively everywhere the rest of this
 * arc already requires.
 *
 * Rows live only until the upload succeeds. The feature they belong
 * to has to reach the server first, so the drain writes the feature,
 * then walks that feature's blobs, then deletes each one it has
 * uploaded.
 */
export interface PendingBlob {
  /** Primary key, and the id the queue record references. */
  blobId: string;
  /** For the deployment cascade, and for the "remove from device"
   *  path to reclaim the bytes. */
  dataCollectionId: string;
  /** Which feature this belongs to. globalId is the client-generated
   *  id, so this resolves even before the insert has replayed. */
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  /** Capture time, not upload time. On a multi-day deployment these
   *  differ by more than they look. */
  capturedAt: string;
  /** Who captured it. Same rules as QueueRecord.ownerUserId: absent on
   *  files stored before schema v3, present on everything since. A
   *  file is uploaded only under the account that took it. */
  ownerUserId?: string;
}

const STORES = {
  deployments: 'deployments',
  features: 'features',
  forms: 'forms',
  pickLists: 'pickLists',
  queue: 'queue',
  blobs: 'blobs',
  meta: OFFLINE_META_STORE,
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
      // v2: files captured in the field before they could be
      // uploaded. Purely additive; every v1 store is untouched, which
      // is the only reason this bump is safe to run on a device
      // holding unsynced captures. Do not extend this block into
      // rewriting an existing store without a much harder look.
      if (e.oldVersion < 2) {
        if (!db.objectStoreNames.contains(STORES.blobs)) {
          const s = db.createObjectStore(STORES.blobs, {
            keyPath: 'blobId',
          });
          // "What is still waiting to upload for this feature?" The
          // drain asks it per feature after each successful write, and
          // the collect form asks it to render what it has captured.
          s.createIndex(
            'by_feature',
            ['dataCollectionId', 'dataLayerId', 'layerKey', 'globalId'],
            { unique: false },
          );
          s.createIndex('by_deployment', 'dataCollectionId', {
            unique: false,
          });
        }
      }
      // v3: which account this device belongs to, so the queue and the
      // pending files can be scoped to the person who captured them.
      // Additive again: one new store, no existing store rewritten.
      //
      // Rows already in `queue` and `blobs` are deliberately NOT
      // stamped with an owner here. The only identity this upgrade
      // could stamp from is the one in this very store, which did not
      // exist a moment ago, and guessing from whoever happens to be
      // signed in when the upgrade runs would attribute the previous
      // user's captures to them on a shared device. Unowned rows keep
      // the pre-ownership behaviour instead (they drain under whoever
      // is current, see isQueueRowOwnedBy), and every row written from
      // now on carries its owner.
      if (e.oldVersion < 3) {
        if (!db.objectStoreNames.contains(STORES.meta)) {
          db.createObjectStore(STORES.meta, { keyPath: 'key' });
        }
      }
      // v4: failure text becomes a structured OfflineMessage.
      //
      // The FIRST bump that rewrites rows rather than adding a store,
      // which the doc warns about for good reason: the rows at risk are
      // unsynced field captures. Three things keep it safe. It touches
      // only the two fields that held English (`queue.failureReason`
      // and `deployments.partial.reasons`), never geometry, properties,
      // status or ownership. It runs inside the versionchange
      // transaction, so a failure anywhere aborts the whole upgrade and
      // the device stays on v3 with its rows intact rather than half
      // converted. And a row it cannot make sense of is left exactly as
      // it is instead of being guessed at.
      //
      // A converted reason renders as the text it always was, through
      // `legacy.text`. Nothing on a device is lost, and no render site
      // has to know which shape it is looking at.
      if (e.oldVersion < 4 && e.oldVersion > 0) {
        const tx = (e.target as IDBOpenDBRequest).transaction;
        if (tx) {
          upgradeQueueFailureText(tx.objectStore(STORES.queue));
          upgradePartialReasons(tx.objectStore(STORES.deployments));
        }
      }
    };
    // Set once the caller has been answered, so a success that arrives
    // after a blocked rejection closes its connection instead of
    // leaking it.
    let settled = false;
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // A newer build opening a higher version sends versionchange to
      // every open connection and waits until they close. Without this
      // a backgrounded tab on the old build blocks the upgrade, and
      // every offline read and write in the new build fails.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      settled = true;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => {
      // Another tab is holding an old version. Surface a recoverable
      // error rather than hanging.
      settled = true;
      reject(
        new Error(
          'Offline cache is in use by another tab; close other tabs and retry.',
        ),
      );
    };
  });
}

/** Text with no code of its own. The renderer passes it through
 *  unchanged, so a row converted by the v4 upgrade reads exactly as it
 *  did before, in whatever language it was written in. */
function legacyMessage(text: string): OfflineMessage {
  return { code: 'legacy.text', params: { text } };
}

/**
 * v4: `failureReason: string` becomes `failure: OfflineMessage`.
 *
 * Synchronous by necessity: this runs inside `onupgradeneeded`, and an
 * awaited step would let the versionchange transaction commit out from
 * under the walk. Rows without the old field are not touched at all,
 * which covers both a row the service worker already wrote in the new
 * shape and a row that never failed.
 */
function upgradeQueueFailureText(store: IDBObjectStore): void {
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    const row = c.value as QueueRecord & { failureReason?: unknown };
    if ('failureReason' in row) {
      const { failureReason, ...rest } = row;
      const next: QueueRecord =
        typeof failureReason === 'string' && failureReason
          ? { ...rest, failure: legacyMessage(failureReason) }
          : rest;
      c.update(next);
    }
    c.continue();
  };
}

/** v4: the download manifest's shortfall list, same conversion. An
 *  entry that is already an object is left alone rather than wrapped
 *  twice. */
function upgradePartialReasons(store: IDBObjectStore): void {
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    const row = c.value as CachedDeployment;
    const partial = row.partial;
    const reasons: unknown = partial?.reasons;
    if (partial && Array.isArray(reasons) && reasons.some((r) => typeof r === 'string')) {
      c.update({
        ...row,
        partial: {
          ...partial,
          reasons: reasons.map((r) =>
            typeof r === 'string' ? legacyMessage(r) : (r as OfflineMessage),
          ),
        },
      });
    }
    c.continue();
  };
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
  // Each call opens its own connection, so each call closes it once
  // its transaction is over. An open connection that nobody closes
  // holds the database at this version until it is garbage
  // collected, which blocks the next schema upgrade.
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      db.close();
      reject(err);
      return;
    }
    const store = tx.objectStore(storeName);
    const result = Promise.resolve(fn(store));
    tx.oncomplete = () => {
      db.close();
      void result.then(resolve).catch(reject);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('IDB transaction failed'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('IDB transaction aborted'));
    };
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
  // Blobs are the biggest rows in the database by a wide margin, so
  // missing them here would be the loudest kind of leak.
  await deleteByDeploymentIndex(STORES.blobs, dataCollectionId);
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
 *   - The write queue, and the pending attachments beside it. Those
 *     are captures that have not reached the server, and destroying
 *     someone's unsynced field work to tidy up a cache is a far worse
 *     outcome than the leak it closes. The sign-out flow warns when
 *     any exist instead.
 *   - The deployment manifests. They carry a title and a size, not
 *     feature data, and dropping them would hide any queued rows from
 *     every screen that could still drain them. Keeping them is what
 *     makes leaving the queue in place useful rather than a trap.
 */
export async function purgeCachedReadData(): Promise<void> {
  await clearStore(STORES.features);
  await clearStore(STORES.forms);
  await clearStore(STORES.pickLists);
  await forgetFeatureCursors();
}

/**
 * Drop every manifest's per-layer sync cursor, in step with emptying
 * the features store. A cursor means "the features store already holds
 * this layer as of version N"; left behind after a purge, the next
 * refresh fetched only the changes since N and reported a nearly
 * empty cache as ready. Without a cursor that refresh does a full pull.
 */
async function forgetFeatureCursors(): Promise<void> {
  await withStore(STORES.deployments, 'readwrite', async (s) => {
    const rows =
      ((await reqAsPromise(s.getAll())) as CachedDeployment[] | undefined) ?? [];
    for (const row of rows) {
      const layerSchemas: Record<string, CachedLayerSchema> = {};
      for (const [key, schema] of Object.entries(row.layerSchemas ?? {})) {
        const {
          syncVersion: _cursor,
          syncBbox: _area,
          bytes: _bytes,
          ...rest
        } = schema;
        void _cursor;
        void _area;
        void _bytes;
        layerSchemas[key] = rest;
      }
      s.put({ ...row, layerSchemas });
    }
  });
}

/** Empty one store, tolerating a database that does not exist yet. */
async function clearStore(storeName: StoreName): Promise<void> {
  await withStore(storeName, 'readwrite', (s) => {
    s.clear();
  });
}

/** How many of THIS account's edits are still waiting to reach the
 *  server, across every deployment on this device. Read by the
 *  sign-out flow so it can warn before a person walks away from
 *  unsynced work. Counts photos and other captured files too: a record
 *  whose attachment has not uploaded is as incomplete as one that has
 *  not been sent. Rows parked for a different account are not this
 *  person's to worry about and are left out. */
export async function countUnsyncedEdits(
  currentUserId: string | null,
): Promise<number> {
  const edits = await withStore(STORES.queue, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    const rows = (r as QueueRecord[] | undefined) ?? [];
    return rows.filter(
      (row) =>
        row.syncStatus !== 'synced' && isQueueRowOwnedBy(row, currentUserId),
    ).length;
  });
  const files = await withStore(STORES.blobs, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    const rows = (r as PendingBlob[] | undefined) ?? [];
    return rows.filter((row) => isQueueRowOwnedBy(row, currentUserId)).length;
  });
  // Form responses captured offline live in their own database
  // (form-offline.ts) and are just as unsynced. Unreadable means none
  // to warn about, never a blocked sign-out.
  const submissions = await countUnsentSubmissions(currentUserId).catch(() => 0);
  return edits + files + submissions;
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/** Which portal account this device currently belongs to, or null when
 *  nobody has signed in since the store was created or sign-out
 *  cleared it. The service worker reads the same row (public/sw.js
 *  readOfflineIdentity) so both drains agree on whose rows to send. */
export async function getOfflineIdentity(): Promise<string | null> {
  return withStore(STORES.meta, 'readonly', async (s) => {
    const r = (await reqAsPromise(s.get(OFFLINE_IDENTITY_KEY))) as
      | OfflineIdentityRow
      | undefined;
    return typeof r?.userId === 'string' && r.userId ? r.userId : null;
  });
}

/** The device identity and whether a purge of the previous account's
 *  cached reads is still owed. */
export async function getOfflineIdentityState(): Promise<{
  userId: string | null;
  purgePending: boolean;
}> {
  return withStore(STORES.meta, 'readonly', async (s) => {
    const r = (await reqAsPromise(s.get(OFFLINE_IDENTITY_KEY))) as
      | OfflineIdentityRow
      | undefined;
    return {
      userId: typeof r?.userId === 'string' && r.userId ? r.userId : null,
      purgePending: r?.purgePending === true,
    };
  });
}

export async function setOfflineIdentity(
  userId: string,
  opts: { purgePending?: boolean } = {},
): Promise<void> {
  const row: OfflineIdentityRow = {
    key: OFFLINE_IDENTITY_KEY,
    userId,
    updatedAt: new Date().toISOString(),
    ...(opts.purgePending ? { purgePending: true } : {}),
  };
  await withStore(STORES.meta, 'readwrite', (s) => {
    s.put(row);
  });
}

/** Sign-out. With no identity on the device, only rows that predate
 *  ownership are visible to anyone; every owned row waits for its
 *  account to sign back in. */
export async function clearOfflineIdentity(): Promise<void> {
  await withStore(STORES.meta, 'readwrite', (s) => {
    s.delete(OFFLINE_IDENTITY_KEY);
  });
}

/** True for a row that belongs to some OTHER account: owned, and not by
 *  the person asking. Legacy rows with no owner are nobody else's. */
function isForeignRow(
  row: { ownerUserId?: string },
  currentUserId: string,
): boolean {
  return row.ownerUserId !== undefined && row.ownerUserId !== currentUserId;
}

/** What a different account has left unsynced on this device. */
export interface ForeignOfflineData {
  /** Queue rows owned by an account other than `currentUserId`. */
  records: number;
  /** Pending files owned by an account other than `currentUserId`. */
  files: number;
}

/**
 * Count the unsynced work on this device that belongs to somebody
 * other than the account now signed in. The identity guard asks this
 * after an account change so it can tell the new person those rows
 * exist and let them decide, rather than purging another person's
 * field data behind their back.
 */
export async function describeForeignOfflineData(
  currentUserId: string,
): Promise<ForeignOfflineData> {
  const records = await withStore(STORES.queue, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    const rows = (r as QueueRecord[] | undefined) ?? [];
    return rows.filter((row) => isForeignRow(row, currentUserId)).length;
  });
  const files = await withStore(STORES.blobs, 'readonly', async (s) => {
    const r = await reqAsPromise(s.getAll());
    const rows = (r as PendingBlob[] | undefined) ?? [];
    return rows.filter((row) => isForeignRow(row, currentUserId)).length;
  });
  const submissions = await countForeignSubmissions(currentUserId).catch(() => 0);
  return { records: records + submissions, files };
}

/**
 * Delete every queue row, pending file and queued form response that
 * belongs to an account other than `currentUserId`. Rows owned by the current account and
 * legacy rows with no owner are untouched. Only ever called after the
 * person has chosen "Remove them from this device" in the identity
 * dialog: this destroys captures that exist nowhere else.
 */
export async function removeForeignOfflineData(
  currentUserId: string,
): Promise<ForeignOfflineData> {
  const records = await deleteWhere(STORES.queue, (row) =>
    isForeignRow(row as QueueRecord, currentUserId),
  );
  const files = await deleteWhere(STORES.blobs, (row) =>
    isForeignRow(row as PendingBlob, currentUserId),
  );
  const submissions = await removeForeignSubmissions(currentUserId).catch(() => 0);
  return { records: records + submissions, files };
}

/** Cursor a whole store and delete the rows a predicate picks. Returns
 *  how many went. */
async function deleteWhere(
  storeName: StoreName,
  pick: (row: unknown) => boolean,
): Promise<number> {
  return withStore(storeName, 'readwrite', async (s) => {
    const cursor = s.openCursor();
    let deleted = 0;
    return new Promise<number>((resolve, reject) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve(deleted);
          return;
        }
        if (pick(c.value)) {
          c.delete();
          deleted += 1;
        }
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('cursor failed'));
    });
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

/**
 * Drop cached feature rows by globalId. Used by the delta refresh
 * path when the observation log carries `kind: 'delete'` tombstones.
 */
export async function deleteFeatures(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
  globalIds: string[],
): Promise<void> {
  if (globalIds.length === 0) return;
  await withStore(STORES.features, 'readwrite', (s) => {
    for (const globalId of globalIds) {
      s.delete([dataCollectionId, dataLayerId, layerKey, globalId]);
    }
  });
}

/** One cached feature row, or null when it is not on the device. */
export async function getCachedFeature(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
  globalId: string,
): Promise<CachedFeature | null> {
  return withStore(STORES.features, 'readonly', async (s) => {
    const r = await reqAsPromise(s.get([dataCollectionId, dataLayerId, layerKey, globalId]));
    return (r as CachedFeature | undefined) ?? null;
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
 * Delegates to clientUuid, which still works when the page is opened
 * as http://<lan-ip> and crypto.randomUUID is missing.
 */
export function newUuid(): string {
  return clientUuid();
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
  /** The signed-in account making this edit. Required: a row written
   *  today with no owner would be indistinguishable from a legacy one
   *  and drain under anybody. */
  ownerUserId: string;
  /** For update / delete: the edited feature's cached
   *  `_observation_id`. See QueueRecord.baseObservationId. */
  baseObservationId?: string;
  /** The online submit sent this edit before falling back to the
   *  queue. See QueueRecord.mayHaveReachedServer. */
  mayHaveReachedServer?: boolean;
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
 *  decision). Also excludes a row another account captured: merging
 *  this person's edit into it would send both under whichever of them
 *  drains first. All three cases fall through to a second row, and
 *  the drains order the pair per feature. */
function isFoldable(row: QueueRecord, ownerUserId: string): boolean {
  return (
    (row.syncStatus === 'pending' || row.syncStatus === 'failed') &&
    row.mayHaveReachedServer !== true &&
    isQueueRowOwnedBy(row, ownerUserId)
  );
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
      .filter((r) => isFoldable(r, edit.ownerUserId))
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
        ownerUserId: edit.ownerUserId,
        ...(edit.op !== 'insert' && edit.baseObservationId
          ? { baseObservationId: edit.baseObservationId }
          : {}),
        ...(edit.mayHaveReachedServer ? { mayHaveReachedServer: true } : {}),
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
      failure: _priorFailure,
      lastAttemptAt: _priorAttempt,
      ...keepRest
    } = keep;
    void _priorFailure;
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
      // A legacy row folded into by an owned edit becomes owned: the
      // bytes it now carries were authored by this account, so this is
      // the account that must send them.
      ownerUserId: edit.ownerUserId,
      // The chain was authored against what the server held when the
      // FIRST row was queued, so that row's base is the guard. A
      // first row with no base (an insert, or a legacy row) falls back
      // to the incoming edit's base when the fold is not an insert.
      ...(folded.edit.op !== 'insert' && (keep.baseObservationId ?? edit.baseObservationId)
        ? { baseObservationId: (keep.baseObservationId ?? edit.baseObservationId)! }
        : {}),
    };
    store.put(record);
    return {
      kind: 'folded',
      record,
      replaced: foldable.length,
    } as EnqueueResult;
  });

  if (result.kind === 'annihilated') {
    // The feature was captured and deleted without ever reaching the
    // server, so no queue row will ever visit it again. Anything
    // captured against it has to go with it, or the largest rows in
    // the database sit there permanently with nothing that could
    // upload or reclaim them. Outside the transaction above because
    // it is a different store.
    await deletePendingBlobsForFeature(
      edit.dataCollectionId,
      edit.dataLayerId,
      edit.layerKey,
      edit.globalId,
    );
    return result;
  }
  // Arm a background replay so the edit reaches the server even if the
  // worker pockets the phone and the tab dies before coverage returns.
  // After the write, so a registration that fires instantly still
  // finds the row.
  requestBackgroundSync();
  return result;
}

// There is deliberately no raw "put a fresh queue row" export here. New
// edits go through `enqueueEdit`, which folds; the drains rewrite rows
// they already hold through `updateQueueRecord`. The unfolded put is
// where the insert-then-edit data loss lived, and an export nobody
// called was an open invitation to reintroduce it.

/**
 * This account's queue for one deployment: rows it captured, plus
 * legacy rows with no owner. Rows another account parked here are
 * invisible, so a count, a chip, a beacon or a drain built on this
 * list cannot claim or report somebody else's work.
 *
 * The identity is a required argument rather than read from the meta
 * store here so that a page which knows who it is running as (every
 * field surface receives `currentUserId` from the server render)
 * cannot race the guard that persists it.
 */
export async function listQueue(
  dataCollectionId: string,
  currentUserId: string | null,
): Promise<QueueRecord[]> {
  const all = await listQueueAllOwners(dataCollectionId);
  return all.filter((row) => isQueueRowOwnedBy(row, currentUserId));
}

/** Every queue row for a deployment regardless of owner. For the
 *  places that reason about the feature rather than the person: the
 *  orphan sweep asking "does this file's feature still have a row",
 *  and the remove-from-device warning, which destroys all of them. */
export async function listQueueAllOwners(
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
  currentUserId: string | null,
): Promise<QueueRecord[]> {
  return withStore(STORES.queue, 'readonly', async (s) => {
    const idx = s.index('by_status');
    const r = await reqAsPromise(
      idx.getAll(IDBKeyRange.only([dataCollectionId, status])),
    );
    const rows = (r as QueueRecord[] | undefined) ?? [];
    return rows.filter((row) => isQueueRowOwnedBy(row, currentUserId));
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
      // From here on the request may reach the server. Kept on every
      // write-back so a later edit is never folded into it.
      mayHaveReachedServer: true,
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

/**
 * After the queued update `landed` reached the server with head
 * `observationId`, move the guard forward for what this device wrote
 * on top of it:
 *
 * - Other pending / failed rows of the same feature, owned by the
 *   SAME account and queued AFTER `landed`. Those were authored on top
 *   of this edit, so without the move they would 409 against the
 *   device's own write. A row another account queued on a shared
 *   device, or one queued earlier, was authored against something
 *   else; moving its base would let it overwrite this write with no
 *   conflict, so it keeps its own base.
 * - The cached feature's `_observation_id`, but only while it still
 *   holds the base `landed` was made against (or none). A newer token
 *   that already arrived by delta is never moved backwards.
 */
export async function rebaseFeatureHead(
  landed: Pick<
    QueueRecord,
    | 'id'
    | 'dataCollectionId'
    | 'dataLayerId'
    | 'layerKey'
    | 'globalId'
    | 'queuedAt'
    | 'ownerUserId'
    | 'baseObservationId'
  >,
  observationId: string,
): Promise<void> {
  await withStore(STORES.queue, 'readwrite', async (store) => {
    const idx = store.index('by_deployment');
    const rows =
      ((await reqAsPromise(
        idx.getAll(IDBKeyRange.only(landed.dataCollectionId)),
      )) as QueueRecord[] | undefined) ?? [];
    for (const row of rows) {
      if (
        row.id !== landed.id &&
        row.globalId === landed.globalId &&
        row.dataLayerId === landed.dataLayerId &&
        row.layerKey === landed.layerKey &&
        landed.ownerUserId !== undefined &&
        row.ownerUserId === landed.ownerUserId &&
        row.queuedAt > landed.queuedAt &&
        row.baseObservationId !== undefined &&
        (row.syncStatus === 'pending' || row.syncStatus === 'failed')
      ) {
        store.put({ ...row, baseObservationId: observationId });
      }
    }
  });
  await withStore(STORES.features, 'readwrite', async (store) => {
    const key = [landed.dataCollectionId, landed.dataLayerId, landed.layerKey, landed.globalId];
    const row = (await reqAsPromise(store.get(key))) as CachedFeature | undefined;
    if (!row) return;
    const cached = (row.feature.properties ?? {})._observation_id;
    if (cached !== undefined && cached !== landed.baseObservationId) return;
    store.put({
      ...row,
      feature: {
        ...row.feature,
        properties: { ...(row.feature.properties ?? {}), _observation_id: observationId },
      },
    });
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
// Pending attachments
// ---------------------------------------------------------------------------

/** Stash a captured file until its feature has reached the server. */
export async function putPendingBlob(row: PendingBlob): Promise<void> {
  await withStore(STORES.blobs, 'readwrite', (s) => {
    s.put(row);
  });
  // A blob is only ever queued alongside a feature edit, so the same
  // background replay that will send the feature can send this too.
  requestBackgroundSync();
}

/** This account's files still waiting to upload for one feature,
 *  oldest first. Another account's photo of the same feature is not
 *  shown and not uploaded under this session. */
export async function listPendingBlobsForFeature(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
  globalId: string,
  currentUserId: string | null,
): Promise<PendingBlob[]> {
  const rows = await listPendingBlobsForFeatureAllOwners(
    dataCollectionId,
    dataLayerId,
    layerKey,
    globalId,
  );
  return rows.filter((row) => isQueueRowOwnedBy(row, currentUserId));
}

/** Every file for one feature regardless of owner. Only for the paths
 *  that act on the FEATURE: when it is deleted or its capture is
 *  discarded, nobody's photo of it has anywhere left to go. */
async function listPendingBlobsForFeatureAllOwners(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
  globalId: string,
): Promise<PendingBlob[]> {
  return withStore(STORES.blobs, 'readonly', async (s) => {
    const idx = s.index('by_feature');
    const r = await reqAsPromise(
      idx.getAll(
        IDBKeyRange.only([dataCollectionId, dataLayerId, layerKey, globalId]),
      ),
    );
    const rows = (r as PendingBlob[] | undefined) ?? [];
    return rows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  });
}

/** This account's pending files for a deployment. Used for the queue
 *  badge, the beacon and the orphan sweep, so a collector can see that
 *  photos are still owed and only their own photos are sent. */
export async function listPendingBlobs(
  dataCollectionId: string,
  currentUserId: string | null,
): Promise<PendingBlob[]> {
  const rows = await listPendingBlobsAllOwners(dataCollectionId);
  return rows.filter((row) => isQueueRowOwnedBy(row, currentUserId));
}

/** Every pending file for a deployment regardless of owner. For the
 *  remove-from-device warning, which destroys all of them. */
export async function listPendingBlobsAllOwners(
  dataCollectionId: string,
): Promise<PendingBlob[]> {
  return withStore(STORES.blobs, 'readonly', async (s) => {
    const idx = s.index('by_deployment');
    const r = await reqAsPromise(idx.getAll(IDBKeyRange.only(dataCollectionId)));
    return (r as PendingBlob[] | undefined) ?? [];
  });
}

export async function deletePendingBlob(blobId: string): Promise<void> {
  await withStore(STORES.blobs, 'readwrite', (s) => {
    s.delete(blobId);
  });
}

/** Drop every pending file for a feature, whoever took it. For a
 *  capture the collector deletes before it ever syncs, or a feature a
 *  replayed delete has just removed from the server: the photos have
 *  nowhere to go. */
export async function deletePendingBlobsForFeature(
  dataCollectionId: string,
  dataLayerId: string,
  layerKey: string,
  globalId: string,
): Promise<void> {
  const rows = await listPendingBlobsForFeatureAllOwners(
    dataCollectionId,
    dataLayerId,
    layerKey,
    globalId,
  );
  for (const row of rows) await deletePendingBlob(row.blobId);
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
  // The canonical text lives in shared-types so the native field
  // client, which hashes with the platform's SHA-256, gets the same
  // bytes from the engine bundle. Only the digest step is local.
  const text = canonicalLayerSchema(fields);
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
    .replace(/^-+|(?<!-)-+$/g, '')
    .slice(0, 60);
  return slug || 'deployment';
}
