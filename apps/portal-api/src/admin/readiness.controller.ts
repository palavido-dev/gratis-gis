// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { OperatorOrgGuard } from '../backup/operator-org.js';
import { AdminGuard } from './admin.guard.js';
import { ReadinessService } from './readiness.service.js';

@ApiTags('admin', 'readiness')
@ApiBearerAuth()
@Controller('admin/readiness')
@UseGuards(AdminGuard, OperatorOrgGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  check() {
    return this.readiness.check();
  }
}
