// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';

import { FakeS3 } from '../testing/fake-s3.js';
import {
  describeS3Error,
  etagIsMd5,
  OffsiteVerifyError,
  partSizeFor,
  uploadStream,
} from './offsite-store.js';

async function* pieces(buf: Buffer, step = 300_000): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
}

const PART = 1024 * 1024;

describe('uploadStream', () => {
  it('uploads in parts, verifies, and reports size and sha256', async () => {
    const s3 = new FakeS3();
    const data = randomBytes(3 * PART + 123);
    const res = await uploadStream(s3, {
      bucket: 'b',
      key: 'k',
      body: pieces(data),
      partSize: PART,
    });
    expect(res.bytes).toBe(data.length);
    expect(res.parts).toBe(4);
    expect(res.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(s3.objects.get('k')!.body.equals(data)).toBe(true);
    expect(s3.calls).toContain('HeadObjectCommand');
  });

  it('uploads an empty body as one part', async () => {
    const s3 = new FakeS3();
    const res = await uploadStream(s3, {
      bucket: 'b',
      key: 'k',
      body: pieces(Buffer.alloc(0)),
      partSize: PART,
    });
    expect(res).toMatchObject({ bytes: 0, parts: 1 });
  });

  it('aborts and fails when a part comes back with another checksum', async () => {
    const s3 = new FakeS3();
    s3.lieAboutPartEtag = true;
    await expect(
      uploadStream(s3, {
        bucket: 'b',
        key: 'k',
        body: pieces(randomBytes(PART + 10)),
        partSize: PART,
      }),
    ).rejects.toBeInstanceOf(OffsiteVerifyError);
    expect(s3.aborted).toHaveLength(1);
    expect(s3.objects.has('k')).toBe(false);
  });

  it('fails when the stored size differs from what was sent', async () => {
    const s3 = new FakeS3();
    s3.lieAboutSize = true;
    await expect(
      uploadStream(s3, { bucket: 'b', key: 'k', body: pieces(randomBytes(10)), partSize: PART }),
    ).rejects.toThrow(/bytes were sent|bytes; 10 were sent/);
  });

  it('fails when the byte count is not the one predicted', async () => {
    const s3 = new FakeS3();
    await expect(
      uploadStream(s3, {
        bucket: 'b',
        key: 'k',
        body: pieces(randomBytes(10)),
        partSize: PART,
        expectedBytes: 11,
      }),
    ).rejects.toThrow(/expected 11/);
  });

  it('aborts the upload when a part is refused', async () => {
    const s3 = new FakeS3();
    s3.fail('UploadPartCommand', 'InvalidAccessKeyId', 403);
    await expect(
      uploadStream(s3, {
        bucket: 'b',
        key: 'k',
        body: pieces(randomBytes(PART + 10)),
        partSize: PART,
      }),
    ).rejects.toThrow();
    expect(s3.aborted).toHaveLength(1);
  });
});

describe('etagIsMd5', () => {
  /** A body that records whether it was closed, and can fail part way. */
  function tracked(data: Buffer, failAfter: number | null = null) {
    const state = { closed: false, read: 0 };
    async function* gen(): AsyncGenerator<Buffer> {
      try {
        for (let i = 0; i < data.length; i += 300_000) {
          if (failAfter !== null && state.read >= failAfter) {
            throw Object.assign(new Error('source read failed'), { code: 'EIO' });
          }
          const piece = data.subarray(i, i + 300_000);
          state.read += piece.length;
          yield piece;
        }
      } finally {
        state.closed = true;
      }
    }
    return { body: gen(), state };
  }

  it('aborts and stores nothing when the source fails in the middle of a multipart upload', async () => {
    const s3 = new FakeS3();
    const { body, state } = tracked(randomBytes(5 * PART), 2 * PART + 10);
    await expect(uploadStream(s3, { bucket: 'b', key: 'k', body, partSize: PART })).rejects.toThrow(
      /source read failed/,
    );
    expect(s3.calls).toContain('UploadPartCommand');
    expect(s3.aborted).toHaveLength(1);
    expect(s3.objects.has('k')).toBe(false);
    expect(s3.uploads.size).toBe(0);
    expect(state.closed).toBe(true);
  });

  it('closes the body when the store refuses to start the upload', async () => {
    const s3 = new FakeS3();
    s3.fail('CreateMultipartUploadCommand', 'AccessDenied', 403);
    const { body, state } = tracked(randomBytes(3 * PART));
    await expect(
      uploadStream(s3, { bucket: 'b', key: 'k', body, partSize: PART }),
    ).rejects.toThrow();
    expect(state.closed).toBe(true);
    expect(state.read).toBeLessThan(3 * PART);
  });

  it('closes the body when a part is refused half way', async () => {
    const s3 = new FakeS3();
    s3.fail('UploadPartCommand', 'InternalError', 500);
    const { body, state } = tracked(randomBytes(4 * PART));
    await expect(
      uploadStream(s3, { bucket: 'b', key: 'k', body, partSize: PART }),
    ).rejects.toThrow();
    expect(state.closed).toBe(true);
    expect(s3.aborted).toHaveLength(1);
  });

  it('does not compare ETags of KMS or customer-key encrypted objects', () => {
    expect(etagIsMd5({ ETag: '"x"' })).toBe(true);
    expect(etagIsMd5({ ETag: '"x"', ServerSideEncryption: 'AES256' })).toBe(true);
    expect(etagIsMd5({ ETag: '"x"', ServerSideEncryption: 'aws:kms' })).toBe(false);
    expect(etagIsMd5({ ETag: '"x"', ServerSideEncryption: 'aws:kms:dsse' })).toBe(false);
    expect(etagIsMd5({ ETag: '"x"', SSECustomerAlgorithm: 'AES256' })).toBe(false);
  });
});

describe('partSizeFor', () => {
  it('stays inside the 10,000 part limit', () => {
    const big = 500 * 1024 ** 3;
    expect(Math.ceil(big / partSizeFor(big))).toBeLessThanOrEqual(10_000);
    expect(partSizeFor(10)).toBe(16 * 1024 * 1024);
  });
});

describe('describeS3Error', () => {
  it('names clock skew plainly', () => {
    expect(describeS3Error({ name: 'RequestTimeTooSkewed' })).toMatch(/clock/);
  });
  it('names bad credentials plainly', () => {
    expect(describeS3Error({ name: 'SignatureDoesNotMatch' })).toMatch(/access key or secret/);
  });
  it('falls back to the code and message', () => {
    expect(describeS3Error({ name: 'Weird', message: 'odd' })).toBe('Weird: odd');
  });
});
