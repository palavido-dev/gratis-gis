// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { runInTenantContext, tenantContextForCaller } from './tenant-context.js';

/**
 * Sets the tenant context for every HTTP request (registered as a
 * global APP_INTERCEPTOR in app.module.ts).
 *
 * Interceptors run after the guards, so `req.user` is already set:
 * a signed-in caller runs as their org (with their user id), a
 * @Public route with no caller runs as anonymous.
 *
 * The context must cover the subscription, not just the call to
 * `next.handle()`. Nest only runs the route handler when the returned
 * observable is subscribed, so wrapping the creation alone would leave
 * the handler body outside the context.
 *
 * The realtime WebSocket gateways do not use Nest message handlers
 * (they read frames from the raw socket), so interceptors never see
 * their messages. They set the context themselves; see
 * realtime/realtime.gateway.ts and realtime/drawings-collab.gateway.ts.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    const tenant = tenantContextForCaller(
      req.user as { id?: unknown; orgId?: unknown } | null | undefined,
    );
    return new Observable((subscriber) =>
      runInTenantContext(tenant, () => next.handle().subscribe(subscriber)),
    );
  }
}
