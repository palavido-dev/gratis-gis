// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { MaintenanceAdminController } from '../admin/maintenance-admin.controller.js';
import { BackupController } from './backup.controller.js';
import { BackupUiEnabledGuard, backupUiDisabled } from './backup-ui-switch.js';

/**
 * GRATIS_DISABLE_BACKUP_UI closes the backup routes and maintenance
 * writes on installs whose operator admin login is shared.
 */

function contextFor(cls: object, handler: (...a: never[]) => unknown) {
  return {
    getHandler: () => handler,
    getClass: () => cls,
  } as never;
}

describe('backupUiDisabled', () => {
  it('reads 1, true and yes as on, anything else as off', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ']) {
      expect(backupUiDisabled({ GRATIS_DISABLE_BACKUP_UI: v })).toBe(true);
    }
    for (const v of [undefined, '', '0', 'false', 'no']) {
      expect(backupUiDisabled({ GRATIS_DISABLE_BACKUP_UI: v })).toBe(false);
    }
  });
});

describe('BackupUiEnabledGuard', () => {
  const guard = new BackupUiEnabledGuard(new Reflector());
  const before = process.env.GRATIS_DISABLE_BACKUP_UI;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_DISABLE_BACKUP_UI;
    else process.env.GRATIS_DISABLE_BACKUP_UI = before;
  });

  it('lets everything through when the switch is off', () => {
    delete process.env.GRATIS_DISABLE_BACKUP_UI;
    const proto = BackupController.prototype;
    expect(guard.canActivate(contextFor(BackupController, proto.runNow))).toBe(true);
  });

  it('refuses run, download, restore and config writes when on', () => {
    process.env.GRATIS_DISABLE_BACKUP_UI = '1';
    const proto = BackupController.prototype;
    for (const h of [proto.runNow, proto.download, proto.runRestore, proto.updateConfig, proto.remove]) {
      expect(() => guard.canActivate(contextFor(BackupController, h))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('leaves the availability probe open when on', () => {
    process.env.GRATIS_DISABLE_BACKUP_UI = '1';
    const proto = BackupController.prototype;
    expect(guard.canActivate(contextFor(BackupController, proto.availability))).toBe(true);
    expect(new BackupController({} as never, {} as never, {} as never, {} as never, {} as never).availability())
      .toEqual({ disabled: true });
  });

  it('is wired on the backup controller and the maintenance write', () => {
    const classGuards = Reflect.getMetadata(GUARDS_METADATA, BackupController) as unknown[];
    expect(classGuards).toContain(BackupUiEnabledGuard);
    const setGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      MaintenanceAdminController.prototype.set,
    ) as unknown[];
    expect(setGuards).toContain(BackupUiEnabledGuard);
    const statusGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      MaintenanceAdminController.prototype.status,
    ) as unknown[] | undefined;
    expect(statusGuards ?? []).not.toContain(BackupUiEnabledGuard);
  });
});
