import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AdminGuard } from './admin.guard.js';
import {
  KeycloakAdminService,
  type KeycloakUserRep,
} from './keycloak-admin.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Keycloak user enriched with portal-specific fields we track ourselves. */
export type AdminUserRep = KeycloakUserRep & {
  /**
   * ISO timestamp of the last authenticated request we saw from this
   * user, or null if they've never signed in to the portal. Stamped
   * by AuthSyncService on every authenticated request.
   */
  lastSeenAt: string | null;
  /**
   * Optional auto-disable timestamp (#85). When non-null and in
   * the past, the user is rejected at request time and disabled
   * in Keycloak by the housekeeping cron. ISO date string on
   * the wire; null = no auto-disable (default).
   */
  autoDisableAt: string | null;
};

type OrgRole = 'viewer' | 'contributor' | 'admin';

class InviteUserDto {
  @IsString() @MinLength(2) @MaxLength(60) username!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(60) firstName?: string;
  @IsOptional() @IsString() @MaxLength(60) lastName?: string;
  @IsOptional() @IsEnum(['viewer', 'contributor', 'admin']) orgRole?: OrgRole;
  /** Defaults to true: the normal invitation flow. */
  @IsOptional() @IsBoolean() sendSetupEmail?: boolean;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(60) firstName?: string;
  @IsOptional() @IsString() @MaxLength(60) lastName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsEnum(['viewer', 'contributor', 'admin']) orgRole?: OrgRole;
  /**
   * Optional auto-disable timestamp (#85). ISO date string sets,
   * null clears, omit to leave untouched. Refused for org admins
   * to avoid lockout; the controller validates this before the
   * write hits the DB.
   */
  @IsOptional() @IsDateString() autoDisableAt?: string | null;
}

/**
 * Admin-only CRUD endpoints for managing users in the built-in
 * Keycloak realm. All paths are gated by AdminGuard: non-admins
 * get a 403 regardless of whether the resource exists.
 *
 * Responses are the raw Keycloak user representation plus a
 * convenience `fullName`. Frontends should treat `attributes.org_role`
 * as the authoritative role; promoting/demoting is done via
 * PATCH with { orgRole }.
 */
