// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import type { Response } from 'express';
import { MAX_REPORT_BODY, MAX_REPORT_FEATURES } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { contentDisposition } from '../common/content-disposition.js';
import { ItemsService } from '../items/items.service.js';

import { readReportTemplate, reportFileName, ReportsService } from './reports.service.js';

class RenderReportDto {
  @IsArray()
  @ArrayMaxSize(MAX_REPORT_FEATURES)
  @IsUUID('all', { each: true })
  featureIds!: string[];
}

class PreviewReportDto {
  @IsUUID()
  sourceItemId!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_.-]+$/)
  layerKey!: string;

  @IsString()
  @MaxLength(MAX_REPORT_BODY)
  body!: string;

  @IsOptional()
  @IsUUID()
  featureId?: string;
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly items: ItemsService,
  ) {}

  /** A report template filled for the given features, as a PDF. */
  @Post('items/:id/report')
  // Each render holds a Chromium session.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async render(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RenderReportDto,
    @Res() res: Response,
  ): Promise<void> {
    const item = await this.items.get(user, id);
    if (item.type !== 'report_template') throw new BadRequestException('Not a report template');
    const tpl = readReportTemplate(item.data);
    if (dto.featureIds.length === 0) throw new BadRequestException('Pick at least one feature');
    const filled = await this.reports.fill(user, tpl.sources[0]!, tpl.body, {
      featureIds: dto.featureIds,
    });
    if (filled.features.length === 0)
      throw new BadRequestException('None of the selected features could be read.');
    const pdf = await this.reports.pdf(
      this.reports.document(item.title, filled.features),
      tpl.page,
    );
    const name = reportFileName(tpl.fileName?.trim() || item.title);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', String(pdf.byteLength));
    res.setHeader('content-disposition', contentDisposition('attachment', name));
    if (filled.issues.length > 0) {
      // Short, plain notes for the client; header values stay ASCII.
      res.setHeader('x-report-issues', encodeURIComponent(filled.issues.slice(0, 5).join(' | ')));
    }
    res.end(pdf);
  }

  /** One feature filled with an unsaved body, as HTML, for the editor. */
  @Post('reports/preview')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async preview(
    @CurrentUser() user: AuthUser,
    @Body() dto: PreviewReportDto,
  ): Promise<{ html: string; featureId: string | null; issues: string[] }> {
    const filled = await this.reports.fill(
      user,
      { itemId: dto.sourceItemId, layerKey: dto.layerKey },
      dto.body,
      {
        ...(dto.featureId ? { featureIds: [dto.featureId] } : { limit: 1 }),
      },
    );
    const first = filled.features[0] ?? null;
    return {
      html: this.reports.document('Preview', first ? [first] : []),
      featureId: first?.id ?? null,
      issues: filled.issues,
    };
  }
}
