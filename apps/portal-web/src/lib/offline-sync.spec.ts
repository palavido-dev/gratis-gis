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
import type { OfflineMessage } from '@gratis-gis/shared-types';

import {
  enqueueEdit,
  listFeaturesForLayer,
  listQueueAllOwners,
  putFeatures,
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
// The account every capture in these specs is made as.
const USER = 'user-alice';
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
    ownerUserId: USER,
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
    ownerUserId: USER,
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

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.terminal).toBe(false);
    const [row] = await listQueue(DC, USER);
    // Not the row's fault: it goes back exactly as it was, so the
    // retry ladder does not climb during an outage and the worker who
    // walks back into signal is not made to wait.
    expect(row!.syncStatus).toBe('pending');
    expect(row!.retryCount).toBeUndefined();
    // The claim stamped a lastAttemptAt; restoring the pre-claim row
    // discards it, which is the whole point.
    expect(row!.lastAttemptAt).toBeUndefined();
    expect(row!.failure).toBeUndefined();
  });

  it('keeps a previously failed row failed, with its count intact', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const priorFailure: OfflineMessage = {
      code: 'sync.requestFailed',
      params: { status: 500 },
    };
    await updateQueueRecord({
      ...row!,
      syncStatus: 'failed',
      retryCount: 2,
      failure: priorFailure,
    });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await syncQueue(DC, { currentUserId: USER, manual: true });

    const [after] = await listQueue(DC, USER);
    expect(after!.syncStatus).toBe('failed');
    expect(after!.retryCount).toBe(2);
    expect(after!.failure).toEqual(priorFailure);
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

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.terminal).toBe(true);
    const [row] = await listQueue(DC, USER);
    expect(row!.syncStatus).toBe('rejected');
    expect(row!.retryCount).toBe(1);
    // The server's sentence, not the JSON envelope around it, and
    // carried as a param rather than folded into English the drain
    // composed: the validator chose those words and this row is read
    // back later, possibly by somebody who does not read English.
    expect(row!.failure).toEqual({
      code: 'sync.serverRefused',
      params: { serverMessage: 'Depth must be a number. Species is required.' },
    });
  });

  it('keeps a server error retryable and counts the attempt', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.failed).toBe(1);
    expect(result.rejected).toBe(0);
    const [row] = await listQueue(DC, USER);
    expect(row!.syncStatus).toBe('failed');
    expect(row!.retryCount).toBe(1);
    expect(row!.failure).toEqual({
      code: 'sync.serverRefusedWithStatus',
      params: { serverMessage: 'boom', status: 500 },
    });
    // Stamped so the backoff has something to measure from.
    expect(typeof row!.lastAttemptAt).toBe('string');
  });

  it('deletes the row once the server accepts it', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(json(201, { ok: true }));

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(1);
    expect(await listQueue(DC, USER)).toEqual([]);
    expect(calls()).toEqual([{ url: FEATURES_PATH, method: 'POST' }]);
  });
});

describe('syncQueue: checkOnly dry-run before transfer', () => {
  it('dry-runs an update with checkOnly before the real PATCH', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null }));
    fetchMock
      .mockResolvedValueOnce(
        json(200, { ok: true, headObservationId: 'obs-1', syncVersion: 3 }),
      )
      .mockResolvedValueOnce(json(200, { type: 'Feature', id: 'feature-1' }));

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(1);
    expect(await listQueue(DC, USER)).toEqual([]);
    expect(calls()).toEqual([
      { url: `${FEATURES_PATH}/feature-1`, method: 'PATCH' },
      { url: `${FEATURES_PATH}/feature-1`, method: 'PATCH' },
    ]);
    const checkBody = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as Record<string, unknown>;
    const writeBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    ) as Record<string, unknown>;
    expect(checkBody.checkOnly).toBe(true);
    expect(writeBody.checkOnly).toBeUndefined();
    expect(writeBody.properties).toEqual({ species: 'oak' });
  });

  it('parks an update when the checkOnly dry-run refuses, without writing', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null }));
    fetchMock.mockResolvedValue(
      json(409, {
        statusCode: 409,
        message: 'Feature changed since you last read it.',
        error: 'Conflict',
      }),
    );

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors[0]?.terminal).toBe(true);
    const [row] = await listQueue(DC, USER);
    expect(row!.syncStatus).toBe('rejected');
    expect(row!.failure).toEqual({
      code: 'sync.serverRefused',
      params: {
        serverMessage: 'Feature changed since you last read it.',
      },
    });
    // Only the dry-run; the real PATCH must not fire.
    expect(calls()).toEqual([
      { url: `${FEATURES_PATH}/feature-1`, method: 'PATCH' },
    ]);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as Record<string, unknown>;
    expect(body.checkOnly).toBe(true);
  });

  it('dry-runs a delete with checkOnly before the real DELETE', async () => {
    await enqueueEdit(edit({ op: 'delete', geometry: null, properties: null }));
    fetchMock
      .mockResolvedValueOnce(
        json(200, { ok: true, headObservationId: 'obs-1', syncVersion: 4 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(1);
    expect(calls()).toEqual([
      { url: `${FEATURES_PATH}/feature-1`, method: 'DELETE' },
      { url: `${FEATURES_PATH}/feature-1`, method: 'DELETE' },
    ]);
    const checkBody = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as Record<string, unknown>;
    expect(checkBody).toEqual({ checkOnly: true });
    expect(fetchMock.mock.calls[1]![1]?.body).toBeUndefined();
  });

  it('skips checkOnly for inserts (API has no create dry-run)', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(json(201, { ok: true }));

    await syncQueue(DC, { currentUserId: USER });

    expect(calls()).toEqual([{ url: FEATURES_PATH, method: 'POST' }]);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('checkOnly');
  });
});

