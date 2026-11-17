// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard.js';
import { UpdatesService } from './updates.service.js';

/**
 * Notify-only update check. This process never talks to the Docker
 * socket and never restarts itself. The page tells an admin which
 * commands to run.
 */
@ApiTags('admin', 'updates')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/updates')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get()
  status() {
    return this.updates.status();
  }
}
