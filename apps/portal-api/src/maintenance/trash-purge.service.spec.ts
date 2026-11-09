// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import { TrashPurgeService } from './trash-purge.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { ItemsService } from '../items/items.service.js';

function service(retention: string | undefined) {
  const cutoffs: Date[] = [];
  const prisma = {
    item: {
      findMany: jest.fn(async (args: { where: { deletedAt: { lt: Date } } }) => {
        cutoffs.push(args.where.deletedAt.lt);
        return [];
      }),
    },
    group: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  } as unknown as PrismaService;
  const cfg = {
    get: (key: string) => (key === 'RECYCLE_BIN_RETENTION_DAYS' ? retention : undefined),
  } as unknown as ConfigService;
  const svc = new TrashPurgeService(
    prisma,
    cfg,
    {} as LeaderElectionService,
    {} as ItemsService,
  );
  return { svc, cutoffs };
}

describe('TrashPurgeService retention', () => {
  const day = 24 * 60 * 60 * 1000;

  it('keeps the 30-day default when Compose passes an empty value', async () => {
    const { svc, cutoffs } = service('');
    const before = Date.now();
    await svc.purgeExpired();
    expect(cutoffs).toHaveLength(1);
    const age = before - cutoffs[0]!.getTime();
    expect(Math.round(age / day)).toBe(30);
  });

  it('uses a set value', async () => {
    const { svc, cutoffs } = service('7');
    const before = Date.now();
    await svc.purgeExpired();
    expect(Math.round((before - cutoffs[0]!.getTime()) / day)).toBe(7);
  });
});
