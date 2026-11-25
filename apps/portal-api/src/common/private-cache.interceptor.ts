// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { isMultiTenant } from './tenancy.js';

/**
 * HTTP cache headers for signed-in answers on an install that serves
 * many organizations (registered as a global APP_INTERCEPTOR).
 *
 * A request that carries a credential (`Authorization: Bearer`) gets,
 * before its handler runs:
 * - `Cache-Control: private, no-cache`, so no shared cache (a proxy or
 *   CDN in front of the install) keeps one person's answer for the
 *   next. A handler that sets its own Cache-Control replaces it; the
 *   handlers that do already say `private` for signed-in callers.
 * - `Vary: Authorization`, added to whatever Vary the handler sets.
 *
 * Signed-out requests are left alone: they only reach public content,
 * which stays cacheable. With one organization nothing is added, so
 * a self-hosted install answers exactly as before.
 */
@Injectable()
export class PrivateCacheInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() === 'http' && isMultiTenant()) {
      const http = ctx.switchToHttp();
      const req = http.getRequest<{ headers?: Record<string, unknown> }>();
      if (carriesBearer(req.headers?.authorization)) {
        markPrivate(http.getResponse<HeaderTarget>());
      }
    }
    return next.handle();
  }
}

type HeaderTarget = {
  headersSent?: boolean;
  getHeader?: (name: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
};

function carriesBearer(raw: unknown): boolean {
  return typeof raw === 'string' && raw.toLowerCase().startsWith('bearer ');
}

/** Set the private default and add Authorization to Vary. */
export function markPrivate(res: HeaderTarget): void {
  if (res.headersSent || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'private, no-cache');
  const current = res.getHeader?.('Vary');
  const parts = (typeof current === 'string' ? current.split(',') : [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.some((p) => p === '*' || p.toLowerCase() === 'authorization')) {
    parts.push('Authorization');
  }
  res.setHeader('Vary', parts.join(', '));
}
