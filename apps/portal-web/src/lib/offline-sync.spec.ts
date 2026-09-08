// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The in-app drain, end to end against a real (fake) IndexedDB and a
 * scripted fetch.
 *
 * shared-types covers the decision tables (which status parks a row,
 * when a row is claimable). What those cannot see is the bookkeeping
 * the drain does around them: what it writes back to the row after
 * each kind of failure, and what it does with the files that ride
 * along with a feature. Every case here is a place where the table
 * was right and the row on the device could still have been wrong.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import {
  enqueueEdit,
  listPendingBlobs,
  listPendingBlobsForFeature,
  listQueue,
  putPendingBlob,
  updateQueueRecord,
  type FeatureEditInput,
  type PendingBlob,
} from './offline-store';
import {
  discardRejected,
  syncQueue,
  uploadPendingBlobsForFeature,
} from './offline-sync';

const DC = 'deployment-1';
const LAYER = { dataLayerId: 'dl-1', layerKey: 'main' };
const FEATURES_PATH = '/api/portal/items/dl-1/layers/main/features';

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

function blob(over: Partial<PendingBlob> = {}): PendingBlob {
  return {
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
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PRESIGN_OK = {
  uploadUrl: 'https://bucket.example/put/abc',
  publicUrl: 'https://bucket.example/get/abc',
  key: 'abc',
  maxBytes: 5 * 1024 * 1024,
};

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;
let fetchMock: FetchMock;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

/** The path and method of every request the drain made, in order. */
function calls(): Array<{ url: string; method: string }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method ?? 'GET',
  }));
}

describe('syncQueue: network failure', () => {
  it('restores the pre-claim row and charges nothing to the backoff', async () => {
    await enqueueEdit(edit());
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await syncQueue(DC);

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.terminal).toBe(false);
    const [row] = await listQueue(DC);
    // Not the row's fault: it goes back exactly as it was, so the
    // retry ladder does not climb during an outage and the worker who
    // walks back into signal is not made to wait.
    expect(row!.syncStatus).toBe('pending');
    expect(row!.retryCount).toBeUndefined();
    // The claim stamped a lastAttemptAt; restoring the pre-claim row
    // discards it, which is the whole point.
    expect(row!.lastAttemptAt).toBeUndefined();
    expect(row!.failureReason).toBeUndefined();
  });

  it('keeps a previously failed row failed, with its count intact', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    await updateQueueRecord({
      ...row!,
      syncStatus: 'failed',
      retryCount: 2,
      failureReason: 'POST failed (500).',
    });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await syncQueue(DC, { manual: true });

    const [after] = await listQueue(DC);
    expect(after!.syncStatus).toBe('failed');
    expect(after!.retryCount).toBe(2);
    expect(after!.failureReason).toBe('POST failed (500).');
  });
});

describe('syncQueue: HTTP failure', () => {
  it('parks a deterministic refusal with the validator sentence', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(
      json(400, {
        statusCode: 400,
        message: ['Depth must be a number.', 'Species is required.'],
        error: 'Bad Request',
      }),
    );

    const result = await syncQueue(DC);

    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.terminal).toBe(true);
    const [row] = await listQueue(DC);
    expect(row!.syncStatus).toBe('rejected');
    expect(row!.retryCount).toBe(1);
    // The sentence, not the JSON envelope around it: this lands on
    // the sync screen in front of a person in the field.
    expect(row!.failureReason).toBe(
      'Depth must be a number. Species is required.',
    );
  });

  it('keeps a server error retryable and counts the attempt', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const result = await syncQueue(DC);

    expect(result.failed).toBe(1);
    expect(result.rejected).toBe(0);
    const [row] = await listQueue(DC);
    expect(row!.syncStatus).toBe('failed');
    expect(row!.retryCount).toBe(1);
    expect(row!.failureReason).toBe('POST failed (500). boom');
    // Stamped so the backoff has something to measure from.
    expect(typeof row!.lastAttemptAt).toBe('string');
  });

  it('deletes the row once the server accepts it', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(json(201, { ok: true }));

    const result = await syncQueue(DC);

    expect(result.synced).toBe(1);
    expect(await listQueue(DC)).toEqual([]);
    expect(calls()).toEqual([{ url: FEATURES_PATH, method: 'POST' }]);
  });
});

