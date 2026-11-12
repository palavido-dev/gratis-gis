// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmailTransport } from './email-transport.js';
import type { NotificationTemplateService } from './notification-template.service.js';
import { NotificationsWorker } from './notifications.worker.js';

/**
 * Queued notifications used to wait forever while SMTP was off, then
 * all go out when it came back (16-6). Rows that have waited past
 * NOTIFICATIONS_MAX_QUEUED_HOURS are now failed instead, and this runs
 * even while the transport is unavailable.
 */
function build(maxHours?: string) {
  const updateMany = jest.fn().mockResolvedValue({ count: 3 });
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { notification: { updateMany, findMany } } as unknown as PrismaService;
  const cfg = {
    get: (key: string) => {
      if (key === 'NOTIFICATIONS_ENABLED') return 'true';
      if (key === 'NOTIFICATIONS_MAX_QUEUED_HOURS') return maxHours;
      return undefined;
    },
  } as unknown as ConfigService;
  const isAvailable = jest.fn().mockResolvedValue(false);
  const worker = new NotificationsWorker(
    prisma,
    { isAvailable } as unknown as EmailTransport,
    cfg,
    {} as NotificationTemplateService,
    { shouldRun: () => true } as unknown as LeaderElectionService,
  );
  return { worker, updateMany, findMany };
}

describe('NotificationsWorker.expireStaleQueued', () => {
  it('fails queued rows due more than the max age ago', async () => {
    const { worker, updateMany } = build('2');
    const before = Date.now();
    expect(await worker.expireStaleQueued()).toBe(3);
    const call = updateMany.mock.calls[0]![0] as {
      where: { status: string; scheduledAt: { lt: Date } };
      data: { status: string; lastError: string };
    };
    expect(call.where.status).toBe('queued');
    const age = before - call.where.scheduledAt.lt.getTime();
    expect(age).toBeGreaterThanOrEqual(2 * 3_600_000 - 1_000);
    expect(age).toBeLessThanOrEqual(2 * 3_600_000 + 1_000);
    expect(call.data.status).toBe('failed');
    expect(call.data.lastError).toMatch(/2 hours/);
  });

  it('runs on each tick even when SMTP is unavailable, and sends nothing', async () => {
    const { worker, updateMany, findMany } = build();
    await worker.tick();
    const expired = updateMany.mock.calls.find(
      ([a]) => (a as { where: { status: string } }).where.status === 'queued',
    );
    expect(expired).toBeDefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});
