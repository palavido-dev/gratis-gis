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

  describe('deleteRun', () => {
    it('refuses to delete a run that is still going', async () => {
      const { svc } = makeService({});
      jest
        .spyOn(svc, 'getRun')
        .mockResolvedValue({ id: 'r1', status: 'running', filename: null } as never);
      await expect(svc.deleteRun('r1')).rejects.toBeInstanceOf(ConflictException);
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
      jest
        .spyOn(svc, 'getRun')
        .mockResolvedValue({ id: 'r1', status: 'running' } as never);
      await expect(svc.requestCancel('r1')).resolves.toEqual({
        cancelled: true,
        status: 'running',
      });
      const arg = update.mock.calls[0]![0];
      expect(arg.where).toEqual({ id: 'r1' });
      expect(arg.data.cancelRequestedAt).toBeInstanceOf(Date);
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

    it('only counts runs inside the stale window', async () => {
      // An abandoned row from a killed process must not lock out every
      // future backup. That is the retention ratchet in another guise.
      const findFirst = jest.fn().mockResolvedValue(null);
      const { svc } = makeService({ findFirst });
      await svc.runBackup('manual', 'u1').catch(() => undefined);
      const where = findFirst.mock.calls[0]![0].where;
      expect(where.status).toBe('running');
      const floor: Date = where.startedAt.gte;
      expect(Date.now() - floor.getTime()).toBeGreaterThan(5.9 * HOURS);
      expect(Date.now() - floor.getTime()).toBeLessThan(6.1 * HOURS);
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
