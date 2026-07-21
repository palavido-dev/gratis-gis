// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  AnalysisService,
  type HillshadeParams,
} from './analysis.service.js';

/**
 * Server-side analysis surface (#184). One derive endpoint per
 * primitive chain plus a per-item job list the UI polls. Tier
 * gating and validation live in the service.
 */
@ApiTags('analysis')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post('items/:itemId/analysis/hillshade')
  createHillshade(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: HillshadeParams,
  ) {
    return this.analysis.createHillshadeJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/elevation')
  createElevation(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { resolution: number },
  ) {
    return this.analysis.createElevationJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/viewshed')
  createViewshed(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: { lng: number; lat: number; heightM?: number; maxDistanceM?: number },
  ) {
    return this.analysis.createViewshedJob(user, itemId, body);
  }

  @Get('items/:itemId/analysis/jobs')
  listJobs(@CurrentUser() user: AuthUser, @Param('itemId') itemId: string) {
    return this.analysis.listJobsForItem(user, itemId);
  }
}
