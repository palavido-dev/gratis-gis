// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Optional,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EMBED_ORIGINS_MAX,
  normalizeEmbedOrigins,
} from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminGuard } from './admin.guard.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { assertAlias, assertPublicHttps } from './oidc-url.js';
import { isAdminTierLocked } from './admin-tier-lock.js';
import { readEmbedOrigins, writeEmbedOrigins } from './embed-origins.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateOidcDto {
  @IsString() @MinLength(1) @MaxLength(40) alias!: string;
  @IsString() @MinLength(1) @MaxLength(80) displayName!: string;
  @IsString() @MinLength(1) @MaxLength(200) clientId!: string;
  @IsString() @MinLength(1) @MaxLength(2048) clientSecret!: string;
  @IsString() @MaxLength(2048) authorizationUrl!: string;
  @IsString() @MaxLength(2048) tokenUrl!: string;
  @IsOptional() @IsString() @MaxLength(253) domain?: string;
}

class MfaDto {
  @IsBoolean() required!: boolean;
}

class EmbedOriginsDto {
  @IsArray()
  @ArrayMaxSize(EMBED_ORIGINS_MAX)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  origins!: string[];
}

/**
 * Sign-in methods an admin can add without opening the Keycloak
 * console. One OpenID Connect provider at a time, plus the realm
 * switch that asks every account to set up an authenticator on the
 * next sign-in.
 *
 * Every setting here lives on the shared Keycloak realm, so it
 * affects every organization on the install. Only admins of the
 * operator organization may read or change it.
 */
@ApiTags('admin', 'security')
@ApiBearerAuth()
@UseGuards(AdminGuard, OperatorOrgGuard)
@Controller('admin/security')
export class AdminSecurityController {
  constructor(
    private readonly keycloak: KeycloakAdminService,
    private readonly prisma: PrismaService,
    @Optional() private readonly audit?: AdminAuditService,
  ) {}

  /**
   * Sites the Embed widget may frame on app runtime pages. Kept
   * apart from GET / so a Keycloak outage does not hide it.
   */
  @Get('embed-origins')
  async getEmbedOrigins() {
    return { origins: await readEmbedOrigins(this.prisma) };
  }

  @Put('embed-origins')
  async putEmbedOrigins(
    @CurrentUser() user: AuthUser,
    @Body() dto: EmbedOriginsDto,
  ) {
    assertNotLocked();
    const { origins, invalid } = normalizeEmbedOrigins(dto.origins);
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Not a site address: ${invalid.slice(0, 3).join(', ')}. Use the form https://example.org.`,
      );
    }
    const saved = await writeEmbedOrigins(this.prisma, origins, user.id);
    void this.audit?.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.security',
      targetType: 'embed_origins',
      targetId: user.orgId,
      outcome: 'succeeded',
      detail: { count: saved.length },
    });
    return { origins: saved };
  }

  @Get()
  async get() {
    const [providers, mfaRequired] = await Promise.all([
      this.keycloak.listIdentityProviders(),
      this.keycloak.getMfaRequired(),
    ]);
    return { providers, mfaRequired };
  }

  @Post('oidc')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateOidcDto) {
    assertNotLocked();
    const domain = dto.domain?.trim().toLowerCase() || null;
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new BadRequestException('Enter a domain such as example.org.');
    }
    await this.keycloak.createOidcProvider({
      alias: assertAlias(dto.alias),
      displayName: dto.displayName.trim(),
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret,
      authorizationUrl: await assertPublicHttps(dto.authorizationUrl),
      tokenUrl: await assertPublicHttps(dto.tokenUrl),
      orgSlug: user.orgSlug,
      domain,
    });
    void this.audit?.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.security',
      targetType: 'oidc',
      targetId: assertAlias(dto.alias),
      outcome: 'succeeded',
      detail: { op: 'create' },
    });
    return { ok: true };
  }

  @Delete('oidc/:alias')
  async remove(@CurrentUser() user: AuthUser, @Param('alias') alias: string) {
    assertNotLocked();
    const target = assertAlias(alias);
    await this.keycloak.deleteIdentityProvider(target);
    void this.audit?.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.security',
      targetType: 'oidc',
      targetId: target,
      outcome: 'succeeded',
      detail: { op: 'delete' },
    });
    return { ok: true };
  }

  @Put('mfa')
  async mfa(@CurrentUser() user: AuthUser, @Body() dto: MfaDto) {
    assertNotLocked();
    await this.keycloak.setMfaRequired(dto.required);
    void this.audit?.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'admin.security',
      targetType: 'mfa',
      targetId: user.orgId,
      outcome: 'succeeded',
      detail: { required: dto.required },
    });
    return { mfaRequired: dto.required };
  }
}

/**
 * In public-testing mode the admin login is shared. A sign-in
 * provider added through it could mint accounts that survive a reset
 * of that password, and these settings are realm-wide.
 */
function assertNotLocked(): void {
  if (isAdminTierLocked()) {
    throw new ForbiddenException(
      'This portal is in public-testing mode; sign-in settings cannot be changed.',
    );
  }
}
