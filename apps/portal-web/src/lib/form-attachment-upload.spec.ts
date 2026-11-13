// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import {
  QUEUED_UPLOAD_REUSE_MS,
  uploadPendingAttachmentsInResponse,
  uploadQueuedAttachments,
} from './form-attachment-upload';

describe('uploadPendingAttachmentsInResponse', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('keeps extra capture fields such as durationSec and drops the bytes', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('data:')) return new Response('clip');
      if (url.endsWith('/presign-upload')) {
        return new Response(
          JSON.stringify({
            uploadUrl: 'https://minio.test/put',
            publicUrl: '/api/portal/storage/private/feature-attachment/k1',
            key: 'feature-attachment/k1',
            contentType: 'video/mp4',
            maxBytes: 25 * 1024 * 1024,
          }),
        );
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const response: Record<string, unknown> = {
      clip: [
        {
          name: 'clip.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 4,
          durationSec: 12,
          dataUrl: 'data:video/mp4;base64,Y2xpcA==',
        },
      ],
    };
    await uploadPendingAttachmentsInResponse(response);
    const [entry] = response.clip as Array<Record<string, unknown>>;
    expect(entry).toMatchObject({
      durationSec: 12,
      url: '/api/portal/storage/private/feature-attachment/k1',
      key: 'feature-attachment/k1',
    });
    expect(entry).not.toHaveProperty('dataUrl');
  });
});

describe('uploadQueuedAttachments', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Fake storage: every presign hands out the next key; PUTs to
   *  `failPut` answer 503. */
  function fakeStorage(failPuts: number[] = []) {
    let n = 0;
    let puts = 0;
    const fn = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('data:')) return new Response('bytes');
      if (url.endsWith('/presign-upload')) {
        n += 1;
        return new Response(
          JSON.stringify({
            uploadUrl: `https://minio.test/put/${n}`,
            publicUrl: `/api/portal/storage/private/feature-attachment/k${n}`,
            key: `feature-attachment/k${n}`,
            contentType: 'image/jpeg',
            maxBytes: 25 * 1024 * 1024,
          }),
        );
      }
      puts += 1;
      return new Response(null, { status: failPuts.includes(puts) ? 503 : 200 });
    });
    global.fetch = fn as unknown as typeof fetch;
    return { presigns: () => fn.mock.calls.filter((c) => String(c[0]).endsWith('/presign-upload')).length };
  }

  const photo = (name: string) => ({
    name,
    mimeType: 'image/jpeg',
    sizeBytes: 5,
    dataUrl: 'data:image/jpeg;base64,Ynl0ZXM=',
  });

  it('keeps uploads from a failed attempt and reuses them on the next one', async () => {
    const storage = fakeStorage([2]);
    let stored: Record<string, unknown> = { photos: [photo('a.jpg'), photo('b.jpg')] };
    const persist = jest.fn(async (next: Record<string, unknown>) => {
      stored = next;
    });

    await expect(uploadQueuedAttachments(stored, persist, 1000)).rejects.toThrow();
    expect(persist).toHaveBeenCalledTimes(1);
    const [a, b] = stored.photos as Array<Record<string, unknown>>;
    // The first upload is recorded, and the bytes are still on the row.
    expect(a).toMatchObject({ key: 'feature-attachment/k1', dataUrl: expect.any(String) });
    expect(b).not.toHaveProperty('url');

    const sent = await uploadQueuedAttachments(stored, persist, 2000);
    // Only the second photo was uploaded again.
    expect(storage.presigns()).toBe(3);
    expect(sent.photos).toEqual([
      { name: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 5, url: '/api/portal/storage/private/feature-attachment/k1', key: 'feature-attachment/k1' },
      { name: 'b.jpg', mimeType: 'image/jpeg', sizeBytes: 5, url: '/api/portal/storage/private/feature-attachment/k3', key: 'feature-attachment/k3' },
    ]);
    // The stored row still keeps the bytes until the POST succeeds.
    for (const e of stored.photos as Array<Record<string, unknown>>) {
      expect(typeof e.dataUrl).toBe('string');
    }
  });

  it('uploads again once an earlier upload is too old to rely on', async () => {
    const storage = fakeStorage();
    let stored: Record<string, unknown> = { photos: [photo('a.jpg')] };
    const persist = async (next: Record<string, unknown>) => {
      stored = next;
    };
    await uploadQueuedAttachments(stored, persist, 0);
    const sent = await uploadQueuedAttachments(stored, persist, QUEUED_UPLOAD_REUSE_MS + 1);
    expect(storage.presigns()).toBe(2);
    expect((sent.photos as Array<Record<string, unknown>>)[0]!.key).toBe('feature-attachment/k2');
  });

  it('does not write the row when nothing was uploaded', async () => {
    fakeStorage();
    const persist = jest.fn(async () => {});
    const sent = await uploadQueuedAttachments({ note: 'hi' }, persist);
    expect(sent).toEqual({ note: 'hi' });
    expect(persist).not.toHaveBeenCalled();
  });
});
