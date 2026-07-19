// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from './admin.guard.js';
import { OnboardingService } from './onboarding.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Admin getting-started checklist (#147 Phase 3). GET computes the
 * live status; the three mutations all return the fresh status so
 * the UI updates in a single round trip. Key validation happens in
 * the service so an unknown key is a 400, not a silent no-op row
 * in the org's state column.
 */
@ApiTags('admin', 'onboarding')
@ApiBearerAuth()
@Controller('admin/onboarding')
@UseGuards(AdminGuard)
export class AdminOnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.onboarding.getStatus(user.orgId);
  }

  @Post(':key/dismiss')
  dismiss(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.onboarding.dismiss(
      user.orgId,
      this.onboarding.assertValidKey(key),
    );
  }

  @Post(':key/complete')
  complete(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.onboarding.complete(
      user.orgId,
      this.onboarding.assertValidKey(key),
    );
  }

  @Post(':key/restore')
  restore(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.onboarding.restore(
      user.orgId,
      this.onboarding.assertValidKey(key),
    );
  }
}
