// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The resumable import upload (#573) against a real S3 server. A mock
 * client cannot show that presigned part URLs accept the bytes, that
 * ListParts reports what was stored, or that the completed object
 * streams back intact. Run it with any S3-compatible server:
 *
 *   moto_server -p 59123 &
 *   S3_TEST_ENDPOINT=http://127.0.0.1:59123 pnpm jest ingest-upload.s3
 *
 * MinIO works too. Pass S3_TEST_ACCESS_KEY and S3_TEST_SECRET_KEY for
 * it. Skipped unless S3_TEST_ENDPOINT is set.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { StorageService } from '../storage/storage.service.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestStagingService } from './ingest-staging.service.js';
import { IngestUploadService } from './ingest-upload.service.js';
import { resetIngestSlotsForTests } from './ingest-slots.js';

const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const d = ENDPOINT ? describe : describe.skip;
const ACCESS = process.env.S3_TEST_ACCESS_KEY ?? 'test';
const SECRET = process.env.S3_TEST_SECRET_KEY ?? 'testsecret';
const MIB = 1024 * 1024;

function user(id: string, role: 'viewer' | 'contributor' = 'contributor'): AuthUser {
  return {
    id,
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: role,
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]),
  } as unknown as AuthUser;
}

async function putParts(
  uploads: IngestUploadService,
  userId: string,
  handle: string,
  bytes: Buffer,
  partSize: number,
  partNumbers: number[],
): Promise<void> {
  const { parts } = await uploads.signParts(userId, handle, partNumbers);
  for (const p of parts) {
    const start = (p.partNumber - 1) * partSize;
    const body = bytes.subarray(start, Math.min(bytes.length, start + partSize));
    const res = await fetch(p.url, { method: 'PUT', body });
    if (!res.ok) throw new Error(`PUT part ${p.partNumber}: ${res.status} ${await res.text()}`);
    // The browser reads this header across origins. MinIO exposes it
    // in its CORS rule; here we only check the server sends it.
    expect(res.headers.get('etag')).toBeTruthy();
  }
}

