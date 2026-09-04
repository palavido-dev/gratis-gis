// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

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
    const last = this.writtenAt.get(itemId) ?? 0;
    if (now - last < this.throttleMs) return;
    this.writtenAt.set(itemId, now);

    this.prisma
      .$executeRaw`UPDATE "item" SET "last_usage_at" = ${new Date(
        now,
      )} WHERE "id" = ${itemId}::uuid`.catch((err: unknown) => {
      // Roll the throttle back so the next read retries rather than
      // waiting out a window we never actually wrote.
      this.writtenAt.delete(itemId);
      this.log.warn(
        `last_usage_at stamp failed for item=${itemId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}
