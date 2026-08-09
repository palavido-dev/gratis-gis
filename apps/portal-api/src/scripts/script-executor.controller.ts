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

import {
  SCRIPT_MAX_NOTEBOOK_BYTES,
  type ScriptFormat,
} from '@gratis-gis/shared-types';

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
    // Every field the claimer sends has to be named here AND forwarded
    // below. Both, or it is silently dropped: this body is destructured
    // by hand rather than bound to a DTO, so an unlisted property does
    // not arrive, and there is no error to notice.
    //
    // That is exactly how notebooks shipped broken. The claimer detected
    // the notebook and sent `format`, the executor service branched on
    // `req.format`, and the hop between them threw it away, so every
    // notebook ran as if it were Python and died on the first line of
    // its own JSON. Each end was individually correct and tested.
    body: {
      source?: string;
      apiKeyToken?: string;
      timeoutSeconds?: number;
      maxLogBytes?: number;
      format?: ScriptFormat;
      maxNotebookBytes?: number;
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
        // Anything other than the literal runs as Python. A body that
        // arrived without a format, from an older claimer mid-deploy,
        // should behave the way it always did.
        format: body.format === 'notebook' ? 'notebook' : 'python',
        maxNotebookBytes: clamp(
          body.maxNotebookBytes,
          SCRIPT_MAX_NOTEBOOK_BYTES,
          1024,
          32 * 1024 * 1024,
        ),
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