d('resumable import upload against S3', () => {
  const previousStaging = process.env.STAGING_DIR;
  const bucket = `gg-upload-spec-${randomUUID().slice(0, 8)}`;
  let root: string;
  let storage: StorageService;
  let staging: IngestStagingService;
  let uploads: IngestUploadService;
  let controller: IngestController;
  const alice = user('00000000-0000-4000-8000-0000000000a1');
  const bob = user('00000000-0000-4000-8000-0000000000b2');

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-upload-spec-'));
    process.env.STAGING_DIR = root;
    const values: Record<string, string> = {
      MINIO_ENDPOINT: ENDPOINT!,
      MINIO_ACCESS_KEY: ACCESS,
      MINIO_SECRET_KEY: SECRET,
      MINIO_BUCKET: bucket,
    };
    const cfg = {
      get: <T>(key: string, fallback?: T) => (values[key] as T | undefined) ?? fallback,
    } as unknown as ConfigService;
    storage = new StorageService(cfg);
    const leader = { shouldRun: () => true } as unknown as LeaderElectionService;
    staging = new IngestStagingService(leader);
    uploads = new IngestUploadService(storage, staging, leader);
    controller = new IngestController(
      new IngestService(),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      staging,
      undefined,
      uploads,
    );
  });

  afterAll(() => {
    if (previousStaging === undefined) delete process.env.STAGING_DIR;
    else process.env.STAGING_DIR = previousStaging;
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => resetIngestSlotsForTests());

  async function openUploads(): Promise<number> {
    const client = new S3Client({
      endpoint: ENDPOINT!,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
    const res = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    return (res.Uploads ?? []).length;
  }

  it('uploads in parts, reports parts done for resume, and stages the exact bytes', async () => {
    const bytes = randomBytes(40 * MIB + 123);
    const started = await uploads.start(alice.id, 'big parcels.gpkg', bytes.length);
    expect(started.partSize).toBe(16 * MIB);
    expect(started.partCount).toBe(3);

    // Send parts 1 and 3, then "drop the connection".
    await putParts(uploads, alice.id, started.handle, bytes, started.partSize, [1, 3]);
    const status = await uploads.status(alice.id, started.handle);
    expect(status.uploadedParts.map((p) => p.partNumber)).toEqual([1, 3]);
    expect(status.partCount).toBe(3);

    // Finishing early is refused and leaves the upload resumable.
    await expect(
      uploads.completeToStaging(uploads.claimsFor(alice.id, started.handle)),
    ).rejects.toThrow(/1 of 3 parts are still missing/);

    // Resume: send only what status says is missing.
    const have = new Set(status.uploadedParts.map((p) => p.partNumber));
    const missing = [1, 2, 3].filter((n) => !have.has(n));
    await putParts(uploads, alice.id, started.handle, bytes, started.partSize, missing);

    const staged = await uploads.completeToStaging(uploads.claimsFor(alice.id, started.handle));
    expect(staged.sizeBytes).toBe(bytes.length);
    expect(staged.filePath.endsWith('big_parcels.gpkg')).toBe(true);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(sha(readFileSync(staged.filePath))).toBe(sha(bytes));
    const got = await staging.getStaging(staged.stagingId, alice.id);
    expect(got.originalName).toBe('big parcels.gpkg');

    // The completed object is gone from the bucket.
    expect(await storage.objectExists(uploads.claimsFor(alice.id, started.handle).key)).toBe(false);
    await staging.dropStaging(staged.stagingId);
  });

  it('complete feeds the stage path and returns stagingId, driver and layers', async () => {
    const geojson = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Cherry Valley', pop: 6000 },
            geometry: { type: 'Point', coordinates: [-116.97, 33.97] },
          },
          {
            type: 'Feature',
            properties: { name: 'Beaumont', pop: 53000 },
            geometry: { type: 'Point', coordinates: [-116.98, 33.93] },
          },
        ],
      }),
    );
    const started = await controller.startUpload(alice, {
      fileName: 'towns.geojson',
      sizeBytes: geojson.length,
    });
    expect(started.partCount).toBe(1);
    await putParts(uploads, alice.id, started.handle, geojson, started.partSize, [1]);

    const out = await controller.completeUpload(alice, { handle: started.handle });
    expect(out.stagingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.driver).toBe('GeoJSON');
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0]).toMatchObject({ featureCount: 2 });
    const fieldNames = (out.layers[0] as { fields: Array<{ name: string }> }).fields.map(
      (f) => f.name,
    );
    expect(fieldNames).toEqual(expect.arrayContaining(['name', 'pop']));
    expect(existsSync(join(root, out.stagingId))).toBe(true);
    await staging.dropStaging(out.stagingId);
  });

  it('refuses another user on sign, status, complete and abort', async () => {
    const started = await controller.startUpload(alice, {
      fileName: 'mine.geojson',
      sizeBytes: 10,
    });
    await expect(
      controller.signUploadParts(bob, { handle: started.handle, partNumbers: [1] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.uploadStatus(bob, { handle: started.handle }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.completeUpload(bob, { handle: started.handle }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.abortUpload(bob, { handle: started.handle }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // A viewer cannot use the endpoints at all.
    await expect(
      controller.startUpload(user(bob.id, 'viewer'), { fileName: 'x.geojson', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // The owner can still abort, and then the upload is gone.
    await controller.abortUpload(alice, { handle: started.handle });
    await expect(uploads.status(alice.id, started.handle)).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('refuses a file the staging disk cannot hold, before creating anything', async () => {
    const before = await openUploads();
    // 1.4 GB file, 2 GB free: under twice the size plus the margin.
    const spy = jest
      .spyOn(uploads, 'freeStagingBytes')
      .mockResolvedValue(2 * 1024 * MIB);
    let caught: unknown;
    try {
      await controller.startUpload(alice, {
        fileName: 'parcels.gpkg',
        sizeBytes: 1_500_000_000,
      });
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(HttpException);
    const http = caught as HttpException;
    expect(http.getStatus()).toBe(413);
    expect(http.message).toBe(
      'Not enough free disk space on the server for this file. 2.0 GB is free and 3.3 GB is needed (twice the file size, plus room to unpack it). Free some space and try again.',
    );
    expect(await openUploads()).toBe(before);
  });

  it('measures the real staging volume', async () => {
    const free = await uploads.freeStagingBytes();
    expect(free).toBeGreaterThan(0);
  });

  it('removes a completed object that was never staged once it is old', async () => {
    const key = `ingest-upload/${alice.id}/${randomUUID()}`;
    // Write a stray object under the upload prefix the way a crashed
    // complete would leave it.
    const id = await storage.createMultipartUpload(key);
    const url = await storage.presignUploadPart(key, id, 1, 1, 60);
    await fetch(url, { method: 'PUT', body: Buffer.from('x') });
    const parts = await storage.listUploadedParts(key, id);
    await storage.completeMultipartUpload(key, id, parts);
    expect(await storage.objectExists(key)).toBe(true);

    expect(await uploads.sweepLeftoverObjectsNow(Date.now())).toBe(0);
    expect(await storage.objectExists(key)).toBe(true);
    const later = Date.now() + 7 * 60 * 60 * 1000;
    expect(await uploads.sweepLeftoverObjectsNow(later)).toBeGreaterThanOrEqual(1);
    expect(await storage.objectExists(key)).toBe(false);
  });
});
