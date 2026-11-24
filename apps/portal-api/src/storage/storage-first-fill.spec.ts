// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';

import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageLedgerService } from './storage-ledger.service.js';
import { StorageUsageReconcileService, type ReconcileSummary } from './storage-usage-reconcile.service.js';
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

function build(opts: { filled: boolean; leader?: boolean | null; fail?: boolean }) {
  const ledger = { ledgerFilled: jest.fn(async () => opts.filled) } as unknown as StorageLedgerService;
  const leader =
    opts.leader === null || opts.leader === undefined
      ? undefined
      : ({ shouldRun: () => opts.leader } as unknown as LeaderElectionService);
  const svc = new StorageUsageReconcileService(
    {} as PrismaService,
    {} as StorageService,
    ledger,
    leader,
  );
  const reconcile = jest
    .spyOn(svc, 'reconcile')
    .mockImplementation(async () => {
      if (opts.fail) throw new Error('store down');
      return summary();
    });
  return { svc, reconcile };
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
    expect(reconcile).toHaveBeenCalledWith({ dryRun: false, progress: true });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Running the first fill now'))).toBe(true);
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

  it('starts from boot without blocking it', () => {
    const { svc } = build({ filled: false, leader: true });
    const ensure = jest.spyOn(svc, 'ensureFirstFill').mockResolvedValue('ran');
    expect(svc.onApplicationBootstrap()).toBeUndefined();
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
