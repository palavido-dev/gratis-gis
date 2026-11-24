// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

import { resetTenancyModeForTests } from './common/tenancy.js';
import { resetExpressionTimeZoneCacheForTests } from './expressions/time-zone.js';
import { PortalInfoController } from './portal-info.controller.js';
import type { PrismaService } from './prisma/prisma.service.js';

/**
 * The portal name and time zone in GET /portal-info. Two orgs; the
 * oldest is A. A one-org install always describes its own org. An
 * install serving many describes the signed-in caller's org, and
 * never another org for a signed-out caller.
 */
const A = { id: 'org-a', name: 'Alpha', landingTitle: 'Alpha Maps', timeZone: 'Europe/Paris' };
const B = { id: 'org-b', name: 'Beta', landingTitle: null, timeZone: 'America/Denver' };

function controller() {
  const prisma = {
    organization: {
      findFirst: jest.fn(async () => A),
      findUnique: jest.fn(
        async (args: { where: { id: string } }) =>
          [A, B].find((o) => o.id === args.where.id) ?? null,
      ),
    },
  };
  return new PortalInfoController(prisma as unknown as PrismaService);
}

const req = (orgId?: string): Request =>
  ({
    user: orgId ? { orgId } : null,
    headers: {},
    protocol: 'https',
    get: () => 'portal.test',
  }) as unknown as Request;

describe.each(['single', 'multi'] as const)('portal-info (%s mode)', (mode) => {
  const saved = { tenancy: process.env.GRATIS_TENANCY, name: process.env.PORTAL_NAME };
  beforeEach(() => {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    process.env.PORTAL_NAME = 'Hosted Portal';
    resetTenancyModeForTests();
    resetExpressionTimeZoneCacheForTests();
  });
  afterAll(() => {
    for (const [key, env] of [
      ['GRATIS_TENANCY', saved.tenancy],
      ['PORTAL_NAME', saved.name],
    ] as const) {
      if (env === undefined) delete process.env[key];
      else process.env[key] = env;
    }
    resetTenancyModeForTests();
    resetExpressionTimeZoneCacheForTests();
  });

  it('signed in as an org B user', async () => {
    const info = await controller().info(req(B.id));
    if (mode === 'multi') {
      expect(info).toMatchObject({ name: 'Beta', timeZone: 'America/Denver' });
    } else {
      expect(info).toMatchObject({ name: 'Alpha Maps', timeZone: 'Europe/Paris' });
    }
  });

  it('signed out', async () => {
    const info = await controller().info(req());
    if (mode === 'multi') {
      expect(info).toMatchObject({ name: 'Hosted Portal', timeZone: 'UTC' });
    } else {
      expect(info).toMatchObject({ name: 'Alpha Maps', timeZone: 'Europe/Paris' });
    }
  });
});
