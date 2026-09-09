// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
// The reference is local rather than a `types` entry in the app's
// tsconfig: setting `types` explicitly turns OFF automatic inclusion
// of every other @types package, which would take @types/react with
// it and break the app's own typecheck. `pnpm typecheck` compiles
// this file along with the rest of src, so it needs the globals from
// somewhere.
/**
 * The IndexedDB half of the offline queue.
 *
 * shared-types already covers the pure decision tables (queue-fold,
 * queue-replay). This covers the part those tables could not reach:
 * that `enqueueEdit` applies the fold inside ONE transaction, that it
 * refuses to fold into a row a drain owns, that the claim is
 * genuinely atomic, and that the attachment lifecycle cleans up after
 * itself. Every one of those is a place where the logic is right and
 * the storage call could still be wrong.
 *
 * fake-indexeddb is a real implementation, so a race here races the
 * way it would in a browser.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import {
  claimQueueRow,
  clearOfflineIdentity,
  countUnsyncedEdits,
  deleteDeployment,
  deletePendingBlobsForFeature,
  describeForeignOfflineData,
  enqueueEdit,
  getOfflineIdentity,
  listPendingBlobs,
  listPendingBlobsForFeature,
  listQueue,
  listQueueAllOwners,
  OFFLINE_DB_NAME,
  purgeCachedReadData,
  putFeatures,
  putPendingBlob,
  removeForeignOfflineData,
  setOfflineIdentity,
  updateQueueRecord,
  type FeatureEditInput,
  type PendingBlob,
  type QueueRecord,
} from './offline-store';

const DC = 'deployment-1';
const LAYER = { dataLayerId: 'dl-1', layerKey: 'main' };
// The account every capture in these specs is made as.
const USER = 'user-alice';

function edit(over: Partial<FeatureEditInput> = {}): FeatureEditInput {
  return {
    dataCollectionId: DC,
    op: 'insert',
    dataLayerId: LAYER.dataLayerId,
    layerKey: LAYER.layerKey,
    globalId: 'feature-1',
    geometry: { type: 'Point', coordinates: [1, 2] },
    properties: { species: 'oak' },
    schemaHash: 'hash-1',
    ownerUserId: USER,
    ...over,
  };
}

beforeEach(() => {
  // A fresh factory per test. Without this the database persists
  // across cases and a test that expects an empty queue passes or
  // fails depending on what ran before it.
  globalThis.indexedDB = new IDBFactory();
});

describe('enqueueEdit', () => {
  it('folds an edit into the unsynced capture it edits', async () => {
    // The bug this whole arc started from: an offline capture,
    // corrected before it synced, used to replace the insert with an
    // update against a globalId the server had never seen.
    const first = await enqueueEdit(edit());
    expect(first.kind).toBe('queued');

    const second = await enqueueEdit(
      edit({ op: 'update', properties: { dbh: 12 }, geometry: null }),
    );
    expect(second.kind).toBe('folded');

    const rows = await listQueue(DC, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe('insert');
    expect(rows[0]!.properties).toEqual({ species: 'oak', dbh: 12 });
    // The attribute-only edit carried no geometry; the capture
    // position has to survive it.
    expect(rows[0]!.geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
  });

  it('keeps the original queue position when it folds', async () => {
    const first = await enqueueEdit(edit());
    const firstRow = first.kind === 'queued' ? first.record : null;
    expect(firstRow).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await enqueueEdit(edit({ op: 'update', properties: { a: 1 } }));
    const rows = await listQueue(DC, USER);
    // Same row id and same queuedAt: a fold must not send the feature
    // to the back of the replay order it was already holding a place
    // in.
    expect(rows[0]!.id).toBe(firstRow!.id);
    expect(rows[0]!.queuedAt).toBe(firstRow!.queuedAt);
  });

  it('resets the retry backoff when the bytes change', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const { updateQueueRecord } = await import('./offline-store');
    await updateQueueRecord({
      ...row!,
      syncStatus: 'failed',
      retryCount: 4,
      failureReason: 'server said no',
      lastAttemptAt: new Date().toISOString(),
    });

    await enqueueEdit(edit({ op: 'update', properties: { fixed: true } }));
    const [after] = await listQueue(DC, USER);
    expect(after!.retryCount).toBe(0);
    expect(after!.failureReason).toBeUndefined();
    expect(after!.lastAttemptAt).toBeUndefined();
    expect(after!.syncStatus).toBe('pending');
  });

  it('annihilates a capture deleted before it ever synced', async () => {
    await enqueueEdit(edit());
    const result = await enqueueEdit(
      edit({ op: 'delete', properties: null, geometry: null }),
    );
    expect(result.kind).toBe('annihilated');
    expect(await listQueue(DC, USER)).toHaveLength(0);
  });

  it('does not fold into a row a drain is replaying', async () => {
    // The row is in flight. Folding into it would let the drain
    // delete the merged result when its own replay succeeded, which
    // is the same data loss arriving from the other direction.
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const claimed = await claimQueueRow(DC, row!.id, () => true);
    expect(claimed?.syncStatus).toBe('syncing');

    const result = await enqueueEdit(
      edit({ op: 'update', properties: { later: true } }),
    );
    expect(result.kind).toBe('queued');
    const rows = await listQueue(DC, USER);
    expect(rows).toHaveLength(2);
  });

  it('does not fold into a row parked for a person', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const { updateQueueRecord } = await import('./offline-store');
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });

    const result = await enqueueEdit(edit({ op: 'update' }));
    expect(result.kind).toBe('queued');
    expect(await listQueue(DC, USER)).toHaveLength(2);
  });

  it('keeps edits to different features apart', async () => {
    await enqueueEdit(edit({ globalId: 'feature-1' }));
    await enqueueEdit(edit({ globalId: 'feature-2' }));
    expect(await listQueue(DC, USER)).toHaveLength(2);
  });

  it('treats the same globalId in another layer as another feature', async () => {
    await enqueueEdit(edit({ layerKey: 'sites' }));
    await enqueueEdit(edit({ layerKey: 'readings' }));
    expect(await listQueue(DC, USER)).toHaveLength(2);
  });

  it('survives two edits enqueued at once', async () => {
    // The read-modify-write has to be one transaction. Done as a
    // separate read and write, both of these would read the same
    // prior row and one fold would overwrite the other, silently
    // dropping an edit.
    await enqueueEdit(edit());
    await Promise.all([
      enqueueEdit(edit({ op: 'update', properties: { a: 1 } })),
      enqueueEdit(edit({ op: 'update', properties: { b: 2 } })),
    ]);
    const rows = await listQueue(DC, USER);
    expect(rows).toHaveLength(1);
    // Whichever landed second wins the race, but NEITHER may be lost:
    // both keys have to be present on the surviving row.
    expect(rows[0]!.properties).toEqual({ species: 'oak', a: 1, b: 2 });
  });
});

describe('claimQueueRow', () => {
  it('lets exactly one of two concurrent claimants win', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const canClaim = (r: { syncStatus: string }) => r.syncStatus === 'pending';
    const [a, b] = await Promise.all([
      claimQueueRow(DC, row!.id, canClaim),
      claimQueueRow(DC, row!.id, canClaim),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('returns null for a row that is gone', async () => {
    expect(await claimQueueRow(DC, 'no-such-row', () => true)).toBeNull();
  });
});

describe('pending attachments', () => {
  const blob = () =>
    ({
      blobId: 'blob-1',
      dataCollectionId: DC,
      dataLayerId: LAYER.dataLayerId,
      layerKey: LAYER.layerKey,
      globalId: 'feature-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      capturedAt: new Date().toISOString(),
      ownerUserId: USER,
    }) as const;

  it('stores and reads back a file for its feature', async () => {
    await putPendingBlob(blob());
    const rows = await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileName).toBe('photo.jpg');
    expect(rows[0]!.blob.size).toBe(3);
  });

  it('does not return another feature’s files', async () => {
    await putPendingBlob(blob());
    const rows = await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-2',
        USER,
      );
    expect(rows).toEqual([]);
  });

  it('goes when its capture is annihilated before syncing', async () => {
    // A photo whose feature never reached the server has nowhere to
    // be attached, and nothing left that could upload or reclaim it.
    await enqueueEdit(edit());
    await putPendingBlob(blob());
    await enqueueEdit(edit({ op: 'delete', properties: null, geometry: null }));
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
    ).toEqual([]);
  });

  it('is discarded with its feature on request', async () => {
    await putPendingBlob(blob());
    await deletePendingBlobsForFeature(
      DC,
      LAYER.dataLayerId,
      LAYER.layerKey,
      'feature-1',
    );
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
    ).toEqual([]);
  });

  it('counts as unsynced work at sign-out', async () => {
    await putPendingBlob(blob());
    // A record whose photograph is still on the phone is not synced
    // in any sense the collector cares about.
    expect(await countUnsyncedEdits(USER)).toBe(1);
    await enqueueEdit(edit());
    expect(await countUnsyncedEdits(USER)).toBe(2);
  });
});

describe('teardown', () => {
  it('removing a deployment takes its queue and its files', async () => {
    await enqueueEdit(edit());
    await putPendingBlob({
      blobId: 'blob-1',
      dataCollectionId: DC,
      dataLayerId: LAYER.dataLayerId,
      layerKey: LAYER.layerKey,
      globalId: 'feature-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      blob: new Blob([new Uint8Array([1])]),
      capturedAt: new Date().toISOString(),
      ownerUserId: USER,
    });

    await deleteDeployment(DC);

    expect(await listQueue(DC, USER)).toEqual([]);
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
    ).toEqual([]);
  });

  it('sign-out clears cached reads but never the unsynced work', async () => {
    await putFeatures([
      {
        dataCollectionId: DC,
        dataLayerId: LAYER.dataLayerId,
        layerKey: LAYER.layerKey,
        globalId: 'cached-1',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {},
        },
        cachedAt: new Date().toISOString(),
      },
    ]);
    await enqueueEdit(edit());
    await putPendingBlob({
      blobId: 'blob-1',
      dataCollectionId: DC,
      dataLayerId: LAYER.dataLayerId,
      layerKey: LAYER.layerKey,
      globalId: 'feature-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      blob: new Blob([new Uint8Array([1])]),
      capturedAt: new Date().toISOString(),
      ownerUserId: USER,
    });

    await purgeCachedReadData();

    const { listFeaturesForLayer } = await import('./offline-store');
    expect(
      await listFeaturesForLayer(DC, LAYER.dataLayerId, LAYER.layerKey),
    ).toEqual([]);
    // The whole point: read caches go, captures stay.
    expect(await listQueue(DC, USER)).toHaveLength(1);
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

const OTHER = 'user-bob';

function blobRow(over: Partial<PendingBlob> = {}): PendingBlob {
  return {
    blobId: 'blob-1',
    dataCollectionId: DC,
    dataLayerId: LAYER.dataLayerId,
    layerKey: LAYER.layerKey,
    globalId: 'feature-1',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    blob: new Blob([new Uint8Array([1])]),
    capturedAt: new Date().toISOString(),
    ownerUserId: USER,
    ...over,
  };
}

/** A file as the v2 build stored it: no owner key at all. Destructured
 *  off rather than set to undefined because the workspace compiles with
 *  exactOptionalPropertyTypes, and because a v2 row genuinely has no
 *  such key; `ownerUserId: undefined` would be a different shape. */
