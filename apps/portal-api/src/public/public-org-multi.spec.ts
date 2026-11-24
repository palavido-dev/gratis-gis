// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';
import type { Organization } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminSecurityController } from '../admin/admin-security.controller.js';
import { resolvePublicOrg } from '../common/public-org.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PublicController } from './public.controller.js';

/**
 * Public, signed-out reads name their organization. Two orgs share
 * the install; the oldest is A. With no org named, a one-org install
 * answers for its own org as before, and an install serving many
 * answers 404 instead of picking "the first org".
 */
const A = '60000000-0000-4000-8000-00000000000a';
const B = '60000000-0000-4000-8000-00000000000b';

function org(id: string, slug: string, createdAt: string, embedOrigins: string[]): Organization {
  return {
    id,
    slug,
    name: slug.toUpperCase(),
    createdAt: new Date(createdAt),
    landingTitle: null,
    landingSubtitle: null,
    landingHeroImageUrl: null,
    landingShowPublicItems: false,
    landingFeaturedItemIds: [],
    embedOrigins,
  } as unknown as Organization;
}

/** A tiny organization table: A (oldest) and B, each with its own list. */
function twoOrgs() {
  const rows = [
    org(A, 'alpha', '2026-01-01', ['https://a.example.org']),
    org(B, 'beta', '2026-02-01', ['https://b.example.org']),
  ];
  const prisma = {
    organization: {
      findUnique: jest.fn(async (args: { where: { slug?: string; id?: string } }) => {
        const r = rows.find((o) =>
          args.where.slug !== undefined ? o.slug === args.where.slug : o.id === args.where.id,
        );
        return r ?? null;
      }),
      findFirst: jest.fn(async () => rows[0]),
      update: jest.fn(async (args: { where: { id: string }; data: { embedOrigins: string[] } }) => {
        const r = rows.find((o) => o.id === args.where.id)!;
        (r as unknown as { embedOrigins: string[] }).embedOrigins = args.data.embedOrigins;
        return r;
      }),
    },
    item: { findMany: jest.fn(async () => []) },
  };
  const publicCtl = new PublicController(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
  );
  const adminCtl = new AdminSecurityController({} as never, prisma as unknown as PrismaService);
  return { prisma, publicCtl, adminCtl };
}

const adminOf = (orgId: string) =>
  ({ id: `admin-${orgId}`, orgId, orgSlug: orgId, orgRole: 'admin' }) as unknown as AuthUser;

describe.each(['single', 'multi'] as const)('public org resolution (%s mode)', (mode) => {
  const saved = process.env.GRATIS_TENANCY;
  beforeEach(() => {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
  });

  it('GET public/landing with no org: oldest org in single mode, 404 in multi mode', async () => {
    const { publicCtl } = twoOrgs();
    if (mode === 'single') {
      await expect(publicCtl.landing()).resolves.toMatchObject({ org: { slug: 'alpha' } });
    } else {
      await expect(publicCtl.landing()).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('GET public/landing names its org with ?org=', async () => {
    const { publicCtl } = twoOrgs();
    await expect(publicCtl.landing('beta')).resolves.toMatchObject({ org: { slug: 'beta' } });
    await expect(publicCtl.landing('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET public/catalog.json follows the same rule', async () => {
    const { publicCtl } = twoOrgs();
    const req = { headers: {}, protocol: 'https', get: () => 'portal.test' } as never;
    if (mode === 'single') {
      await expect(publicCtl.catalog(req)).resolves.toMatchObject({ publisher: { name: 'ALPHA' } });
    } else {
      await expect(publicCtl.catalog(req)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(publicCtl.catalog(req, 'beta')).resolves.toMatchObject({
      publisher: { name: 'BETA' },
    });
  });

  it('resolvePublicOrg treats a blank slug as none', async () => {
    const { prisma } = twoOrgs();
    const got = await resolvePublicOrg(prisma as unknown as PrismaService, { slug: '  ' });
    expect(got?.id ?? null).toBe(mode === 'single' ? A : null);
  });

  if (mode === 'multi') {
    it("embed origins: org A's list never appears for org B", async () => {
      const { publicCtl } = twoOrgs();
      await expect(publicCtl.embedOrigins('alpha')).resolves.toEqual({
        origins: ['https://a.example.org'],
      });
      await expect(publicCtl.embedOrigins('beta')).resolves.toEqual({
        origins: ['https://b.example.org'],
      });
      await expect(publicCtl.embedOrigins()).rejects.toBeInstanceOf(NotFoundException);
      await expect(publicCtl.embedOrigins('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("embed origins: each org admin reads and writes only their own org's list", async () => {
      const { adminCtl, publicCtl } = twoOrgs();
      await expect(adminCtl.getEmbedOrigins(adminOf(B))).resolves.toEqual({
        origins: ['https://b.example.org'],
      });
      await adminCtl.putEmbedOrigins(adminOf(B), { origins: ['https://new-b.example.org'] });
      await expect(publicCtl.embedOrigins('beta')).resolves.toEqual({
        origins: ['https://new-b.example.org'],
      });
      await expect(publicCtl.embedOrigins('alpha')).resolves.toEqual({
        origins: ['https://a.example.org'],
      });
    });
  } else {
    it('embed origins: the install list (oldest org), whatever ?org= says', async () => {
      const { publicCtl, adminCtl } = twoOrgs();
      await expect(publicCtl.embedOrigins()).resolves.toEqual({
        origins: ['https://a.example.org'],
      });
      await expect(publicCtl.embedOrigins('beta')).resolves.toEqual({
        origins: ['https://a.example.org'],
      });
      // The operator admin edits the install list.
      await adminCtl.putEmbedOrigins(adminOf(A), { origins: ['https://x.example.org'] });
      await expect(publicCtl.embedOrigins()).resolves.toEqual({
        origins: ['https://x.example.org'],
      });
    });

    it('embed origins: an install with no organization yet has an empty list', async () => {
      const prisma = { organization: { findFirst: jest.fn(async () => null) } };
      const ctl = new PublicController(
        prisma as unknown as PrismaService,
        {} as never,
        {} as never,
      );
      await expect(ctl.embedOrigins()).resolves.toEqual({ origins: [] });
    });
  }
});
