// SPDX-License-Identifier: AGPL-3.0-or-later
import { AgoImportJobsService } from './jobs.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AgoImportService } from './import.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * #232 crash recovery for the AGO import runner. The runner is
 * fire-and-forget in the API process, so a replica dying mid-run leaves
 * a row stuck at status='running' with nothing to flip it. These tests
 * pin the reclaim contract: heartbeat-based detection, a status guard
 * on the terminal update, leader gating, and no-op when nothing is
 * stale. The heartbeat writes and timer wiring are exercised by the
 * live demo verification, not here.
 */
function build(opts?: { leader?: boolean }) {
  const findMany = jest.fn().mockResolvedValue([]);
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    agoImportJob: { findMany, updateMany },
  } as unknown as PrismaService;
  const importer = {} as unknown as AgoImportService;
  const shouldRun = jest.fn().mockReturnValue(opts?.leader ?? true);
  const leader = { shouldRun } as unknown as LeaderElectionService;
  const svc = new AgoImportJobsService(prisma, importer, leader);
  return { svc, findMany, updateMany, shouldRun };
}

describe('AgoImportJobsService.recoverStaleRunning', () => {
  it('fails stale running rows, guarded on status=running', async () => {
    const { svc, findMany, updateMany } = build();
    findMany.mockResolvedValue([{ id: 'dead-1' }, { id: 'dead-2' }]);
    updateMany.mockResolvedValue({ count: 2 });

    await svc.recoverStaleRunning(1);

    // Detection: only status='running' with a stale (or null) beat.
    const where = findMany.mock.calls[0]![0].where as {
      status: string;
      OR: Array<Record<string, unknown>>;
    };
    expect(where.status).toBe('running');
    expect(where.OR).toHaveLength(2);

    // Terminal update carries the status guard so a job that finished
    // between the select and the update is not clobbered.
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0] as {
      where: { id: { in: string[] }; status: string };
      data: { status: string; currentItem: null; errorMessage: string };
    };
    expect(arg.where.status).toBe('running');
    expect(arg.where.id.in).toEqual(['dead-1', 'dead-2']);
    expect(arg.data.status).toBe('failed');
    expect(arg.data.currentItem).toBeNull();
    expect(arg.data.errorMessage).toMatch(/start the import again/i);
  });

  it('is a no-op when nothing is stale', async () => {
    const { svc, findMany, updateMany } = build();
    findMany.mockResolvedValue([]);
    await svc.recoverStaleRunning(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('AgoImportJobsService reclaim leader gating', () => {
  it('skips the sweep entirely when this replica is not the leader', async () => {
    const { svc, findMany, shouldRun } = build({ leader: false });
    // reclaimSafely is the timer target; call it directly.
    await (svc as unknown as { reclaimSafely(): Promise<void> }).reclaimSafely();
    expect(shouldRun).toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('runs the sweep when this replica is the leader', async () => {
    const { svc, findMany } = build({ leader: true });
    await (svc as unknown as { reclaimSafely(): Promise<void> }).reclaimSafely();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
