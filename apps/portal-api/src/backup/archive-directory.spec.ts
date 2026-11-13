// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup.service.js';

/**
 * Backups create, fill and prune whatever folder `archiveDirectory`
 * names, so an admin may only pick BACKUP_DIR, a folder inside it, or
 * a root the operator lists in BACKUP_ALLOWED_DIRS (05-6).
 */
describe('backup archiveDirectory is limited to operator roots', () => {
  const svc = new BackupService(
    {} as PrismaService,
    new ConfigService({ BACKUP_DIR: '/srv/backups', BACKUP_ALLOWED_DIRS: '/mnt/nas' }),
  );
  const allowed = (dir: string) =>
    (svc as unknown as { allowedArchiveDirectory: (d: string) => string }).allowedArchiveDirectory(dir);

  it('accepts BACKUP_DIR, a folder inside it, and an allowed root', () => {
    expect(allowed('/srv/backups')).toBe('/srv/backups');
    expect(allowed('/srv/backups/nightly')).toBe('/srv/backups/nightly');
    expect(allowed('/mnt/nas/gg')).toBe('/mnt/nas/gg');
  });

  it('refuses any other path, including a climb out of the root', () => {
    for (const dir of ['/var/cache/gg-tiles', '/srv/backups/../etc', '/srv/backups-evil', 'relative']) {
      expect(() => allowed(dir)).toThrow(BadRequestException);
    }
  });

  it('updateConfig refuses before writing anything', async () => {
    await expect(
      svc.updateConfig({ archiveDirectory: '/var/cache/gg-tiles' }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * A custom schedule needs an expression. Saving custom mode without
 * one used to succeed and then schedule nothing, and a malformed one
 * came back as a 500.
 */
describe('backup custom schedule validation', () => {
  function svcWithRow(row: Record<string, unknown>) {
    const update = jest.fn();
    const prisma = {
      backupConfig: { findFirst: jest.fn(async () => row), update },
    } as unknown as PrismaService;
    return { svc: new BackupService(prisma, new ConfigService({ BACKUP_DIR: '/srv/backups' })), update };
  }

  it('refuses custom mode with no expression, as a 400, before writing', async () => {
    const { svc, update } = svcWithRow({ id: 'r', scheduleMode: 'daily', customCron: null });
    await expect(
      svc.updateConfig({ scheduleMode: 'custom', customCron: null }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a malformed expression as a 400', async () => {
    const { svc } = svcWithRow({ id: 'r', scheduleMode: 'daily', customCron: null });
    await expect(
      svc.updateConfig({ scheduleMode: 'custom', customCron: '0 2 *' }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an out-of-range hour as a 400', async () => {
    const { svc } = svcWithRow({ id: 'r', scheduleMode: 'daily', customCron: null });
    await expect(svc.updateConfig({ scheduleHour: 24 }, 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

/**
 * Each run records the folder it wrote to, so changing the archive
 * directory does not hide older archives, and deleting a run (or
 * retention) removes the file from its own folder (05-6).
 */
describe('backup runs keep their own archive folder', () => {
  let root: string;
  let oldDir: string;
  let newDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gg-backup-dir-'));
    oldDir = join(root, 'old');
    newDir = join(root, 'new');
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, 'backup-a.tar.gz'), 'x');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function svcWith(runs: Array<Record<string, unknown>>) {
    const remove = jest.fn(async () => undefined);
    const prisma = {
      backupConfig: {
        findFirst: jest.fn(async () => ({ id: 'c', archiveDirectory: newDir })),
      },
      backupRun: {
        findMany: jest.fn(async () => runs),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          runs.find((r) => r.id === where.id) ?? null,
        ),
        delete: remove,
      },
    } as unknown as PrismaService;
    const svc = new BackupService(prisma, new ConfigService({ BACKUP_DIR: root }));
    return { svc, remove };
  }

  const oldRun = () => ({
    id: 'r1',
    status: 'succeeded',
    filename: 'backup-a.tar.gz',
    archiveDirectory: oldDir,
    startedAt: new Date(),
  });

  it('finds an archive in the folder the run recorded', async () => {
    const { svc } = svcWith([oldRun()]);
    const listed = await svc.listRunsWithArchiveState();
    expect(listed[0]?.archiveOnDisk).toBe(true);
    const resolved = await svc.resolveArchivePath('r1');
    expect(resolved.path).toBe(join(oldDir, 'backup-a.tar.gz'));
  });

  it('deletes the file from the run folder, not the current one', async () => {
    const { svc, remove } = svcWith([oldRun()]);
    await svc.deleteRun('r1');
    expect(existsSync(join(oldDir, 'backup-a.tar.gz'))).toBe(false);
    expect(remove).toHaveBeenCalled();
  });

  it('falls back to the current folder for rows without one', async () => {
    const { svc } = svcWith([{ ...oldRun(), archiveDirectory: null }]);
    const listed = await svc.listRunsWithArchiveState();
    expect(listed[0]?.archiveOnDisk).toBe(false);
  });
});
