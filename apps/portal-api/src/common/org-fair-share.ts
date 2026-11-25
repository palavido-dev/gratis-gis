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
 * On an install that serves many, the rule is work-conserving:
 *
 *   1. Never more than `limit` slots in use at once.
 *   2. While no other bucket is waiting, a bucket may take any free
 *      slot, so capacity never idles while there is work for it.
 *   3. While another bucket is waiting, a bucket may take a slot only
 *      while it holds fewer than its share, ceil(limit / n), where n
 *      counts the buckets holding or waiting, itself included.
 *
 * A bucket that took more than its share while nobody else asked keeps
 * those slots; it takes no new one while another waits, so freed slots
 * go to the waiting buckets and the holdings converge to the shares. A
 * waiting line is served in turns: the waiting bucket that holds the
 * fewest slots goes first, so a waiting bucket is never starved.
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

/** The share of `limit` one of `competing` buckets may hold. */
export function fairShareOf(limit: number, competing: number): number {
  return Math.max(1, Math.ceil(limit / Math.max(1, competing)));
}

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
   * Buckets holding a slot or waiting for one, `bucket` included.
   * `waiting` adds the buckets of a caller's own waiting line.
   */
  competing(bucket: string, waiting: readonly string[] = []): number {
    const cutoff = this.now() - this.waitMemoryMs;
    const seen = new Set<string>([bucket]);
    for (const b of this.held.keys()) seen.add(b);
    for (const b of waiting) seen.add(b);
    for (const [b, at] of this.refusedAt) {
      if (at >= cutoff) seen.add(b);
      else this.refusedAt.delete(b);
    }
    return seen.size;
  }

  /** Whether a bucket other than `bucket` is waiting. */
  private othersWaiting(bucket: string, waiting: Iterable<string>): boolean {
    for (const b of waiting) if (b !== bucket) return true;
    const cutoff = this.now() - this.waitMemoryMs;
    for (const [b, at] of this.refusedAt) {
      if (b !== bucket && at >= cutoff) return true;
    }
    return false;
  }

  /**
   * Whether the bucket may take one more of `limit` slots: rule 1
   * always, rules 2 and 3 only with many organizations. `waiting`
   * names the buckets of a caller's own waiting line, if it has one.
   */
  mayTake(bucket: string, limit: number, waiting: readonly string[] = []): boolean {
    if (this.total() >= limit) return false;
    if (!isMultiTenant()) return true;
    if (!this.othersWaiting(bucket, waiting)) return true;
    return this.heldBy(bucket) < fairShareOf(limit, this.competing(bucket, waiting));
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