function legacyBlobRow(blobId: string): Omit<PendingBlob, 'ownerUserId'> {
  const { ownerUserId: _owner, ...rest } = blobRow({ blobId });
  void _owner;
  return rest;
}

/**
 * Write a database exactly as the v2 build left it: version 2, the
 * six v2 stores, and rows with no owner. `openOfflineDb` then finds
 * oldVersion 2 and runs the v3 step on real data, which is the only
 * way to test a migration honestly.
 */
async function seedV2Database(rows: {
  queue: Array<Omit<QueueRecord, 'ownerUserId'>>;
  blobs: Array<Omit<PendingBlob, 'ownerUserId'>>;
}): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('deployments', { keyPath: 'dataCollectionId' });
      const f = d.createObjectStore('features', {
        keyPath: ['dataCollectionId', 'dataLayerId', 'layerKey', 'globalId'],
      });
      f.createIndex('by_layer', ['dataCollectionId', 'dataLayerId', 'layerKey']);
      f.createIndex('by_deployment', 'dataCollectionId');
      d.createObjectStore('forms', { keyPath: ['dataCollectionId', 'formItemId'] });
      d.createObjectStore('pickLists', {
        keyPath: ['dataCollectionId', 'pickListItemId'],
      });
      const q = d.createObjectStore('queue', { keyPath: ['dataCollectionId', 'id'] });
      q.createIndex('by_status', ['dataCollectionId', 'syncStatus']);
      q.createIndex('by_deployment', 'dataCollectionId');
      const b = d.createObjectStore('blobs', { keyPath: 'blobId' });
      b.createIndex('by_feature', [
        'dataCollectionId',
        'dataLayerId',
        'layerKey',
        'globalId',
      ]);
      b.createIndex('by_deployment', 'dataCollectionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['queue', 'blobs'], 'readwrite');
    for (const r of rows.queue) tx.objectStore('queue').put(r);
    for (const b of rows.blobs) tx.objectStore('blobs').put(b);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function legacyQueueRow(id: string): Omit<QueueRecord, 'ownerUserId'> {
  return {
    id,
    dataCollectionId: DC,
    op: 'insert',
    dataLayerId: LAYER.dataLayerId,
    layerKey: LAYER.layerKey,
    globalId: id,
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {},
    queuedAt: new Date().toISOString(),
    schemaHash: 'hash-0',
    syncStatus: 'pending',
  };
}

describe('schema v3 upgrade', () => {
  it('keeps v2 rows intact and leaves them unowned', async () => {
    // The meta store is created by this same upgrade, so there is no
    // identity to stamp from and none is guessed. The rows must
    // survive untouched (they are unsynced field captures) and stay
    // visible to whoever signs in, exactly as before ownership.
    await seedV2Database({
      queue: [legacyQueueRow('legacy-1')],
      blobs: [legacyBlobRow('legacy-blob')],
    });

    expect(await getOfflineIdentity()).toBeNull();
    const rows = await listQueueAllOwners(DC);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('legacy-1');
    expect(rows[0]!.ownerUserId).toBeUndefined();
    // Visible to any identity, and to no identity.
    expect(await listQueue(DC, USER)).toHaveLength(1);
    expect(await listQueue(DC, OTHER)).toHaveLength(1);
    expect(await listQueue(DC, null)).toHaveLength(1);
    expect(await listPendingBlobs(DC, OTHER)).toHaveLength(1);
  });

  it('an owned edit folded into a legacy row takes ownership of it', async () => {
    await seedV2Database({ queue: [legacyQueueRow('feature-1')], blobs: [] });
    const result = await enqueueEdit(
      edit({ op: 'update', properties: { fixed: true } }),
    );
    expect(result.kind).toBe('folded');
    const [row] = await listQueueAllOwners(DC);
    // The bytes are now this account's, so this is the account that
    // must send them.
    expect(row!.ownerUserId).toBe(USER);
    expect(await listQueue(DC, OTHER)).toHaveLength(0);
  });
});

describe('ownership', () => {
  it('stamps every new row and file with its owner', async () => {
    await enqueueEdit(edit());
    await putPendingBlob(blobRow());
    const [row] = await listQueue(DC, USER);
    expect(row!.ownerUserId).toBe(USER);
    const [file] = await listPendingBlobs(DC, USER);
    expect(file!.ownerUserId).toBe(USER);
  });

  it('hides another account’s rows from lists, counts and claims', async () => {
    await enqueueEdit(edit({ globalId: 'mine' }));
    await enqueueEdit(edit({ globalId: 'theirs', ownerUserId: OTHER }));
    await putPendingBlob(blobRow({ blobId: 'their-photo', ownerUserId: OTHER }));

    expect((await listQueue(DC, USER)).map((r) => r.globalId)).toEqual(['mine']);
    expect((await listQueue(DC, OTHER)).map((r) => r.globalId)).toEqual([
      'theirs',
    ]);
    // With no identity on the device only legacy rows are visible, so
    // neither owned row is.
    expect(await listQueue(DC, null)).toEqual([]);
    expect(await listPendingBlobs(DC, USER)).toEqual([]);
    expect(await countUnsyncedEdits(USER)).toBe(1);
    expect(await countUnsyncedEdits(OTHER)).toBe(2);

    // The claim predicate the drain passes re-checks ownership, so a
    // foreign row cannot be flipped to syncing under this account.
    const { isQueueRowOwnedBy } = await import('@gratis-gis/shared-types');
    const theirs = (await listQueueAllOwners(DC)).find(
      (r) => r.globalId === 'theirs',
    )!;
    expect(
      await claimQueueRow(DC, theirs.id, (r) => isQueueRowOwnedBy(r, USER)),
    ).toBeNull();
    expect(
      await claimQueueRow(DC, theirs.id, (r) => isQueueRowOwnedBy(r, OTHER)),
    ).not.toBeNull();
  });

  it('does not fold this account’s edit into another account’s row', async () => {
    // Same feature, two accounts. Merging would send both under
    // whichever drains first; a second row keeps them apart.
    await enqueueEdit(edit({ ownerUserId: OTHER }));
    const result = await enqueueEdit(edit({ op: 'update', properties: { a: 1 } }));
    expect(result.kind).toBe('queued');
    expect(await listQueueAllOwners(DC)).toHaveLength(2);
    expect(await listQueue(DC, USER)).toHaveLength(1);
  });

  it('an account’s own status filter excludes foreign rows', async () => {
    await enqueueEdit(edit({ globalId: 'theirs', ownerUserId: OTHER }));
    const [row] = await listQueueAllOwners(DC);
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });
    const { listQueueByStatus } = await import('./offline-store');
    expect(await listQueueByStatus(DC, 'rejected', USER)).toEqual([]);
    expect(await listQueueByStatus(DC, 'rejected', OTHER)).toHaveLength(1);
  });
});

