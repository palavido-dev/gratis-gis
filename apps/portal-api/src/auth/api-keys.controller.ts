// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CurrentUser } from './current-user.decorator.js';
import type { AuthUser } from './auth-sync.service.js';
import { ApiKeyService } from './api-key.service.js';

class CreateApiKeyDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsBoolean() readOnly?: boolean;
  /** Null / absent means "until revoked". Capped at ~2 years. */
  @IsOptional() @IsInt() @Min(1) @Max(730) expiresInDays?: number | null;
}

/**
 * Personal API key management (#219).
 *
 * Scoped to the calling user throughout: there is no admin surface
 * for listing or minting someone else's keys, because a key is a
 * credential rather than a permission. An admin who needs to cut off
 * a user disables the account, which invalidates every key that user
 * holds on the next request.
 *
 * Deliberately NOT reachable with an API key: minting credentials
 * from a credential is an escalation path (a leaked read-only key
 * could mint a read-write one). Enforced here rather than in the
 * guard because this is the only route where it applies.
 */
@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('users/me/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    assertInteractive(user);
    return this.apiKeys.list(user.id);
  }

  /**
   * Tighter throttle than the global default: minting is rare for a
   * human and a burst is either a bug or an attack.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiKeyDto) {
    assertInteractive(user);
    return this.apiKeys.create(user, {
      name: dto.name,
      ...(dto.readOnly !== undefined ? { readOnly: dto.readOnly } : {}),
      ...(dto.expiresInDays !== undefined
        ? { expiresInDays: dto.expiresInDays }
        : {}),
    });
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertInteractive(user);
    return this.apiKeys.revoke(user.id, id);
  }
}

function assertInteractive(user: AuthUser): void {
  if (user.authKind === 'api_key') {
    throw new ForbiddenException(
      'API keys cannot manage API keys. Sign in to the portal to create or revoke a key.',
    );
  }
}
