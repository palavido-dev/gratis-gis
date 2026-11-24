// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';

import { isMultiTenant } from './tenancy.js';

/**
 * Request rate limits, by caller.
 *
 * One organization (the self-hosted default): every request counts
 * against its client address, with the route's limit, exactly as the
 * stock ThrottlerGuard does. These two guards change nothing there.
 *
 * Many organizations: many people of one organization can sit behind
 * one address (an office), and one organization must not use up the
 * budget of the others.
 * - Signed-out requests count against the address, as before.
 * - A request with a credential counts against the address in its
 *   own, wider budget before sign-in is checked
 *   (`AddressThrottlerGuard`), so a flood of made-up credentials from
 *   one address is still held back.
 * - Once signed in (`OrgThrottlerGuard`, after the auth guard) it
 *   counts against the person, with the route's limit, and against
 *   the organization, with a wider ceiling.
 * - On a public route, a credential that signs nobody in (the route
 *   answers it as signed out) counts against the address with the
 *   route's limit, the same budget as signed-out requests. On other
 *   routes the auth guard refuses it.
 *
 * Counts are kept per API process, as before.
 */

/** Budget of one address for requests with a credential, in route limits. */
export const CREDENTIALED_ADDRESS_FACTOR = 10;
/** Ceiling of one organization, in route limits. */
export const ORG_CEILING_FACTOR = 20;

type ThrottledRequest = {
  headers?: Record<string, unknown>;
  user?: { id?: unknown; orgId?: unknown } | null;
};

export function presentsCredential(req: ThrottledRequest): boolean {
  const raw = req.headers?.authorization;
  return typeof raw === 'string' && raw.toLowerCase().startsWith('bearer ');
}

/** The signed-in caller's ids, or null. */
function signedIn(req: ThrottledRequest): { id: string; orgId: string } | null {
  const user = req.user;
  if (!user) return null;
  const { id, orgId } = user;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof orgId !== 'string' || orgId.length === 0) return null;
  return { id, orgId };
}

/**
 * Runs before the auth guard. Exactly the stock guard with one
 * organization; with many, a request that carries a credential is
 * counted in a wider per-address budget (see above).
 */
@Injectable()
export class AddressThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    if (!isMultiTenant()) return super.handleRequest(props);
    const { req } = this.getRequestResponse(props.context);
    if (!presentsCredential(req as ThrottledRequest)) return super.handleRequest(props);
    const byAddress = props.getTracker;
    return super.handleRequest({
      ...props,
      limit: props.limit * CREDENTIALED_ADDRESS_FACTOR,
      getTracker: async (r, c) => `credentialed:${await byAddress(r, c)}`,
    });
  }
}

/**
 * Runs after the auth guard, and only with many organizations: the
 * per-person and per-organization counts (see above).
 */
@Injectable()
export class OrgThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (!isMultiTenant() || context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ThrottledRequest>();
    // A request without a credential was counted by address already.
    return !presentsCredential(req);
  }

  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { req } = this.getRequestResponse(props.context);
    const caller = signedIn(req as ThrottledRequest);
    if (!caller) {
      // The credential signed nobody in (a public route answers it as
      // signed out): the plain address budget, shared with signed-out
      // requests to the same route.
      return super.handleRequest(props);
    }
    // The organization first, so the rate headers the client sees
    // last are the person's own.
    await super.handleRequest({
      ...props,
      limit: props.limit * ORG_CEILING_FACTOR,
      getTracker: async () => `org:${caller.orgId}`,
    });
    return super.handleRequest({
      ...props,
      getTracker: async () => `user:${caller.id}`,
    });
  }
}
