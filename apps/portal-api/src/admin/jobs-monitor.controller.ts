// SPDX-License-Identifier: AGPL-3.0-or-later
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminAuditService } from './admin-audit.service.js';
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
  constructor(
    private readonly jobs: JobsMonitorService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.jobs.list(user.orgId);
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: JobKindDto,
  ) {
    try {
      return await this.jobs.cancel(user, body.kind, id);
    } catch (err) {
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'job.cancel',
        targetType: body.kind,
        targetId: id,
        outcome: 'failed',
      });
      throw err;
    }
  }

  @Post(':id/retry')
  async retry(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: JobKindDto,
  ) {
    try {
      return await this.jobs.retry(user, body.kind, id);
    } catch (err) {
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'job.retry',
        targetType: body.kind,
        targetId: id,
        outcome: 'failed',
      });
      throw err;
    }
  }
}
