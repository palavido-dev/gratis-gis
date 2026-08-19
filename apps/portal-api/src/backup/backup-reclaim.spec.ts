// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConfigService } from '@nestjs/config';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { BackupService } from './backup.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// Partial mock: real fs/promises with `rm` swapped out.
//
// Two things rule out the obvious alternatives. A blanket
// jest.mock('node:fs/promises') breaks BackupService's constructor,
// which builds an S3 client whose credential-provider chain reads an
// INI file through this module; it returns undefined and crashes the
// worker AFTER the assertions have passed, which reads as a failure
// but is not one. And jest.spyOn cannot be used either, because the
// module namespace is non-configurable ("Cannot redefine property").
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  rm: jest.fn(),
}));

/**
 * A backup is owned by a single process: runBackup marks its own row
 * failed in a catch and drops the staging dir in a finally. Kill the
 * process mid-backup and neither runs, so the row stays `running`
 * forever and the admin page reports "In progress" indefinitely.
 *
 * Prod carried exactly that from 2026-07-25, with a multi-GB
 * .stage-<id> directory still on disk 16 days later, and it read as a
 * slow backup rather than a dead one.
 */
describe('BackupService.reclaimStaleRuns', () => {
  const BACKUP_DIR = '/app/backups';
  const HOURS = 3_600_000;
  const MINUTES = 60_000;
  const rm = fs.rm as unknown as jest.Mock;

  function makeService(rows: Array<{ id: string; startedAt: Date }>) {
    const update = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = {
      backupRun: { findMany, update },
    } as unknown as PrismaService;
    const svc = new BackupService(prisma, new ConfigService());
    // getConfig merges a DB row over env defaults; the reclaim only
    // needs the archive directory, so stub it rather than standing up
    // the config row machinery.
    jest
      .spyOn(svc, 'getConfig')
      .mockResolvedValue({ archiveDirectory: BACKUP_DIR } as never);
    return { svc, findMany, update };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    rm.mockResolvedValue(undefined);
  });

  it('does nothing, and touches no directory, when there are no stale runs', async () => {
    const { svc, update } = makeService([]);
    await expect(svc.reclaimStaleRuns()).resolves.toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('only ever queries for runs whose liveness signal has gone stale', async () => {
    // The guard that makes this safe to run on every boot and every
    // sweep: a live backup, which beats every couple of seconds, must
    // never be reclaimable. One arm thresholds the heartbeat; the
    // other exists only for rows that predate the heartbeat column
    // and thresholds their startedAt instead. If either arm loses its
    // bound, a long-running backup gets marked failed underneath
    // itself.
    const { svc, findMany } = makeService([]);
    const before = Date.now();
    await svc.reclaimStaleRuns();
    const where = findMany.mock.calls[0]![0].where;
    expect(where.status).toBe('running');
    const arms = where.OR as Array<Record<string, { lt?: Date } | null>>;
    expect(arms).toHaveLength(2);
    const beatCutoff = (arms[0]!.heartbeatAt as { lt: Date }).lt;
    expect(arms[1]!.heartbeatAt).toBeNull();
    const startCutoff = (arms[1]!.startedAt as { lt: Date }).lt;
    // Five minutes back, generously bounded so the assertion is about
    // the order of magnitude rather than clock precision.
    for (const cutoff of [beatCutoff, startCutoff]) {
      expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(4.9 * MINUTES);
      expect(before - cutoff.getTime()).toBeLessThanOrEqual(5.1 * MINUTES);
    }
  });

  it('marks an abandoned run failed and records why', async () => {
    const startedAt = new Date(Date.now() - 380 * HOURS); // ~16 days
    const { svc, update } = makeService([{ id: 'run-1', startedAt }]);

    await expect(svc.reclaimStaleRuns()).resolves.toBe(1);

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: 'run-1' });
    expect(arg.data.status).toBe('failed');
    expect(arg.data.finishedAt).toBeInstanceOf(Date);
    // The message has to say it was abandoned rather than that the
    // backup itself failed: the distinction is what tells an operator
    // the process died instead of pg_dump erroring.
    expect(arg.data.error).toMatch(/abandoned/i);
    expect(arg.data.error).toContain('380h');
  });

  it('removes the staging directory and partial archive the finally never reached', async () => {
    // A kill can land mid-seal, so both a .stage-<id> directory and a
    // .partial-<id>.tar.gz can be orphaned by the same death.
    const { svc } = makeService([
      { id: 'run-1', startedAt: new Date(Date.now() - 20 * HOURS) },
    ]);
    await svc.reclaimStaleRuns();
    // path.join, not a slash literal: the implementation joins, so a
    // hardcoded "/" would pass on the Linux runner and fail on the
    // Windows dev box for a reason that has nothing to do with backups.
    expect(rm).toHaveBeenCalledWith(
      path.join(BACKUP_DIR, '.stage-run-1'),
      { recursive: true, force: true },
    );
    expect(rm).toHaveBeenCalledWith(
      path.join(BACKUP_DIR, '.partial-run-1.tar.gz'),
      { recursive: false, force: true },
    );
  });

  it('never deletes a sealed archive, only staging bytes', async () => {
    // A stuck row never produced a final archive, so nothing in this
    // path should ever address one. Sealed archives are the only files
    // named backup-*.tar.gz; staging bytes are dot-prefixed. Guards
    // against someone later "tidying up" by removing the run's
    // filename too.
    const { svc } = makeService([
      { id: 'run-1', startedAt: new Date(Date.now() - 20 * HOURS) },
    ]);
    await svc.reclaimStaleRuns();
    expect(rm).toHaveBeenCalled();
    for (const call of rm.mock.calls) {
      const base = path.basename(String(call[0]));
      expect(base.startsWith('.stage-') || base.startsWith('.partial-')).toBe(
        true,
      );
      expect(base.startsWith('backup-')).toBe(false);
    }
  });

  it('reclaims every stale run, not just the first', async () => {
    const { svc, update } = makeService([
      { id: 'a', startedAt: new Date(Date.now() - 10 * HOURS) },
      { id: 'b', startedAt: new Date(Date.now() - 40 * HOURS) },
    ]);
    await expect(svc.reclaimStaleRuns()).resolves.toBe(2);
    expect(update).toHaveBeenCalledTimes(2);
    // Stage dir + partial archive per run.
    expect(rm).toHaveBeenCalledTimes(4);
  });

  it('reports a recent death in minutes, not a rounded-to-zero hour', async () => {
    // The 2026-08-19 phantom died seven minutes in. "0h" would read
    // as nonsense; the message thresholds to minutes below two hours.
    const { svc, update } = makeService([
      { id: 'run-1', startedAt: new Date(Date.now() - 7 * MINUTES) },
    ]);
    await svc.reclaimStaleRuns();
    const arg = update.mock.calls[0]![0];
    expect(arg.data.error).toContain('7m');
    expect(arg.data.error).toMatch(/abandoned/i);
  });
});