@ApiTags('admin', 'users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('_meta')
  meta(): { configured: boolean } {
    return { configured: this.kc.isConfigured() };
  }

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('first') first?: string,
    @Query('max') max?: string,
  ): Promise<AdminUserRep[]> {
    const opts: { search?: string; first?: number; max?: number } = {};
    if (q) opts.search = q;
    if (first !== undefined) opts.first = Number(first);
    if (max !== undefined) opts.max = Number(max);
    const kcUsers = await this.kc.listUsers(opts);
    // Pull lastSeenAt + autoDisableAt in one query for the
    // usernames we just got back, rather than N+1 per user. We
    // join by USERNAME, not id: seeded users carry a different
    // local user.id than their Keycloak sub (auth-sync upserts
    // by username and never rewrites the id), so a join by id
    // misses every seeded account and renders them as "Never"
    // logged in. Username is stable in both systems.
    const usernames = kcUsers
      .map((u) => u.username)
      .filter((u): u is string => typeof u === 'string');
    const local = usernames.length
      ? await this.prisma.user.findMany({
          where: { username: { in: usernames } },
          select: { username: true, lastSeenAt: true, autoDisableAt: true },
        })
      : [];
    const byUsername = new Map(local.map((u) => [u.username, u]));
    return kcUsers.map((u) => {
      const row = u.username ? byUsername.get(u.username) : undefined;
      return {
        ...u,
        lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
        autoDisableAt: row?.autoDisableAt?.toISOString() ?? null,
      };
    });
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<KeycloakUserRep> {
    return this.kc.getUser(id);
  }

  @Post()
  invite(
    @CurrentUser() me: AuthUser,
    @Body() dto: InviteUserDto,
  ): Promise<KeycloakUserRep> {
    // Orgs are single-tenant per realm in the current model, so new
    // users inherit the inviting admin's org slug. When we go multi-
    // tenant, an explicit org claim moves onto the DTO.
    const input: Parameters<typeof this.kc.createUser>[0] = {
      username: dto.username,
      email: dto.email,
      sendSetupEmail: dto.sendSetupEmail ?? true,
      enabled: true,
      org: me.orgId,
    };
    if (dto.firstName !== undefined) input.firstName = dto.firstName;
    if (dto.lastName !== undefined) input.lastName = dto.lastName;
    if (dto.orgRole !== undefined) input.orgRole = dto.orgRole;
    return this.kc.createUser(input);
  }

  @Patch(':id')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<AdminUserRep> {
    // Drop any undefined optional keys so the service's read-modify-
    // write logic doesn't overwrite existing values with undefined.
    const patch: Parameters<typeof this.kc.updateUser>[1] = {};
    if (dto.firstName !== undefined) patch.firstName = dto.firstName;
    if (dto.lastName !== undefined) patch.lastName = dto.lastName;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.orgRole !== undefined) patch.orgRole = dto.orgRole;

    // autoDisableAt (#85) lives on our local user row, not in
    // Keycloak. Persist it BEFORE the Keycloak update so a
    // failure on the Keycloak side doesn't strand the local
    // change. Org admins are refused to avoid lockout: setting
    // an auto-disable on the only admin would brick the org.
    //
    // We resolve the local row by username, not by `id`. Seeded
    // users carry a different local user.id than their Keycloak
    // sub (auth-sync upserts by username and never rewrites the
    // id), so a path lookup by Keycloak id misses for any user
    // whose local row predated Keycloak. Username is stable in
    // both systems.
    if (dto.autoDisableAt !== undefined) {
      const kcUser = await this.kc.getUser(id);
      if (!kcUser?.username) throw new NotFoundException('User not found');
      const localUser = await this.prisma.user.findUnique({
        where: { username: kcUser.username },
        select: { id: true, orgRole: true, orgId: true },
      });
      const targetRole = dto.orgRole ?? localUser?.orgRole;
      if (dto.autoDisableAt !== null && targetRole === 'admin') {
        throw new BadRequestException(
          'Auto-disable cannot be set on an org admin. Demote the user first.',
        );
      }
      const nextAutoDisable =
        dto.autoDisableAt === null ? null : new Date(dto.autoDisableAt);
      if (localUser) {
        if (localUser.orgId !== me.orgId) {
          throw new ForbiddenException('User is not in your organization');
        }
        await this.prisma.user.update({
          where: { id: localUser.id },
          data: { autoDisableAt: nextAutoDisable },
        });
      } else {
        // Genuinely no local row (user has never signed in).
        // Bootstrap one so the auto-disable timer is persisted;
        // auth-sync will pick this row up on first login because
        // it keys on username.
        const fullName =
          [kcUser.firstName, kcUser.lastName]
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join(' ') || kcUser.username;
        await this.prisma.user.create({
          data: {
            id,
            orgId: me.orgId,
            username: kcUser.username,
            email: kcUser.email ?? '',
            fullName,
            orgRole: dto.orgRole ?? 'viewer',
            autoDisableAt: nextAutoDisable,
          },
        });
      }
    }
    const kcUserAfter = await this.kc.updateUser(id, patch);
    // Enrich with the local-only fields so the FE row update gets a
    // complete AdminUserRep (matches what /admin/users list returns).
    // Without this, the dialog's spread merge keeps the stale
    // autoDisableAt from before the save and the picker re-opens
    // empty even though the DB has the new value.
    const username = kcUserAfter.username ?? '';
    const local = username
      ? await this.prisma.user.findUnique({
          where: { username },
          select: { lastSeenAt: true, autoDisableAt: true },
        })
      : null;
    return {
      ...kcUserAfter,
      lastSeenAt: local?.lastSeenAt?.toISOString() ?? null,
      autoDisableAt: local?.autoDisableAt?.toISOString() ?? null,
    };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.kc.deleteUser(id);
  }

  /**
   * Trigger Keycloak's "required actions" email flow. Default set
   * resets the password and asks the user to verify their email.
   */
  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(@Param('id') id: string): Promise<void> {
    await this.kc.sendExecuteActionsEmail(id, [
      'UPDATE_PASSWORD',
      'VERIFY_EMAIL',
    ]);
  }

  /**
   * Per-user access dump for admins (#89). Returns every item the
   * target user can see, categorised by HOW they see it (owner /
   * direct share / via group / org-wide / public), plus their
   * group memberships. Used by the "View access" dialog on
   * /admin/users for both routine audit and the troubleshooting
   * case where someone says "I can't see X" -- the admin can
   * confirm in one place.
   *
   * Org isolation: the calling admin is restricted to their own
   * org. We refuse the request when the target user's orgId
   * doesn't match the caller's, so an admin in org A can't probe
   * a user in org B even by guessing UUIDs.
   *
   * Truncation: each list is capped at MAX_ROWS rows. The flags
   * on `truncated` let the UI hint "more rows hidden". Power
   * users with thousands of shares would otherwise blow the
   * dialog past the point of usability.
   */
  @Get(':id/access')
  async access(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
  ): Promise<UserAccessResponse> {
    const MAX_ROWS = 200;
    // Resolve the local user via Keycloak username, not the path
    // :id. Seeded accounts have a local user.id that doesn't equal
    // the Keycloak sub (auth-sync upserts by username and never
    // rewrites the id), so an id-based lookup misses for any user
    // who existed before they first signed in. Username is the
    // stable join key.
    const kcUser = await this.kc.getUser(id).catch(() => null);
    if (!kcUser?.username) throw new NotFoundException('User not found');
    const target = await this.prisma.user.findUnique({
      where: { username: kcUser.username },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        orgId: true,
        orgRole: true,
      },
    });
    if (!target) {
      // Genuinely never signed in -- Keycloak has the user but no
      // local row exists. Return a friendly empty bundle so the UI
      // can render "no portal activity yet" instead of a 404.
      const fullName =
        [kcUser.firstName, kcUser.lastName]
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .join(' ') || null;
      return {
        user: {
          id,
          username: kcUser.username,
          fullName,
          email: kcUser.email ?? '',
          orgRole: 'viewer',
        },
        owned: [],
        directShared: [],
        groupShared: [],
        orgAccessibleCount: 0,
        publicAccessibleCount: 0,
        groups: [],
        truncated: { owned: false, directShared: false, groupShared: false },
        maxRows: MAX_ROWS,
        neverSignedIn: true,
      };
    }
    if (target.orgId !== me.orgId) {
      throw new ForbiddenException('User is not in your organization');
    }

    // Resolve group memberships once: we need them both for the
    // "groups this user is in" tab AND to look up which items they
    // can see via group shares. Excludes soft-deleted groups: they
    // don't grant access in auth-sync either.
    // Group's display field is `title` in the schema; the UI
    // calls it "name" for clarity, so we map at the response edge.
    const memberships = await this.prisma.groupMember.findMany({
      where: { userId: target.id, group: { deletedAt: null } },
      select: {
        role: true,
        group: {
          select: {
            id: true,
            title: true,
            description: true,
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { group: { title: 'asc' } },
    });
    const groupIds = memberships.map((m) => m.group.id);

    // Run the four item queries in parallel. Each is bounded at
    // MAX_ROWS + 1 so we can detect truncation cheaply.
    const itemSelect = {
      id: true,
      title: true,
      type: true,
      access: true,
      updatedAt: true,
    } as const;
    const [owned, directShared, groupShared, orgCount, publicCount] =
      await Promise.all([
        this.prisma.item.findMany({
          where: {
            ownerId: target.id,
            orgId: target.orgId,
            deletedAt: null,
          },
          select: itemSelect,
          orderBy: { updatedAt: 'desc' },
          take: MAX_ROWS + 1,
        }),
        this.prisma.itemShare.findMany({
          where: {
            principalType: 'user',
            principalId: target.id,
            item: { orgId: target.orgId, deletedAt: null },
          },
          select: {
            permission: true,
            expiresAt: true,
            item: { select: itemSelect },
          },
          orderBy: { item: { updatedAt: 'desc' } },
          take: MAX_ROWS + 1,
        }),
        groupIds.length === 0
          ? Promise.resolve([])
          : this.prisma.itemShare.findMany({
              where: {
                principalType: 'group',
                principalId: { in: groupIds },
                item: { orgId: target.orgId, deletedAt: null },
              },
              select: {
                permission: true,
                expiresAt: true,
                principalId: true,
                item: { select: itemSelect },
              },
              orderBy: { item: { updatedAt: 'desc' } },
              take: MAX_ROWS + 1,
            }),
        // Org-wide / public counts: just numbers. Enumerating them
        // would dwarf the response and the admin can't revoke them
        // per-user anyway (item-level setting).
        this.prisma.item.count({
          where: { access: 'org', orgId: target.orgId, deletedAt: null },
        }),
        this.prisma.item.count({
          where: { access: 'public', deletedAt: null },
        }),
      ]);

    // Merge group shares by item: a single item can be shared to
    // multiple groups the user belongs to. Collapse to one row per
    // item with the via-groups list so the UI doesn't show duplicate
    // rows.
    const groupNameById = new Map(
      memberships.map((m) => [m.group.id, m.group.title]),
    );
    const groupSharedByItem = new Map<
      string,
      {
        item: typeof groupShared[number]['item'];
        permission: string;
        expiresAt: Date | null;
        viaGroups: Array<{ id: string; name: string }>;
      }
    >();
    for (const row of groupShared) {
      const existing = groupSharedByItem.get(row.item.id);
      const groupName = groupNameById.get(row.principalId) ?? row.principalId;
      if (existing) {
        existing.viaGroups.push({ id: row.principalId, name: groupName });
        // Promote permission to the highest of the group shares so
        // the UI label reflects what the user can actually do; we
        // mirror the SharePermission ordering used elsewhere
        // (view < download < edit < admin).
        if (
          permissionRank(row.permission) > permissionRank(existing.permission)
        ) {
          existing.permission = row.permission;
        }
        if (
          existing.expiresAt &&
          (!row.expiresAt || row.expiresAt > existing.expiresAt)
        ) {
          existing.expiresAt = row.expiresAt;
        }
      } else {
        groupSharedByItem.set(row.item.id, {
          item: row.item,
          permission: row.permission,
          expiresAt: row.expiresAt,
          viaGroups: [{ id: row.principalId, name: groupName }],
        });
      }
    }

    // Per-item de-duplication: an item should only appear once,
    // under its strongest access path. Order: owner > direct share
    // > group share. A user who owns an item gains nothing from a
    // group share or a direct share to themselves -- showing those
    // redundant rows just clutters the dialog and confuses the
    // "what does revoking this share/group do?" mental model.
    const ownedIds = new Set(owned.map((i) => i.id));
    const directIds = new Set(directShared.map((s) => s.item.id));
    const filteredDirectShared = directShared.filter(
      (s) => !ownedIds.has(s.item.id),
    );
    const filteredGroupShared = Array.from(groupSharedByItem.values()).filter(
      (g) => !ownedIds.has(g.item.id) && !directIds.has(g.item.id),
    );

    return {
      user: {
        id: target.id,
        username: target.username,
        fullName: target.fullName ?? null,
        email: target.email,
        orgRole: target.orgRole,
      },
      owned: owned.slice(0, MAX_ROWS).map((i) => ({
        id: i.id,
        title: i.title,
        type: i.type,
        access: i.access,
        updatedAt: i.updatedAt.toISOString(),
      })),
      directShared: filteredDirectShared.slice(0, MAX_ROWS).map((s) => ({
        id: s.item.id,
        title: s.item.title,
        type: s.item.type,
        access: s.item.access,
        updatedAt: s.item.updatedAt.toISOString(),
        permission: s.permission,
        expiresAt: s.expiresAt?.toISOString() ?? null,
      })),
      groupShared: filteredGroupShared.slice(0, MAX_ROWS).map((g) => ({
        id: g.item.id,
        title: g.item.title,
        type: g.item.type,
        access: g.item.access,
        updatedAt: g.item.updatedAt.toISOString(),
        permission: g.permission,
        expiresAt: g.expiresAt?.toISOString() ?? null,
        viaGroups: g.viaGroups,
      })),
      orgAccessibleCount: orgCount,
      publicAccessibleCount: publicCount,
      groups: memberships.map((m) => ({
        id: m.group.id,
        name: m.group.title,
        description: m.group.description ?? null,
        memberRole: m.role,
        memberCount: m.group._count.members,
      })),
      truncated: {
        owned: owned.length > MAX_ROWS,
        directShared: filteredDirectShared.length > MAX_ROWS,
        groupShared: filteredGroupShared.length > MAX_ROWS,
      },
      maxRows: MAX_ROWS,
      neverSignedIn: false,
    };
  }
}

/**
 * Permission ordering for picking the "highest" permission across
 * multiple group shares of the same item. Mirrors the
 * SharePermission ladder used everywhere else in the codebase.
 */
function permissionRank(p: string): number {
  switch (p) {
    case 'view':
      return 1;
    case 'download':
      return 2;
    case 'edit':
      return 3;
    case 'admin':
      return 4;
    default:
      return 0;
  }
}

/**
 * Wire shape for GET /admin/users/:id/access. Kept colocated with
 * the controller so the frontend can import it from the BFF.
 */
export interface UserAccessResponse {
  user: {
    id: string;
    username: string;
    fullName: string | null;
    email: string;
    orgRole: 'viewer' | 'contributor' | 'admin';
  };
  /** Items this user owns. Cannot be revoked here: use reassign. */
  owned: Array<UserAccessItemRow>;
  /** Items shared directly to this user. Bulk-revocable. */
  directShared: Array<UserAccessItemRow & {
    permission: string;
    expiresAt: string | null;
  }>;
  /** Items the user can see because of group membership. The
   *  "via" list names every group that grants access; the UI
   *  routes the admin to the Groups tab to act on it. */
  groupShared: Array<UserAccessItemRow & {
    permission: string;
    expiresAt: string | null;
    viaGroups: Array<{ id: string; name: string }>;
  }>;
  /** How many additional items the user sees via access='org'.
   *  Not enumerated to keep the response small; admin can't
   *  revoke per-user anyway. */
  orgAccessibleCount: number;
  /** How many items the user sees because they're access='public'. */
  publicAccessibleCount: number;
  /** Group memberships. Bulk-revocable from the Groups tab. */
  groups: Array<{
    id: string;
    name: string;
    description: string | null;
    memberRole: string;
    memberCount: number;
  }>;
  truncated: {
    owned: boolean;
    directShared: boolean;
    groupShared: boolean;
  };
  /** Cap value the controller used; renders as "showing the most
   *  recent N" copy on the UI. */
  maxRows: number;
  /** True when the target user is in Keycloak but has never signed
   *  in to the portal. All lists are empty in this case; the UI
   *  should explain "no portal activity yet" rather than treating
   *  the empty result as ordinary. */
  neverSignedIn: boolean;
}

interface UserAccessItemRow {
  id: string;
  title: string;
  type: string;
  access: string;
  updatedAt: string;
}
