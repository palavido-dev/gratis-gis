// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ScriptsService } from './scripts.service.js';

/**
 * Run and inspect `script` items (#221).
 *
 * Session-authenticated only. An API key is explicitly refused on the
 * run endpoint: a key that could start a script could start a script
 * that mints work for another script, and the audit trail would stop
 * being a person. Reading history is fine with a key.
 */
@ApiTags('scripts')
@ApiBearerAuth()
@Controller('scripts')
@UseGuards(JwtAuthGuard)
export class ScriptsController {
  constructor(private readonly scripts: ScriptsService) {}

  @Post(':id/run')
  @HttpCode(202)
  async run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    assertNotApiKey(user);
    return this.scripts.enqueue(user, id);
  }

  @Get(':id/runs')
  async runs(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit === undefined ? 20 : Number(limit);
    return this.scripts.listRuns(
      user,
      id,
      Number.isFinite(n) ? Math.floor(n) : 20,
    );
  }

  @Get('runs/:runId')
  async run_(@CurrentUser() user: AuthUser, @Param('runId') runId: string) {
    return this.scripts.getRun(user, runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('runId') runId: string,
  ) {
    assertNotApiKey(user);
    return this.scripts.cancelRun(user, runId);
  }
}

/**
 * Refuse an API key on the endpoints that start or stop execution.
 *
 * A run already executes with a minted key carrying the runner's
 * authority. Letting a key start a run means a key can cause more code
 * to run under that same authority, which is a short walk to a script
 * that keeps itself alive. Starting execution stays a thing a signed-in
 * person does.
 */
function assertNotApiKey(user: AuthUser): void {
  if (user.authKind === 'api_key') {
    throw new ForbiddenException(
      'API keys cannot start or stop script runs. Sign in to the portal to run a script.',
    );
  }
}
