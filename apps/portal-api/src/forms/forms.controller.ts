import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { FormsService } from './forms.service.js';

class SubmitDto {
  @IsString() @Length(8, 100) clientId!: string;
  @IsInt() @Min(1) schemaVersion!: number;
  @IsObject() response!: Record<string, unknown>;
  @IsString() capturedAt!: string;
}

@ApiTags('forms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  /**
   * Submit a response. Idempotent on (formId, clientId) so a re-
   * drained offline queue is a no-op. Returns 200 + { id, created }
   * either way -- callers don't need to distinguish first-write from
   * re-drain.
   */
  @Post(':id/submissions')
  @HttpCode(200)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SubmitDto,
  ): Promise<{ id: string; created: boolean }> {
    return this.forms.submit(id, user, dto);
  }

  @Get(':id/submissions')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw === undefined ? undefined : Math.max(1, Number(limitRaw));
    const opts: { limit?: number } = {};
    if (limit !== undefined) opts.limit = limit;
    return this.forms.list(id, user, opts);
  }

  @Get(':id/submissions/_count')
  async count(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ count: number }> {
    return { count: await this.forms.count(id, user) };
  }
}
