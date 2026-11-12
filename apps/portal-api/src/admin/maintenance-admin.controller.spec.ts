// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';

import { MaintenanceAdminController } from './maintenance-admin.controller.js';

describe('MaintenanceAdminController under a failed-restore hold', () => {
  function controller() {
    const mode = {
      snapshot: () => ({
        active: true,
        startedAt: null,
        reason: 'Restore of backup x failed. Last error: pg_restore exited 1',
      }),
      activate: jest.fn(),
      deactivate: jest.fn(),
    };
    const audit = { record: jest.fn(async () => undefined) };
    return { c: new MaintenanceAdminController(mode as never, audit as never), mode };
  }
  const user = { id: 'u', orgId: 'o' } as never;

  it('refuses turning it on, which would overwrite the failure reason', async () => {
    const { c, mode } = controller();
    await expect(c.set(user, { active: true } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(mode.activate).not.toHaveBeenCalled();
  });

  it('refuses turning it off', async () => {
    const { c, mode } = controller();
    await expect(c.set(user, { active: false } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(mode.deactivate).not.toHaveBeenCalled();
  });
});
