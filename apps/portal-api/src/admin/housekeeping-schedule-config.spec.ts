// SPDX-License-Identifier: AGPL-3.0-or-later
import { HousekeepingScheduleService } from './housekeeping-schedule.service.js';

/**
 * A schedule with every toggle off still runs the passes that have no
 * toggle (end-date account disable, Keycloak user sync), so it must
 * produce a cron expression (03-7). And a run left 'running' by a dead
 * process is failed at start (03-12).
 */
function build(row: Record<string, unknown> | null) {
  const updateMany = jest.fn(async () => ({ count: 2 }));
  const prisma = {
    housekeepingConfig: { findFirst: jest.fn(async () => row) },
    housekeepingRun: { updateMany },
  };
  const svc = new HousekeepingScheduleService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, updateMany };
}

const base = {
  autoTrashEnabled: false,
  autoTrashDays: null,
  autoDisableEnabled: false,
  autoDisableDays: null,
  recomputeExtentsEnabled: false,
  fieldQueueStaleDays: null,
  fieldQueueAutoPruneEnabled: false,
  fieldQueueAutoPruneGraceDays: null,
  scheduleHour: 3,
  scheduleMinute: 0,
  scheduleDayOfWeek: null,
};

describe('housekeeping schedule config', () => {
  it('gives a cron for a daily schedule with every toggle off', async () => {
    const { svc } = build({ ...base, scheduleMode: 'daily' });
    const cfg = await svc.getConfig();
    expect(cfg.effectiveCron).toBe('0 3 * * *');
    expect(cfg.scheduleSummary).toBe(
      'Daily at 03:00 (account end dates and user sync only)',
    );
  });

  it('gives no cron when the schedule is off', async () => {
    const { svc } = build({ ...base, scheduleMode: 'off', autoTrashEnabled: true });
    const cfg = await svc.getConfig();
    expect(cfg.effectiveCron).toBeNull();
    expect(cfg.scheduleSummary).toBe('Off');
  });

  it('fails runs left running', async () => {
    const { svc, updateMany } = build(null);
    expect(await svc.failInterruptedRuns()).toBe(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'running' },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
