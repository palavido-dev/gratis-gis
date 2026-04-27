import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
    // Pull lastSeenAt in one query for the ids we just got back
    // rather than N+1 per user. Users who have never hit the API
    // are absent from the map and render as null on the client.
    const ids = kcUsers
      .map((u) => u.id)
      .filter((id): id is string => typeof id === 'string');
    const local = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, lastSeenAt: true, autoDisableAt: true },
        })
      : [];
    const byId = new Map(local.map((u) => [u.id, u]));
    return kcUsers.map((u) => {
      const row = u.id ? byId.get(u.id) : undefined;
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
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<KeycloakUserRep> {
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
    if (dto.autoDisableAt !== undefined) {
      const localUser = await this.prisma.user.findUnique({
        where: { id },
        select: { orgRole: true },
      });
      const targetRole = dto.orgRole ?? localUser?.orgRole;
      if (dto.autoDisableAt !== null && targetRole === 'admin') {
        throw new BadRequestException(
          'Auto-disable cannot be set on an org admin. Demote the user first.',
        );
      }
      await this.prisma.user.update({
        where: { id },
        data: {
          autoDisableAt:
            dto.autoDisableAt === null ? null : new Date(dto.autoDisableAt),
        },
      });
    }
    return this.kc.updateUser(id, patch);
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
}
