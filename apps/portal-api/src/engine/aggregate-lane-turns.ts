// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';

import { currentTenant, type TenantContext } from '../common/tenant-context.js';

/**
 * Turn-taking in the waiting line of a queued compute lane (the
 * aggregate lane of the tile cache), on an install that serves many
 * organizations. With one organization the lane does not use any of
 * this: it is first come, first served, as always.
 *
 * The rule for a running slot of the lane:
 *
 *   1. Never more than `limit` running at once.
 *   2. A bucket may take a free slot, unless another bucket waits in
 *      the line and the asker runs strictly more than every waiting
 *      bucket: then the slot is left for the waiting ones.
 *
 * So a bucket alone may use the whole lane, and a bucket running
 * nothing is never refused a free slot.
 *
 * Work is counted against the organization of the current tenant
 * context. Signed-out work is counted against the organization that
 * owns the item being served when the caller says which one that is
 * (`runServingOrg`); without an item it shares one anonymous bucket.
 * System work has a bucket of its own.
 */

const servedOrg = new AsyncLocalStorage<string>();

/**
 * Run `fn` as work that serves an item of `orgId`. Only signed-out work
 * looks at it (see laneBucket): a public map of one organization then
 * counts against that organization, not against a bucket every
 * signed-out viewer of every organization shares.
 */
export function runServingOrg<T>(orgId: string | null | undefined, fn: () => T): T {
  if (typeof orgId !== 'string' || orgId.length === 0) return fn();
  return servedOrg.run(orgId, fn);
}

/** The bucket the current work counts against in a lane. */
export function laneBucket(
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

/** Running slots of one lane, counted per bucket. */
export class LaneTurnCounter {
  private readonly held = new Map<string, number>();

  /** Slots the bucket runs now. */
  heldBy(bucket: string): number {
    return this.held.get(bucket) ?? 0;
  }

  /** Slots run by every bucket together. */
  total(): number {
    let sum = 0;
    for (const n of this.held.values()) sum += n;
    return sum;
  }

  /**
   * Whether the bucket may take one more of `limit` slots, given the
   * buckets of the lane's waiting line (the rule at the top of this
   * file).
   */
  mayTake(bucket: string, limit: number, waiting: readonly string[]): boolean {
    if (this.total() >= limit) return false;
    let most = -1;
    for (const b of waiting) {
      if (b !== bucket) most = Math.max(most, this.heldBy(b));
    }
    return most < 0 || this.heldBy(bucket) <= most;
  }

  take(bucket: string): void {
    this.held.set(bucket, this.heldBy(bucket) + 1);
  }

  release(bucket: string): void {
    const next = this.heldBy(bucket) - 1;
    if (next <= 0) this.held.delete(bucket);
    else this.held.set(bucket, next);
  }
}