describe('discardRejected', () => {
  it('takes the feature’s pending files with the row', async () => {
    await enqueueEdit(edit());
    await putPendingBlob(blob());
    const [row] = await listQueue(DC);
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });
    const [rejected] = await listQueue(DC);

    await discardRejected(rejected!);

    expect(await listQueue(DC)).toEqual([]);
    // Left behind, the orphan sweep would try to upload these against
    // a feature the server has never seen, on every sync, forever.
    expect(await listPendingBlobs(DC)).toEqual([]);
  });

  it('leaves a row alone unless it is actually rejected', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    await discardRejected(row!);
    expect(await listQueue(DC)).toHaveLength(1);
  });
});

describe('orphaned file sweep', () => {
  it('skips files whose feature still has a queue row', async () => {
    // feature-1 is parked, so the drain will not touch it, and its
    // photo must wait with it: uploading now would hit an attachment
    // endpoint for a feature the server does not have. feature-2 has
    // no row at all, so its feature is on the server and the file is
    // safe to send on its own.
    await enqueueEdit(edit());
    const [row] = await listQueue(DC);
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });
    await putPendingBlob(blob({ blobId: 'blob-1', globalId: 'feature-1' }));
    await putPendingBlob(blob({ blobId: 'blob-2', globalId: 'feature-2' }));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await syncQueue(DC);

    // Exactly one attempt, the presign for feature-2. Nothing for
    // feature-1.
    expect(calls()).toEqual([
      { url: '/api/portal/storage/presign-upload', method: 'POST' },
    ]);
    // The sweep is best-effort: a failed attempt leaves the file put.
    expect(await listPendingBlobs(DC)).toHaveLength(2);
  });
});

describe('uploadPendingBlobsForFeature', () => {
  const ref = {
    dataCollectionId: DC,
    dataLayerId: LAYER.dataLayerId,
    layerKey: LAYER.layerKey,
    globalId: 'feature-1',
  };

  it('deletes the file only after the register call succeeds', async () => {
    await putPendingBlob(blob());
    fetchMock
      .mockResolvedValueOnce(json(200, PRESIGN_OK)) // presign
      .mockResolvedValueOnce(new Response('', { status: 200 })) // PUT
      .mockResolvedValueOnce(new Response('down', { status: 503 })); // register

    await expect(uploadPendingBlobsForFeature(ref)).rejects.toThrow(
      'Attachment register failed (503). down',
    );
    // The bytes are in the bucket but the portal does not know about
    // them, so the file stays for the next attempt. Deleting it here
    // would lose a photo from a device that may have no way back to
    // its subject.
    expect(
      await listPendingBlobsForFeature(DC, LAYER.dataLayerId, LAYER.layerKey, 'feature-1'),
    ).toHaveLength(1);

    fetchMock
      .mockResolvedValueOnce(json(200, PRESIGN_OK))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(json(201, { id: 'att-1' }));

    await uploadPendingBlobsForFeature(ref);
    expect(
      await listPendingBlobsForFeature(DC, LAYER.dataLayerId, LAYER.layerKey, 'feature-1'),
    ).toEqual([]);
    expect(calls().slice(3)).toEqual([
      { url: '/api/portal/storage/presign-upload', method: 'POST' },
      { url: PRESIGN_OK.uploadUrl, method: 'PUT' },
      { url: `${FEATURES_PATH}/feature-1/attachments`, method: 'POST' },
    ]);
  });

  it('declares the file size at presign so the server can sign it', async () => {
    await putPendingBlob(blob());
    fetchMock
      .mockResolvedValueOnce(json(200, PRESIGN_OK))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(json(201, { id: 'att-1' }));

    await uploadPendingBlobsForFeature(ref);

    const presignBody = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as Record<string, unknown>;
    expect(presignBody).toEqual({
      kind: 'feature-attachment',
      contentType: 'image/jpeg',
      sizeBytes: 3,
    });
  });

  it('parks a file the server will never take', async () => {
    // Through the drain, because the parking is the drain's reaction
    // to the rejection: the feature insert lands, the presign says the
    // cap is 1 byte, and the row must end up rejected with a reason a
    // person can act on (re-shoot smaller), not retried forever.
    await enqueueEdit(edit());
    await putPendingBlob(blob());
    fetchMock
      .mockResolvedValueOnce(json(201, { ok: true })) // insert
      .mockResolvedValueOnce(json(200, { ...PRESIGN_OK, maxBytes: 1 }));

    const result = await syncQueue(DC);

    expect(result.rejected).toBe(1);
    const [row] = await listQueue(DC);
    expect(row!.syncStatus).toBe('rejected');
    expect(row!.failureReason).toContain('photo.jpg');
    expect(row!.failureReason).toContain('limit');
    // Never PUT, never registered, file still on the device for the
    // collector to delete or replace.
    expect(calls()).toHaveLength(2);
    expect(await listPendingBlobs(DC)).toHaveLength(1);
  });
});
