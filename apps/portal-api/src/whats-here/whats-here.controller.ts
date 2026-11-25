// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { Public } from '../auth/public.decorator.js';
import { contentDisposition } from '../common/content-disposition.js';
import { reportFileName } from '../reports/reports.service.js';
import { WhatsHereReportService } from './whats-here-report.service.js';

@ApiTags('whats-here')
@Controller('whats-here')
export class WhatsHereController {
  constructor(private readonly reports: WhatsHereReportService) {}

  /**
   * The What's Here screen as a PDF (#796).
   *
   * Public so a public app can print for anonymous visitors, the same
   * way its aggregate reads go through the public mirror. A signed-in
   * caller is read with their own access; an anonymous one sees public
   * layers only, clipped to the public tier. Each render holds a
   * Chromium session, so the throttle matches report templates.
   */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  @Post('report')
  async report(
    @Req() req: Request & { user?: AuthUser },
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const { pdf, fileName } = await this.reports.pdf(req.user ?? null, body);
    const name = reportFileName(fileName);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', String(pdf.byteLength));
    res.setHeader('content-disposition', contentDisposition('attachment', name));
    res.end(pdf);
  }
}
