// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
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
import { isScriptsEnabled } from './scripts-config.js';

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
    assertScriptsEnabled();
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
 * Refuse to START execution unless the operator turned scripts on.
 *
 * This was missing, and the gap was not theoretical: the runner and
 * the web app both checked the flag, so the feature looked disabled,
 * while POST /scripts/:id/run happily queued work. On a portal where
 * untrusted people can create items that is arbitrary code execution
 * behind a switch the operator believes is off.
 *
 * 404 rather than 403, matching the feedback endpoint: a portal that
 * has not enabled scripts has no such endpoint, which is more honest
 * than implying the caller merely lacks permission.
 *
 * Deliberately NOT applied to the read endpoints. History has to stay
 * readable after an operator switches the feature off, or turning it
 * off strands the logs of whatever ran while it was on.
 */
function assertScriptsEnabled(): void {
  if (!isScriptsEnabled()) {
    throw new NotFoundException('Cannot POST /scripts');
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
