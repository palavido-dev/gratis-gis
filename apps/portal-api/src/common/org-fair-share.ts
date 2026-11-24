// SPDX-License-Identifier: AGPL-3.0-or-later
import { currentTenant, type TenantContext } from './tenant-context.js';
import { isMultiTenant } from './tenancy.js';

/**
 * Fair use of a limit that the whole process shares (compute slots,
 * export slots, import slots, render slots).
 *
 * On an install with one organization nothing changes: the
 * organization may use the whole limit, as before. On an install that
 * serves many, one organization may hold at most half of it (rounded
 * up, at least one), so the rest stays free for the others.
 *
 * Work is counted against the organization of the current tenant
 * context. Signed-out requests share one bucket and system work
 * another, so a storm of anonymous requests is held to a share too.
 */

/** The most of `limit` one organization may hold at once. */
export function orgShareOf(limit: number): number {
  if (!isMultiTenant()) return limit;
  return Math.max(1, Math.ceil(limit / 2));
}

/** The bucket the current work counts against. */
export function fairShareBucket(ctx: TenantContext | undefined = currentTenant()): string {
  if (ctx === undefined) return 'none';
  switch (ctx.kind) {
    case 'org':
      return `org:${ctx.orgId}`;
    case 'anonymous':
      return 'anonymous';
    case 'system':
      return 'system';
    default: {
      const unhandled: never = ctx;
      return unhandled;
    }
  }
}

/**
 * Counts slots held per bucket. The caller still checks its own
 * overall limit; this only adds the per-organization share, and only
 * on an install that serves many organizations.
 */
export class OrgSlotCounter {
  private readonly held = new Map<string, number>();

  /** Slots the bucket holds now. */
  heldBy(bucket: string): number {
    return this.held.get(bucket) ?? 0;
  }

  /** Whether the bucket may take one more slot of `limit`. */
  mayTake(bucket: string, limit: number): boolean {
    if (!isMultiTenant()) return true;
    return this.heldBy(bucket) < orgShareOf(limit);
  }

  take(bucket: string): void {
    this.held.set(bucket, this.heldBy(bucket) + 1);
  }

  release(bucket: string): void {
    const next = this.heldBy(bucket) - 1;
    if (next <= 0) this.held.delete(bucket);
    else this.held.set(bucket, next);
  }

  /** Tests only. */
  clear(): void {
    this.held.clear();
  }
}
