// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { GroupsService } from './groups.service.js';

/**
 * Org boundary for group reads. An admin of org A must not open a
 * group in org B, or read its roster, just because orgRole is admin.
 * Owner, public, org-access, and real membership still apply.
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'admin-a',
    orgId: 'org-a',
    orgSlug: 'org-a',
    username: 'admin-a',
    email: 'admin-a@example.test',
    orgRole: 'admin',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function makeGroup(
  overrides: Partial<{
    id: string;
    orgId: string;
    access: 'private' | 'org' | 'public';
    ownerId: string;
    deletedAt: Date | null;
  }> = {},
) {
  return {
    id: 'group-b',
    orgId: 'org-b',
    title: 'Other org crew',
    description: '',
    access: 'private' as const,
    ownerId: 'owner-b',
    thumbnailUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeService(group: ReturnType<typeof makeGroup> | null) {
  const members = [
    {
      groupId: group?.id ?? 'group-b',
      userId: 'owner-b',
      role: 'admin',
      user: { id: 'owner-b', username: 'owner-b', fullName: 'Owner B', email: 'b@example.test' },
    },
  ];
  const prisma = {
    group: {
      findUnique: jest.fn(async () => group),
    },
    groupMember: {
      findMany: jest.fn(async () => members),
    },
  };
  const svc = new GroupsService(
    prisma as unknown as ConstructorParameters<typeof GroupsService>[0],
    { invalidate: jest.fn(), invalidateAll: jest.fn() } as unknown as ConstructorParameters<
      typeof GroupsService
    >[1],
  );
  return { svc, prisma, members };
}

describe('GroupsService org-scoped reads', () => {
  describe('get / canSee', () => {
    it('lets an admin see a private group in their own org', async () => {
      const group = makeGroup({ orgId: 'org-a', access: 'private' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser(), group.id)).resolves.toEqual(group);
    });

    it('hides a private group in another org from that org admin', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'private' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser(), group.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('hides an org-access group in another org from that org admin', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'org' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser(), group.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still lets anyone see a public group, including a cross-org admin', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'public' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser(), group.id)).resolves.toEqual(group);
    });

    it('still lets the owner see their group across orgs', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'private', ownerId: 'admin-a' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser(), group.id)).resolves.toEqual(group);
    });

    it('lets a non-admin see an org-access group in their own org', async () => {
      const group = makeGroup({ orgId: 'org-a', access: 'org' });
      const { svc } = makeService(group);
      await expect(
        svc.get(makeUser({ orgRole: 'contributor' }), group.id),
      ).resolves.toEqual(group);
    });

    it('hides a private group from a non-admin who is not the owner', async () => {
      const group = makeGroup({ orgId: 'org-a', access: 'private' });
      const { svc } = makeService(group);
      await expect(svc.get(makeUser({ orgRole: 'viewer' }), group.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listMembers', () => {
    it('lets a same-org admin read the roster without being a member', async () => {
      const group = makeGroup({ id: 'group-a', orgId: 'org-a', access: 'private' });
      const { svc, prisma, members } = makeService(group);
      await expect(svc.listMembers(makeUser(), group.id)).resolves.toEqual(members);
      expect(prisma.groupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { groupId: group.id } }),
      );
    });

    it('does not let a cross-org admin read another org roster', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'public' });
      const { svc, prisma } = makeService(group);
      await expect(svc.listMembers(makeUser(), group.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    });

    it('does not let a cross-org admin read a private roster by id', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'private' });
      const { svc, prisma } = makeService(group);
      await expect(svc.listMembers(makeUser(), group.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    });

    it('lets a cross-org admin read the roster when they are actually a member', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'private' });
      const { svc, members } = makeService(group);
      const user = makeUser({ groupIds: [group.id] });
      await expect(svc.listMembers(user, group.id)).resolves.toEqual(members);
    });

    it('lets a cross-org admin read the roster when they own the group', async () => {
      const group = makeGroup({ orgId: 'org-b', access: 'private', ownerId: 'admin-a' });
      const { svc, members } = makeService(group);
      await expect(svc.listMembers(makeUser(), group.id)).resolves.toEqual(members);
    });

    it('lets an actual member read a private roster', async () => {
      const group = makeGroup({ orgId: 'org-a', access: 'private' });
      const { svc, members } = makeService(group);
      const user = makeUser({ orgRole: 'contributor', groupIds: [group.id] });
      await expect(svc.listMembers(user, group.id)).resolves.toEqual(members);
    });

    it('hides the roster of a discoverable group from a non-member', async () => {
      const group = makeGroup({ orgId: 'org-a', access: 'public' });
      const { svc, prisma } = makeService(group);
      await expect(
        svc.listMembers(makeUser({ orgRole: 'contributor' }), group.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    });

    it('answers NotFound for a missing or trashed group', async () => {
      const missing = makeService(null);
      await expect(missing.svc.listMembers(makeUser(), 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      const trashed = makeGroup({ orgId: 'org-a', deletedAt: new Date('2026-02-01T00:00:00Z') });
      const { svc, prisma } = makeService(trashed);
      await expect(svc.listMembers(makeUser(), trashed.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
    });
  });
});
