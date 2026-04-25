import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KeycloakAdminService } from '../admin/keycloak-admin.service.js';

class UpdateMeDto {
  // Null clears a previously-set avatar back to the initial badge.
  @IsOptional() @IsString() @MaxLength(2048)
  avatarUrl?: string | null;

  // Identity-adjacent fields that need to go back to Keycloak. All
  // optional: the PATCH is a sparse update, absent keys are left
  // untouched. Username is intentionally NOT editable here; it's the
  // stable handle other tables key on.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  firstName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  lastName?: string;
  @IsOptional() @IsEmail() @MaxLength(200)
  email?: string;
}

/**
 * The /users/me endpoint is the single source of truth the web layer
 * reads for "who am I". Lower-traffic fields (avatar, org display name)
 * live here rather than in every JWT decode so the auth-sync layer stays
 * narrow. PATCH lets a user swap their avatar; Keycloak remains the
 * authority for anything identity-critical like username or email.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kc: KeycloakAdminService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const [row, org] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { avatarUrl: true, fullName: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { name: true, slug: true },
      }),
    ]);
    // Pull firstName/lastName from Keycloak so the /profile form can
    // prepopulate edit inputs. We tolerate Keycloak unreachability
    // here: if the admin API isn't configured the profile page still
    // renders, it just falls back to the split-on-space heuristic.
    let firstName: string | undefined;
    let lastName: string | undefined;
    if (this.kc.isConfigured()) {
      try {
        const kcUser = await this.kc.getUser(user.id);
        firstName = kcUser.firstName;
        lastName = kcUser.lastName;
      } catch {
        /* non-fatal: read-only display continues to work */
      }
    }
    return {
      ...user,
      fullName: row?.fullName ?? user.username,
      firstName: firstName ?? splitName(row?.fullName ?? '').first,
      lastName: lastName ?? splitName(row?.fullName ?? '').last,
      avatarUrl: row?.avatarUrl ?? null,
      orgName: org?.name ?? null,
      orgSlug: org?.slug ?? null,
    };
  }

  /**
   * Org-scoped directory used by the sharing picker. Returns a lean
   * shape (no email, no createdAt) because this endpoint is called
   * from the client on every keystroke and we don't want to leak
   * contact details through a search surface.
   *
   * Search is case-insensitive across username and fullName. Limits to
   * 50 results so a cold query on a big org doesn't blow a payload.
   *
   * `ids` accepts a comma-separated list of user ids and returns
   * exactly those users (still org-scoped for safety). This is the
   * path the webmap access matrix uses to resolve names for
   * arbitrary principal ids without running a wide-open search.
   * When `ids` is set it takes precedence over `q`; the result
   * carries `groupIds` so the client can evaluate transitive
   * group-based access without a second round-trip.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('ids') ids?: string,
  ) {
    const idList = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (idList.length > 0) {
      const rows = await this.prisma.user.findMany({
        where: {
          orgId: user.orgId,
          id: { in: idList },
        },
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          groupMembers: {
            where: { group: { deletedAt: null } },
            select: { groupId: true },
          },
        },
        take: Math.min(idList.length, 200),
      });
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.fullName,
        avatarUrl: r.avatarUrl,
        groupIds: r.groupMembers.map((m: { groupId: string }) => m.groupId),
      }));
    }

    const trimmed = (q ?? '').trim();
    const where: {
      orgId: string;
      OR?: Array<Record<string, unknown>>;
    } = { orgId: user.orgId };
    if (trimmed.length > 0) {
      where.OR = [
        { username: { contains: trimmed, mode: 'insensitive' } },
        { fullName: { contains: trimmed, mode: 'insensitive' } },
      ];
    }
    return this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
      },
      orderBy: { fullName: 'asc' },
      take: 50,
    });
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMeDto,
  ) {
    const identityPatch: {
      firstName?: string;
      lastName?: string;
      email?: string;
    } = {};
    if (dto.firstName !== undefined) identityPatch.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) identityPatch.lastName = dto.lastName.trim();
    if (dto.email !== undefined) identityPatch.email = dto.email.trim();

    // Push identity-owning fields to Keycloak first so we don't end up
    // with the local row ahead of the IdP (which would look fine until
    // the next JWT refresh overwrote it). If Keycloak rejects, the
    // client gets the error and nothing local has changed yet.
    if (Object.keys(identityPatch).length > 0) {
      if (!this.kc.isConfigured()) {
        // Surface a 503 instead of silently no-op'ing so the user
        // knows why their edit didn't stick.
        throw new Error(
          'Keycloak admin API is not configured: identity edits are disabled',
        );
      }
      await this.kc.updateUser(user.id, identityPatch);
    }

    // Mirror the new identity fields into the local row so downstream
    // readers (items, sharing lookups, /users list) see them without
    // waiting for the next auth-sync upsert.
    const localPatch: Record<string, unknown> = {};
    if (dto.avatarUrl !== undefined) localPatch.avatarUrl = dto.avatarUrl;
    if (identityPatch.firstName !== undefined || identityPatch.lastName !== undefined) {
      // Rebuild fullName from the fresh Keycloak values.
      const kcUser = await this.kc.getUser(user.id);
      const parts = [kcUser.firstName, kcUser.lastName].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
      localPatch.fullName = parts.join(' ') || user.username;
    }
    if (identityPatch.email !== undefined) localPatch.email = identityPatch.email;

    if (Object.keys(localPatch).length > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: localPatch,
      });
    }

    return this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        avatarUrl: true,
      },
    });
  }
}

/**
 * Best-effort split of "First Last" into { first, last } so the profile
 * form can prepopulate when Keycloak isn't reachable. Multi-word last
 * names fall into `last`. Single-word names land in `first` with an
 * empty `last`.
 */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}
