// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImportJobsService } from './import-jobs.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Counter-honesty tests for the import_job failure paths.
 *
 * The invariant under test: a job whose COPY transaction rolled
 * back must never keep a nonzero insertedFeatures, because every
 * streamed row was erased by the rollback. The cancelled path
 * already enforced this (zeroInsertedForCancelled); these tests pin
 * the failure-path mirror (zeroInsertedForFailed) and the stale-
 * 'running' recovery sweep, which flips crashed jobs to failed.
 */
describe('ImportJobsService counter honesty', () => {
  function build() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      importJob: { updateMany, update, findMany },
    } as unknown as PrismaService;
    const svc = new ImportJobsService(prisma);
    return { svc, updateMany, update, findMany };
  }

  it('zeroInsertedForFailed zeroes the counter, guarded on failed status', async () => {
    const { svc, updateMany } = build();
    await svc.zeroInsertedForFailed('job-1');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'failed' },
      data: { insertedFeatures: 0 },
    });
  });

  it('zeroInsertedForCancelled zeroes the counter, guarded on cancelled status', async () => {
    const { svc, updateMany } = build();
    await svc.zeroInsertedForCancelled('job-2');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'job-2', status: 'cancelled' },
      data: { insertedFeatures: 0 },
    });
  });

  it('recoverStaleRunning zeroes insertedFeatures on the rows it fails', async () => {
    const { svc, updateMany, findMany } = build();
    findMany.mockResolvedValue([{ id: 'dead-1' }, { id: 'dead-2' }]);
    await svc.recoverStaleRunning(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ id: { in: ['dead-1', 'dead-2'] } });
    expect(arg.data.status).toBe('failed');
    // The crashed worker's transaction died with its connection,
    // so the recovered rows must not claim any inserted rows.
    expect(arg.data.insertedFeatures).toBe(0);
  });

  it('recoverStaleRunning is a no-op when nothing is stale', async () => {
    const { svc, updateMany, findMany } = build();
    findMany.mockResolvedValue([]);
    await svc.recoverStaleRunning(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('markFailed leaves insertedFeatures untouched (post-commit failures keep real rows)', async () => {
    const { svc, update } = build();
    await svc.markFailed('job-3', 'boom');
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    // markFailed itself must NOT zero the counter: the worker
    // decides based on whether the COPY transaction committed.
    // A failure after commit (source-stamp write, read-back)
    // leaves durable rows behind, and the counter must say so.
    expect('insertedFeatures' in arg.data).toBe(false);
    expect(arg.data.status).toBe('failed');
    expect(arg.data.errorMessage).toBe('boom');
  });
});
