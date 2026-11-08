// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { JobsMonitorService } from './jobs-monitor.service.js';

class JobKindDto {
  @IsIn(['import', 'analysis', 'backup'])
  kind!: 'import' | 'analysis' | 'backup';
}

@ApiTags('admin', 'jobs')
@ApiBearerAuth()
@Controller('admin/jobs')
@UseGuards(AdminGuard)
export class JobsMonitorController {
  constructor(private readonly jobs: JobsMonitorService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.jobs.list(user.orgId);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: JobKindDto,
  ) {
    return this.jobs.cancel(user, body.kind, id);
  }

  @Post(':id/retry')
  retry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: JobKindDto,
  ) {
    return this.jobs.retry(user, body.kind, id);
  }
}
