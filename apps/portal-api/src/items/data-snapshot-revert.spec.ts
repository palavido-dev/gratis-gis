// SPDX-License-Identifier: AGPL-3.0-or-later
import { DataSnapshotService } from './data-snapshot.service.js';

/**
 * Reverting a data layer to an older snapshot used to write the
 * snapshot's data verbatim with no lock. A layer's syncVersion is the
 * delta cursor field clients hold, so the revert moved it backwards
 * and those clients skipped every edit made since. The revert now
 * runs under the row lock and keeps the current syncVersion.
 */
describe('DataSnapshotService.revert', () => {
  function makePrisma(type: string) {
    const prisma = {
      itemDataSnapshot: {
        findUnique: jest.fn(async () => ({
          id: 'snap-1',
          itemId: 'item-1',
          data: {
            version: 3,
            layers: [{ id: 'L1', syncVersion: 640, fields: [] }],
            bbox: [0, 0, 1, 1],
          },
        })),
        create: jest.fn(async () => ({ id: 'snap-2' })),
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      item: {
        findUnique: jest.fn(async () => ({ type, data: {} })),
        update: jest.fn(async () => ({})),
      },
      $queryRaw: jest.fn(async () => [
        {
          data: { version: 3, layers: [{ id: 'L1', syncVersion: 812 }] },
          updated_at_ms: 0,
        },
      ]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return prisma;
  }

  it('keeps the current syncVersion and writes inside the locked transaction', async () => {
    const prisma = makePrisma('data_layer');
    const svc = new DataSnapshotService(prisma as never);
    await svc.revert('snap-1', 'user-1');
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalled();
    const args = (prisma.item.update.mock.calls as unknown as Array<
      [{ data: { data: { layers: Array<{ syncVersion: number }> }; bbox: unknown } }]
    >)[0]![0];
    expect(args.data.data.layers[0]!.syncVersion).toBe(812);
    expect(args.data.bbox).toEqual([0, 0, 1, 1]);
  });

  it('leaves the stored extent of a map alone and asks for a recompute', async () => {
    const prisma = makePrisma('map');
    prisma.itemDataSnapshot.findUnique.mockResolvedValueOnce({
      id: 'snap-1',
      itemId: 'item-1',
      data: { layers: [{ kind: 'data-layer', itemId: 'layer-1' }] },
    } as never);
    const refreshItemBbox = jest.fn();
    const svc = new DataSnapshotService(
      prisma as never,
      { refreshItemBbox } as never,
    );
    await svc.revert('snap-1', 'user-1');
    const args = (prisma.item.update.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >)[0]![0];
    expect('bbox' in args.data).toBe(false);
    expect(refreshItemBbox).toHaveBeenCalledWith('item-1');
  });
});
