// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imagery mosaic admission: the time ceiling used client-declared
// image sizes, the source cap applied per call instead of to the
// whole list, and a second build could be queued over a running one.

jest.mock('../storage/key-ownership.js', () => ({
  assertKeysAttachable: jest.fn(async () => undefined),
  deleteIfUnreferenced: jest.fn(async () => undefined),
}));

import { ConflictException } from '@nestjs/common';

import { MOSAIC_MAX_SOURCES } from './mosaic-sources.js';
import { TileLayerService } from './tile-layer.service.js';

const ITEM = '11111111-1111-4111-8111-111111111111';
const user = { id: 'u1', orgId: 'o1' } as never;

function key(n: number): string {
  return `item-tile-layer/${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
}

function service(opts: { jobsInFlight?: number; storedSize?: number | null; existing?: number } = {}) {
  const sources = Array.from({ length: opts.existing ?? 0 }, (_, i) => ({
    storageKey: key(i + 1000),
    fileName: `e${i}.tif`,
    sizeBytes: 10,
    addedAt: '2026-01-01T00:00:00.000Z',
  }));
  const item = {
    id: ITEM,
    type: 'tile_layer',
    data: {
      version: 1,
      format: 'cog',
      kind: 'raster',
      storageKey: '',
      storageUrl: '',
      fileName: '',
      sizeBytes: 0,
      uploadedAt: '',
      sources,
    },
  };
  const items = { get: jest.fn(async () => item), update: jest.fn(async () => item) };
  const prisma = {
    analysisJob: {
      count: jest.fn(async () => opts.jobsInFlight ?? 0),
      create: jest.fn(async () => ({ id: 'job-1' })),
    },
  };
  const storage = {
    headObjectSize: jest.fn(async () =>
      opts.storedSize === undefined ? 5 * 1024 ** 4 : opts.storedSize,
    ),
  };
  const cfg = { get: (k: string) => (k === 'ANALYSIS_TIERS' ? 'server-heavy' : undefined) };
  const svc = new TileLayerService(
    items as never,
    { canAdmin: () => true } as never,
    storage as never,
    prisma as never,
    cfg as never,
  );
  return { svc, prisma };
}

const one = { storageKey: key(1), fileName: 'a.tif', sizeBytes: 1 };

describe('imagery mosaic admission', () => {
  it('measures image sizes from storage, not from the request body', async () => {
    // 5 TiB stored, 1 byte declared: refused by the time ceiling.
    const { svc, prisma } = service();
    await expect(svc.mosaicBuild(user, ITEM, { sources: [one] })).rejects.toThrow(/very large/);
    expect(prisma.analysisJob.create).not.toHaveBeenCalled();
  });

  it('refuses an image that is not in storage', async () => {
    const { svc } = service({ storedSize: null });
    await expect(svc.mosaicBuild(user, ITEM, { sources: [one] })).rejects.toThrow(
      /not finished uploading/,
    );
  });

  it('refuses a second build while one is queued or running', async () => {
    const { svc, prisma } = service({ jobsInFlight: 1, storedSize: 10 });
    await expect(svc.mosaicBuild(user, ITEM, { sources: [one] })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.analysisJob.create).not.toHaveBeenCalled();
  });

  it('caps the whole source list, not only the batch being added', async () => {
    const { svc, prisma } = service({ storedSize: 10, existing: MOSAIC_MAX_SOURCES });
    await expect(svc.mosaicAddSources(user, ITEM, { sources: [one] })).rejects.toThrow(
      /at most/,
    );
    expect(prisma.analysisJob.create).not.toHaveBeenCalled();
  });

  it('queues a normal build', async () => {
    const { svc, prisma } = service({ storedSize: 10, existing: 2 });
    await expect(svc.mosaicAddSources(user, ITEM, { sources: [one] })).resolves.toMatchObject({
      jobId: 'job-1',
    });
    expect(prisma.analysisJob.create).toHaveBeenCalledTimes(1);
  });
});
