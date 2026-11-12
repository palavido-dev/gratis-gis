// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { FormsService } from './forms.service.js';

class SubmitDto {
  @IsString() @Length(8, 100) clientId!: string;
  @IsInt() @Min(1) schemaVersion!: number;
  @IsObject() response!: Record<string, unknown>;
  @IsString() capturedAt!: string;
  /** Respondent's minutes east of UTC at capture, for today(). */
  @IsOptional() @IsInt() @Min(-840) @Max(840) utcOffsetMinutes?: number;
}

@ApiTags('forms')
@ApiBearerAuth()
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
    @Query('before') before?: string,
  ) {
    const opts: { limit?: number; before?: string } = {};
    if (limitRaw !== undefined) {
      // A non-number or a fraction used to reach Prisma as `take: NaN`
      // and come back as a 500.
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new BadRequestException('limit must be a whole number of 1 or more.');
      }
      opts.limit = limit;
    }
    // Id of the last row of the previous page. Without it only the
    // newest 500 submissions could ever be listed.
    if (before !== undefined) opts.before = before;
    return this.forms.list(id, user, opts);
  }

  @Get(':id/submissions/:submissionId/pdf')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('submissionId') submissionId: string,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.forms.submissionPdf(id, submissionId, user);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', String(pdf.bytes.length));
    res.setHeader(
      'content-disposition',
      `attachment; filename="${pdf.filename}"`,
    );
    res.end(pdf.bytes);
  }

  @Get(':id/submissions/_count')
  async count(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ count: number }> {
    return { count: await this.forms.count(id, user) };
  }
}
