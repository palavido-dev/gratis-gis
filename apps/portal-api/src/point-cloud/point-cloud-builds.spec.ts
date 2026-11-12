// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Point cloud builds: the merge ceiling used client-declared tile
// sizes, builds stacked up for the same item, finalize deleted the
// old file before the item row moved, the public file route 500'd on
// a malformed id, and the file was served immutable on a URL that
// stays the same when the file is replaced.

jest.mock('../storage/key-ownership.js', () => ({
  assertKeysAttachable: jest.fn(async () => undefined),
  deleteIfUnreferenced: jest.fn(async () => undefined),
}));
jest.mock('./copc-header.js', () => ({
  COPC_PROBE_BYTES: 16,
  CopcParseError: class extends Error {},
  parseCopcHeader: () => ({
    pointCount: 1,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    lasVersion: '1.4',
    pointFormat: 6,
    hasRgb: false,
  }),
}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';

import { deleteIfUnreferenced } from '../storage/key-ownership.js';
import { PointCloudController } from './point-cloud.controller.js';
import { PointCloudService } from './point-cloud.service.js';

const ITEM = '11111111-1111-4111-8111-111111111111';
const KEY = 'item-point-cloud/22222222-2222-4222-8222-222222222222';
const user = { id: 'u1', orgId: 'o1' } as never;

function service(opts: { jobsInFlight?: number; storedSize?: number | null } = {}) {
  const calls: string[] = [];
  const item = { id: ITEM, type: 'point_cloud', data: { version: 1, format: 'copc', storageKey: 'item-point-cloud/old', storageUrl: '', fileName: 'a', sizeBytes: 1, uploadedAt: '' } };
  const items = {
    get: jest.fn(async () => item),
    update: jest.fn(async () => {
      calls.push('update');
      return item;
    }),
  };
  const prisma = {
    analysisJob: {
      count: jest.fn(async () => opts.jobsInFlight ?? 0),
      create: jest.fn(async () => ({ id: 'job-1' })),
    },
  };
  const storage = {
    headObjectSize: jest.fn(async () => (opts.storedSize === undefined ? 5 * 1024 ** 4 : opts.storedSize)),
    streamObject: jest.fn(async () => ({ body: Readable.from([Buffer.alloc(16)]) })),
  };
  const cfg = { get: (k: string) => (k === 'ANALYSIS_TIERS' ? 'server-heavy' : undefined) };
  (deleteIfUnreferenced as jest.Mock).mockImplementation(async () => {
    calls.push('delete-old');
  });
  const svc = new PointCloudService(
    items as never,
    { canAdmin: () => true } as never,
    storage as never,
    prisma as never,
    cfg as never,
  );
  return { svc, items, prisma, storage, calls };
}

const tile = { storageKey: KEY, fileName: 't.laz', sizeBytes: 1 };

describe('point cloud builds', () => {
  it('measures tile sizes from storage, not from the request body', async () => {
    // 5 TiB stored, 1 byte declared: refused by the merge ceiling.
    const { svc, prisma } = service();
    await expect(svc.buildFromSources(user, ITEM, { sources: [tile] })).rejects.toThrow(/very large/);
    expect(prisma.analysisJob.create).not.toHaveBeenCalled();
  });

  it('refuses a tile that is not in storage', async () => {
    const { svc } = service({ storedSize: null });
    await expect(svc.buildFromSources(user, ITEM, { sources: [tile] })).rejects.toThrow(/not finished uploading/);
  });

  it('refuses a second build while one is queued or running', async () => {
    const { svc, prisma } = service({ jobsInFlight: 1, storedSize: 10 });
    await expect(svc.buildFromSources(user, ITEM, { sources: [tile] })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.analysisJob.create).not.toHaveBeenCalled();
  });

  it('finalize moves the item to the new file before deleting the old one, and not during a build', async () => {
    const ok = service({ storedSize: 10 });
    await ok.svc.finalizeUpload(user, ITEM, { storageKey: KEY, storageUrl: 'u', fileName: 'b.copc.laz', sizeBytes: 10 });
    expect(ok.calls).toEqual(['update', 'delete-old']);

    const busy = service({ jobsInFlight: 1 });
    await expect(
      busy.svc.finalizeUpload(user, ITEM, { storageKey: KEY, storageUrl: 'u', fileName: 'b.copc.laz', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(busy.items.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed id on the public file route', async () => {
    const { svc } = service();
    await expect(svc.resolveStorageKey(null, 'abc')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('point cloud file caching', () => {
  function res() {
    const headers: Record<string, string> = {};
    const r = {
      statusCode: 0,
      headers,
      status(c: number) {
        r.statusCode = c;
        return r;
      },
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
      end: jest.fn(),
      on: jest.fn(),
    };
    return r;
  }

  it('revalidates instead of caching immutable, and answers 304 for the same file', async () => {
    const storage = {
      streamObject: jest.fn(async () => ({
        statusCode: 200,
        body: Readable.from([Buffer.from('x')]),
      })),
    };
    const pc = { resolveStorageKey: jest.fn(async () => KEY) };
    const c = new PointCloudController(pc as never, storage as never);
    const first = res();
    first.on.mockImplementation(() => undefined);
    const pipe = jest.spyOn(Readable.prototype, 'pipe').mockImplementation(function (this: Readable) {
      setImmediate(() => this.emit('end'));
      return undefined as never;
    });
    await c.serveFile(null, ITEM, undefined, { headers: {} } as never, first as never);
    pipe.mockRestore();
    expect(first.headers['Cache-Control']).toBe('public, no-cache');
    const etag = first.headers.ETag!;
    expect(etag).toMatch(/^"pc-/);

    const second = res();
    await c.serveFile(null, ITEM, undefined, { headers: { 'if-none-match': etag } } as never, second as never);
    expect(second.statusCode).toBe(304);
    expect(storage.streamObject).toHaveBeenCalledTimes(1);
  });
});
