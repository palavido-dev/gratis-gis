// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { AdminAuditService } from './admin-audit.service.js';

@ApiTags('admin', 'audit')
@ApiBearerAuth()
@Controller('admin/audit')
@UseGuards(AdminGuard)
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const parsed = Number(limit);
    return this.audit.list(user.orgId, {
      ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
      ...(before ? { before } : {}),
    });
  }
}
