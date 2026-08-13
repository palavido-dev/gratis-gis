// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotificationsWorker } from './notifications.worker.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmailTransport } from './email-transport.js';
import type { ConfigService } from '@nestjs/config';
import type { NotificationTemplateService } from './notification-template.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * #232 crash recovery for the notification queue. `processOne` claims a
 * row queued -> sending and only later writes a terminal state; a
 * process that dies in that window strands the row in `sending`, where
 * drainBatch (queued-only) never re-selects it and the admin retry
 * (failed-only) can't reach it. These tests pin the reclaim contract:
 * requeue while retryable, fail once the budget is spent, both guarded
 * on status='sending' and thresholded on sendingAt.
 */
function build() {
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    notification: { updateMany },
  } as unknown as PrismaService;
  const cfg = {
    get: (key: string) => {
      if (key === 'NOTIFICATIONS_MAX_ATTEMPTS') return '5';
      if (key === 'NOTIFICATIONS_ENABLED') return 'true';
      if (key === 'NOTIFICATIONS_BATCH_SIZE') return '25';
      return undefined;
    },
  } as unknown as ConfigService;
  const worker = new NotificationsWorker(
    prisma,
    {} as unknown as EmailTransport,
    cfg,
    {} as unknown as NotificationTemplateService,
    {} as unknown as LeaderElectionService,
  );
  const reclaim = () =>
    (worker as unknown as { reclaimStaleSending(): Promise<void> })
      .reclaimStaleSending();
  return { reclaim, updateMany };
}

describe('NotificationsWorker.reclaimStaleSending', () => {
  it('requeues retryable stranded rows and fails exhausted ones, both guarded', async () => {
    const { reclaim, updateMany } = build();
    await reclaim();

    expect(updateMany).toHaveBeenCalledTimes(2);
    const [requeue, fail] = updateMany.mock.calls.map((c) => c[0]) as Array<{
      where: {
        status: string;
        sendingAt: { lt: Date };
        attempts: { lt?: number; gte?: number };
      };
      data: { status: string; sendingAt: null; scheduledAt?: Date };
    }>;

    // Requeue branch: still-retryable rows go back to queued, now.
    expect(requeue.where.status).toBe('sending');
    expect(requeue.where.attempts.lt).toBe(5);
    expect(requeue.where.sendingAt.lt).toBeInstanceOf(Date);
    expect(requeue.data.status).toBe('queued');
    expect(requeue.data.sendingAt).toBeNull();
    expect(requeue.data.scheduledAt).toBeInstanceOf(Date);

    // Fail branch: budget already spent, so the row can never drain.
    expect(fail.where.status).toBe('sending');
    expect(fail.where.attempts.gte).toBe(5);
    expect(fail.data.status).toBe('failed');
    expect(fail.data.sendingAt).toBeNull();
  });

  it('thresholds on the same cutoff for both branches', async () => {
    const { reclaim, updateMany } = build();
    const before = Date.now();
    await reclaim();
    const after = Date.now();

    const cutoffs = updateMany.mock.calls.map(
      (c) => (c[0] as { where: { sendingAt: { lt: Date } } }).where.sendingAt.lt,
    );
    // Both branches share one cutoff ~15 minutes in the past.
    const fifteenMin = 15 * 60_000;
    for (const cutoff of cutoffs) {
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - fifteenMin - 50);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - fifteenMin + 50);
    }
  });
});
