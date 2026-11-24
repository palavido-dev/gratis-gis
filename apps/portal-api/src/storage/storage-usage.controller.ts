// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { StorageLedgerService, type OrgUsage } from './storage-ledger.service.js';

/**
 * Storage used by the caller's organization: stored files by kind, and
 * the estimated size of its feature data. Read only, own org only: the
 * org comes from the signed-in admin, never from the request. Nothing
 * here limits uploads.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/storage-usage')
@UseGuards(AdminGuard)
export class StorageUsageController {
  constructor(private readonly ledger: StorageLedgerService) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<
    OrgUsage & {
      /** How feature data is measured, for display next to the figure. */
      featureMethod: string;
    }
  > {
    const usage = await this.ledger.usage(user.orgId);
    return {
      ...usage,
      featureMethod: 'Feature data is estimated from feature count and average feature size.',
    };
  }
}
