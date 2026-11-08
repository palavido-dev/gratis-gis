// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { AdminGuard } from './admin.guard.js';
import { DiagnosticsService } from './diagnostics.service.js';

/**
 * Creating a support bundle is a POST. A page load does not build one.
 */
@ApiTags('admin', 'diagnostics')
@ApiBearerAuth()
@Controller('admin/diagnostics')
@UseGuards(AdminGuard)
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Post('bundle')
  @HttpCode(200)
  bundle(@CurrentUser() user: AuthUser) {
    return this.diagnostics.bundle(user.orgId, user.id);
  }
}
