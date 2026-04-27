import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  CAPABILITY_KEYS,
  ROLE_BASELINES,
  effectiveCapabilities,
  isCapabilityKey,
  type CapabilityKey,
} from '../auth/capabilities.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminGuard } from './admin.guard.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

class UpsertOverrideDto {
  @IsString() @MaxLength(80) capability!: string;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

interface CapabilityRow {
  capability: CapabilityKey;
  /** Set the role baseline grants this capability. */
  baseline: boolean;
  /** Effective value the user actually has right now. */
  effective: boolean;
  /** Override row, if present. Null means no deviation from baseline. */
  override: {
    enabled: boolean;
    note: string | null;
    grantedBy: string;
    grantedAt: string;
  } | null;
}

/**
 * Admin surface for managing per-user capability overrides
 * (task #68). Mounted under /admin so AdminGuard already gates
 * everything to admin role, which avoids the chicken-and-egg of
 * "non-admin user grants themselves can_manage_users".
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users/:id/capabilities')
@UseGuards(AdminGuard)
export class AdminCapabilitiesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kc: KeycloakAdminService,
  ) {}

  /**
   * Resolve the local user row for a path :id that's actually a
   * Keycloak sub. We can't lookup by `id` directly because seeded
   * accounts have a local user.id that doesn't equal the Keycloak
   * sub (auth-sync upserts by username and never rewrites the id),
   * so an id-based lookup misses for any pre-existing account.
   * Username is stable across both systems.
   */
  private async resolveLocalUser(keycloakId: string, actorOrgId: string) {
    const kcUser = await this.kc.getUser(keycloakId).catch(() => null);
    if (!kcUser?.username) {
      throw new NotFoundException('User not found.');
    }
    const user = await this.prisma.user.findUnique({
      where: { username: kcUser.username },
      select: { id: true, orgId: true, orgRole: true },
    });
    if (!user || user.orgId !== actorOrgId) {
      throw new NotFoundException('User not found in your organization.');
    }
    return user;
  }

  @Get()
  async list(
    @Param('id') userId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ rows: CapabilityRow[]; effective: CapabilityKey[] }> {
    const user = await this.resolveLocalUser(userId, actor.orgId);
    // Override lookups below all key on the local user.id; rebind
    // for clarity.
    const localId = user.id;

    const overrides = await this.prisma.userCapabilityOverride.findMany({
      where: { userId: localId },
      select: {
        capability: true,
        enabled: true,
        note: true,
        grantedBy: true,
        grantedAt: true,
      },
    });
    const overrideByKey = new Map(
      overrides.map((o) => [o.capability, o] as const),
    );

    const baseline = ROLE_BASELINES[user.orgRole];
    const effective = effectiveCapabilities(user.orgRole, overrides);
    const rows: CapabilityRow[] = CAPABILITY_KEYS.map((cap) => {
      const o = overrideByKey.get(cap);
      return {
        capability: cap,
        baseline: baseline.has(cap),
        effective: effective.has(cap),
        override: o
          ? {
              enabled: o.enabled,
              note: o.note,
              grantedBy: o.grantedBy,
              grantedAt: o.grantedAt.toISOString(),
            }
          : null,
      };
    });

    return { rows, effective: Array.from(effective) };
  }

  @Post()
  async upsert(
    @Param('id') userId: string,
    @Body() body: UpsertOverrideDto,
    @CurrentUser() actor: AuthUser,
  ) {
    if (!isCapabilityKey(body.capability)) {
      throw new BadRequestException(
        `Unknown capability "${body.capability}".`,
      );
    }
    const user = await this.resolveLocalUser(userId, actor.orgId);

    await this.prisma.userCapabilityOverride.upsert({
      where: {
        userId_capability: { userId: user.id, capability: body.capability },
      },
      update: {
        enabled: body.enabled,
        ...(body.note !== undefined ? { note: body.note } : {}),
        grantedBy: actor.id,
        grantedAt: new Date(),
      },
      create: {
        userId: user.id,
        capability: body.capability,
        enabled: body.enabled,
        note: body.note ?? null,
        grantedBy: actor.id,
      },
    });

    return this.list(userId, actor);
  }

  @Delete(':capability')
  async remove(
    @Param('id') userId: string,
    @Param('capability') capability: string,
    @CurrentUser() actor: AuthUser,
  ) {
    if (!isCapabilityKey(capability)) {
      throw new BadRequestException(`Unknown capability "${capability}".`);
    }
    const user = await this.resolveLocalUser(userId, actor.orgId);

    await this.prisma.userCapabilityOverride
      .delete({
        where: {
          userId_capability: { userId: user.id, capability },
        },
      })
      .catch(() => {
        // Already gone is fine; idempotent delete keeps the UI
        // tolerant of a stale list.
      });

    return this.list(userId, actor);
  }
}