describe('syncQueue: ownership', () => {
  const OTHER = 'user-bob';

  it('never sends, claims or counts a row another account captured', async () => {
    // A shared tablet: Bob captured feature-2 and did not sync before
    // Alice signed in. Alice's drain must send her row and leave his
    // exactly where it is, in every sense: not on the wire, not
    // flipped to syncing, not in her remaining count.
    await enqueueEdit(edit({ globalId: 'mine' }));
    await enqueueEdit(edit({ globalId: 'theirs', ownerUserId: OTHER }));
    await putPendingBlob(blob({ blobId: 'their-photo', globalId: 'theirs', ownerUserId: OTHER }));
    fetchMock.mockResolvedValue(json(201, { ok: true }));

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.processed).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.remaining).toBe(0);
    // One feature write, for Alice's row. No presign for Bob's photo:
    // the orphan sweep is scoped to her files too.
    expect(calls()).toEqual([{ url: FEATURES_PATH, method: 'POST' }]);
    const theirs = await listQueue(DC, OTHER);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.globalId).toBe('theirs');
    expect(theirs[0]!.syncStatus).toBe('pending');
    expect(await listPendingBlobs(DC, OTHER)).toHaveLength(1);
  });

  it('drains a legacy row with no owner under whoever is current', async () => {
    // Rows written before ownership existed cannot be given an owner
    // truthfully, so they keep the old behaviour rather than being
    // stranded forever.
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    const { ownerUserId: _owner, ...legacy } = row!;
    void _owner;
    await updateQueueRecord(legacy);
    fetchMock.mockResolvedValue(json(201, { ok: true }));

    const result = await syncQueue(DC, { currentUserId: OTHER });

    expect(result.synced).toBe(1);
    expect(await listQueue(DC, null)).toEqual([]);
  });
});

