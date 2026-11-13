// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Deployment switch for the backup surface. With
 * GRATIS_DISABLE_BACKUP_UI=1 (or true) the API refuses to run,
 * download, delete or restore backups, change the backup settings, or
 * turn maintenance on or off, and the web hides those controls. It is
 * for installs whose operator admin login is shared, such as a public
 * demo, where that login must not hand out a full database dump or
 * roll the portal back. Scheduled backups still run.
 */
export function backupUiDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.GRATIS_DISABLE_BACKUP_UI?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export const BACKUP_UI_DISABLED_MESSAGE =
  'Backup, restore and maintenance are turned off on this install.';

/** Marks a route the switch leaves open (the availability probe). */
export const ALLOW_WHEN_BACKUP_UI_DISABLED = 'allowWhenBackupUiDisabled';
export const AllowWhenBackupUiDisabled = () =>
  SetMetadata(ALLOW_WHEN_BACKUP_UI_DISABLED, true);

@Injectable()
export class BackupUiEnabledGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (!backupUiDisabled()) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WHEN_BACKUP_UI_DISABLED,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;
    throw new ForbiddenException(BACKUP_UI_DISABLED_MESSAGE);
  }
}
