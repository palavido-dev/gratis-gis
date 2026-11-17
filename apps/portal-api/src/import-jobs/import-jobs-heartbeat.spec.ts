// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ImportJob } from '@prisma/client';

import {
  IMPORT_HEARTBEAT_EVERY_MS,
  IMPORT_STALE_AFTER_MS,
  IMPORT_WORKER_STOPPED_MESSAGE,
  ImportJobsService,
} from './import-jobs.service.js';
import { ImportJobsWorker } from './import-jobs.worker.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * #573: a worker killed mid-import left its job showing "running" at
 * the last batch count for 5 minutes. The worker now beats on a timer
 * while a job runs, so the sweep can fail a dead job after 2 minutes
 * without catching a slow one.
 */
describe('import job heartbeat', () => {
  function buildService() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      importJob: { updateMany, findMany },
    } as unknown as PrismaService;
    return { svc: new ImportJobsService(prisma), updateMany, findMany };
  }

  it('beats several times inside the stale window', () => {
    expect(IMPORT_STALE_AFTER_MS / IMPORT_HEARTBEAT_EVERY_MS).toBeGreaterThanOrEqual(4);
  });

  it('touchHeartbeat only touches a running job', async () => {
    const { svc, updateMany } = buildService();
    await svc.touchHeartbeat('job-1');
    const arg = updateMany.mock.calls[0]![0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: 'job-1', status: 'running' });
    expect(Object.keys(arg.data)).toEqual(['lastHeartbeatAt']);
  });

  it('the sweep uses the 2 minute threshold and the memory message', async () => {
    const { svc, updateMany, findMany } = buildService();
    findMany.mockResolvedValue([{ id: 'dead' }]);
    const before = Date.now();
    await svc.recoverStaleRunning();
    const where = findMany.mock.calls[0]![0].where as {
      OR: Array<{ lastHeartbeatAt?: { lt: Date } }>;
    };
    const cutoff = where.OR[0]!.lastHeartbeatAt!.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(IMPORT_STALE_AFTER_MS - 1_000);
    expect(before - cutoff).toBeLessThanOrEqual(IMPORT_STALE_AFTER_MS + 1_000);
    const data = (updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.errorMessage).toBe(IMPORT_WORKER_STOPPED_MESSAGE);
    expect(IMPORT_WORKER_STOPPED_MESSAGE).toMatch(/memory/);
  });

  describe('ImportJobsWorker.runJobWithHeartbeat', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function buildWorker(run: () => Promise<void>) {
      const touchHeartbeat = jest.fn().mockResolvedValue(undefined);
      const jobs = { touchHeartbeat } as unknown as ImportJobsService;
      const worker = new ImportJobsWorker(
        jobs,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      jest.spyOn(worker, 'runJob').mockImplementation(run);
      return { worker, touchHeartbeat };
    }

    const job = { id: 'job-9' } as ImportJob;

    it('beats while the job runs and stops when it ends', async () => {
      let finish!: () => void;
      const { worker, touchHeartbeat } = buildWorker(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const done = worker.runJobWithHeartbeat(job);
      jest.advanceTimersByTime(IMPORT_HEARTBEAT_EVERY_MS * 3);
      expect(touchHeartbeat).toHaveBeenCalledTimes(3);
      expect(touchHeartbeat).toHaveBeenCalledWith('job-9');
      finish();
      await done;
      jest.advanceTimersByTime(IMPORT_HEARTBEAT_EVERY_MS * 3);
      expect(touchHeartbeat).toHaveBeenCalledTimes(3);
    });

    it('stops beating when the job throws', async () => {
      const { worker, touchHeartbeat } = buildWorker(() =>
        Promise.reject(new Error('boom')),
      );
      await expect(worker.runJobWithHeartbeat(job)).rejects.toThrow('boom');
      jest.advanceTimersByTime(IMPORT_HEARTBEAT_EVERY_MS * 3);
      expect(touchHeartbeat).not.toHaveBeenCalled();
    });

    it('a failed beat does not fail the job', async () => {
      let finish!: () => void;
      const { worker, touchHeartbeat } = buildWorker(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      touchHeartbeat.mockRejectedValue(new Error('db down'));
      const done = worker.runJobWithHeartbeat(job);
      jest.advanceTimersByTime(IMPORT_HEARTBEAT_EVERY_MS);
      await Promise.resolve();
      finish();
      await expect(done).resolves.toBeUndefined();
    });
  });
});
