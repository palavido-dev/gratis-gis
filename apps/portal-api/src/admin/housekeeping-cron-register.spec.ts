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
});