describe('discardRejected', () => {
  it('takes the feature’s pending files with the row', async () => {
    await enqueueEdit(edit());
    await putPendingBlob(blob());
    const [row] = await listQueue(DC, USER);
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });
    const [rejected] = await listQueue(DC, USER);

    await discardRejected(rejected!);

    expect(await listQueue(DC, USER)).toEqual([]);
    // Left behind, the orphan sweep would try to upload these against
    // a feature the server has never seen, on every sync, forever.
    expect(await listPendingBlobs(DC, USER)).toEqual([]);
  });

  it('leaves a row alone unless it is actually rejected', async () => {
    await enqueueEdit(edit());
    const [row] = await listQueue(DC, USER);
    await discardRejected(row!);
    expect(await listQueue(DC, USER)).toHaveLength(1);
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
    const [row] = await listQueue(DC, USER);
    await updateQueueRecord({ ...row!, syncStatus: 'rejected' });
    await putPendingBlob(blob({ blobId: 'blob-1', globalId: 'feature-1' }));
    await putPendingBlob(blob({ blobId: 'blob-2', globalId: 'feature-2' }));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await syncQueue(DC, { currentUserId: USER });

    // Exactly one attempt, the presign for feature-2. Nothing for
    // feature-1.
    expect(calls()).toEqual([
      { url: '/api/portal/storage/presign-upload', method: 'POST' },
    ]);
    // The sweep is best-effort: a failed attempt leaves the file put.
    expect(await listPendingBlobs(DC, USER)).toHaveLength(2);
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

    // The thrown error carries the structured reason; its `message` is
    // only the code, because nothing but a console trace reads it and
    // English there would be the same mistake one level down.
    await expect(
      uploadPendingBlobsForFeature(ref, USER),
    ).rejects.toMatchObject({
      offline: {
        code: 'sync.serverRefusedWithStatus',
        params: { serverMessage: 'down', status: 503 },
      },
    });
    // The bytes are in the bucket but the portal does not know about
    // them, so the file stays for the next attempt. Deleting it here
    // would lose a photo from a device that may have no way back to
    // its subject.
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
    ).toHaveLength(1);

    fetchMock
      .mockResolvedValueOnce(json(200, PRESIGN_OK))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(json(201, { id: 'att-1' }));

    await uploadPendingBlobsForFeature(ref, USER);
    expect(
      await listPendingBlobsForFeature(
        DC,
        LAYER.dataLayerId,
        LAYER.layerKey,
        'feature-1',
        USER,
      ),
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

    await uploadPendingBlobsForFeature(ref, USER);

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

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.rejected).toBe(1);
    const [row] = await listQueue(DC, USER);
    expect(row!.syncStatus).toBe('rejected');
    // Named file, real numbers: the collector has to be able to act on
    // this (delete it, re-shoot smaller) without a support call.
    expect(row!.failure).toEqual({
      code: 'sync.fileTooLarge',
      params: { fileName: 'photo.jpg', sizeMb: '0.0', limitMb: '0' },
    });
    // Never PUT, never registered, file still on the device for the
    // collector to delete or replace.
    expect(calls()).toHaveLength(2);
    expect(await listPendingBlobs(DC, USER)).toHaveLength(1);
  });
});

describe('syncQueue: form attachments pending in the properties', () => {
  // A signature (or photo) answer captured offline in the field app is
  // a { dataUrl } attachment inside the feature's properties. The
  // replay uploads it first, so the row stores a descriptor, not base64.
  const DATA_URL = 'data:image/png;base64,QQ==';
  const pendingSig = () => [
    { name: 'signature.png', mimeType: 'image/png', sizeBytes: 1, dataUrl: DATA_URL },
  ];

  it('uploads it before the write and sends the descriptor', async () => {
    await enqueueEdit(edit({ properties: { species: 'oak', sig: pendingSig() } }));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('data:')) {
        return new Response(new Blob([new Uint8Array([65])], { type: 'image/png' }));
      }
      if (url === '/api/portal/storage/presign-upload') return json(200, PRESIGN_OK);
      if (url === PRESIGN_OK.uploadUrl) return new Response(null, { status: 200 });
      if (url === FEATURES_PATH && init?.method === 'POST') return json(201, {});
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(1);
    expect(calls().filter((c) => !c.url.startsWith('data:'))).toEqual([
      { url: '/api/portal/storage/presign-upload', method: 'POST' },
      { url: PRESIGN_OK.uploadUrl, method: 'PUT' },
      { url: FEATURES_PATH, method: 'POST' },
    ]);
    const post = fetchMock.mock.calls.find(
      ([url, init]) => url === FEATURES_PATH && init?.method === 'POST',
    )!;
    const sent = JSON.parse(String(post[1]!.body)) as {
      features: Array<{ properties: Record<string, unknown> }>;
    };
    expect(sent.features[0]!.properties).toEqual({
      species: 'oak',
      sig: [
        {
          name: 'signature.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          url: PRESIGN_OK.publicUrl,
          key: PRESIGN_OK.key,
        },
      ],
    });
    expect(await listQueue(DC, USER)).toEqual([]);
  });

  it('keeps the row, and its pending image, when the upload cannot reach the network', async () => {
    await enqueueEdit(edit({ properties: { species: 'oak', sig: pendingSig() } }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('data:')) {
        return new Response(new Blob([new Uint8Array([65])], { type: 'image/png' }));
      }
      throw new TypeError('Failed to fetch');
    });

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(0);
    expect(result.errors[0]?.terminal).toBe(false);
    const [row] = await listQueue(DC, USER);
    // An outage, not the row's fault: back as it was, image still
    // pending for the next drain, and no feature write was attempted.
    expect(row!.syncStatus).toBe('pending');
    expect(row!.retryCount).toBeUndefined();
    expect(row!.properties).toEqual({ species: 'oak', sig: pendingSig() });
    expect(calls().some((c) => c.url === FEATURES_PATH)).toBe(false);
  });
});

