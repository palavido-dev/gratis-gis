// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AiDraftService } from './ai-draft.service.js';

class DraftAiDto {
  @IsUUID('loose') itemId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) instruction!: string;
}

/**
 * Signed-in draft assist. Sharing is enforced inside the service
 * via ItemsService.get, which 404s when the caller cannot read
 * the item. Nothing here writes an item.
 */
@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly drafts: AiDraftService) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.drafts.status(user);
  }

  @Post('draft')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  draft(@CurrentUser() user: AuthUser, @Body() dto: DraftAiDto) {
    return this.drafts.draft(user, dto.itemId, dto.instruction);
  }
}
