// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  choosePartSize,
  INGEST_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_PARTS,
  MIN_PART_BYTES,
  partCountFor,
  partLength,
  requiredFreeBytes,
  signUploadHandle,
  verifyUploadHandle,
  type UploadClaims,
} from './ingest-upload-handle.js';

const MIB = 1024 * 1024;
const KEY = Buffer.alloc(32, 7);

function claims(over: Partial<UploadClaims> = {}): UploadClaims {
  return {
    uid: '00000000-0000-0000-0000-0000000000aa',
    key: 'ingest-upload/00000000-0000-0000-0000-0000000000aa/abc',
    upl: 'upload-1',
    size: 1_500_000_000,
    part: 16 * MIB,
    name: 'parcels.gpkg',
    exp: Date.now() + 60_000,
    ...over,
  };
}

describe('part sizing', () => {
  it('uses 16 MiB parts for ordinary files', () => {
    expect(choosePartSize(1)).toBe(MIN_PART_BYTES);
    expect(choosePartSize(1_500_000_000)).toBe(MIN_PART_BYTES);
    expect(partCountFor(1_500_000_000, MIN_PART_BYTES)).toBe(90);
  });

  it('never needs more than 10,000 parts, up to the ceiling and past it', () => {
    for (const size of [INGEST_MAX_UPLOAD_BYTES, 200 * 1024 * 1024 * MIB]) {
      const part = choosePartSize(size);
      expect(part % MIB).toBe(0);
      expect(partCountFor(size, part)).toBeLessThanOrEqual(MAX_UPLOAD_PARTS);
    }
  });

  it('gives every part the part size except the last, which holds the rest', () => {
    const size = 40 * MIB + 5;
    const part = choosePartSize(size);
    const count = partCountFor(size, part);
    expect(count).toBe(3);
    expect(partLength(size, part, 1)).toBe(part);
    expect(partLength(size, part, 3)).toBe(size - 2 * part);
    let total = 0;
    for (let n = 1; n <= count; n += 1) total += partLength(size, part, n);
    expect(total).toBe(size);
    expect(partLength(size, part, 0)).toBe(0);
    expect(partLength(size, part, 4)).toBe(0);
  });

  it('asks for twice the file plus a margin of free disk', () => {
    expect(requiredFreeBytes(1000)).toBe(2000 + 512 * MIB);
  });
});

describe('upload handle', () => {
  it('round-trips its claims', () => {
    const c = claims();
    expect(verifyUploadHandle(signUploadHandle(c, KEY), KEY)).toEqual(c);
  });

  it('refuses a handle signed with another key', () => {
    const handle = signUploadHandle(claims(), Buffer.alloc(32, 8));
    expect(verifyUploadHandle(handle, KEY)).toBeNull();
  });

  it('refuses edited claims, such as a swapped user id or a larger size', () => {
    const handle = signUploadHandle(claims(), KEY);
    const [, sig] = handle.split('.');
    for (const edit of [{ uid: 'someone-else' }, { size: 5 }]) {
      const body = Buffer.from(JSON.stringify(claims(edit))).toString('base64url');
      expect(verifyUploadHandle(`${body}.${sig}`, KEY)).toBeNull();
    }
  });

  it('refuses an expired handle and junk', () => {
    expect(verifyUploadHandle(signUploadHandle(claims({ exp: 1 }), KEY), KEY)).toBeNull();
    for (const junk of [undefined, 42, '', 'abc', 'a.b.c', '.x', 'x'.repeat(5000)]) {
      expect(verifyUploadHandle(junk, KEY)).toBeNull();
    }
  });
});
