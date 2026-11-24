// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import { ownOrgListScope, publicListScope, scopedWhere } from './list-scope.js';
import { resetTenancyModeForTests } from './tenancy.js';

const ORG_A = '1a000000-0000-4000-8000-00000000000a';

function prismaWith(org: { id: string; slug: string; name: string } | null) {
  const findUnique = jest.fn(async () => org);
  const findFirst = jest.fn(async () => org);
  return { prisma: { organization: { findUnique, findFirst } } as never, findUnique, findFirst };
}

describe('list scope', () => {
  const saved = process.env.GRATIS_TENANCY;

  function setMode(mode: 'single' | 'multi') {
    if (mode === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  }

  afterEach(() => {
    if (saved === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = saved;
    resetTenancyModeForTests();
  });

  describe('signed-in lists', () => {
    it('adds no limit in single mode and leaves the where as it was', () => {
      setMode('single');
      const where = { AND: [{ access: 'public' as const }] };
      expect(ownOrgListScope({ orgId: ORG_A })).toBeNull();
      expect(scopedWhere(where, ownOrgListScope({ orgId: ORG_A }))).toBe(where);
    });

    it("limits a list to the caller's org in multi mode", () => {
      setMode('multi');
      const where = { access: 'public' as const };
      expect(scopedWhere(where, ownOrgListScope({ orgId: ORG_A }))).toEqual({
        AND: [where, { orgId: ORG_A }],
      });
    });
  });

  describe('signed-out lists and feeds', () => {
    it('single mode with no org named: every public item, as before', async () => {
      setMode('single');
      const { prisma, findFirst } = prismaWith(null);
      await expect(publicListScope(prisma, {})).resolves.toEqual({
        org: null,
        scope: null,
        slug: undefined,
      });
      // Never "the first org": no lookup at all.
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('multi mode with no org named: 404, never the first org', async () => {
      setMode('multi');
      const { prisma, findFirst } = prismaWith({ id: ORG_A, slug: 'a', name: 'A' });
      await expect(publicListScope(prisma, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(publicListScope(prisma, { slug: '  ' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(findFirst).not.toHaveBeenCalled();
    });

    it.each(['single', 'multi'] as const)(
      '%s mode: a known slug limits to that org',
      async (mode) => {
        setMode(mode);
        const org = { id: ORG_A, slug: 'a', name: 'Org A' };
        const { prisma } = prismaWith(org);
        await expect(publicListScope(prisma, { slug: 'a' })).resolves.toEqual({
          org,
          scope: { orgId: ORG_A },
          slug: 'a',
        });
      },
    );

    it.each(['single', 'multi'] as const)('%s mode: an unknown slug is 404', async (mode) => {
      setMode(mode);
      const { prisma } = prismaWith(null);
      await expect(publicListScope(prisma, { slug: 'nope' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('an org id limits without a lookup; a malformed one counts as none', async () => {
      setMode('multi');
      const { prisma, findUnique } = prismaWith(null);
      await expect(publicListScope(prisma, { orgId: ORG_A })).resolves.toEqual({
        org: null,
        scope: { orgId: ORG_A },
        slug: undefined,
      });
      expect(findUnique).not.toHaveBeenCalled();
      await expect(publicListScope(prisma, { orgId: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