describe('syncQueue: conflict guard (docs/sync-protocol.md)', () => {
  function bodyOf(i: number): Record<string, unknown> {
    return JSON.parse(String(fetchMock.mock.calls[i]![1]!.body)) as Record<string, unknown>;
  }

  it('sends baseObservationId on the dry run and the real PATCH', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'obs-base' }));
    fetchMock
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(
        json(200, { type: 'Feature', id: 'feature-1', properties: { _observation_id: 'obs-new' } }),
      );

    await syncQueue(DC, { currentUserId: USER });

    expect(bodyOf(0).baseObservationId).toBe('obs-base');
    expect(bodyOf(1).baseObservationId).toBe('obs-base');
  });

  it('sends baseObservationId on the dry run and the real DELETE', async () => {
    await enqueueEdit(
      edit({ op: 'delete', geometry: null, properties: null, baseObservationId: 'obs-base' }),
    );
    fetchMock
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await syncQueue(DC, { currentUserId: USER });

    expect(bodyOf(0)).toEqual({ baseObservationId: 'obs-base', checkOnly: true });
    expect(bodyOf(1)).toEqual({ baseObservationId: 'obs-base' });
  });

  it('a folded chain keeps the first row base', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'obs-first' }));
    await enqueueEdit(
      edit({
        op: 'update',
        geometry: null,
        properties: { species: 'elm' },
        baseObservationId: 'obs-later',
      }),
    );
    const rows = await listQueue(DC, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.baseObservationId).toBe('obs-first');
  });

  it('never puts a base on an insert', async () => {
    await enqueueEdit(edit({ baseObservationId: 'obs-x' }));
    const [row] = await listQueue(DC, USER);
    expect(row!.baseObservationId).toBeUndefined();
  });

  it('treats a 409 that already holds the queued values as its own landed write', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'obs-base' }));
    fetchMock.mockResolvedValueOnce(
      json(409, {
        statusCode: 409,
        code: 'feature-conflict',
        current: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { species: 'oak', _observation_id: 'obs-mine' },
        },
      }),
    );

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.synced).toBe(1);
    expect(result.rejected).toBe(0);
    expect(await listQueue(DC, USER)).toEqual([]);
    // Only the dry run: nothing to send.
    expect(calls()).toHaveLength(1);
  });

  it('still parks a 409 whose current differs', async () => {
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'obs-base' }));
    fetchMock.mockResolvedValue(
      json(409, {
        statusCode: 409,
        code: 'feature-conflict',
        message: 'This feature was changed by someone else since you last read it.',
        current: { type: 'Feature', geometry: null, properties: { species: 'pine' } },
      }),
    );

    const result = await syncQueue(DC, { currentUserId: USER });

    expect(result.rejected).toBe(1);
  });

  it('moves only the same account\'s later rows to the new head (shared device)', async () => {
    // Account Y queued an edit against o1 first; this account (X)
    // edits too and drains. Y's row must keep o1 so it 409s instead
    // of overwriting X's write.
    await enqueueEdit(
      edit({ op: 'update', geometry: null, baseObservationId: 'o1', ownerUserId: 'user-bob' }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'o1' }));
    const [mine] = await listQueue(DC, USER);
    // A later row of this account, authored on top of the one that lands.
    await updateQueueRecord({
      ...mine!,
      id: 'later-row',
      queuedAt: new Date(Date.parse(mine!.queuedAt) + 1000).toISOString(),
      properties: { species: 'elm' },
    });
    fetchMock
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(
        json(200, { type: 'Feature', id: 'feature-1', properties: { _observation_id: 'o2' } }),
      );

    await syncQueue(DC, { currentUserId: USER });

    const rows = await listQueueAllOwners(DC);
    const bob = rows.find((r) => r.ownerUserId === 'user-bob')!;
    const later = rows.find((r) => r.id === 'later-row')!;
    expect(bob.baseObservationId).toBe('o1');
    expect(later.baseObservationId).toBe('o2');
  });

  it('does not move the cached token backwards when a newer one arrived', async () => {
    const cached = (token: string) => ({
      dataCollectionId: DC,
      dataLayerId: LAYER.dataLayerId,
      layerKey: LAYER.layerKey,
      globalId: 'feature-1',
      feature: {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [1, 2] },
        properties: { _global_id: 'feature-1', _observation_id: token },
      },
      cachedAt: new Date().toISOString(),
    });
    const landing = () =>
      fetchMock
        .mockResolvedValueOnce(json(200, { ok: true }))
        .mockResolvedValueOnce(
          json(200, { type: 'Feature', id: 'feature-1', properties: { _observation_id: 'o2' } }),
        );
    const token = async () =>
      ((await listFeaturesForLayer(DC, LAYER.dataLayerId, LAYER.layerKey))[0]!.properties as {
        _observation_id?: string;
      })._observation_id;

    // A delta already delivered o3, newer than what this edit lands.
    await putFeatures([cached('o3')]);
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'o1' }));
    landing();
    await syncQueue(DC, { currentUserId: USER });
    expect(await token()).toBe('o3');

    // Still at the base the edit was made against: moves forward.
    await putFeatures([cached('o1')]);
    await enqueueEdit(edit({ op: 'update', geometry: null, baseObservationId: 'o1' }));
    landing();
    await syncQueue(DC, { currentUserId: USER });
    expect(await token()).toBe('o2');
  });
});

