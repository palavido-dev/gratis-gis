// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { IngestService } from '../ingest/ingest.service.js';
import { IngestStagingService } from '../ingest/ingest-staging.service.js';
import { ImportJobsService } from './import-jobs.service.js';
import type { DataLayerLayerShape } from '../data-layer/tables.service.js';

class CreateImportJobDto {
  @IsUUID() stagingId!: string;
  @IsString() sourceLayerName!: string;
  @IsOptional() @IsIn(['replace', 'append']) mode?: 'replace' | 'append';
}

/**
 * REST surface for the async import-jobs flow (#115).
 *
 * The wizard creates a job via POST and immediately navigates to
 * the item detail page; the detail page polls
 * GET /items/:id/import-jobs/active and renders an in-progress
 * banner. Jobs run on a background worker (see
 * ImportJobsWorker), so the POST returns in milliseconds
 * regardless of the dataset size.
 *
 * The legacy streaming POST /items/:id/layers/:layerId/import
 * path stays for direct API users (curl, scripted ingests) that
 * want the synchronous NDJSON behavior. Wizard moves off it.
 */
@ApiTags('import-jobs')
@ApiBearerAuth()
@Controller()
export class ImportJobsController {
  constructor(
    private readonly jobs: ImportJobsService,
    private readonly items: ItemsService,
    private readonly staging: IngestStagingService,
    private readonly ingest: IngestService,
  ) {}

  /**
   * Enqueue a per-layer ingest job. Returns immediately with the
   * persisted job row; the worker will pick it up within ~1s.
   *
   * Validates that:
   *   - the item exists, is a v3 data_layer, and the caller can edit
   *   - the named layer is in the item's schema
   *   - the staging file is owned by the caller and not yet expired
   *   - mode is replace or append
   *
   * Pre-validating against the staging here means a job-row that
   * lands in the queue has a real shot at succeeding. A staging
   * that expires AFTER enqueue but BEFORE the worker claims it
   * fails at run time with a clear "re-upload" message.
   */
  @Post('items/:id/layers/:layerId/import-jobs')
  async createJob(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() dto: CreateImportJobDto,
  ) {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Async import targets data_layer items only.',
      );
    }
    const data = item.data as {
      version?: number;
      layers?: Array<DataLayerLayerShape>;
    } | null;
    if (data?.version !== 3) {
      throw new BadRequestException(
        'Async import is v3-only.',
      );
    }
    const layer = (data.layers ?? []).find((l) => l.id === layerId);
    if (!layer) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema.`,
      );
    }
    await this.items.assertCanEdit(user, itemId);

    // Pre-validate the staging so a doomed job never lands in the
    // queue. getStaging throws Forbidden if the staging belongs to
    // someone else and NotFound if it has expired.
    const staged = await this.staging.getStaging(dto.stagingId, user.id);

    // Probe the staged file once to capture totalFeatures so the
    // detail-page banner can render percentage-done immediately,
    // not after the first batch flush. Tolerates a probe failure
    // (still enqueues without a total) so the user isn't blocked
    // by an exotic format that streamLayerFromPath would still
    // handle.
    let totalFeatures: number | null = null;
    try {
      const probe = await this.ingest.probeFileFromPath(staged.filePath);
      const matched = probe.layers.find(
        (l) => l.name === dto.sourceLayerName,
      );
      if (matched) totalFeatures = matched.featureCount;
    } catch {
      // Probe failed; the worker will surface a real error if the
      // file is genuinely broken. Move on without totalFeatures so
      // the queue isn't blocked.
    }

    const row = await this.jobs.enqueue({
      itemId,
      layerId,
      stagingId: dto.stagingId,
      sourceFileName: staged.originalName,
      sourceLayerName: dto.sourceLayerName,
      mode: dto.mode ?? 'replace',
      totalFeatures,
      userId: user.id,
      orgId: user.orgId,
      bytes: BigInt(staged.sizeBytes),
    });
    return this.jobs.toWire(row);
  }

  /**
   * Active jobs for the detail-page banner. Returns queued +
   * running jobs the caller can see (their org). Sorted oldest-
   * first so a queue with multiple pending jobs renders in
   * arrival order.
   */
  @Get('items/:id/import-jobs/active')
  async listActive(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
  ) {
    // Item visibility check first so an unauthorized caller can't
    // probe job existence by trying random item ids.
    await this.items.get(user, itemId);
    const rows = await this.jobs.listActiveForItem(user, itemId);
    return rows.map((r) => this.jobs.toWire(r));
  }

  /** Single-job lookup for the post-run "what happened" UX. */
  @Get('import-jobs/:jobId')
  async getJob(
    @CurrentUser() user: AuthUser,
    @Param('jobId') jobId: string,
  ) {
    const row = await this.jobs.get(user, jobId);
    return this.jobs.toWire(row);
  }

  /**
   * Caller-initiated cancel. Idempotent on terminal states.
   * Only the job's creator (or an org admin) can cancel.
   */
  @Post('import-jobs/:jobId/cancel')
  @HttpCode(200)
  async cancelJob(
    @CurrentUser() user: AuthUser,
    @Param('jobId') jobId: string,
  ) {
    const row = await this.jobs.get(user, jobId);
    if (row.createdBy !== user.id && user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only the job creator or an org admin can cancel.',
      );
    }
    const updated = await this.jobs.cancel(user, jobId);
    return this.jobs.toWire(updated);
  }
}
