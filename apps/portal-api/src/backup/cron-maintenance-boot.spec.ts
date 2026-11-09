// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { CronJob } from 'cron';

import { HousekeepingCronService } from '../admin/housekeeping-cron.service.js';
import type { HousekeepingScheduleService } from '../admin/housekeeping-schedule.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { BackupCronService } from './backup-cron.service.js';
import type { BackupService } from './backup.service.js';

/**
 * A leader that boots while maintenance is on (a crash mid-restore
 * leaves the marker) must still register its schedules. Otherwise an
 * operator who clears the marker without a restart is left with no
 * scheduled backups or housekeeping at all. Each run is what waits
 * out maintenance.
 */

function leaderInMaintenance() {
  const leader = new LeaderElectionService();
  (leader as unknown as { isLeader: boolean }).isLeader = true;
  const state = { maintenance: true };
  leader.pauseWhile(() => state.maintenance);
  return { leader, state };
}

function scheduler() {
  const jobs = new Map<string, CronJob>();
  const reg = {
    addCronJob: jest.fn((name: string, job: CronJob) => jobs.set(name, job)),
    getCronJob: jest.fn((name: string) => {
      const j = jobs.get(name);
      if (!j) throw new Error('not registered');
      return j;
    }),
    deleteCronJob: jest.fn((name: string) => jobs.delete(name)),
  };
  return { reg, jobs };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('leader crons registered while maintenance is on', () => {
  const started: CronJob[] = [];
  afterEach(() => {
    for (const j of started.splice(0)) void j.stop();
  });

  it('backup cron registers at boot and runs once maintenance ends', async () => {
    const { leader, state } = leaderInMaintenance();
    const s = scheduler();
    const backup = {
      reclaimStaleRuns: jest.fn(async () => 0),
      getConfig: jest.fn(async () => ({
        scheduleMode: 'daily',
        effectiveCron: '0 2 * * *',
        scheduleSummary: 'daily',
      })),
      onConfigChange: jest.fn(),
      runBackup: jest.fn(async () => ({ id: 'r1', status: 'succeeded' })),
    };
    const svc = new BackupCronService(
      backup as unknown as BackupService,
      s.reg as unknown as SchedulerRegistry,
      leader,
    );
    await svc.onApplicationBootstrap();
    clearInterval((svc as unknown as { reclaimTimer: NodeJS.Timeout }).reclaimTimer);

    const job = s.jobs.get('backup-scheduled');
    expect(job).toBeDefined();
    started.push(job!);
    // Reclaim writes, so it waited out maintenance.
    expect(backup.reclaimStaleRuns).not.toHaveBeenCalled();

    await job!.fireOnTick();
    await flush();
    expect(backup.runBackup).not.toHaveBeenCalled();

    state.maintenance = false;
    await job!.fireOnTick();
    await flush();
    expect(backup.runBackup).toHaveBeenCalledWith('scheduled', null);
  });

  it('housekeeping cron registers at boot and runs once maintenance ends', async () => {
    const { leader, state } = leaderInMaintenance();
    const s = scheduler();
    const schedule = {
      getConfig: jest.fn(async () => ({
        scheduleMode: 'daily',
        effectiveCron: '0 3 * * *',
        scheduleSummary: 'daily',
        autoTrashEnabled: true,
        autoDisableEnabled: false,
        recomputeExtentsEnabled: false,
      })),
      onConfigChange: jest.fn(),
      runOnce: jest.fn(async () => ({
        id: 'h1',
        status: 'succeeded',
        itemsTrashed: 0,
        usersDisabled: 0,
      })),
    };
    const svc = new HousekeepingCronService(
      schedule as unknown as HousekeepingScheduleService,
      s.reg as unknown as SchedulerRegistry,
      leader,
    );
    await svc.onApplicationBootstrap();
    const job = [...s.jobs.values()][0];
    expect(job).toBeDefined();
    started.push(job!);

    await job!.fireOnTick();
    await flush();
    expect(schedule.runOnce).not.toHaveBeenCalled();

    state.maintenance = false;
    await job!.fireOnTick();
    await flush();
    expect(schedule.runOnce).toHaveBeenCalledTimes(1);
  });

  it('a follower still registers nothing', async () => {
    const leader = new LeaderElectionService();
    const s = scheduler();
    const schedule = {
      getConfig: jest.fn(),
      onConfigChange: jest.fn(),
    };
    const svc = new HousekeepingCronService(
      schedule as unknown as HousekeepingScheduleService,
      s.reg as unknown as SchedulerRegistry,
      leader,
    );
    await svc.onApplicationBootstrap();
    expect(s.reg.addCronJob).not.toHaveBeenCalled();
  });
});
