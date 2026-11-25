// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';

import { currentTenant, type TenantContext } from './tenant-context.js';
import { isMultiTenant } from './tenancy.js';

/**
 * Fair use of a limit that the whole process shares (compute slots,
 * export slots, import slots, render slots).
 *
 * On an install with one organization nothing changes: there is one
 * rule, "no more than the limit at once", exactly as before.
 *
 * On an install that serves many, the rule is:
 *
 *   1. Never more than `limit` slots held at once.
 *   2. A bucket that asks gets a free slot, unless another bucket is
 *      waiting and the asker holds strictly more than every waiting
 *      bucket: then the slot is left for the waiting ones.
 *
 * So a bucket alone may use the whole limit, a bucket holding nothing
 * is never refused a free slot, and no slot idles while a bucket that
 * holds no more than some other waiting bucket asks for it. Callers
 * with a waiting line serve it fewest-held first (see the tile cache).
 *
 * Callers that turn work away instead of queueing it have no line.
 * For them a bucket that was turned away in the last few seconds
 * counts as waiting, so its next try finds the slot that a busier
 * bucket gave up.
 *
 * Work is counted against the organization of the current tenant
 * context. Signed-out work is counted against the organization that
 * owns the item being served when the caller says which one that is
 * (`runServingOrg`); without an item it shares one anonymous bucket.
 * System work has a bucket of its own.
 */

/** How long a bucket that was turned away still counts as waiting. */
export const FAIR_SHARE_WAIT_MEMORY_MS = 5_000;

const servedOrg = new AsyncLocalStorage<string>();

/**
 * Run `fn` as work that serves an item of `orgId`. Only signed-out work
 * looks at it (see fairShareBucket): a public map of one organization
 * then counts against that organization, not against a bucket every
 * signed-out viewer of every organization shares.
 */
export function runServingOrg<T>(orgId: string | null | undefined, fn: () => T): T {
  if (typeof orgId !== 'string' || orgId.length === 0) return fn();
  return servedOrg.run(orgId, fn);
}

/** The bucket the current work counts against. */
export function fairShareBucket(
  ctx: TenantContext | undefined = currentTenant(),
  serving: string | undefined = servedOrg.getStore(),
): string {
  if (ctx === undefined) return 'none';
  switch (ctx.kind) {
    case 'org':
      return `org:${ctx.orgId}`;
    case 'anonymous':
      return serving ? `org:${serving}` : 'anonymous';
    case 'system':
      return 'system';
    default: {
      const unhandled: never = ctx;
      return unhandled;
    }
  }
}

/**
 * Counts slots held per bucket and applies the rule above. Every take
 * and release of the limit goes through it, so its total is the
 * number of slots in use. With one organization it checks only that
 * total against the limit, the check each caller made before.
 */
export class OrgSlotCounter {
  private readonly held = new Map<string, number>();
  /** Buckets turned away recently, with when. */
  private readonly refusedAt = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly waitMemoryMs: number = FAIR_SHARE_WAIT_MEMORY_MS,
  ) {}

  /** Slots the bucket holds now. */
  heldBy(bucket: string): number {
    return this.held.get(bucket) ?? 0;
  }

  /** Slots held by every bucket together. */
  total(): number {
    let sum = 0;
    for (const n of this.held.values()) sum += n;
    return sum;
  }

  /**
   * The most slots held by a waiting bucket other than `bucket`, or -1
   * when no other bucket waits. `waiting` names the buckets of a
   * caller's own waiting line; buckets turned away recently count too.
   */
  private mostHeldByOthersWaiting(bucket: string, waiting: Iterable<string>): number {
    let most = -1;
    for (const b of waiting) {
      if (b !== bucket) most = Math.max(most, this.heldBy(b));
    }
    const cutoff = this.now() - this.waitMemoryMs;
    for (const [b, at] of this.refusedAt) {
      if (at < cutoff) this.refusedAt.delete(b);
      else if (b !== bucket) most = Math.max(most, this.heldBy(b));
    }
    return most;
  }

  /**
   * Whether the bucket may take one more of `limit` slots. One
   * organization: while fewer than `limit` are held. Many: the rule at
   * the top of this file.
   */
  mayTake(bucket: string, limit: number, waiting: readonly string[] = []): boolean {
    if (this.total() >= limit) return false;
    if (!isMultiTenant()) return true;
    const most = this.mostHeldByOthersWaiting(bucket, waiting);
    return most < 0 || this.heldBy(bucket) <= most;
  }

  /**
   * Take a slot if the rule allows it. Returns false, and remembers
   * the bucket as waiting for a few seconds, when it does not.
   */
  tryTake(bucket: string, limit: number): boolean {
    if (!this.mayTake(bucket, limit)) {
      if (isMultiTenant()) this.refusedAt.set(bucket, this.now());
      return false;
    }
    this.take(bucket);
    return true;
  }

  take(bucket: string): void {
    this.held.set(bucket, this.heldBy(bucket) + 1);
    this.refusedAt.delete(bucket);
  }

  release(bucket: string): void {
    const next = this.heldBy(bucket) - 1;
    if (next <= 0) this.held.delete(bucket);
    else this.held.set(bucket, next);
  }

  /** Tests only. */
  clear(): void {
    this.held.clear();
    this.refusedAt.clear();
  }
}
