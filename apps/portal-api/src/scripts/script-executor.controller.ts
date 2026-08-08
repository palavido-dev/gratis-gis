// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { Public } from '../auth/public.decorator.js';
import {
  ScriptExecutorService,
  type ExecuteResult,
} from './script-executor.service.js';

/**
 * The executor's only endpoint. Reachable solely from the claimer,
 * over an internal Docker network that portal-api also sits on but
 * postgres, object storage, and Keycloak do not.
 *
 * `@Public()` because this process has no Keycloak, no user database,
 * and no notion of a portal session; it is not part of the user-facing
 * API and is never exposed through Caddy. Authentication is a shared
 * secret, checked below. Network placement is the primary control and
 * the secret is the backstop for the day something else lands on that
 * network.
 */
@Controller('execute')
export class ScriptExecutorController {
  constructor(private readonly executor: ScriptExecutorService) {}

  @Public()
  @Post()
  @HttpCode(200)
  async execute(
    @Body()
    body: {
      source?: string;
      apiKeyToken?: string;
      timeoutSeconds?: number;
      maxLogBytes?: number;
    },
    @Headers('x-script-executor-token') token: string | undefined,
    @Req() req: Request,
  ): Promise<ExecuteResult> {
    assertToken(token);

    if (typeof body.source !== 'string' || body.source.length === 0) {
      throw new ServiceUnavailableException('No source to execute.');
    }
    if (typeof body.apiKeyToken !== 'string' || body.apiKeyToken.length === 0) {
      // Refuse rather than run credential-less. A script that silently
      // ran with no key would fail deep inside the user's code with a
      // confusing error instead of here, with a clear one.
      throw new ServiceUnavailableException('No run key supplied.');
    }

    // Cancel is the claimer hanging up. Express fires 'close' on the
    // request when the socket goes away, which aborts the child.
    // Modelling cancel as "the caller left" avoids a second endpoint
    // and a run-id registry that could leak entries.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    return this.executor.execute(
      {
        source: body.source,
        apiKeyToken: body.apiKeyToken,
        timeoutSeconds: clamp(body.timeoutSeconds, 300, 1, 3600),
        maxLogBytes: clamp(body.maxLogBytes, 262_144, 1024, 4_194_304),
      },
      ac.signal,
    );
  }
}

/**
 * Constant-time compare, and refuse outright when no secret is
 * configured rather than defaulting to open. An executor that accepts
 * unauthenticated work because someone forgot an env var is worse than
 * one that refuses all work loudly.
 */
function assertToken(supplied: string | undefined): void {
  const expected = process.env.SCRIPT_EXECUTOR_TOKEN ?? '';
  if (expected.length === 0) {
    throw new ServiceUnavailableException(
      'This executor has no SCRIPT_EXECUTOR_TOKEN configured and will not accept work.',
    );
  }
  const a = Buffer.from(supplied ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException('Bad executor token.');
  }
}

function clamp(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), min), max);
}
