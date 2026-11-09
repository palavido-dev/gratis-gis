// SPDX-License-Identifier: AGPL-3.0-or-later
import { HousekeepingCronService } from '../admin/housekeeping-cron.service.js';
import type { HousekeepingScheduleService } from '../admin/housekeeping-schedule.service.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import { BackupCronService } from './backup-cron.service.js';
import type { BackupService } from './backup.service.js';

/**
 * Schedules used to register only on the replica that led at boot,
 * and a config save ran its listener only on the replica that served
 * it. After a lone restart of the leader, or a save that landed on the
 * follower, the wrong schedule (or none) ran.
 */

function registry() {
  const jobs = new Map<string, { cronTime: { source: string } ; stop(): void }>();
  return {
    jobs,
    addCronJob: jest.fn((name: string, job: never) => {
      jobs.set(name, job);
    }),
    getCronJob: jest.fn((name: string) => {
      const job = jobs.get(name);
      if (!job) throw new Error('no job');
      return job;
    }),
    deleteCronJob: jest.fn((name: string) => jobs.delete(name)),
  };
}

const cronOf = (job: unknown) =>
  String((job as { cronTime: { source: string } }).cronTime.source);

describe('backup schedule registers on every replica (API-OPS-06)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(leader: { lead: boolean }) {
    let cfg = {
      scheduleMode: 'daily',
      effectiveCron: '0 2 * * *',
      scheduleSummary: 'daily',
    };
    const backup = {
      getConfig: jest.fn(async () => cfg),
      onConfigChange: jest.fn(),
      reclaimStaleRuns: jest.fn(async () => 0),
      runBackup: jest.fn(async () => ({ id: 'r', status: 'succeeded' })),
    };
    const reg = registry();
    const svc = new BackupCronService(
      backup as unknown as BackupService,
      reg as never,
      { shouldRun: () => leader.lead } as unknown as LeaderElectionService,
    );
    const setCfg = (next: Partial<typeof cfg>) => {
      cfg = { ...cfg, ...next };
    };
    return { svc, backup, reg, setCfg };
  }

  it('a replica that boots as follower still registers, and fires once it leads', async () => {
    const leader = { lead: false };
    const t = setup(leader);
    await t.svc.onApplicationBootstrap();
    expect(t.reg.jobs.has('backup-scheduled')).toBe(true);

    const run = () =>
      (t.svc as unknown as { runSafely(): Promise<void> }).runSafely();
    await run();
    expect(t.backup.runBackup).not.toHaveBeenCalled();
    leader.lead = true;
    await run();
    expect(t.backup.runBackup).toHaveBeenCalledTimes(1);
    t.svc.onModuleDestroy();
  });

  it('a schedule saved on the other replica takes effect on the next poll', async () => {
    const t = setup({ lead: true });
    await t.svc.onApplicationBootstrap();
    expect(cronOf(t.reg.jobs.get('backup-scheduled'))).toBe('0 2 * * *');
    expect(t.reg.addCronJob).toHaveBeenCalledTimes(1);

    // Unchanged config: the poll does not re-register.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.reg.addCronJob).toHaveBeenCalledTimes(1);

    t.setCfg({ effectiveCron: '30 3 * * *' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(cronOf(t.reg.jobs.get('backup-scheduled'))).toBe('30 3 * * *');

    t.setCfg({ scheduleMode: 'off', effectiveCron: null as never });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.reg.jobs.has('backup-scheduled')).toBe(false);
    t.svc.onModuleDestroy();
  });
});

describe('housekeeping schedule registers on every replica (API-OPS-06)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('registers on a follower, gates each run, and follows remote saves', async () => {
    const leader = { lead: false };
    let cfg = {
      scheduleMode: 'daily',
      effectiveCron: '0 3 * * *',
      scheduleSummary: 'daily',
      autoTrashEnabled: true,
      autoDisableEnabled: false,
      recomputeExtentsEnabled: false,
    };
    const schedule = {
      getConfig: jest.fn(async () => cfg),
      onConfigChange: jest.fn(),
      runOnce: jest.fn(async () => ({
        id: 'h',
        status: 'succeeded',
        itemsTrashed: 0,
        usersDisabled: 0,
      })),
    };
    const reg = registry();
    const svc = new HousekeepingCronService(
      schedule as unknown as HousekeepingScheduleService,
      reg as never,
      { shouldRun: () => leader.lead } as unknown as LeaderElectionService,
    );
    await svc.onApplicationBootstrap();
    expect(reg.jobs.has('housekeeping-scheduled')).toBe(true);

    const run = () =>
      (svc as unknown as { runSafely(): Promise<void> }).runSafely();
    await run();
    expect(schedule.runOnce).not.toHaveBeenCalled();
    leader.lead = true;
    await run();
    expect(schedule.runOnce).toHaveBeenCalledTimes(1);

    cfg = { ...cfg, autoTrashEnabled: false };
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reg.jobs.has('housekeeping-scheduled')).toBe(false);
    svc.onModuleDestroy();
  });
});
