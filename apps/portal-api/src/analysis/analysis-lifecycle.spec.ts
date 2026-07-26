// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AnalysisService } from './analysis.service.js';
import { AnalysisBridgeWorker } from './analysis-bridge.worker.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { ConfigService } from '@nestjs/config';
import type { StorageService } from '../storage/storage.service.js';
import type { IngestStagingService } from '../ingest/ingest-staging.service.js';
import type { ImportJobsService } from '../import-jobs/import-jobs.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Lifecycle hardening (cancel + reclaim). The queue mechanics
 * themselves live in SQL and the python worker; what is testable
 * here with stubs is the API's side of the contract: who may
 * cancel, which state flips happen for queued vs running rows,
 * that the pre-created target item gets its failed-husk stamp on
 * the paths where no worker is alive to write it, and that the
 * reclaim sweep issues the right terminal states and messages.
 */

interface JobRow {
  id: string;
  orgId: string;
  userId: string;
  kind: string;
  state: string;
  targetItemId: string | null;
  sourceItemId: string;
  finishedAt: Date | null;
}

interface World {
  job: JobRow | null;
  updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  executeRawCalls: Array<{ strings: readonly string[]; values: unknown[] }>;
}

function makePrisma(world: World): PrismaService {
  return {
    analysisJob: {
      findUnique: jest.fn(async () => world.job),
      updateMany: jest.fn(
        async (args: { where: { state?: string }; data: Record<string, unknown> }) => {
          world.updateManyCalls.push(
            args as { where: Record<string, unknown>; data: Record<string, unknown> },
          );
          if (world.job && args.where.state === world.job.state) {
            Object.assign(world.job, args.data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    $executeRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      world.executeRawCalls.push({ strings, values });
      return 1;
    }),
  } as unknown as PrismaService;
}

function makeService(world: World): AnalysisService {
  // cancelJob touches neither ItemsService nor ConfigService (on
  // purpose: cancel must work with the analysis tier disabled).
  return new AnalysisService(
    makePrisma(world),
    {} as ItemsService,
    {} as ConfigService,
  );
}

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgRole: 'contributor',
    ...overrides,
  } as AuthUser;
}

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    orgId: 'org-1',
    userId: 'user-1',
    kind: 'hillshade',
    state: 'queued',
    targetItemId: 'target-1',
    sourceItemId: 'source-1',
    finishedAt: null,
    ...overrides,
  };
}

function freshWorld(overrides: Partial<World> = {}): World {
  return {
    job: jobRow(),
    updateManyCalls: [],
    executeRawCalls: [],
    ...overrides,
  };
}

