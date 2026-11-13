// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { uploadPendingAttachmentsInResponse } from './form-attachment-upload';

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
