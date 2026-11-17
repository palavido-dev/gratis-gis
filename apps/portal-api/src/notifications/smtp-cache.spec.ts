// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigService } from '@nestjs/config';

import { EmailTransport } from './email-transport.js';
import { SMTP_CACHE_TTL_MS, SystemSettingsService } from './system-settings.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Two replicas: the admin's PUT lands on one, the leader that drains
 * the queue is the other. The leader must see the saved row within
 * the cache TTL, including the first save after "no SMTP yet".
 */
describe('SMTP config cache across replicas', () => {
  let now = 1_000_000;
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => spy.mockRestore());

  it('re-reads the row after the TTL so a save elsewhere is picked up', async () => {
    let row: unknown = null;
    const findUnique = jest.fn(async () => row);
    const settings = new SystemSettingsService(
      { systemSetting: { findUnique } } as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
    );
    const transport = new EmailTransport(settings);

    expect(await transport.isAvailable()).toBe(false);

    // Another replica saves SMTP.
    row = {
      value: { enabled: true, host: 'smtp.example.org', port: 587, secure: false },
      encryptedSecret: null,
      encryptedSecretIv: null,
    };
    expect(await transport.isAvailable()).toBe(false);

    now += SMTP_CACHE_TTL_MS + 1;
    expect(await transport.isAvailable()).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
