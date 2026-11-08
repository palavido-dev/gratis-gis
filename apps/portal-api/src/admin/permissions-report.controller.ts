// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { PermissionsReportService } from './permissions-report.service.js';

@ApiTags('admin', 'permissions')
@ApiBearerAuth()
@Controller('admin/permissions')
@UseGuards(AdminGuard)
export class PermissionsReportController {
  constructor(private readonly report: PermissionsReportService) {}

  @Get()
  json(@CurrentUser() user: AuthUser) {
    return this.report.report(user.orgId);
  }

  @Get('export.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="permissions-current.csv"')
  @Header('x-content-type-options', 'nosniff')
  csv(@CurrentUser() user: AuthUser) {
    return this.report.csv(user.orgId);
  }
}
