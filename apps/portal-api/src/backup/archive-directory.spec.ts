// SPDX-License-Identifier: AGPL-3.0-or-later
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
