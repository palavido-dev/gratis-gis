// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageLedgerService } from './storage-ledger.service.js';
import {
  embedItemOf,
  FIRST_FILL_CURSOR_SETTING,
  FIRST_FILL_RETRY_MAX_MS,
  FIRST_FILL_RETRY_MS,
  StorageUsageReconcileService,
  type ReconcileSummary,
} from './storage-usage-reconcile.service.js';
import type { StorageService } from './storage.service.js';

function summary(): ReconcileSummary {
  return {
    startedAt: '',
    finishedAt: '',
    dryRun: false,
    objectsSeen: 3,
    bytesSeen: 30,
    recorded: 2,
    resized: 0,
    markedDeleted: 0,
    unattributed: 1,
    unattributedSample: [],
    orgs: [],
    resumeAfter: null,
  };
}

function build(opts: {
  filled: boolean;
  leader?: boolean | null;
  fail?: boolean;
  cursor?: string;
}) {
  const ledger = {
    ledgerFilled: jest.fn(async () => opts.filled),
  } as unknown as StorageLedgerService;
  const leader =
    opts.leader === null || opts.leader === undefined
      ? undefined
      : ({ shouldRun: () => opts.leader } as unknown as LeaderElectionService);
  const settings = {
    findUnique: jest.fn(async () =>
      opts.cursor ? { key: FIRST_FILL_CURSOR_SETTING, value: { after: opts.cursor } } : null,
    ),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };
  const svc = new StorageUsageReconcileService(
    { systemSetting: settings } as unknown as PrismaService,
    {} as StorageService,
    ledger,
    leader,
  );
  const reconcile = jest.spyOn(svc, 'reconcile').mockImplementation(async () => {
    if (opts.fail) throw new Error('store down');
    return summary();
  });
  return { svc, reconcile, settings };
}

describe('first fill of the storage usage ledger', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing once the durable marker says filled', async () => {
    const { svc, reconcile } = build({ filled: true, leader: true });
    await expect(svc.ensureFirstFill()).resolves.toBe('filled');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('runs a full real reconcile on the leader and logs the start and the end', async () => {
    const { svc, reconcile } = build({ filled: false, leader: true });
    await expect(svc.ensureFirstFill()).resolves.toBe('ran');
    expect(reconcile).toHaveBeenCalledWith({
      dryRun: false,
      progress: true,
      saveCursor: FIRST_FILL_CURSOR_SETTING,
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Running the first fill now'))).toBe(
      true,
    );
    expect(log.mock.calls.some((c) => String(c[0]).includes('first fill finished'))).toBe(true);
  });

  it('leaves it to the leader', async () => {
    const { svc, reconcile } = build({ filled: false, leader: false });
    await expect(svc.ensureFirstFill()).resolves.toBe('skipped');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('logs a failure and leaves the retry to the next tick', async () => {
    const { svc } = build({ filled: false, leader: true, fail: true });
    await expect(svc.ensureFirstFill()).resolves.toBe('failed');
    expect(error.mock.calls.some((c) => String(c[0]).includes('retried'))).toBe(true);
  });

  it('resumes after the saved key and forgets it once finished', async () => {
    const { svc, reconcile, settings } = build({
      filled: false,
      leader: true,
      cursor: 'item-file/x',
    });
    await expect(svc.ensureFirstFill()).resolves.toBe('ran');
    expect(reconcile).toHaveBeenCalledWith({
      dryRun: false,
      progress: true,
      saveCursor: FIRST_FILL_CURSOR_SETTING,
      startAfter: 'item-file/x',
    });
    expect(settings.deleteMany).toHaveBeenCalledWith({
      where: { key: FIRST_FILL_CURSOR_SETTING },
    });
  });

  it('waits longer after each failure, doubling up to six hours', async () => {
    const { svc, reconcile } = build({ filled: false, leader: true, fail: true });
    let now = 1_000_000;
    let wait = FIRST_FILL_RETRY_MS;
    const waits: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      await expect(svc.ensureFirstFill(now)).resolves.toBe('failed');
      // Not before the wait is over.
      await expect(svc.ensureFirstFill(now + wait - 1)).resolves.toBe('skipped');
      waits.push(wait);
      now += wait;
      wait = Math.min(wait * 2, FIRST_FILL_RETRY_MAX_MS);
    }
    expect(waits.slice(0, 3)).toEqual([
      FIRST_FILL_RETRY_MS,
      2 * FIRST_FILL_RETRY_MS,
      4 * FIRST_FILL_RETRY_MS,
    ]);
    expect(waits[waits.length - 1]).toBe(FIRST_FILL_RETRY_MAX_MS);
    expect(reconcile).toHaveBeenCalledTimes(9);
  });

  it('starts from boot without blocking it', () => {
    const { svc } = build({ filled: false, leader: true });
    const ensure = jest.spyOn(svc, 'ensureFirstFill').mockResolvedValue('ran');
    expect(svc.onApplicationBootstrap()).toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

describe('embedItemOf', () => {
  const item = '5f0e2d1c-1111-4222-8333-444455556666';
  it('names the imagery item of a cached embedding and nothing else', () => {
    expect(embedItemOf({ kind: 'sam-embed', rest: `${item}/16/1/2.bin` })).toBe(item);
    expect(embedItemOf({ kind: 'sam-embed', rest: 'not-a-uuid/16/1/2.bin' })).toBeNull();
    expect(embedItemOf({ kind: 'item-file', rest: item })).toBeNull();
  });
});
