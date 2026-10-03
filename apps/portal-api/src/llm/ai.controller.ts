// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AiBuildService } from './ai-build.service.js';
import { AiDraftService } from './ai-draft.service.js';
import { AiFeaturesService } from './ai-features.service.js';

class DraftAiDto {
  @IsUUID('loose') itemId!: string;
  @IsString() @MinLength(1) @MaxLength(2000) instruction!: string;
}

class BuildAiDto {
  @IsString() @MinLength(1) @MaxLength(4000) instruction!: string;
}

class AskFeaturesDto {
  @IsUUID('loose') itemId!: string;
  @IsString() @MinLength(1) @MaxLength(500) question!: string;
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
  layerId?: string;
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
  constructor(
    private readonly drafts: AiDraftService,
    private readonly builds: AiBuildService,
    private readonly features: AiFeaturesService,
  ) {}

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

  /**
   * Turn a description into layers, a styled map, a form, and a
   * viewer app. Creates real items. The caller must be allowed
   * to publish, and the model may only reuse layers the caller
   * can already read.
   */
  @Post('build')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  build(@CurrentUser() user: AuthUser, @Body() dto: BuildAiDto) {
    return this.builds.build(user, dto.instruction);
  }

  /**
   * Answer a question from attribute text the caller can already
   * read. Geometries stay on the server. Returned ids are a
   * subset of the sample that was sent.
   */
  @Post('features')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  featuresAsk(@CurrentUser() user: AuthUser, @Body() dto: AskFeaturesDto) {
    return this.features.ask(user, dto.itemId, dto.question, dto.layerId);
  }
}
