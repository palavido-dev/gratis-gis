// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AiConfigService, type SaveAiConfigInput } from './ai-config.service.js';
import { AI_PROVIDER_IDS, type AiProviderId } from './providers.js';

class SaveAiProviderDto {
  @IsIn(AI_PROVIDER_IDS) provider!: AiProviderId;
  @IsString() @MinLength(1) @MaxLength(200) model!: string;
  /** Required for openai-compatible. Rejected for the others. */
  @IsOptional() @IsString() @MaxLength(2048) baseUrl?: string;
  /**
   * Omit, or send empty, to keep the stored key. Required the
   * first time a provider is saved. Never echoed back.
   */
  @IsOptional() @IsString() @MaxLength(4096) apiKey?: string;
}

/**
 * Org-admin provider settings. AdminGuard also refuses API keys,
 * same as the rest of /admin/*. The response never includes the
 * raw key.
 */
@ApiTags('admin', 'ai')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/ai')
export class AiAdminController {
  constructor(private readonly config: AiConfigService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.config.getPublic(user.orgId);
  }

  @Put()
  save(@CurrentUser() user: AuthUser, @Body() dto: SaveAiProviderDto) {
    const input: SaveAiConfigInput = {
      provider: dto.provider,
      model: dto.model,
    };
    if (dto.baseUrl !== undefined) input.baseUrl = dto.baseUrl;
    if (dto.apiKey !== undefined) input.apiKey = dto.apiKey;
    return this.config.save(user.orgId, user.id, input);
  }

  @Delete()
  clear(@CurrentUser() user: AuthUser) {
    return this.config.clear(user.orgId);
  }
}
