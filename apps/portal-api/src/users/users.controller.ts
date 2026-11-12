// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Optional,
  Patch,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

/** How long /users/me reuses a user's Keycloak names. */
const KC_NAME_CACHE_MS = 5 * 60_000;
const KC_NAME_CACHE_MAX = 10_000;
const KC_NAME_TIMEOUT_MS = 3_000;

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
    @Optional() private readonly cfg?: ConfigService,
  ) {}

  /**
   * Keycloak first and last names by user id, for a few minutes. The
   * app shell and most pages call /users/me on every load, and each
   * call used to wait on a Keycloak admin request only the profile
   * form needs. PATCH /users/me drops the user's entry.
   */
  private readonly kcNames = new Map<
    string,
    { firstName?: string; lastName?: string; at: number }
  >();

  private async keycloakNames(
    userId: string,
  ): Promise<{ firstName?: string; lastName?: string } | null> {
    const hit = this.kcNames.get(userId);
    if (hit && Date.now() - hit.at < KC_NAME_CACHE_MS) return hit;
    try {
      // A short timeout: a stalled Keycloak must not hold every page.
      const kcUser = await this.kc.getUser(userId, { timeoutMs: KC_NAME_TIMEOUT_MS });
      if (this.kcNames.size >= KC_NAME_CACHE_MAX) this.kcNames.clear();
      const entry = {
        ...(kcUser.firstName !== undefined ? { firstName: kcUser.firstName } : {}),
        ...(kcUser.lastName !== undefined ? { lastName: kcUser.lastName } : {}),
        at: Date.now(),
      };
      this.kcNames.set(userId, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Only the portal's own avatar uploads may be stored. The value is
   * rendered as an <img src> for other users and anonymous visitors,
   * so any other URL lets a user log who views their name.
   */
  private assertOwnAvatarUrl(url: string): void {
    const get = (k: string, d: string) => this.cfg?.get<string>(k) ?? process.env[k] ?? d;
    const endpoint = get('MINIO_ENDPOINT', 'http://localhost:9000');
    const base = get('MINIO_PUBLIC_BASE', endpoint).replace(/\/$/, '');
    const prefix = `${base}/${get('MINIO_BUCKET', 'gratisgis')}/user-avatar/`;
    const rest = url.startsWith(prefix) ? url.slice(prefix.length) : null;
    if (rest === null || !/^[0-9a-f-]{36}[A-Za-z0-9._-]*$/i.test(rest)) {
      throw new BadRequestException(
        'avatarUrl must be an image uploaded to this portal.',
      );
    }
  }

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
      // Non-fatal: read-only display continues to work without it.
      const names = await this.keycloakNames(user.id);
      firstName = names?.firstName;
      lastName = names?.lastName;
    }
    return {
      ...user,
      // AuthUser.capabilities is a ReadonlySet, which JSON.stringify
      // turns into `{}`. The web app mirrors server gates such as
      // `can_publish_items` off this response, so emit the set as a
      // sorted array (sorted so the payload is stable across requests
      // and diffs cleanly in tests).
      capabilities: [...user.capabilities].sort(),
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
      // The ids branch is used to resolve names for already-known
      // principal ids (e.g. the access matrix on a saved web map).
      // We deliberately INCLUDE soft-deleted users here so the UI
      // can still render their display name as "Removed user (was
      // matt)" rather than showing a raw UUID. The caller can branch
      // on `deletedAt !== null` if it wants to style the row.
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
          deletedAt: true,
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
        // When the row has been soft-deleted by KeycloakSyncService
        // (the user is gone from the realm), show a sentinel display
        // name so a stale share row doesn't render the now-removed
        // user's real name as if they were still active. The UI can
        // also key on `deletedAt !== null` to style the row.
        fullName: r.deletedAt !== null
          ? `Removed user (was ${r.username})`
          : r.fullName,
        avatarUrl: r.deletedAt !== null ? null : r.avatarUrl,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        groupIds: r.groupMembers.map((m: { groupId: string }) => m.groupId),
      }));
    }

    // Search branch (the principal picker on share / reassign / etc.).
    // Soft-deleted users are excluded here so the picker only offers
    // currently-active users; the ids branch above keeps showing them
    // for display-name resolution on existing share rows.
    const trimmed = (q ?? '').trim();
    const where: {
      orgId: string;
      deletedAt: null;
      OR?: Array<Record<string, unknown>>;
    } = { orgId: user.orgId, deletedAt: null };
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
    if (typeof dto.avatarUrl === 'string') this.assertOwnAvatarUrl(dto.avatarUrl);
    if (dto.firstName !== undefined) identityPatch.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) identityPatch.lastName = dto.lastName.trim();
    if (dto.email !== undefined) identityPatch.email = dto.email.trim();

    // Push identity-owning fields to Keycloak first so we don't end up
    // with the local row ahead of the IdP (which would look fine until
    // the next JWT refresh overwrote it). If Keycloak rejects, the
    // client gets the error and nothing local has changed yet.
    if (Object.keys(identityPatch).length > 0) {
      // An API key must not be able to change the account's email:
      // with "Forgot password" on the new address, a leaked key would
      // become the whole account. Same rule as minting keys.
      if (user.authKind === 'api_key') {
        throw new ForbiddenException(
          'Name and email can only be changed from a signed-in session, not with an API key.',
        );
      }
      if (!this.kc.isConfigured()) {
        // Surface a 503 instead of silently no-op'ing so the user
        // knows why their edit didn't stick.
        throw new ServiceUnavailableException(
          'Keycloak admin API is not configured: identity edits are disabled',
        );
      }
      await this.kc.updateUser(user.id, identityPatch);
      this.kcNames.delete(user.id);
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
