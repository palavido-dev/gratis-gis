// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
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

  @Post('items/:itemId/analysis/contours')
  createContours(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { intervalM?: number },
  ) {
    return this.analysis.createContoursJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/steepness')
  createSteepness(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
  ) {
    return this.analysis.createSteepnessJob(user, itemId);
  }

  @Post('items/:itemId/analysis/heightmap')
  createHeightmap(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { resolution: number },
  ) {
    return this.analysis.createHeightmapJob(user, itemId, body);
  }

  @Get('items/:itemId/analysis/jobs')
  listJobs(@CurrentUser() user: AuthUser, @Param('itemId') itemId: string) {
    return this.analysis.listJobsForItem(user, itemId);
  }

  /**
   * Cancel a queued or running analysis job. POST-with-verb (not
   * DELETE) to mirror the existing import-jobs cancel: the row is
   * kept as history, only its state moves. Owner-or-org-admin and
   * terminal-state idempotence are enforced in the service.
   */
  @Post('analysis-jobs/:jobId/cancel')
  @HttpCode(200)
  cancelJob(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string) {
    return this.analysis.cancelJob(user, jobId);
  }
}
