// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';
import { OfflinePackageService } from './offline-package.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OfflineArea } from '@gratis-gis/shared-types';

/**
 * Behaviour pins for the offline package queue (2026-08-24 review,
 * finding 8: none of these paths had coverage, and each one guards
 * an invariant a race can break).
 */

const AREA: OfflineArea = {
  id: 'a1',
  name: 'North',
  bbox: [-80, 38, -79, 39],
  minZoom: 0,
  maxZoom: 14,
};

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makePrisma(over: Record<string, unknown> = {}) {
  const offlinePackage = {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(async () => [] as Array<{ id: string }>),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 0 })),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    ...((over.offlinePackage as object) ?? {}),
  };
  const prisma = {
    offlinePackage,
    // markReady runs inside a transaction; hand the same mock
    // surface through so the spec sees every call.
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ offlinePackage }),
    ),
    ...over,
  } as unknown as PrismaService;
  return { prisma, offlinePackage };
}

describe('OfflinePackageService.enqueue', () => {
  const input = {
    orgId: 'org1',
    itemId: 'item1',
    area: AREA,
    createdBy: 'user1',
    sourceUrl: 'https://example.com/planet.pmtiles',
  };

  it('returns the created row on the happy path', async () => {
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.create.mockResolvedValue({ id: 'pkg1' });
    const svc = new OfflinePackageService(prisma);
    const out = await svc.enqueue(input);
    expect(out).toEqual({ package: { id: 'pkg1' }, alreadyQueued: false });
  });

  it('returns the existing active row on a unique-index conflict', async () => {
    // The partial unique index is what makes "Build now" idempotent
    // under a double click; this pins that losing the insert race
    // reports the winner rather than erroring.
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.create.mockRejectedValueOnce(p2002());
    offlinePackage.findFirst.mockResolvedValue({ id: 'winner' });
    const svc = new OfflinePackageService(prisma);
    const out = await svc.enqueue(input);
    expect(out).toEqual({ package: { id: 'winner' }, alreadyQueued: true });
  });

  it('re-inserts when the conflicting build finished in the gap', async () => {
    // Subtle branch: the winner can complete between our failed
    // insert and our lookup, leaving no active row to return. The
    // correct behaviour is a fresh insert, not a conflict error the
    // situation has already resolved.
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.create
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({ id: 'retry' });
    offlinePackage.findFirst.mockResolvedValue(null);
    const svc = new OfflinePackageService(prisma);
    const out = await svc.enqueue(input);
    expect(out).toEqual({ package: { id: 'retry' }, alreadyQueued: false });
    expect(offlinePackage.create).toHaveBeenCalledTimes(2);
  });

  it('rethrows anything that is not a unique violation', async () => {
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.create.mockRejectedValue(new Error('connection reset'));
    const svc = new OfflinePackageService(prisma);
    await expect(svc.enqueue(input)).rejects.toThrow('connection reset');
  });
});

describe('OfflinePackageService.markReady', () => {
  it('promotes, demotes only the same area, and prunes old generations', async () => {
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.update.mockResolvedValue({
      id: 'new',
      itemId: 'item1',
      areaId: 'a1',
    });
    offlinePackage.findMany.mockResolvedValue([{ id: 'old-2' }, { id: 'old-3' }]);
    const svc = new OfflinePackageService(prisma);
    await svc.markReady('new', 'offline-package/key', 123, 456);

    // Promotion carries the build results.
    expect(offlinePackage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'new' },
        data: expect.objectContaining({
          status: 'ready',
          storageKey: 'offline-package/key',
          sizeBytes: 123,
          tileCount: 456,
        }),
      }),
    );
    // Demotion is scoped: same item, same area, ready, not itself.
    // The scoping is what keeps a rebuild of the north area from
    // demoting the south area's working package.
    expect(offlinePackage.updateMany).toHaveBeenCalledWith({
      where: {
        itemId: 'item1',
        areaId: 'a1',
        status: 'ready',
        id: { not: 'new' },
      },
      data: { status: 'superseded' },
    });
    // Generation pruning keeps the newest superseded (skip: 1) and
    // deletes the rest, which is what stops weekly refreshes from
    // accumulating unreclaimable archives forever.
    expect(offlinePackage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1 }),
    );
    expect(offlinePackage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-2', 'old-3'] } },
    });
  });

  it('deletes nothing when only one superseded generation exists', async () => {
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.update.mockResolvedValue({
      id: 'new',
      itemId: 'item1',
      areaId: 'a1',
    });
    offlinePackage.findMany.mockResolvedValue([]);
    const svc = new OfflinePackageService(prisma);
    await svc.markReady('new', 'k', 1, 1);
    expect(offlinePackage.deleteMany).not.toHaveBeenCalled();
  });
});

describe('OfflinePackageService.recoverStale', () => {
  it('re-checks status on the write so a just-finished build is not failed', async () => {
    // The findMany and the updateMany are separated by time. A build
    // that publishes in that window is 'ready' by the time the write
    // runs, and flipping it to failed would take a working package
    // away from collectors. The status guard on the updateMany is
    // the whole protection; pin that it is present.
    const { prisma, offlinePackage } = makePrisma();
    offlinePackage.findMany.mockResolvedValue([{ id: 'stale-1' }]);
    const svc = new OfflinePackageService(prisma);
    await svc.recoverStale(0);
    expect(offlinePackage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'building' }),
      }),
    );
  });
});
