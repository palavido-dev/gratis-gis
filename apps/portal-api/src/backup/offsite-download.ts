// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { unsealStream, type OffsitePrivateKey } from './offsite-crypto.js';
import { getObjectStream, type S3Like } from './offsite-store.js';

/** Expected size and SHA-256 of an encrypted object. */
export interface ObjectCheck {
  bytes: number | null;
  sha256: string;
}

/**
 * Download an object into an open, new file, counting and hashing its
 * bytes, and fail when it does not match `expect`. Nothing is
 * decrypted here. The caller reads the checked bytes back through the
 * same handle, so what was checked is what gets decrypted.
 */
export async function downloadChecked(
  s3: S3Like,
  bucket: string,
  objectKey: string,
  fh: fs.FileHandle,
  expect: ObjectCheck | null,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const body = await getObjectStream(s3, bucket, objectKey);
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    // Stop as soon as it is larger than the record says.
    if (expect && expect.bytes !== null && bytes + b.length > expect.bytes) {
      throw new Error(
        `The downloaded object is larger than the ${expect.bytes} bytes its record says. Nothing was decrypted.`,
      );
    }
    hash.update(b);
    let off = 0;
    while (off < b.length) {
      const { bytesWritten } = await fh.write(b, off, b.length - off, bytes + off);
      off += bytesWritten;
    }
    bytes += b.length;
  }
  const sha256 = hash.digest('hex');
  if (expect && expect.bytes !== null && expect.bytes !== bytes) {
    throw new Error(
      `The downloaded object has ${bytes} bytes; the signed record says ${expect.bytes}. Nothing was decrypted.`,
    );
  }
  if (expect && expect.sha256 !== sha256) {
    throw new Error(
      'The downloaded object does not match the checksum in its signed record. Nothing was decrypted.',
    );
  }
  return { bytes, sha256 };
}

/** The bytes of an open file from the start, through its handle. */
async function* readHandle(fh: fs.FileHandle): AsyncGenerator<Buffer> {
  for await (const c of fh.createReadStream({ start: 0, autoClose: false })) yield c as Buffer;
}

/**
 * Download, check, then decrypt one object to `file`. The encrypted
 * bytes go to a new scratch file first; the decrypted file appears only
 * when the check passed and every record verified. Both scratch files
 * are removed afterwards.
 */
export async function fetchChecked(
  s3: S3Like,
  bucket: string,
  objectKey: string,
  file: string,
  expect: ObjectCheck | null,
  key: OffsitePrivateKey,
): Promise<void> {
  const partial = `${file}.partial`;
  const scratch = `${file}.enc.partial`;
  // A run stopped half way leaves these behind.
  await fs.rm(partial, { force: true });
  await fs.rm(scratch, { force: true });
  try {
    const fh = await fs.open(scratch, 'wx+', 0o600);
    try {
      await downloadChecked(s3, bucket, objectKey, fh, expect);
      await pipeline(
        Readable.from(unsealStream(readHandle(fh), key)),
        createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
      );
    } finally {
      await fh.close();
      await fs.rm(scratch, { force: true });
    }
    await fs.rename(partial, file);
  } finally {
    await fs.rm(partial, { force: true });
  }
}