describe('device identity', () => {
  it('round-trips and clears', async () => {
    expect(await getOfflineIdentity()).toBeNull();
    await setOfflineIdentity(USER);
    expect(await getOfflineIdentity()).toBe(USER);
    await setOfflineIdentity(OTHER);
    expect(await getOfflineIdentity()).toBe(OTHER);
    await clearOfflineIdentity();
    expect(await getOfflineIdentity()).toBeNull();
  });

  it('describes what another account left behind', async () => {
    await enqueueEdit(edit({ globalId: 'mine' }));
    await enqueueEdit(edit({ globalId: 'theirs', ownerUserId: OTHER }));
    await putPendingBlob(blobRow({ blobId: 'their-photo', ownerUserId: OTHER }));
    // Legacy rows belong to nobody else, so they are not "foreign".
    await putPendingBlob(legacyBlobRow('legacy-photo'));

    expect(await describeForeignOfflineData(USER)).toEqual({
      records: 1,
      files: 1,
    });
    expect(await describeForeignOfflineData(OTHER)).toEqual({
      records: 1,
      files: 0,
    });
  });

  it('"remove" deletes only the other account’s rows and files', async () => {
    await enqueueEdit(edit({ globalId: 'mine' }));
    await enqueueEdit(edit({ globalId: 'theirs', ownerUserId: OTHER }));
    await putPendingBlob(blobRow({ blobId: 'my-photo' }));
    await putPendingBlob(blobRow({ blobId: 'their-photo', ownerUserId: OTHER }));
    await putPendingBlob(legacyBlobRow('legacy-photo'));

    const gone = await removeForeignOfflineData(USER);

    expect(gone).toEqual({ records: 1, files: 1 });
    expect((await listQueueAllOwners(DC)).map((r) => r.globalId)).toEqual([
      'mine',
    ]);
    // Own file and the legacy file both survive.
    const left = (await listPendingBlobs(DC, USER)).map((b) => b.blobId).sort();
    expect(left).toEqual(['legacy-photo', 'my-photo']);
    expect(await describeForeignOfflineData(USER)).toEqual({
      records: 0,
      files: 0,
    });
  });
});