describe('AnalysisService.cancelJob', () => {
  it('queued job flips to cancelled immediately and stamps the husk item', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    const out = (await svc.cancelJob(user(), 'job-1')) as JobRow;

    expect(out.state).toBe('cancelled');
    expect(world.updateManyCalls[0]?.where).toMatchObject({ state: 'queued' });
    expect(world.updateManyCalls[0]?.data).toMatchObject({ state: 'cancelled' });
    // Husk stamp: one jsonb merge onto the pre-created target item.
    expect(world.executeRawCalls).toHaveLength(1);
    const patch = JSON.parse(world.executeRawCalls[0]!.values[0] as string) as {
      processingState: string;
      processingError: string;
    };
    expect(patch.processingState).toBe('failed');
    expect(patch.processingError).toContain('cancelled');
    expect(world.executeRawCalls[0]!.values[1]).toBe('target-1');
  });

  it('running job flips to cancel_requested and leaves the item to the worker', async () => {
    const world = freshWorld({ job: jobRow({ state: 'running' }) });
    const svc = makeService(world);
    const out = (await svc.cancelJob(user(), 'job-1')) as JobRow;

    expect(out.state).toBe('cancel_requested');
    // First attempt targets queued (misses), second targets running.
    expect(world.updateManyCalls).toHaveLength(2);
    expect(world.updateManyCalls[1]?.where).toMatchObject({ state: 'running' });
    expect(world.updateManyCalls[1]?.data).toEqual({ state: 'cancel_requested' });
    // The worker owns the mid-run husk stamp; nothing here.
    expect(world.executeRawCalls).toHaveLength(0);
  });

  it('terminal job is a no-op (idempotent cancel)', async () => {
    const world = freshWorld({ job: jobRow({ state: 'done' }) });
    const svc = makeService(world);
    const out = (await svc.cancelJob(user(), 'job-1')) as JobRow;

    expect(out.state).toBe('done');
    expect(world.executeRawCalls).toHaveLength(0);
  });

  it('refuses a caller who is neither creator nor org admin', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    await expect(
      svc.cancelJob(user({ id: 'someone-else', orgRole: 'contributor' }), 'job-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(world.updateManyCalls).toHaveLength(0);
  });

  it('lets an org admin cancel another user\'s job', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    const out = (await svc.cancelJob(
      user({ id: 'admin-user', orgRole: 'admin' }),
      'job-1',
    )) as JobRow;
    expect(out.state).toBe('cancelled');
  });

  it('refuses cross-org access and unknown jobs', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    await expect(
      svc.cancelJob(user({ orgId: 'other-org' }), 'job-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const empty = freshWorld({ job: null });
    const svc2 = makeService(empty);
    await expect(svc2.cancelJob(user(), 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

interface ReclaimedRow {
  id: string;
  kind: string;
  state: string;
  target_item_id: string | null;
  source_item_id: string;
}

function makeBridge(rows: ReclaimedRow[], world: World): AnalysisBridgeWorker {
  const prisma = {
    $queryRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      world.executeRawCalls.push({ strings, values });
      return rows;
    }),
    $executeRaw: jest.fn(async (strings: readonly string[], ...values: unknown[]) => {
      world.executeRawCalls.push({ strings, values });
      return 1;
    }),
  } as unknown as PrismaService;
  return new AnalysisBridgeWorker(
    prisma,
    {} as StorageService,
    {} as IngestStagingService,
    {} as ImportJobsService,
  );
}

describe('AnalysisBridgeWorker.reclaimStaleJobs', () => {
  it('sweeps stale rows to terminal states and stamps items that need it', async () => {
    const world = freshWorld();
    const bridge = makeBridge(
      [
        {
          id: 'a',
          kind: 'hillshade',
          state: 'failed',
          target_item_id: 't-hs',
          source_item_id: 's-hs',
        },
        {
          id: 'b',
          kind: 'copc-build',
          state: 'failed',
          target_item_id: null,
          source_item_id: 's-pc',
        },
        {
          id: 'c',
          kind: 'contours',
          state: 'failed',
          target_item_id: 't-dl',
          source_item_id: 's-dl',
        },
        {
          id: 'd',
          kind: 'viewshed',
          state: 'cancelled',
          target_item_id: 't-vs',
          source_item_id: 's-vs',
        },
      ],
      world,
    );
    await bridge.reclaimStaleJobs();

    // Call 0 is the sweep UPDATE itself; it must carry the exact
    // job error and the stale-heartbeat predicate.
    const sweepSql = world.executeRawCalls[0]!.strings.join('?');
    expect(sweepSql).toContain("'worker stopped responding'");
    expect(sweepSql).toContain("state IN ('running', 'cancel_requested')");
    expect(sweepSql).toContain('COALESCE(heartbeat_at, started_at, created_at)');

    // Stamps: hillshade target, copc-build (falls back to the source
    // item, which IS the point cloud being merged), viewshed target.
    // contours is bridge-settled and gets no processingState stamp.
    const stamps = world.executeRawCalls.slice(1);
    expect(stamps).toHaveLength(3);
    const stampedItems = stamps.map((c) => c.values[1]);
    expect(stampedItems).toEqual(['t-hs', 's-pc', 't-vs']);
    const messages = stamps.map(
      (c) =>
        (JSON.parse(c.values[0] as string) as { processingError: string })
          .processingError,
    );
    expect(messages[0]).toContain('stopped responding');
    expect(messages[1]).toContain('merge');
    // The cancel_requested row was the user's own stop, so its item
    // note says cancelled, not crashed.
    expect(messages[2]).toContain('cancelled');
  });

  it('throttles: a second sweep within the minute issues no query', async () => {
    const world = freshWorld();
    const bridge = makeBridge([], world);
    await bridge.reclaimStaleJobs();
    const callsAfterFirst = world.executeRawCalls.length;
    await bridge.reclaimStaleJobs();
    expect(world.executeRawCalls.length).toBe(callsAfterFirst);
  });
});
