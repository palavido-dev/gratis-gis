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
  countUnsyncedEdits,
  deleteDeployment,
  deletePendingBlobsForFeature,
  enqueueEdit,
  listPendingBlobsForFeature,
  listQueue,
  purgeCachedReadData,
  putFeatures,
  putPendingBlob,
  type FeatureEditInput,
} from './offline-store';

const DC = 'deployment-1';
const LAYER = { dataLayerId: 'dl-1', layerKey: 'main' };

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

    const rows = await listQueue(DC);
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
    const rows = await listQueue(DC);
    // Same row id and same queuedAt: a fold must not send the feature
    // to the back of the replay order it was already holding a place
    // in.
    expect(rows[0]!.id).toBe(firstRow!.id);
    expect(rows[0]!.queuedAt).toBe(firstRow!.queuedAt);
  });

  it('resets the retry backoff when the bytes change', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    const { updateQueueRecord } = await import('./offline-store');
    await updateQueueRecord({
      ...row!,
      syncStatus: 'failed',
      retryCount: 4,
      failureReason: 'server said no',
      lastAttemptAt: new Date().toISOString(),
    });

    await enqueueEdit(edit({ op: 'update', properties: { fixed: true } }));
    const [after] = await listQueue(DC);
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
    expect(await listQueue(DC)).toHaveLength(0);
  });

  it('does not fold into a row a drain is replaying', async () => {
    // The row is in flight. Folding into it would let the drain
    // delete the merged result when its own replay succeeded, which
    // is the same data loss arriving from the other direction.
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    const claimed = await claimQueueRow(DC, row!.id, () => true);
    expect(claimed?.syncStatus).toBe('syncing');

    const result = await enqueueEdit(
      edit({ op: 'update', properties: { later: true } }),
    );
    expect(result.kind).toBe('queued');
    const rows = await listQueue(DC);
    expect(rows).toHaveLength(2);
  });

  it('does not fold into a row parked for a person', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    const { updateQueueRecord } = await import('./offline-store');
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });

    const result = await enqueueEdit(edit({ op: 'update' }));
    expect(result.kind).toBe('queued');
    expect(await listQueue(DC)).toHaveLength(2);
  });

  it('keeps edits to different features apart', async () => {
    await enqueueEdit(edit({ globalId: 'feature-1' }));
    await enqueueEdit(edit({ globalId: 'feature-2' }));
    expect(await listQueue(DC)).toHaveLength(2);
  });

  it('treats the same globalId in another layer as another feature', async () => {
    await enqueueEdit(edit({ layerKey: 'sites' }));
    await enqueueEdit(edit({ layerKey: 'readings' }));
    expect(await listQueue(DC)).toHaveLength(2);
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
    const rows = await listQueue(DC);
    expect(rows).toHaveLength(1);
    // Whichever landed second wins the race, but NEITHER may be lost:
    // both keys have to be present on the surviving row.
    expect(rows[0]!.properties).toEqual({ species: 'oak', a: 1, b: 2 });
  });
});

describe('claimQueueRow', () => {
  it('lets exactly one of two concurrent claimants win', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
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
    }) as const;

  it('stores and reads back a file for its feature', async () => {
    await putPendingBlob(blob());
    const rows = await listPendingBlobsForFeature(
      DC,
      LAYER.dataLayerId,
      LAYER.layerKey,
      'feature-1',
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
      ),
    ).toEqual([]);
  });

  it('counts as unsynced work at sign-out', async () => {
    await putPendingBlob(blob());
    // A record whose photograph is still on the phone is not synced
    // in any sense the collector cares about.
    expect(await countUnsyncedEdits()).toBe(1);
    await enqueueEdit(edit());
    expect(await countUnsyncedEdits()).toBe(2);
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
    });

    await deleteDeployment(DC);

    expect(await listQueue(DC)).toEqual([]);
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
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
    });

    await purgeCachedReadData();

    const { listFeaturesForLayer } = await import('./offline-store');
    expect(
      await listFeaturesForLayer(DC, LAYER.dataLayerId, LAYER.layerKey),
    ).toEqual([]);
    // The whole point: read caches go, captures stay.
    expect(await listQueue(DC)).toHaveLength(1);
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
      ),
    ).toHaveLength(1);
  });
});
