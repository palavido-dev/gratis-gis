// SPDX-License-Identifier: AGPL-3.0-or-later
import { HttpException } from '@nestjs/common';

import { IngestUploadService } from './ingest-upload.service.js';
import {
  INGEST_UPLOAD_PREFIX,
  UPLOAD_HANDLE_TTL_MS,
  declaredSizeOfKey,
  uploadObjectKey,
} from './ingest-upload-handle.js';

/**
 * Starting a resumable upload. Started uploads hold no reservation
 * until they complete, so each new start used to pass the same
 * free-space check, and one account could park any number of them.
 */
const USER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const GiB = 1024 ** 3;

function service(open: string[], free: number) {
  const storage = {
    deriveSigningKey: () => Buffer.alloc(32, 1),
    listMultipartUploadsUnder: jest.fn(async () => open),
    createMultipartUpload: jest.fn(async () => 'upload-id'),
  };
  const svc = new IngestUploadService(storage as never, {} as never);
  jest.spyOn(svc, 'freeStagingBytes').mockResolvedValue(free);
  return { svc, storage };
}

describe('IngestUploadService.start', () => {
  it('refuses a fourth open upload for one user', async () => {
    const open = [1, 2, 3].map((i) => uploadObjectKey(USER, 10, `id-${i}`));
    const { svc, storage } = service(open, 100 * GiB);
    await expect(svc.start(USER, 'a.gpkg', 10)).rejects.toMatchObject({ status: 429 });
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('counts the bytes other open uploads will need', async () => {
    const open = [uploadObjectKey(OTHER, 20 * GiB, 'x')];
    const { svc } = service(open, 30 * GiB);
    // 2 x (10 + 20) GiB plus margin is more than 30 GiB free.
    await expect(svc.start(USER, 'a.gpkg', 10 * GiB)).rejects.toBeInstanceOf(HttpException);
  });

  it('writes the declared size into the key and a handle that lives as long as MinIO keeps parts', async () => {
    const { svc, storage } = service([], 100 * GiB);
    const before = Date.now();
    const started = await svc.start(USER, 'a.gpkg', 12345);
    const key = (storage.createMultipartUpload.mock.calls[0] as unknown as [string])[0];
    expect(key.startsWith(`${INGEST_UPLOAD_PREFIX}${USER}/`)).toBe(true);
    expect(declaredSizeOfKey(key)).toBe(12345);
    expect(Date.parse(started.expiresAt) - before).toBeLessThanOrEqual(UPLOAD_HANDLE_TTL_MS + 1000);
    expect(UPLOAD_HANDLE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('reads no size from a key written before sizes were part of it', () => {
    expect(declaredSizeOfKey(`${INGEST_UPLOAD_PREFIX}${USER}/7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab`)).toBe(0);
    expect(declaredSizeOfKey(`${INGEST_UPLOAD_PREFIX}${USER}/12345678-aaaa-4bbb-8ccc-0123456789ab`)).toBe(0);
  });
});
