// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { HousekeepingService } from './housekeeping.service.js';
import {
  HousekeepingScheduleService,
  type HousekeepingScheduleMode,
} from './housekeeping-schedule.service.js';

class HousekeepingConfigDto {
  @IsOptional() @IsBoolean() autoTrashEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650) autoTrashDays?: number | null;
  @IsOptional() @IsBoolean() autoDisableEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650) autoDisableDays?: number | null;
  @IsOptional() @IsBoolean() recomputeExtentsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(3650)
  fieldQueueStaleDays?: number | null;
  @IsOptional() @IsBoolean() fieldQueueAutoPruneEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(3650)
  fieldQueueAutoPruneGraceDays?: number | null;
  @IsOptional() @IsEnum(['off', 'daily', 'weekly'])
  scheduleMode?: HousekeepingScheduleMode;
  @IsOptional() @IsInt() @Min(0) @Max(23) scheduleHour?: number;
  @IsOptional() @IsInt() @Min(0) @Max(59) scheduleMinute?: number;
  @IsOptional() @IsInt() @Min(0) @Max(6) scheduleDayOfWeek?: number | null;
}

/**
 * Admin-only housekeeping dashboard. Pure read endpoints: the
 * admin takes action on individual items / users through the
 * existing detail pages (reassign, delete, disable). Keeping the
 * actions scoped there means the audit log and permissions model
 * work the same way whether the admin reached the item from this
 * page or anywhere else.
 */
@ApiTags('admin', 'housekeeping')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/housekeeping')
export class HousekeepingController {
  constructor(
    private readonly housekeeping: HousekeepingService,
    private readonly schedule: HousekeepingScheduleService,
  ) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.housekeeping.summary(user.orgId);
  }

  @Get('stale-items')
  staleItems(@CurrentUser() user: AuthUser) {
    return this.housekeeping.staleItems(user.orgId);
  }

  /**
   * #217 companion: live items referencing item ids that no longer
   * resolve (a map whose layer's item was purged renders silently
   * broken). Per-referrer rows split into hard-missing vs trashed.
   */
  @Get('dangling-references')
  danglingReferences(@CurrentUser() user: AuthUser) {
    return this.housekeeping.danglingReferences(user.orgId);
  }

  @Get('stale-users')
  staleUsers(@CurrentUser() user: AuthUser) {
    return this.housekeeping.staleUsers(user.orgId);
  }

  @Get('large-items')
  largeItems(@CurrentUser() user: AuthUser) {
    return this.housekeeping.largeItems(user.orgId);
  }

  /**
   * Storage telemetry (#161). Postgres total size, MinIO bucket
   * usage, host-disk free / total. The MinIO walk is O(objects),
   * so this endpoint is fetched lazily on Housekeeping page render
   * and not as part of the lighter `summary` cards.
   */
  @Get('storage')
  storage() {
    return this.housekeeping.storageMetrics();
  }

  /**
   * Top N tables by total relation size (#161). Read-only diagnostic
   * for "which table is bloating the cluster"; returns schema /
   * name / total / table / index bytes plus a row estimate.
   */
  @Get('largest-tables')
  largestTables() {
    return this.housekeeping.largestTables();
  }

  /**
   * Top data_layer scopes by approximate observation footprint
   * (#115 P10 follow-up). After the engine pivot the per-table
   * "Largest database tables" list collapses every layer into a
   * handful of monthly partitions and stops being useful for
   * "which dataset is eating disk?". This drills down to
   * data_layer:itemId:layerId.
   */
  @Get('largest-data-layers')
  largestDataLayers(@CurrentUser() user: AuthUser) {
    return this.housekeeping.largestDataLayers(user.orgId);
  }

  /**
   * "Soon to expire" share rows (#86). `?within=` is the lookahead
   * window in days; defaults to 30. Already-expired rows are
   * included with `isExpired: true` so the admin can extend or
   * cancel them in one place.
   */
  @Get('expiring-shares')
  expiringShares(
    @CurrentUser() user: AuthUser,
    @Query('within') within?: string,
  ) {
    const days = parseWithin(within, 30);
    return this.housekeeping.expiringShares(user.orgId, days);
  }

  /**
   * Users with an explicit auto-disable date in the next `?within=`
   * days (or already past). Cron flips Keycloak's enabled flag in
   * bulk; this list lets the admin extend, cancel, or disable now
   * before the schedule fires.
   */
  @Get('expiring-users')
  expiringUsers(
    @CurrentUser() user: AuthUser,
    @Query('within') within?: string,
  ) {
    const days = parseWithin(within, 30);
    return this.housekeeping.expiringUsers(user.orgId, days);
  }

  // -------------------------------------------------------------
  // #67: scheduled housekeeping config + run history
  // -------------------------------------------------------------

  @Get('config')
  getConfig() {
    return this.schedule.getConfig();
  }

  @Patch('config')
  updateConfig(@Body() dto: HousekeepingConfigDto) {
    return this.schedule.updateConfig(dto);
  }

  @Get('runs')
  listRuns(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.schedule.listRuns(Number.isFinite(n) && n > 0 ? n : 25);
  }

  @Post('run')
  runNow(@CurrentUser() user: AuthUser) {
    return this.schedule.runOnce({
      trigger: 'manual',
      startedBy: user.id,
    });
  }

  /**
   * Recompute the cached bbox on every spatial item in the org
   * (#90). Use this after seeding fixtures, or when an upgrade
   * adds a new bbox source: each data_layer aggregates its current
   * PostGIS feature footprint, and maps re-aggregate from the
   * freshly-recomputed referenced items. Returns counts so the UI
   * can confirm the pass actually did something.
   */
  @Post('recompute-extents')
  async recomputeExtents(@CurrentUser() user: AuthUser) {
    return this.housekeeping.recomputeExtents(user.orgId);
  }

  /**
   * Build / reconcile per-searchable-field trigram indexes on the
   * observation table for every data_layer in the org. Run after
   * marking fields searchable (schema saves are metadata-only and
   * do not build indexes inline) or after a big import, so the map
   * search bar stops scanning county-scale layers per keystroke.
   * Synchronous like recompute-extents: the admin waits and gets
   * the created / kept / dropped breakdown back.
   */
  @Post('build-search-indexes')
  async buildSearchIndexes(@CurrentUser() user: AuthUser) {
    return this.housekeeping.buildSearchIndexes(user.orgId);
  }

  /**
   * Orphaned-uploads DRY RUN. Lists objects in the MinIO bucket's
   * managed upload prefixes that are older than the age floor and
   * that no database row references anymore (crashed imports,
   * abandoned wizards, deleted rows whose best-effort object
   * delete failed). Read-only: returns counts, bytes, and a key
   * sample so the admin sees exactly what a purge would remove.
   * The delete is a separate explicit POST below.
   */
  @Get('orphaned-uploads')
  orphanedUploads() {
    return this.housekeeping.orphanedUploadsReport();
  }

  /**
   * Orphaned-uploads PURGE: the destructive second step. The
   * orphan set is recomputed server-side at this moment; the
   * client cannot submit keys, so a stale report tab can never
   * delete an object that has since gained a reference. Objects
   * remain subject to the same age floor and reference checks as
   * the dry run.
   */
  @Post('orphaned-uploads/purge')
  purgeOrphanedUploads() {
    return this.housekeeping.purgeOrphanedUploads();
  }
}

/**
 * Parse the `?within=` window. Clamped to [1, 365] so a typo can't
 * pull a year-and-a-half of rows out of the DB; defaults when
 * missing or invalid so the route stays forgiving.
 */
function parseWithin(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(365, Math.floor(n));
}
