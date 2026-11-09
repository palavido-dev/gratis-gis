// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import { NotificationsCron, notificationRetentionDays } from './notifications-cron.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { NotificationsService } from './notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('notification retention', () => {
  it('defaults to 180 days and never drops below the dedupe window', () => {
    expect(notificationRetentionDays(undefined, 7)).toBe(180);
    expect(notificationRetentionDays('30', 7)).toBe(30);
    expect(notificationRetentionDays('3', 7)).toBe(15);
    expect(notificationRetentionDays('junk', 30)).toBe(180);
    expect(notificationRetentionDays('10', 30)).toBe(61);
  });

  function cron(batches: number[], leader = true) {
    const sql: string[] = [];
    const executeRaw = jest.fn(async (strings: TemplateStringsArray) => {
      sql.push(strings.join('?'));
      return batches.shift() ?? 0;
    });
    const svc = new NotificationsCron(
      { $executeRaw: executeRaw } as unknown as PrismaService,
      {} as NotificationsService,
      { shouldRun: () => leader } as unknown as LeaderElectionService,
      { get: () => undefined } as unknown as ConfigService,
    );
    return { svc, sql, executeRaw };
  }

  it('deletes sent and failed rows in batches until a short batch', async () => {
    const { svc, sql, executeRaw } = cron([5000, 5000, 12]);
    expect(await svc.prune()).toBe(10_012);
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(sql[0]).toMatch(/status IN \('sent', 'failed'\)/);
  });

  it('does nothing on a follower', async () => {
    const { svc, executeRaw } = cron([5000], false);
    expect(await svc.prune()).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
