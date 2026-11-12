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
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminGuard } from './admin.guard.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { assertAlias, assertPublicHttps } from './oidc-url.js';
import { isAdminTierLocked } from './admin-tier-lock.js';

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
    @Optional() private readonly audit?: AdminAuditService,
  ) {}

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
