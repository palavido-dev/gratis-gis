// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';
import { assertAlias, assertPublicHttps } from './oidc-url.js';

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
 * Sign-in methods an org admin can add without opening the
 * Keycloak console. One OpenID Connect provider at a time, plus
 * the realm switch that asks every account to set up an
 * authenticator on the next sign-in.
 */
@ApiTags('admin', 'security')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/security')
export class AdminSecurityController {
  constructor(private readonly keycloak: KeycloakAdminService) {}

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
    const domain = dto.domain?.trim().toLowerCase() || null;
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new BadRequestException('Enter a domain such as example.org.');
    }
    await this.keycloak.createOidcProvider({
      alias: assertAlias(dto.alias),
      displayName: dto.displayName.trim(),
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret,
      authorizationUrl: assertPublicHttps(dto.authorizationUrl),
      tokenUrl: assertPublicHttps(dto.tokenUrl),
      orgSlug: user.orgSlug,
      domain,
    });
    return { ok: true };
  }

  @Delete('oidc/:alias')
  async remove(@Param('alias') alias: string) {
    await this.keycloak.deleteIdentityProvider(assertAlias(alias));
    return { ok: true };
  }

  @Put('mfa')
  async mfa(@Body() dto: MfaDto) {
    await this.keycloak.setMfaRequired(dto.required);
    return { mfaRequired: dto.required };
  }
}
