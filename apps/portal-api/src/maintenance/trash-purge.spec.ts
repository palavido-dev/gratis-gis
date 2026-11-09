// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import { TrashPurgeService } from './trash-purge.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The nightly purge reads its candidates once, then tears each one
 * down. An item restored in between must be left alone, and a purged
 * group must take its item shares with it.
 */
function build(stillTrashed: Set<string>) {
  const teardown = jest.fn(async () => undefined);
  const detach = jest.fn(async () => undefined);
  const deleted: string[] = [];
  const shareDeletes: unknown[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, id: string) =>
      stillTrashed.has(id) ? [{ id }] : [],
    ),
    item: {
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return {};
      }),
    },
    itemShare: {
      deleteMany: jest.fn(async (args: unknown) => {
        shareDeletes.push(args);
        return { count: 1 };
      }),
    },
    group: { deleteMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    item: {
      findMany: jest.fn(async () => [
        { id: 'kept', type: 'data_layer', data: {} },
        { id: 'gone', type: 'data_layer', data: {} },
      ]),
    },
    group: { findMany: jest.fn(async () => [{ id: 'g-1' }]) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const svc = new TrashPurgeService(
    prisma as unknown as PrismaService,
    { get: (_k: string, d: string) => d } as unknown as ConfigService,
    { shouldRun: () => true } as unknown as LeaderElectionService,
    { tearDownItemBackingStorage: teardown, detachPurgedItemReferences: detach } as unknown as ItemsService,
  );
  return { svc, teardown, deleted, shareDeletes };
}

describe('TrashPurgeService', () => {
  it('skips an item restored after the candidate list was read', async () => {
    const { svc, teardown, deleted } = build(new Set(['gone']));
    const out = await svc.purgeExpired();
    expect(out.items).toBe(1);
    expect(deleted).toEqual(['gone']);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith('gone', 'data_layer', {});
  });

  it('deletes item shares that name a purged group', async () => {
    const { svc, shareDeletes } = build(new Set());
    await svc.purgeExpired();
    expect(shareDeletes).toEqual([
      { where: { principalType: 'group', principalId: { in: ['g-1'] } } },
    ]);
  });
});
