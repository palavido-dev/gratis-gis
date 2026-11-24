// SPDX-License-Identifier: AGPL-3.0-or-later
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  clearExpressionTimeZoneCache,
  expressionTimeZone,
  resetExpressionTimeZoneCacheForTests,
} from './time-zone.js';

const A = 'org-a';
const B = 'org-b';

function prismaWith(zones: Record<string, string | null>, oldest: string) {
  return {
    organization: {
      findUnique: jest.fn(async (args: { where: { id: string } }) =>
        args.where.id in zones ? { timeZone: zones[args.where.id] } : null,
      ),
      findFirst: jest.fn(async () => ({ timeZone: zones[oldest] })),
    },
  };
}

function setMode(mode: 'single' | 'multi'): void {
  if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
  else delete process.env.GRATIS_TENANCY;
  resetTenancyModeForTests();
  resetExpressionTimeZoneCacheForTests();
}

describe('expressionTimeZone', () => {
  const saved = process.env.GRATIS_TENANCY;
  afterAll(() => {
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
    resetExpressionTimeZoneCacheForTests();
  });

  it('multi mode: each org gets its own zone, cached per org', async () => {
    setMode('multi');
    const prisma = prismaWith({ [A]: 'Europe/Paris', [B]: 'America/Denver' }, A);
    const p = prisma as unknown as PrismaService;
    expect(await expressionTimeZone(p, A)).toBe('Europe/Paris');
    expect(await expressionTimeZone(p, B)).toBe('America/Denver');
    expect(await expressionTimeZone(p, A)).toBe('Europe/Paris');
    expect(prisma.organization.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it('multi mode: clearing one org leaves the other cached', async () => {
    setMode('multi');
    const prisma = prismaWith({ [A]: 'Europe/Paris', [B]: 'America/Denver' }, A);
    const p = prisma as unknown as PrismaService;
    await expressionTimeZone(p, A);
    await expressionTimeZone(p, B);
    clearExpressionTimeZoneCache(A);
    await expressionTimeZone(p, A);
    await expressionTimeZone(p, B);
    expect(prisma.organization.findUnique).toHaveBeenCalledTimes(3);
  });

  it('multi mode: no org, an unknown org or a bad zone read as UTC', async () => {
    setMode('multi');
    const prisma = prismaWith({ [A]: 'Not/AZone' }, A);
    const p = prisma as unknown as PrismaService;
    expect(await expressionTimeZone(p, null)).toBe('UTC');
    expect(await expressionTimeZone(p, 'missing')).toBe('UTC');
    expect(await expressionTimeZone(p, A)).toBe('UTC');
  });

  it("single mode: the install's (oldest) org zone for every org, as before", async () => {
    setMode('single');
    const prisma = prismaWith({ [A]: 'Europe/Paris', [B]: 'America/Denver' }, A);
    const p = prisma as unknown as PrismaService;
    expect(await expressionTimeZone(p, B)).toBe('Europe/Paris');
    expect(await expressionTimeZone(p, null)).toBe('Europe/Paris');
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(1);
    clearExpressionTimeZoneCache(B);
    expect(await expressionTimeZone(p, A)).toBe('Europe/Paris');
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(2);
  });
});
