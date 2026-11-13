// SPDX-License-Identifier: AGPL-3.0-or-later
import { AgoImportJobsService } from './jobs.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ImportStoppedError, type AgoImportService } from './import.js';
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
    const runningCalls = updateMany.mock.calls.filter(
      (c) => (c[0] as { where: { status: string } }).where.status === 'running',
    );
    expect(runningCalls).toHaveLength(1);
    const arg = runningCalls[0]![0] as {
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
    const runningCalls = updateMany.mock.calls.filter(
      (c) => (c[0] as { where: { status: string } }).where.status === 'running',
    );
    expect(runningCalls).toHaveLength(0);
  });

  it('fails a job still queued past the window: no runner will ever pick it up', async () => {
    const { svc, updateMany } = build();
    await svc.recoverStaleRunning(1);
    const queued = updateMany.mock.calls.find(
      (c) => (c[0] as { where: { status: string } }).where.status === 'queued',
    );
    expect(queued).toBeDefined();
    const arg = queued![0] as { where: { createdAt: { lt: Date } }; data: { status: string } };
    expect(arg.where.createdAt.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('failed');
  });
});

describe('AgoImportJobsService runner', () => {
  const report = {
    items: [{ willImport: true }, { willImport: true }, { willImport: false }],
  } as unknown as import('./dry-run.js').DryRunReport;

  function runner(run: (args: { onProgress?: (s: unknown) => Promise<void> }) => Promise<unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    let status = 'queued';
    const prisma = {
      agoImportJob: {
        findUnique: jest.fn(async () => ({ id: 'j1', status })),
        update: jest.fn(async (a: { data: Record<string, unknown> }) => {
          updates.push(a.data);
          if (typeof a.data.status === 'string') status = a.data.status;
          return {};
        }),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaService;
    const importer = { run: jest.fn(run) } as unknown as AgoImportService;
    const svc = new AgoImportJobsService(prisma, importer, {
      shouldRun: () => true,
    } as unknown as LeaderElectionService);
    const go = () =>
      (svc as unknown as { runJob(id: string, input: unknown): Promise<void> }).runJob('j1', {
        user: {},
        portalUrl: 'p',
        token: 't',
        report,
      });
    return { go, updates, setStatus: (s: string) => (status = s) };
  }

  it('counts done as the importable rows, not every row of the report', async () => {
    const t = runner(async () => ({ total: 3, created: 2, failed: 0, skipped: 1 }));
    await t.go();
    expect(t.updates.at(-1)).toMatchObject({ status: 'succeeded', done: 2 });
  });

  it('stores the partial report when the job is cancelled', async () => {
    const partial = { total: 3, created: 1, results: [] };
    const t = runner(async (args) => {
      t.setStatus('cancelled');
      try {
        await args.onProgress?.({ done: 1, currentItem: '' });
      } catch (e) {
        throw new ImportStoppedError(e, partial as never);
      }
      return partial;
    });
    await t.go();
    expect(t.updates.at(-1)).toMatchObject({ report: partial });
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

describe('AgoImportJobsService concurrency (11-5)', () => {
  it('runs at most two imports at once and starts the next as one ends', async () => {
    const statuses = new Map<string, string>();
    let nextId = 0;
    const prisma = {
      agoImportJob: {
        create: jest.fn(async () => {
          const id = `j${++nextId}`;
          statuses.set(id, 'queued');
          return { id };
        }),
        findUnique: jest.fn(async (a: { where: { id: string } }) => ({
          id: a.where.id,
          status: statuses.get(a.where.id),
        })),
        update: jest.fn(
          async (a: { where: { id: string }; data: { status?: string } }) => {
            if (a.data.status) statuses.set(a.where.id, a.data.status);
            return {};
          },
        ),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaService;
    const finish: Array<() => void> = [];
    const run = jest.fn(
      () =>
        new Promise((resolve) => {
          finish.push(() => resolve({ total: 0, created: 0, failed: 0, skipped: 0 }));
        }),
    );
    const svc = new AgoImportJobsService(
      prisma,
      { run } as unknown as AgoImportService,
      { shouldRun: () => true } as unknown as LeaderElectionService,
    );
    const input = {
      user: { id: 'u', orgId: 'o' },
      portalUrl: 'p',
      token: 't',
      report: { items: [] },
    } as never;
    await svc.start(input);
    await svc.start(input);
    await svc.start(input);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(statuses.get('j3')).toBe('queued');
    finish[0]!();
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
    finish[1]!();
    finish[2]!();
    await settle();
    expect([...statuses.values()]).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });
});
