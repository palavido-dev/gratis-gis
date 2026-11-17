// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PresignUploadDto } from './storage.controller.js';
import { StorageService } from './storage.service.js';

/**
 * The presign size guard, end to end.
 *
 * `sizeBytes` was optional "so older clients keep working", and four
 * call sites in our own web app were the older clients: they left it
 * out, so the per-kind cap never applied to them and the presigned PUT
 * carried no Content-Length condition. The guard is only a guard when
 * every request declares a size, so this pins the three pieces that
 * make it one: the DTO refuses a request without a size, the service
 * refuses an over-cap size, and the URL it signs binds the size so the
 * PUT cannot send more than what was checked.
 *
 * Signing needs no network: SigV4 is arithmetic over the request, so a
 * service built from default config produces a real URL to inspect.
 */
function service(): StorageService {
  const cfg = {
    get: <T>(_key: string, fallback?: T) => fallback,
  } as unknown as ConfigService;
  const svc = new StorageService(cfg);
  // Skip the bucket bootstrap; the test never talks to MinIO.
  (svc as unknown as { bootstrapped: boolean }).bootstrapped = true;
  return svc;
}

function signedHeaders(url: string): string[] {
  const value = new URL(url).searchParams.get('X-Amz-SignedHeaders');
  return value ? value.split(';') : [];
}

describe('PresignUploadDto', () => {
  it('refuses a request that leaves the size out', async () => {
    const dto = plainToInstance(PresignUploadDto, {
      kind: 'item-thumb',
      contentType: 'image/png',
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['sizeBytes']);
  });

  it('refuses a negative or fractional size', async () => {
    for (const sizeBytes of [-1, 1.5]) {
      const dto = plainToInstance(PresignUploadDto, {
        kind: 'item-thumb',
        contentType: 'image/png',
        sizeBytes,
      });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toEqual(['sizeBytes']);
    }
  });

  it('accepts a complete request', async () => {
    const dto = plainToInstance(PresignUploadDto, {
      kind: 'feature-attachment',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });
    await expect(validate(dto)).resolves.toEqual([]);
  });
});

describe('StorageService.presignUpload size guard', () => {
  it('refuses an over-cap size with the cap in the message', async () => {
    // 5 MB is the thumbnail cap.
    await expect(
      service().presignUpload('item-thumb', 'image/png', 5 * 1024 * 1024 + 1),
    ).rejects.toThrow(/too large.*5 MB/);
  });

  it('applies the per-kind cap, not one global number', async () => {
    // 6 MB is over the thumbnail cap and well under the attachment one.
    const six = 6 * 1024 * 1024;
    await expect(
      service().presignUpload('item-thumb', 'image/png', six),
    ).rejects.toThrow(/too large/);
    await expect(
      service().presignUpload('feature-attachment', 'image/png', six),
    ).resolves.toMatchObject({ maxBytes: 25 * 1024 * 1024 });
  });

  it('refuses a size that is not a real byte count', async () => {
    await expect(
      service().presignUpload('item-thumb', 'image/png', -1),
    ).rejects.toThrow('Invalid upload size.');
    await expect(
      service().presignUpload('item-thumb', 'image/png', Number.NaN),
    ).rejects.toThrow('Invalid upload size.');
  });

  it('signs the size into the URL, so the PUT cannot exceed it', async () => {
    // A header in X-Amz-SignedHeaders is part of the signature: a PUT
    // whose Content-Length differs from the presigned one fails the
    // signature check at the bucket. Without this the size check above
    // would only be advice.
    const { uploadUrl, contentType } = await service().presignUpload(
      'item-file',
      'application/zip',
      4096,
    );
    expect(signedHeaders(uploadUrl)).toContain('content-length');
    // The type is signed too, so a PUT cannot swap image/png for
    // text/html on a public prefix.
    expect(signedHeaders(uploadUrl)).toContain('content-type');
    expect(contentType).toBe('application/zip');
  });

  it('accepts an empty file, which is a legitimate zero', async () => {
    await expect(
      service().presignUpload('item-file', 'text/plain', 0),
    ).resolves.toMatchObject({ key: expect.stringMatching(/^item-file\//) });
  });
});

describe('StorageService.presignUploadPart', () => {
  it('signs the part length, so a part PUT cannot carry more bytes', async () => {
    const url = await service().presignUploadPart(
      'ingest-upload/u/k',
      'upload-1',
      3,
      16 * 1024 * 1024,
      3600,
    );
    expect(signedHeaders(url)).toContain('content-length');
    const params = new URL(url).searchParams;
    expect(params.get('partNumber')).toBe('3');
    expect(params.get('uploadId')).toBe('upload-1');
    // A browser cannot add checksum headers, so none may be signed.
    expect(signedHeaders(url).filter((h) => h.includes('checksum'))).toEqual([]);
    expect([...params.keys()].filter((k) => k.toLowerCase().includes('checksum'))).toEqual([]);
  });
});

describe('large upload presign gate', () => {
  it('refuses a fifth open large upload for one user', async () => {
    const { assertLargeGrantRoom, MAX_OPEN_LARGE_GRANTS } = await import('./key-ownership.js');
    const prisma = {
      storageUploadGrant: { count: jest.fn(async () => MAX_OPEN_LARGE_GRANTS) },
    };
    await expect(
      assertLargeGrantRoom(prisma as never, 'item-tile-layer', 'u1'),
    ).rejects.toThrow(/large uploads in progress/);
    // Small kinds are not counted.
    await expect(
      assertLargeGrantRoom(prisma as never, 'item-thumb', 'u1'),
    ).resolves.toBeUndefined();
  });

  it('refuses a large presign from a viewer', async () => {
    const { StorageController } = await import('./storage.controller.js');
    const { ROLE_BASELINES } = await import('../auth/capabilities.js');
    const c = new StorageController(
      {} as never,
      { storageUploadGrant: { count: async () => 0 } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      c.presignUpload(
        { id: 'u1', capabilities: new Set(ROLE_BASELINES.viewer) } as never,
        { kind: 'item-tile-layer', contentType: 'image/tiff', sizeBytes: 10 } as never,
      ),
    ).rejects.toThrow(/contributor or admin/);
  });
});
