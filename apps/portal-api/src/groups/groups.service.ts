import { BadRequestException, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { GroupAccess, GroupRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

export interface CreateGroupInput {
  title: string;
  description?: string;
  access?: GroupAccess;
}

export interface UpdateGroupInput {
  title?: string;
  description?: string;
  access?: GroupAccess;
  /** Pass null to clear. */
  thumbnailUrl?: string | null;
}

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Groups visible to the caller: owner OR member OR org-visible
   *  OR public. The ownerId clause is critical (#102): in our model
   *  group ownership lives on the group row separate from
   *  group_member, so a curator-not-participant pattern is valid --
   *  e.g. a manager creates a group for a team they don't belong
   *  to, or removes their own membership while keeping ownership.
   *  Without this clause, an owner who's not a member of a private
   *  group would lose visibility into the group from their own
   *  groups list. */
  listVisible(user: AuthUser) {
    return this.prisma.group.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
          { orgId: user.orgId, access: { in: ['org', 'public'] } },
          { access: 'public' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Trashed groups visible to the caller. Scoped to owner + org admin so
   * a collaborator can't surface or restore someone else's deleted group.
   */
  listTrash(user: AuthUser) {
    return this.prisma.group.findMany({
      where:
        user.orgRole === 'admin'
          ? { orgId: user.orgId, deletedAt: { not: null } }
          : { ownerId: user.id, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });
  }

  async create(user: AuthUser, input: CreateGroupInput) {
    return this.prisma.group.create({
      data: {
        orgId: user.orgId,
        ownerId: user.id,
        title: input.title,
        description: input.description ?? '',
        access: input.access ?? 'private',
        members: {
          create: { userId: user.id, role: 'admin' },
        },
      },
    });
  }

  async update(user: AuthUser, groupId: string, input: UpdateGroupInput) {
    const group = await this.get(user, groupId);
    if (!this.canAdmin(user, group)) {
      throw new ForbiddenException('Only the group owner or an org admin can edit a group');
    }
    return this.prisma.group.update({
      where: { id: groupId },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.access !== undefined && { access: input.access }),
        ...(input.thumbnailUrl !== undefined && { thumbnailUrl: input.thumbnailUrl }),
      },
    });
  }

  /** Soft-delete. See docs/soft-delete.md for rationale. */
  async remove(user: AuthUser, groupId: string) {
    const group = await this.get(user, groupId);
    if (!this.canAdmin(user, group)) {
      throw new ForbiddenException('Only the group owner or an org admin can delete a group');
    }
    await this.prisma.group.update({
      where: { id: groupId },
      data: { deletedAt: new Date() },
    });
  }

  async restore(user: AuthUser, groupId: string) {
    const group = await this.get(user, groupId, { includeTrashed: true });
    if (!group.deletedAt) {
      throw new BadRequestException('Group is not in the trash');
    }
    if (!this.canAdmin(user, group)) {
      throw new ForbiddenException('Only the group owner or an org admin can restore a group');
    }
    return this.prisma.group.update({
      where: { id: groupId },
      data: { deletedAt: null },
    });
  }

  /**
   * Permanent delete. Cascades to group_member rows. Only available for
   * groups already in the trash so there is always a two-step ceremony.
   */
  async purge(user: AuthUser, groupId: string) {
    const group = await this.get(user, groupId, { includeTrashed: true });
    if (!group.deletedAt) {
      throw new BadRequestException('Group must be in the trash before it can be purged');
    }
    if (!this.canAdmin(user, group)) {
      throw new ForbiddenException('Only the group owner or an org admin can purge a group');
    }
    await this.prisma.group.delete({ where: { id: groupId } });
  }

  async get(user: AuthUser, groupId: string, opts: { includeTrashed?: boolean } = {}) {
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    if (group.deletedAt) {
      if (!opts.includeTrashed) throw new NotFoundException('Group not found');
      if (!this.canAdmin(user, group)) throw new NotFoundException('Group not found');
      return group;
    }
    if (!this.canSee(user, group)) throw new NotFoundException('Group not found');
    return group;
  }

  async listMembers(user: AuthUser, groupId: string) {
    const group = await this.get(user, groupId);
    // Only members (or org-admins) can see the full roster; non-members
    // of a discoverable group see membership count only. For now we gate
    // roster visibility to members-and-up.
    const isMember =
      user.orgRole === 'admin' ||
      group.ownerId === user.id ||
      user.groupIds.includes(groupId);
    if (!isMember) throw new NotFoundException('Group not found');

    return this.prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, email: true },
        },
      },
    });
  }

  async addMember(user: AuthUser, groupId: string, memberId: string, role: GroupRole = 'member') {
    await this.assertAdminOfGroup(user, groupId);
    return this.prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId: memberId } },
      update: { role },
      create: { groupId, userId: memberId, role },
    });
  }

  private canSee(user: AuthUser, group: { orgId: string; access: string; ownerId: string }) {
    if (user.orgRole === 'admin') return true;
    if (group.ownerId === user.id) return true;
    if (group.access === 'public') return true;
    if (group.access === 'org' && group.orgId === user.orgId) return true;
    return false; // Membership check handled at query time for private groups.
  }

  /** Owner or org-admin can edit/delete/restore/purge the group. */
  private canAdmin(user: AuthUser, group: { ownerId: string; orgId: string }) {
    if (group.ownerId === user.id) return true;
    return user.orgRole === 'admin' && group.orgId === user.orgId;
  }

  async removeMember(user: AuthUser, groupId: string, memberId: string) {
    await this.assertAdminOfGroup(user, groupId);
    await this.prisma.groupMember.delete({
      where: { groupId_userId: { groupId, userId: memberId } },
    });
  }

  private async assertAdminOfGroup(user: AuthUser, groupId: string) {
    if (user.orgRole === 'admin') return;
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.id } },
    });
    if (!membership) throw new NotFoundException('Group not found or you are not a member');
    if (membership.role !== 'admin') {
      throw new ForbiddenException('Group admin permission required');
    }
  }
}