describe('syncQueue: an edit folded in after the drain listed the queue', () => {
  // The drain lists the queue once, then works through it with network
  // I/O per row. A re-save of a later feature in that window folds into
  // its still-pending row. The drain must send, and write back, the row
  // as it is when claimed, never the copy it listed.
  type Body = { features?: Array<{ globalId: string; properties: Record<string, unknown> }> };
  const sentBody = (init?: RequestInit): Body =>
    JSON.parse(String(init?.body ?? '{}')) as Body;

  /** Hold the POST for `globalId` until `release` is called. */
  function holdFirstFeature(globalId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const reachedGate = new Promise<void>((r) => (reached = r));
    return {
      release,
      reached: reachedGate,
      async maybeHold(init?: RequestInit) {
        if (sentBody(init).features?.[0]?.globalId === globalId) {
          reached();
          await gate;
        }
      },
    };
  }

  /** Queue feature-w strictly before feature-x so the drain reaches w
   *  first (rows queued in the same millisecond have no fixed order). */
  async function queueWThenX(): Promise<void> {
    const w = await enqueueEdit(edit({ globalId: 'feature-w' }));
    if (w.kind !== 'queued') throw new Error('expected a fresh row');
    await updateQueueRecord({ ...w.record, queuedAt: '2000-01-01T00:00:00.000Z' });
    await enqueueEdit(edit({ globalId: 'feature-x', properties: { species: 'old' } }));
  }

  it('sends the newer values once and leaves no row behind', async () => {
    await queueWThenX();
    const hold = holdFirstFeature('feature-w');
    fetchMock.mockImplementation(async (_url, init) => {
      await hold.maybeHold(init);
      return json(201, { inserted: 1 });
    });

    const run = syncQueue(DC, { currentUserId: USER });
    await hold.reached;
    // feature-x is re-saved while the drain is busy with feature-w.
    const folded = await enqueueEdit(
      edit({ op: 'update', globalId: 'feature-x', geometry: null, properties: { species: 'new' } }),
    );
    expect(folded.kind).toBe('folded');
    hold.release();
    const result = await run;

    const xBodies = fetchMock.mock.calls
      .map(([, init]) => sentBody(init).features?.[0])
      .filter((f) => f?.globalId === 'feature-x');
    // Sent exactly once, with the newer value.
    expect(xBodies).toHaveLength(1);
    expect(xBodies[0]!.properties).toEqual({ species: 'new' });
    expect(result.synced).toBe(2);
    expect(await listQueueAllOwners(DC)).toEqual([]);
  });

  it('keeps the newer values queued when the send cannot reach the network', async () => {
    await queueWThenX();
    const hold = holdFirstFeature('feature-w');
    fetchMock.mockImplementation(async (_url, init) => {
      await hold.maybeHold(init);
      if (sentBody(init).features?.[0]?.globalId === 'feature-x') {
        throw new TypeError('Failed to fetch');
      }
      return json(201, { inserted: 1 });
    });

    const run = syncQueue(DC, { currentUserId: USER });
    await hold.reached;
    await enqueueEdit(
      edit({ op: 'update', globalId: 'feature-x', geometry: null, properties: { species: 'new' } }),
    );
    hold.release();
    await run;

    const rows = await listQueueAllOwners(DC);
    // One row, still pending, holding the newer value: nothing lost.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.globalId).toBe('feature-x');
    expect(rows[0]!.syncStatus).toBe('pending');
    expect(rows[0]!.properties).toEqual({ species: 'new' });
  });
});

describe('syncQueue: deployment owner notification', () => {
  it('sends the data collection header on a queued insert, as the online add does', async () => {
    await enqueueEdit(edit());
    fetchMock.mockResolvedValue(json(201, { inserted: 1 }));
    await syncQueue(DC, { currentUserId: USER });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['x-data-collection-id']).toBe(DC);
  });
});
