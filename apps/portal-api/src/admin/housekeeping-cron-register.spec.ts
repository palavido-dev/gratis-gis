// SPDX-License-Identifier: AGPL-3.0-or-later
import { HousekeepingCronService } from './housekeeping-cron.service.js';

/**
 * The settings page counts field-queue auto-prune as an action and
 * shows a schedule for it. The cron service must register a job for
 * it too, or nothing ever runs.
 */
describe('HousekeepingCronService registration', () => {
  it('registers a job when field-queue auto-prune is the only action', () => {
    const jobs: Array<{ stop: () => void }> = [];
    const scheduler = {
      addCronJob: jest.fn((_name: string, job: { stop: () => void }) => jobs.push(job)),
      getCronJob: jest.fn(() => {
        throw new Error('no job');
      }),
      deleteCronJob: jest.fn(),
    };
    const svc = new HousekeepingCronService({} as never, scheduler as never, {} as never);
    (svc as unknown as { apply: (c: unknown) => void }).apply({
      scheduleMode: 'daily',
      effectiveCron: '0 3 * * *',
      scheduleSummary: 'Daily at 03:00',
      autoTrashEnabled: false,
      autoDisableEnabled: false,
      recomputeExtentsEnabled: false,
      fieldQueueAutoPruneEnabled: true,
    });
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
    for (const j of jobs) j.stop();
  });

  it('registers a job with every toggle off, for the passes that always run', () => {
    const jobs: Array<{ stop: () => void }> = [];
    const scheduler = {
      addCronJob: jest.fn((_name: string, job: { stop: () => void }) => jobs.push(job)),
      getCronJob: jest.fn(() => {
        throw new Error('no job');
      }),
      deleteCronJob: jest.fn(),
    };
    const svc = new HousekeepingCronService({} as never, scheduler as never, {} as never);
    (svc as unknown as { apply: (c: unknown) => void }).apply({
      scheduleMode: 'daily',
      effectiveCron: '0 3 * * *',
      autoTrashEnabled: false,
      autoDisableEnabled: false,
      recomputeExtentsEnabled: false,
      fieldQueueAutoPruneEnabled: false,
    });
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
    for (const j of jobs) j.stop();
  });
});

describe('HousekeepingCronService interrupted-run sweep (03-12)', () => {
  function build(leader: boolean) {
    const failInterruptedRuns = jest.fn(async () => 1);
    let isLeader = leader;
    const svc = new HousekeepingCronService(
      { failInterruptedRuns } as never,
      {} as never,
      { shouldRun: () => isLeader } as never,
    );
    return { svc, failInterruptedRuns, setLeader: (v: boolean) => (isLeader = v) };
  }

  it('fails left-over running rows once, on the leader', async () => {
    const t = build(true);
    await t.svc.sweepInterruptedRuns();
    await t.svc.sweepInterruptedRuns();
    expect(t.failInterruptedRuns).toHaveBeenCalledTimes(1);
  });

  it('waits for leadership, then sweeps', async () => {
    const t = build(false);
    await t.svc.sweepInterruptedRuns();
    expect(t.failInterruptedRuns).not.toHaveBeenCalled();
    t.setLeader(true);
    await t.svc.sweepInterruptedRuns();
    expect(t.failInterruptedRuns).toHaveBeenCalledTimes(1);
  });

  it('does not sweep when leadership arrives long after boot', async () => {
    const t = build(false);
    (t.svc as unknown as { bootedAt: number }).bootedAt = Date.now() - 60 * 60_000;
    t.setLeader(true);
    await t.svc.sweepInterruptedRuns();
    expect(t.failInterruptedRuns).not.toHaveBeenCalled();
  });
});
