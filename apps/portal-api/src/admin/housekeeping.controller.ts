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

  @Get('stale-users')
  staleUsers(@CurrentUser() user: AuthUser) {
    return this.housekeeping.staleUsers(user.orgId);
  }

  @Get('large-items')
  largeItems(@CurrentUser() user: AuthUser) {
    return this.housekeeping.largeItems(user.orgId);
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
