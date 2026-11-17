// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * OSM cache-scrub cron (#100, wave 2).
 *
 * The osm-query SourceRef caches Overpass responses by hash into the
 * OsmQueryCache table; the underlying features land in the
 * observation log under a scope of `osm:<hash>`. Without a scrub job
 * the cache table grows unbounded and the observation log keeps
 * holding rows for queries no one re-runs. This service walks the
 * expired cache rows on a fixed schedule and removes both the cache
 * entry and its observation rows.
 *
 * Multi-replica safety: only the cron leader runs the scrub. The
 * follower replicas skip the registration entirely (the cron
 * decorator still binds, but the body short-circuits via the leader
 * check on every fire).
 *
 * Deletion strategy: a plain `DELETE FROM observation WHERE scope =
 * $1` is the obvious approach, but per the OSM hotfix on 2026-05-25
 * that pattern hit statement_timeout on partitioned observation
 * tables. Instead we delete in 5,000-row chunks until the scope is
 * empty so each statement stays well inside the per-request budget.
 * 50k features = 10 chunks per scope, ~250ms each in prod.
 *
 * Idempotency: an expired-and-already-empty cache row is safe to
 * delete again; we just delete zero observation rows and proceed.
 */
@Injectable()
export class OsmScrubService implements OnApplicationBootstrap {
  private readonly log = new Logger(OsmScrubService.name);
  /** Per-statement row cap; keeps each chunk inside statement_timeout. */
  private static readonly CHUNK_SIZE = 5000;
  /** Per-run cap on number of expired scopes processed. Bounded so a
   *  single run never holds the pool open arbitrarily long. */
  private static readonly MAX_SCOPES_PER_RUN = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly _scheduler: SchedulerRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Leadership only: the hourly tick checks shouldRun() itself, so
    // maintenance at boot must not log the scrub as disabled.
    if (!this.leader.holdsLock()) {
      this.log.log(
        'OSM cache scrub disabled on this replica (not the cron leader).',
      );
      return;
    }
    this.log.log('OSM cache scrub enabled on this replica (cron leader).');
  }

  /**
   * Hourly tick. Picks at most MAX_SCOPES_PER_RUN expired cache
   * entries, removes the underlying observation rows in chunks, and
   * deletes the cache rows. Anything still expired after this run
   * gets picked up on the next tick.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'osm-cache-scrub' })
  async scrubExpired(): Promise<void> {
    if (!this.leader.shouldRun()) return;
    const now = new Date();
    let totalCacheDeleted = 0;
    let totalObsDeleted = 0;

    // Read a bounded list of expired rows. Order by oldest first so
    // a hot cache (lots of new entries) doesn't starve the truly-
    // stale scopes from getting cleaned up.
    const expired = await this.prisma.osmQueryCache.findMany({
      where: { expiresAt: { lt: now } },
      select: { hash: true, scope: true, expiresAt: true },
      orderBy: { expiresAt: 'asc' },
      take: OsmScrubService.MAX_SCOPES_PER_RUN,
    });

    if (expired.length === 0) return;

    for (const row of expired) {
      // Claim the row first, and only while it is still expired. A
      // resolve of the same query may have refreshed it since the list
      // was read; purging then left a fresh cache row over a half
      // deleted scope.
      const claimed = await this.prisma.osmQueryCache.deleteMany({
        where: { hash: row.hash, expiresAt: { lt: now } },
      });
      if (claimed.count === 0) continue;
      totalCacheDeleted += 1;
      try {
        const obsCount = await this.purgeScope(row.scope);
        totalObsDeleted += obsCount;
      } catch (err) {
        // Put the expired row back so the next tick retries the purge;
        // without it the scope's rows would have nothing pointing at
        // them and would never be reclaimed.
        await this.prisma.osmQueryCache
          .upsert({
            where: { hash: row.hash },
            create: {
              hash: row.hash,
              scope: row.scope,
              presetIds: [],
              bbox: [],
              featureCount: 0,
              endpoint: '',
              fetchedAt: row.expiresAt,
              expiresAt: row.expiresAt,
            },
            update: {},
          })
          .catch(() => undefined);
        // One scope failing should not stop the whole run. Log and
        // continue; the row stays expired and will be retried next
        // tick.
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `OSM scrub: failed to purge scope ${row.scope}: ${msg}`,
        );
      }
    }

    if (totalCacheDeleted > 0 || totalObsDeleted > 0) {
      this.log.log(
        `OSM scrub: removed ${totalCacheDeleted} cache rows and ${totalObsDeleted} observation rows (${expired.length} scopes inspected).`,
      );
    }
  }

  /**
   * Delete every observation row for a single scope, in 5,000-row
   * chunks so each statement stays inside statement_timeout. Returns
   * the total number of rows removed.
   *
   * Rows are matched by primary key (id, tx_time) AND scope. Never by
   * ctid: observation is partitioned by tx_time, a ctid is only unique
   * inside one partition, and `WHERE ctid IN (...)` on the parent
   * deleted whatever row sat at the same physical slot in every other
   * monthly partition, which were user data layer rows. The scope
   * predicate on the outer DELETE is a second guard: whatever the
   * subquery returns, only this scope's rows can go.
   */
  async purgeScope(scope: string): Promise<number> {
    // Only OSM cache scopes may be purged here. A cache row is written
    // by OsmService with `osm:<hash>`; anything else (a damaged row, a
    // future writer) must never reach a bulk delete of user data.
    if (!/^osm:[A-Za-z0-9_-]+$/.test(scope)) {
      throw new Error(`refusing to purge non-OSM scope ${JSON.stringify(scope)}`);
    }
    let total = 0;
    // Hard upper bound: 200 chunks * 5000 rows = 1M rows per scope
    // per run. Anything larger than that is almost certainly a
    // misconfigured scope (no individual OSM result hits this cap;
    // the maxFeatures cap in OsmService is 50k). Bound exists so a
    // pathological row can't spin this method forever.
    for (let i = 0; i < 200; i += 1) {
      const deleted: number = await this.prisma.$executeRaw(
        Prisma.sql`DELETE FROM observation
          WHERE scope = ${scope}
            AND (id, tx_time) IN (
              SELECT id, tx_time FROM observation
              WHERE scope = ${scope}
              LIMIT ${OsmScrubService.CHUNK_SIZE})`,
      );
      total += deleted;
      if (deleted < OsmScrubService.CHUNK_SIZE) break;
    }
    return total;
  }
}
