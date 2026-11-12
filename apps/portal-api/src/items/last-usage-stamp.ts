// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Throttled writer for `item.last_usage_at`, the signal behind the
 * stale-item heuristic (#96, #99).
 *
 * Why this is raw SQL rather than `prisma.item.update`. `updatedAt` on
 * the Item model carries Prisma's `@updatedAt`, which rewrites the
 * column on *any* update through the client, including one that only
 * touches `last_usage_at`. That turned a passive read into a content
 * edit: opening a map item's detail page advanced its "Updated"
 * timestamp by the elapsed wall time, for a viewer with no edit rights.
 *
 * The damage went past the cosmetic. `updatedAt` is the input to the
 * "Recently updated" sort, to the synthesized thumbnail's `?v=` cache
 * buster, and to housekeeping's stale-item and quiet-item sweeps, all
 * of which read it as "somebody changed this". A read that stamps it
 * makes every viewed item look freshly edited and permanently
 * un-stale, which is the opposite of what `last_usage_at` was added to
 * measure. The schema comment on `last_usage_at` says it is tracked
 * "alongside item.updatedAt"; `@updatedAt` was quietly collapsing the
 * two into one signal.
 *
 * `@updatedAt` cannot be opted out of per call, so the write has to go
 * around the client. Keep it that way: switching this back to
 * `prisma.item.update` reintroduces the bug silently, because nothing
 * type-checks the difference.
 */
/** Most items the throttle remembers before it forgets expired ones. */
const MAX_TRACKED = 10_000;

export class LastUsageStamp {
  private readonly writtenAt = new Map<string, number>();

  /**
   * @param throttleMs Per-process, per-item floor between writes. The
   *   map is deliberately in-memory: with two prod replicas each keeps
   *   its own window, so the effective rate is one write per window per
   *   replica, which is well inside what the column needs to be useful.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly log: Logger,
    private readonly throttleMs: number,
  ) {}

  /**
   * Record usage of `itemId`. Fire-and-forget by design: a slow write
   * must not add latency to the read that triggered it, and a failed
   * stamp is not worth failing the request over.
   */
  stamp(itemId: string, now = Date.now()): void {
    const key = itemId.toLowerCase();
    const last = this.writtenAt.get(key) ?? 0;
    if (now - last < this.throttleMs) return;
    if (this.writtenAt.size >= MAX_TRACKED) this.prune(now);
    this.writtenAt.set(key, now);

    this.prisma
      .$executeRaw`UPDATE "item" SET "last_usage_at" = ${new Date(
        now,
      )} WHERE "id" = ${itemId}::uuid`.catch((err: unknown) => {
      // Roll the throttle back so the next read retries rather than
      // waiting out a window we never actually wrote.
      this.writtenAt.delete(key);
      this.log.warn(
        `last_usage_at stamp failed for item=${itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Bound the map. Entries past their window carry no information, so
   * drop those first; if that is not enough, drop the oldest. Without
   * this the map grew by one entry per item ever opened, forever.
   */
  private prune(now: number): void {
    for (const [k, at] of this.writtenAt) {
      if (now - at >= this.throttleMs) this.writtenAt.delete(k);
    }
    while (this.writtenAt.size >= MAX_TRACKED) {
      const oldest = this.writtenAt.keys().next().value as string;
      this.writtenAt.delete(oldest);
    }
  }

  /** For tests. */
  get trackedCount(): number {
    return this.writtenAt.size;
  }
}
