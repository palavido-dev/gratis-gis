// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

import { isMultiTenant } from './tenancy.js';

/**
 * Which organization the current piece of work is for.
 *
 * The API sets it for every HTTP request and realtime message
 * (TenantContextInterceptor), and the workers set it around each job,
 * so code deep in a call chain can ask "which org is this for" without
 * every function passing an org id along.
 *
 * Nothing reads it to filter data yet. Later work (row-level security,
 * fair queues, limits) builds on it.
 *
 * The variants:
 * - `org`: work for one organization. `userId` is set when a signed-in
 *   user (or that user's API key) made the request.
 * - `anonymous`: a public route with no signed-in caller.
 * - `system`: work that is not for any one org, such as claiming the
 *   next job from a shared queue, resolving who a token belongs to, or
 *   a housekeeping sweep. `reason` is a short fixed label such as
 *   `'job-claim'`, `'auth-sync'` or `'cron:trash-purge'`.
 *
 * A guest variant (a user of one org working in a group of another)
 * is planned. Code that needs the org id should go through
 * `tenantOrgId` or `requireOrgId` rather than checking `kind === 'org'`
 * itself, so adding that variant is a change in one place.
 */
export type OrgTenantContext = {
  readonly kind: 'org';
  readonly orgId: string;
  readonly userId?: string;
};

export type AnonymousTenantContext = { readonly kind: 'anonymous' };

export type SystemTenantContext = {
  readonly kind: 'system';
  readonly reason: string;
};

export type TenantContext = OrgTenantContext | AnonymousTenantContext | SystemTenantContext;

export type TenantContextKind = TenantContext['kind'];

const storage = new AsyncLocalStorage<TenantContext>();

/** The context of the work running now, or undefined outside any. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * The org a context acts for, or undefined for anonymous and system
 * work. The one place that maps a context kind to an org id.
 */
export function tenantOrgId(ctx: TenantContext | undefined): string | undefined {
  if (ctx === undefined) return undefined;
  switch (ctx.kind) {
    case 'org':
      return ctx.orgId;
    case 'anonymous':
    case 'system':
      return undefined;
    default: {
      // A new variant must be handled above.
      const unhandled: never = ctx;
      return unhandled;
    }
  }
}

/**
 * The context for a caller: an org context (with the user id) when a
 * user is signed in, anonymous otherwise. Takes only the two fields it
 * needs so this module does not depend on the auth types.
 *
 * A caller object without a usable org id is treated as anonymous,
 * the least the caller could be.
 */
export function tenantContextForCaller(
  user: { id?: unknown; orgId?: unknown } | null | undefined,
): TenantContext {
  if (user && typeof user.orgId === 'string' && user.orgId.length > 0) {
    return typeof user.id === 'string' && user.id.length > 0
      ? { kind: 'org', orgId: user.orgId, userId: user.id }
      : { kind: 'org', orgId: user.orgId };
  }
  return { kind: 'anonymous' };
}

/** Run `fn` with the given context. The outer context returns after. */
export function runInTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(Object.freeze({ ...ctx }), fn);
}

/**
 * Run `fn` as work for one organization. Throws on an empty org id:
 * running "for an org" with no org is always a bug, and treating it
 * as no org at all would hide it.
 */
export function runAsOrg<T>(orgId: string, fn: () => T, options: { userId?: string } = {}): T {
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new TypeError('runAsOrg needs a non-empty org id');
  }
  const ctx: OrgTenantContext =
    typeof options.userId === 'string' && options.userId.length > 0
      ? { kind: 'org', orgId, userId: options.userId }
      : { kind: 'org', orgId };
  return runInTenantContext(ctx, fn);
}

/** Run `fn` as a public, signed-out request. */
export function runAsAnonymous<T>(fn: () => T): T {
  return runInTenantContext({ kind: 'anonymous' }, fn);
}

/**
 * Run `fn` as system work that is not for any one org. `reason` is a
 * short fixed label (`'job-claim'`, `'auth-sync'`, `'cron:<name>'`),
 * never a value built from user input.
 */
export function runAsSystem<T>(reason: string, fn: () => T): T {
  return runInTenantContext({ kind: 'system', reason }, fn);
}

/**
 * Method decorator: every call of the method runs as system work, as
 * `runAsSystem(reason, ...)` would. For scheduled handlers:
 *
 *   @Cron('0 3 * * *', { name: 'purge-trash' })
 *   @RunAsSystem('cron:purge-trash')
 *   async handleCron() { ... }
 *
 * Metadata other decorators stored on the original function (such as
 * @Cron's) is copied to the wrapper, so the order of the two
 * decorators does not matter.
 */
export function RunAsSystem(
  reason: string,
): (target: object, key: string | symbol, descriptor: PropertyDescriptor) => void {
  return (_target, _key, descriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') {
      throw new TypeError('@RunAsSystem can only decorate a method');
    }
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      return runAsSystem(reason, () => original.apply(this, args));
    };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    copyMetadata(original, wrapped);
    descriptor.value = wrapped;
  };
}

type MetadataReflect = typeof Reflect & {
  getOwnMetadataKeys?: (target: object) => unknown[];
  getOwnMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
};

function copyMetadata(from: object, to: object): void {
  const r = Reflect as MetadataReflect;
  if (!r.getOwnMetadataKeys || !r.getOwnMetadata || !r.defineMetadata) return;
  for (const key of r.getOwnMetadataKeys(from)) {
    r.defineMetadata(key, r.getOwnMetadata(key, from), to);
  }
}

/**
 * The current org id, for code that must never run without one.
 * Throws when there is no context or the context is anonymous or
 * system work.
 */
export function requireOrgId(): string {
  const ctx = currentTenant();
  const orgId = tenantOrgId(ctx);
  if (orgId === undefined) {
    throw new Error(`No organization in the current context (${ctx ? ctx.kind : 'none'})`);
  }
  return orgId;
}

const strictLogger = new Logger('TenantContext');
const reportedSites = new Set<string>();

function strictEnabled(): boolean {
  return isMultiTenant() && process.env.GRATIS_TENANCY_STRICT === '1';
}

/**
 * Debug aid for finding code that runs with no tenant context. Off
 * unless `GRATIS_TENANCY=multi` and `GRATIS_TENANCY_STRICT=1`. When on
 * and there is no context, it logs a warning with the caller's stack,
 * once per call site. It never throws and never changes behaviour.
 *
 * Returns true when a context is present (or the check is off).
 */
export function assertTenantContext(label?: string): boolean {
  if (!strictEnabled()) return true;
  if (currentTenant() !== undefined) return true;
  const stack = new Error().stack ?? '';
  // Drop the message line and this function's own frame. The call
  // site is the caller's frame (file, line and column); the rest of
  // the stack is logged but does not make a new site.
  const callerFrames = stack.split('\n').slice(2);
  const frames = callerFrames.join('\n');
  const site = createHash('sha1')
    .update(callerFrames[0] ?? '')
    .digest('hex')
    .slice(0, 12);
  if (reportedSites.has(site)) return false;
  reportedSites.add(site);
  strictLogger.warn(`No tenant context${label ? ` at ${label}` : ''} (site ${site})\n${frames}`);
  return false;
}

/** Tests only: forget which call sites were already reported. */
export function resetTenantContextReportsForTests(): void {
  reportedSites.clear();
}
