// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloud milestone C1 — org isolation matrix.
 *
 * Run: pnpm --filter @gratis-gis/portal-api test -- org-isolation
 *
 * Proves Org A cannot reach Org B private / org-scoped items via
 * SharingService point-checks and that visibleWhere stays scoped to
 * the caller's org. Public cross-org read remains intentional.
 */
import type { Prisma } from '@prisma/client';

import { PolicyService } from '../policy/policy.service.js';
import {
  ORG_A,
  ORG_B,
  makeAuthUser,
  makeItem,
} from '../testing/org-fixtures.js';
import { SharingService } from './sharing.service.js';

const ANY_PRISMA = undefined as unknown as ConstructorParameters<
  typeof SharingService
>[0];

describe('org isolation (C1)', () => {
  let svc: SharingService;

  beforeAll(() => {
    svc = new SharingService(ANY_PRISMA, new PolicyService());
  });

  const orgAUser = makeAuthUser({
    id: 'user-a',
    orgId: ORG_A,
    orgRole: 'contributor',
  });
  const orgAAdmin = makeAuthUser({
    id: 'admin-a',
    orgId: ORG_A,
    orgRole: 'admin',
  });

  const orgBPrivate = makeItem({
    id: 'item-b-private',
    orgId: ORG_B,
    ownerId: 'owner-b',
    access: 'private',
  });
  const orgBOrgAccess = makeItem({
    id: 'item-b-org',
    orgId: ORG_B,
    ownerId: 'owner-b',
    access: 'org',
  });
  const orgBPublic = makeItem({
    id: 'item-b-public',
    orgId: ORG_B,
    ownerId: 'owner-b',
    access: 'public',
  });

  describe('Org A user cannot access Org B private item', () => {
    it.each(['canRead', 'canEdit', 'canDownload', 'canAdmin'] as const)(
      '%s denied',
      (m) => {
        if (m === 'canAdmin') {
          expect(svc[m](orgAUser, orgBPrivate)).toBe(false);
        } else {
          expect(svc[m](orgAUser, orgBPrivate, [])).toBe(false);
        }
      },
    );
  });

  describe('Org A user cannot canRead Org B access:org item', () => {
    it('canRead denied', () => {
      expect(svc.canRead(orgAUser, orgBOrgAccess, [])).toBe(false);
    });
  });

  describe('Org A admin cannot admin Org B private item', () => {
    it('canAdmin denied (admin power is org-scoped)', () => {
      expect(svc.canAdmin(orgAAdmin, orgBPrivate)).toBe(false);
    });
  });

  describe('Org B public item is readable by Org A (intentional)', () => {
    it('canRead allowed across orgs for public access', () => {
      expect(svc.canRead(orgAUser, orgBPublic, [])).toBe(true);
    });
  });

  describe('visibleWhere org scoping', () => {
    it('for Org A admin adds every ORG_A item and nothing org-wide from ORG_B', () => {
      const where = svc.visibleWhere(orgAAdmin);
      const and = (where as { AND: Prisma.ItemWhereInput[] }).AND;
      expect(and).toEqual(expect.arrayContaining([{ deletedAt: null }]));
      const access = and.find(
        (c) => typeof c === 'object' && c !== null && 'OR' in c,
      ) as { OR: Prisma.ItemWhereInput[] };
      // Every item of the admin's own org, regardless of sharing.
      expect(access.OR).toContainEqual({ orgId: ORG_A });
      // The same outside reach as any member (public items, shares),
      // which canRead also grants an admin.
      expect(access.OR).toContainEqual({ access: 'public' });
      // The admin clause must not broaden to ORG_B under any key.
      expect(JSON.stringify(where)).not.toContain(ORG_B);
    });

    it('for Org A contributor does not match Org B org-access items via the org clause', () => {
      const where = svc.visibleWhere(orgAUser);
      const and = (where as { AND: Prisma.ItemWhereInput[] }).AND;
      const access = and.find(
        (c) => typeof c === 'object' && c !== null && 'OR' in c,
      ) as { OR: Prisma.ItemWhereInput[] };
      expect(access).toBeDefined();

      const orgAccessClause = access.OR.find(
        (c) =>
          typeof c === 'object' &&
          c !== null &&
          'access' in c &&
          (c as { access?: string }).access === 'org',
      ) as { access: string; orgId: string };

      expect(orgAccessClause).toEqual({ access: 'org', orgId: ORG_A });
      expect(orgAccessClause.orgId).not.toBe(ORG_B);

      // Structural check: an Org B org-scoped item would need
      // orgId: ORG_B on this clause to match; it does not.
      expect(orgAccessClause).not.toEqual({
        access: 'org',
        orgId: ORG_B,
      });
    });
  });
});
