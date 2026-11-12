// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { BackupService } from './backup.service.js';

/**
 * A custom cron the scheduler rejects was saved and shown as the
 * active schedule while no backup ever ran. It is now refused with a
 * 400 before anything is written.
 */
describe('BackupService.updateConfig custom cron', () => {
  it('refuses an expression the cron library rejects', async () => {
    const svc = Object.create(BackupService.prototype) as BackupService;
    await expect(svc.updateConfig({ customCron: '0 25 * * *' }, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.updateConfig({ customCron: '0 2 * *' }, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
