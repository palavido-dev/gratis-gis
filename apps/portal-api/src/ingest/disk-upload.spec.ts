// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ForbiddenException } from '@nestjs/common';

import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import {
  admitUpload,
  resetUploadAdmissionForTests,
  sweepStaleIngestTempDirs,
} from './disk-upload.js';
import { IngestBusyException, IngestDiskException } from './ingest-slots.js';

const GiB = 1024 ** 3;

function fakeReq(role: 'viewer' | 'contributor', bytes: number, id = 'u1') {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.headers = { 'content-length': String(bytes) };
  req.user = { id, capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]) };
  return req as never;
}

describe('upload admission, before any bytes are written', () => {
  afterEach(() => resetUploadAdmissionForTests());

  it('refuses a caller without the publish capability on the wizard routes', async () => {
    await expect(
      admitUpload(fakeReq('viewer', 10), { requirePublish: true, freeBytes: 100 * GiB }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an upload the disk cannot hold', async () => {
    await expect(
      admitUpload(fakeReq('contributor', 10 * GiB), { requirePublish: true, freeBytes: 5 * GiB }),
    ).rejects.toBeInstanceOf(IngestDiskException);
  });

  it('counts uploads still arriving against free space', async () => {
    await admitUpload(fakeReq('contributor', 6 * GiB, 'a'), { requirePublish: false, freeBytes: 10 * GiB });
    await expect(
      admitUpload(fakeReq('contributor', 6 * GiB, 'b'), { requirePublish: false, freeBytes: 10 * GiB }),
    ).rejects.toBeInstanceOf(IngestDiskException);
  });

  it('caps how many uploads one user sends at once and frees the slot when the body ends', async () => {
    const first = fakeReq('contributor', 1);
    await admitUpload(first, { requirePublish: false, freeBytes: 10 * GiB });
    await admitUpload(fakeReq('contributor', 1), { requirePublish: false, freeBytes: 10 * GiB });
    await expect(
      admitUpload(fakeReq('contributor', 1), { requirePublish: false, freeBytes: 10 * GiB }),
    ).rejects.toBeInstanceOf(IngestBusyException);
    (first as unknown as EventEmitter).emit('end');
    await expect(
      admitUpload(fakeReq('contributor', 1), { requirePublish: false, freeBytes: 10 * GiB }),
    ).resolves.toBeUndefined();
  });
});

describe('sweepStaleIngestTempDirs', () => {
  it('removes old upload dirs and keeps fresh ones and other dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gg-sweep-spec-'));
    try {
      const old = join(root, 'gg-ingest-old');
      const fresh = join(root, 'gg-ingest-fresh');
      const other = join(root, 'something-else');
      for (const d of [old, fresh, other]) await mkdir(d);
      await writeFile(join(old, 'payload.bin'), 'x');
      const past = new Date(Date.now() - 48 * 3600_000);
      await utimes(join(old, 'payload.bin'), past, past);
      await utimes(old, past, past);
      await utimes(other, past, past);
      const removed = await sweepStaleIngestTempDirs(6 * 3600_000, root);
      expect(removed).toBe(1);
      expect((await readdir(root)).sort()).toEqual(['gg-ingest-fresh', 'something-else']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
