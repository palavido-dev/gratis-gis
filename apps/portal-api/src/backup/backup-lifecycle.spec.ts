// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as fs from 'node:fs/promises';

import { BackupService } from './backup.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// Partial mock: real fs/promises with readdir and stat swapped. A
// blanket module mock breaks the S3 client the constructor builds (its
// credential chain reads an INI file through this module) and crashes
// the worker after the assertions pass.
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  readdir: jest.fn(),
  stat: jest.fn(),
}));

/**
 * The lifecycle half of the backup fix. Every case here is something
 * that actually went wrong in production on 2026-08-09/10:
 *
 * - Delete was the only per-run action, so an admin trying to STOP a
 *   run deleted its row instead. `filename` is null until success, so
 *   nothing came off disk while the row the live process needed to
 *   record its outcome was destroyed.
 * - Nothing could signal the work itself, so the job kept writing.
 * - Two replicas share one archive volume with no concurrency guard.
 * - Sixteen days without a backup rendered as seven healthy rows.
 */
describe('backup lifecycle', () => {
  const HOURS = 3_600_000;
  const MINUTES = 60_000;
  const DIR = '/app/backups';
  const readdir = fs.readdir as unknown as jest.Mock;
  const stat = fs.stat as unknown as jest.Mock;

  function makeService(overrides: {
    findFirst?: jest.Mock;
    findUnique?: jest.Mock;
    update?: jest.Mock;
    delete?: jest.Mock;
    scheduleMode?: string;
  }) {
    const prisma = {
      backupRun: {
        findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
        findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
        update: overrides.update ?? jest.fn().mockResolvedValue({}),
        delete: overrides.delete ?? jest.fn().mockResolvedValue({}),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;
    const svc = new BackupService(prisma, new ConfigService());
    jest.spyOn(svc, 'getConfig').mockResolvedValue({
      archiveDirectory: DIR,
      scheduleMode: overrides.scheduleMode ?? 'daily',
      scheduleSummary: 'Every day at 02:00',
      retentionCount: 7,
    } as never);
    return { svc, prisma };
  }

  beforeEach(() => jest.clearAllMocks());

  /** A run whose owner is provably alive: beat within the window. */
  const liveRun = (extra: Record<string, unknown> = {}) => ({
    id: 'r1',
    status: 'running',
    filename: null,
    startedAt: new Date(),
    heartbeatAt: new Date(),
    ...extra,
  });

  /** A run whose owner died: last beat far outside the window. */
  const deadRun = (extra: Record<string, unknown> = {}) => ({
    id: 'r1',
    status: 'running',
    filename: null,
    startedAt: new Date(Date.now() - 2 * HOURS),
    heartbeatAt: new Date(Date.now() - 2 * HOURS),
    ...extra,
  });

  describe('deleteRun', () => {
    it('refuses to delete a run that is still going', async () => {
      const { svc } = makeService({});
      jest.spyOn(svc, 'getRun').mockResolvedValue(liveRun() as never);
      await expect(svc.deleteRun('r1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('closes out and deletes a run whose process died', async () => {
      // The 2026-08-19 phantom: a deploy killed the 02:00 run, and the
      // admin was left with a row Delete 409'd on and Cancel could not
      // reach. A dead run has no process to protect, so the same click
      // fails the row and then does the delete that was asked for.
      const del = jest.fn().mockResolvedValue({});
      const update = jest.fn().mockResolvedValue({});
      const { svc } = makeService({ delete: del, update });
      jest.spyOn(svc, 'getRun').mockResolvedValue(deadRun() as never);
      await expect(svc.deleteRun('r1')).resolves.toEqual({ deleted: 'r1' });
      expect(update).toHaveBeenCalled();
      expect(update.mock.calls[0]![0].data.status).toBe('failed');
      expect(del).toHaveBeenCalled();
    });

    it('treats a pre-heartbeat running row as dead once old enough', async () => {
      // Rows created before the heartbeat column have heartbeatAt null
      // and threshold on startedAt. They cannot belong to a live
      // process; shipping the column restarted every replica.
      const del = jest.fn().mockResolvedValue({});
      const { svc } = makeService({ delete: del });
      jest
        .spyOn(svc, 'getRun')
        .mockResolvedValue(deadRun({ heartbeatAt: null }) as never);
      await expect(svc.deleteRun('r1')).resolves.toEqual({ deleted: 'r1' });
      expect(del).toHaveBeenCalled();
    });

    it('still deletes a finished run', async () => {
      const del = jest.fn().mockResolvedValue({});
      const { svc } = makeService({ delete: del });
      jest
        .spyOn(svc, 'getRun')
        .mockResolvedValue({ id: 'r1', status: 'failed', filename: null } as never);
      await expect(svc.deleteRun('r1')).resolves.toEqual({ deleted: 'r1' });
      expect(del).toHaveBeenCalled();
    });
  });

  describe('requestCancel', () => {
    it('flags a running run so the other replica can see it', async () => {
      // Durable, not in-memory: the request lands on whichever replica
      // the proxy picked, usually not the one holding pg_dump.
      const update = jest.fn().mockResolvedValue({});
      const { svc } = makeService({ update });
      jest.spyOn(svc, 'getRun').mockResolvedValue(liveRun() as never);
      await expect(svc.requestCancel('r1')).resolves.toEqual({
        cancelled: true,
        status: 'running',
      });
      const arg = update.mock.calls[0]![0];
      expect(arg.where).toEqual({ id: 'r1' });
      expect(arg.data.cancelRequestedAt).toBeInstanceOf(Date);
    });

    it('closes out a dead run instead of setting a flag nothing polls', async () => {
      // Cancel on a dead run used to "succeed" by writing
      // cancelRequestedAt for a process that no longer existed, so the
      // row stayed In progress and the admin stayed stuck. It now says
      // what actually happened.
      const update = jest.fn().mockResolvedValue({});
      const { svc } = makeService({ update });
      jest.spyOn(svc, 'getRun').mockResolvedValue(deadRun() as never);
      await expect(svc.requestCancel('r1')).resolves.toEqual({
        cancelled: false,
        status: 'failed',
        reclaimed: true,
      });
      // The one write is the reclaim, not a cancel flag.
      expect(update).toHaveBeenCalledTimes(1);
      const arg = update.mock.calls[0]![0];
      expect(arg.data.status).toBe('failed');
      expect(arg.data.cancelRequestedAt).toBeUndefined();
    });

    it('is a no-op on a finished run rather than an error', async () => {
      // The admin cannot know the run finished a second before they
      // clicked; a 409 here would just be noise.
      const update = jest.fn();
      const { svc } = makeService({ update });
      jest
        .spyOn(svc, 'getRun')
        .mockResolvedValue({ id: 'r1', status: 'succeeded' } as never);
      await expect(svc.requestCancel('r1')).resolves.toEqual({
        cancelled: false,
        status: 'succeeded',
      });
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('concurrency guard', () => {
    it('refuses a second run while one is active', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'other', startedAt: new Date() });
      const { svc } = makeService({ findFirst });
      await expect(svc.runBackup('manual', 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('only counts runs with a live heartbeat', async () => {
      // An abandoned row from a killed process must not lock out every
      // future backup. That is the retention ratchet in another guise.
      // The guard filters to rows whose beat (or, pre-heartbeat, whose
      // startedAt) is within the five-minute liveness window; dead
      // rows were already reclaimed a moment earlier.
      const findFirst = jest.fn().mockResolvedValue(null);
      const { svc } = makeService({ findFirst });
      await svc.runBackup('manual', 'u1').catch(() => undefined);
      const where = findFirst.mock.calls[0]![0].where;
      expect(where.status).toBe('running');
      const arms = where.OR as Array<Record<string, { gte?: Date } | null>>;
      expect(arms).toHaveLength(2);
      const beatFloor = (arms[0]!.heartbeatAt as { gte: Date }).gte;
      expect(arms[1]!.heartbeatAt).toBeNull();
      const startFloor = (arms[1]!.startedAt as { gte: Date }).gte;
      for (const floor of [beatFloor, startFloor]) {
        expect(Date.now() - floor.getTime()).toBeGreaterThan(4.9 * MINUTES);
        expect(Date.now() - floor.getTime()).toBeLessThan(5.1 * MINUTES);
      }
    });

    it('reclaims dead rows before deciding, so they cannot block', async () => {
      // The full deadlock shape: a killed process leaves a running row
      // and, without this, every future scheduled run refuses forever.
      const findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'dead', startedAt: new Date(Date.now() - 2 * HOURS), heartbeatAt: null },
        ]);
      const update = jest.fn().mockResolvedValue({});
      const findFirst = jest.fn().mockResolvedValue(null);
      const { svc, prisma } = makeService({ findFirst, update });
      (prisma.backupRun as unknown as { findMany: jest.Mock }).findMany =
        findMany;
      jest
        .spyOn(
          svc as unknown as { runPgDump: () => Promise<void> },
          'runPgDump',
        )
        .mockRejectedValue(new Error('stop here'));
      (prisma.backupRun as unknown as { create: jest.Mock }).create = jest
        .fn()
        .mockResolvedValue({ id: 'r-new', startedAt: new Date() });

      await svc.runBackup('manual', 'u1').catch(() => undefined);

      // The dead row was failed BEFORE the guard query ran.
      const reclaimCall = update.mock.calls.find(
        (c) => c[0].where.id === 'dead',
      );
      expect(reclaimCall).toBeDefined();
      expect(reclaimCall![0].data.status).toBe('failed');
      expect(findFirst).toHaveBeenCalled();
    });
  });

  describe('cancel polling', () => {
    // The first live cancel took ~60s against a 2s poll, because the
    // check was driven from the archive loop and could therefore only
    // fire between members: it was waiting out a multi-GB object. The
    // poll now runs on its own timer so the signal reaches the
    // in-flight S3 read, which is the whole reason that read is wired
    // to an AbortSignal.
    it('polls on a timer rather than from the archive loop', async () => {
      const setSpy = jest.spyOn(global, 'setInterval');
      const findUnique = jest.fn().mockResolvedValue({ cancelRequestedAt: null });
      const { svc } = makeService({ findUnique });
      // Fail fast once the poll is started; we only care that the
      // timer was armed, not that a backup completes.
      jest
        .spyOn(
          svc as unknown as { runPgDump: () => Promise<void> },
          'runPgDump',
        )
        .mockRejectedValue(new Error('stop here'));
      (svc as unknown as { prisma: { backupRun: { create: jest.Mock } } }).prisma
        .backupRun.create = jest
        .fn()
        .mockResolvedValue({ id: 'r1', startedAt: new Date() });

      await svc.runBackup('manual', null).catch(() => undefined);

      const armed = setSpy.mock.calls.some(([, ms]) => ms === 2000);
      expect(armed).toBe(true);
      setSpy.mockRestore();
    });

    it('clears the timer even when the run fails', async () => {
      // A leaked interval would query the database every two seconds
      // for the life of the process. It is started inside the try
      // precisely so the finally always reaches it.
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const { svc } = makeService({});
      jest
        .spyOn(
          svc as unknown as { runPgDump: () => Promise<void> },
          'runPgDump',
        )
        .mockRejectedValue(new Error('boom'));
      (svc as unknown as { prisma: { backupRun: { create: jest.Mock } } }).prisma
        .backupRun.create = jest
        .fn()
        .mockResolvedValue({ id: 'r1', startedAt: new Date() });

      await svc.runBackup('manual', null).catch(() => undefined);

      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it('stamps a first liveness beat when the row is created', async () => {
      // The liveness window must hold from birth; without this a run
      // could be "dead" for the gap before the poll's first tick.
      const create = jest
        .fn()
        .mockResolvedValue({ id: 'r1', startedAt: new Date() });
      const { svc, prisma } = makeService({});
      (prisma.backupRun as unknown as { create: jest.Mock }).create = create;
      jest
        .spyOn(
          svc as unknown as { runPgDump: () => Promise<void> },
          'runPgDump',
        )
        .mockRejectedValue(new Error('stop here'));

      await svc.runBackup('manual', null).catch(() => undefined);

      expect(create).toHaveBeenCalled();
      expect(create.mock.calls[0]![0].data.heartbeatAt).toBeInstanceOf(Date);
    });

    it('does not arm the timer at all if config lookup fails', async () => {
      // getConfig() runs before the try. Arming the timer any earlier
      // would leak it on exactly this path.
      const setSpy = jest.spyOn(global, 'setInterval');
      const { svc } = makeService({});
      jest.spyOn(svc, 'getConfig').mockRejectedValue(new Error('no config'));
      (svc as unknown as { prisma: { backupRun: { create: jest.Mock } } }).prisma
        .backupRun.create = jest
        .fn()
        .mockResolvedValue({ id: 'r1', startedAt: new Date() });

      await svc.runBackup('manual', null).catch(() => undefined);

      expect(setSpy.mock.calls.some(([, ms]) => ms === 2000)).toBe(false);
      setSpy.mockRestore();
    });
  });

  describe('getHealth', () => {
    it('reads the archive directory, not the run table', async () => {
      // The table is reverted nightly by the golden reset while the
      // archives survive, so rows are the wrong source of truth here.
      readdir.mockResolvedValue([
        'backup-2026-08-01T02-00-00-000-aaaaaaaa.tar.gz',
        '.partial-xyz.tar.gz',
        'not-a-backup.txt',
      ]);
      stat.mockResolvedValue({ mtime: new Date(Date.now() - 3 * HOURS) });
      const { svc } = makeService({});
      const h = await svc.getHealth();
      expect(h.archiveCount).toBe(1); // partial + junk excluded
      expect(h.ageHours).toBeCloseTo(3, 0);
      expect(h.overdue).toBe(false);
    });

    it('flags a stale portal as overdue', async () => {
      // The sixteen-day case, which the UI rendered as healthy.
      readdir.mockResolvedValue(['backup-2026-07-24T02-00-00-000-dddddddd.tar.gz']);
      stat.mockResolvedValue({ mtime: new Date(Date.now() - 16 * 24 * HOURS) });
      const { svc } = makeService({});
      const h = await svc.getHealth();
      expect(h.overdue).toBe(true);
      expect(h.reason).toMatch(/384h old/);
    });

    it('reports no archives as overdue when a schedule is set', async () => {
      readdir.mockResolvedValue([]);
      const { svc } = makeService({});
      await expect(svc.getHealth()).resolves.toMatchObject({
        lastArchiveAt: null,
        archiveCount: 0,
        overdue: true,
      });
    });

    it('does not cry wolf when scheduled backups are off', async () => {
      readdir.mockResolvedValue([]);
      const { svc } = makeService({ scheduleMode: 'off' });
      await expect(svc.getHealth()).resolves.toMatchObject({ overdue: false });
    });

    it('treats an unreadable archive directory as overdue', async () => {
      // Failing open here would report health for a volume that is not
      // mounted, which is the failure this whole signal exists to catch.
      readdir.mockRejectedValue(new Error('ENOENT'));
      const { svc } = makeService({});
      const h = await svc.getHealth();
      expect(h.overdue).toBe(true);
      expect(h.reason).toMatch(/Could not read/);
    });
  });
});
