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
import { AnalysisService } from './analysis.service.js';
import {
  ContoursBodyDto,
  HillshadeBodyDto,
  ResolutionBodyDto,
  ViewshedBodyDto,
} from './analysis.dto.js';

/**
 * Server-side analysis surface (#184). One derive endpoint per
 * primitive chain plus a per-item job list the UI polls. Tier
 * gating and validation live in the service; bodies are real DTOs
 * so ValidationPipe actually runs (#225).
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
    @Body() body: HillshadeBodyDto,
  ) {
    return this.analysis.createHillshadeJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/elevation')
  createElevation(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: ResolutionBodyDto,
  ) {
    return this.analysis.createElevationJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/viewshed')
  createViewshed(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: ViewshedBodyDto,
  ) {
    return this.analysis.createViewshedJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/contours')
  createContours(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: ContoursBodyDto,
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
    @Body() body: ResolutionBodyDto,
  ) {
    return this.analysis.createHeightmapJob(user, itemId, body);
  }

  @Post('items/:itemId/analysis/colorize')
  createColorize(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body() body: { rasterItemId: string },
  ) {
    return this.analysis.createColorizeJob(user, itemId, body);
  }

  @Get('items/:itemId/analysis/jobs')
  listJobs(@CurrentUser() user: AuthUser, @Param('itemId') itemId: string) {
    return this.analysis.listJobsForItem(user, itemId);
  }

  /**
   * Single-job lookup (#225). Lets a scripted client poll the id
   * returned by the submit call without scraping the per-item list.
   * Same ACL as the list: read on the source item.
   */
  @Get('analysis-jobs/:jobId')
  getJob(@CurrentUser() user: AuthUser, @Param('jobId') jobId: string) {
    return this.analysis.getJob(user, jobId);
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
