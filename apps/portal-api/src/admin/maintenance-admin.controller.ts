// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { MaintenanceModeService } from '../backup/maintenance-mode.service.js';
import { OperatorOrgGuard } from '../backup/operator-org.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminGuard } from './admin.guard.js';

class MaintenanceDto {
  @IsBoolean()
  active!: boolean;

  /** Accepted and ignored. A failed restore stays on until a restore finishes. */
  @IsOptional()
  @IsBoolean()
  acknowledgeFailure?: boolean;
}

export function failedRestore(reason: string | null): boolean {
  if (!reason) return false;
  return /restore/i.test(reason) && /fail|inconsistent/i.test(reason);
}

@ApiTags('admin', 'maintenance')
@ApiBearerAuth()
@Controller('admin/maintenance')
// Maintenance returns 503 for every org, so it is an operator power
// like install-wide backup, not an org admin power.
@UseGuards(AdminGuard, OperatorOrgGuard)
export class MaintenanceAdminController {
  constructor(
    private readonly mode: MaintenanceModeService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  status() {
    const snap = this.mode.snapshot();
    return {
      active: snap.active,
      startedAt: snap.startedAt,
      failureHold: failedRestore(snap.reason),
    };
  }

  @Post()
  @HttpCode(200)
  async set(@CurrentUser() user: AuthUser, @Body() body: MaintenanceDto) {
    const before = this.mode.snapshot();
    if (!body.active && failedRestore(before.reason)) {
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'maintenance.set',
        targetType: 'maintenance',
        targetId: user.orgId,
        outcome: 'failed',
        detail: { active: false, held: true },
      });
      throw new ConflictException(
        'A failed restore is holding maintenance. It stays on until a restore finishes. The portal will not serve a partial database.',
      );
    }
    try {
      if (body.active) {
        await this.mode.activate('Turned on by an org admin.', { replaceReason: true });
      } else {
        await this.mode.deactivate();
      }
    } catch (err) {
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'maintenance.set',
        targetType: 'maintenance',
        targetId: user.orgId,
        outcome: 'failed',
        detail: { active: body.active },
      });
      throw err;
    }
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'maintenance.set',
      targetType: 'maintenance',
      targetId: user.orgId,
      outcome: 'succeeded',
      detail: { active: body.active },
    });
    return this.status();
  }
}
