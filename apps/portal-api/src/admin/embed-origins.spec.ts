// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminSecurityController } from './admin-security.controller.js';
import { readEmbedOrigins } from './embed-origins.js';

/**
 * Review 28b-5: the admin allow-list of sites the Embed widget may
 * frame. Each entry reaches a CSP header, so only bare origins pass.
 */
describe('embed origins setting', () => {
  const user = { id: 'a', orgId: 'o', orgSlug: 'o' } as unknown as AuthUser;

  function setup(stored: unknown = null) {
    const prisma = {
      systemSetting: {
        upsert: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => (stored === null ? null : { value: stored })),
      },
    };
    const ctrl = new AdminSecurityController({} as never, prisma as never);
    return { prisma, ctrl };
  }

  it('saves normalized, de-duplicated origins', async () => {
    const { prisma, ctrl } = setup();
    const out = await ctrl.putEmbedOrigins(user, {
      origins: ['https://Dash.Example.org/', 'https://dash.example.org', ''],
    });
    expect(out).toEqual({ origins: ['https://dash.example.org'] });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'embed_origins' },
        update: { value: { origins: ['https://dash.example.org'] }, updatedBy: 'a' },
      }),
    );
  });

  it('refuses an entry that could inject into the CSP', async () => {
    const { prisma, ctrl } = setup();
    await expect(
      ctrl.putEmbedOrigins(user, {
        origins: ["https://a.org; script-src 'unsafe-inline'"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('drops bad entries from a hand-edited row on read', async () => {
    const { prisma } = setup({ origins: ['https://ok.org', '*', 42] });
    await expect(readEmbedOrigins(prisma as never)).resolves.toEqual([
      'https://ok.org',
    ]);
  });
});
