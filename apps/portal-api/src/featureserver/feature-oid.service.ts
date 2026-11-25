// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { RunAsSystem } from '../common/tenant-context.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dataLayerScopes, forgetItemOids } from './feature-oid.js';

/** Scopes backfilled per cron run, so a big install spreads the work. */
const SCOPES_PER_RUN = 20;
/** One scope's backfill may run long on a big layer; imports do the same. */
const BACKFILL_TX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Integer ObjectIDs for the Esri FeatureServer interface.
 *
 * New features are numbered by a database trigger as they are written
 * (see the feature_oid migration). Features written before that
 * migration are numbered here, one layer at a time: by the leader's
 * cron in the background, or on demand the first time a FeatureServer
 * request names a layer that has not been reached yet.
 */
@Injectable()
export class FeatureOidService {
  private readonly log = new Logger(FeatureOidService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
  ) {}

  @Cron('0 */10 * * * *', { name: 'feature-oid-backfill', timeZone: 'UTC' })
  @RunAsSystem('cron:feature-oid-backfill')
  async handleCron(): Promise<void> {
    if (!this.leader.shouldRun()) return;
    try {
      await this.backfillPending(SCOPES_PER_RUN);
    } catch (err) {
      this.log.warn(`ObjectID backfill failed: ${String(err)}`);
    }
  }

  /** Number up to `limit` data layer scopes not backfilled yet. */
  async backfillPending(limit: number): Promise<number> {
    const items = await this.prisma.item.findMany({
      where: { type: 'data_layer', deletedAt: null },
      select: { id: true, data: true },
    });
    const scopes = items.flatMap((i) => dataLayerScopes(i.id, i.data));
    if (scopes.length === 0) return 0;
    const done = await this.prisma.featureOidScope.findMany({
      where: { scope: { in: scopes } },
      select: { scope: true },
    });
    const doneSet = new Set(done.map((d) => d.scope));
    const pending = scopes.filter((s) => !doneSet.has(s)).slice(0, limit);
    for (const scope of pending) await this.ensureScope(scope);
    return pending.length;
  }

  /**
   * Make sure every feature ever written to `scope` has an ObjectID.
   * Idempotent and safe beside live writes: the trigger numbers new
   * features while this runs, and both skip what already has a number.
   * Older features are numbered in the order they were first written,
   * so ObjectIDs ascend with age within a layer.
   */
  async ensureScope(scope: string): Promise<void> {
    const marked = await this.prisma.featureOidScope.findUnique({ where: { scope } });
    if (marked) return;
    await this.prisma.$transaction(
      async (tx) => {
        // A layer of millions of features takes longer than the app
        // role's statement_timeout. Lift it for this transaction only.
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 0');
        await tx.$executeRaw`
          INSERT INTO feature_oid (scope, entity)
          SELECT ${scope}, s.entity
            FROM (
              SELECT o.entity, min(o.tx_time) AS first_at
                FROM observation o
               WHERE o.scope = ${scope}
               GROUP BY o.entity
            ) s
           WHERE NOT EXISTS (
             SELECT 1 FROM feature_oid f WHERE f.scope = ${scope} AND f.entity = s.entity
           )
           ORDER BY s.first_at, s.entity
          ON CONFLICT DO NOTHING`;
        await tx.featureOidScope.upsert({
          where: { scope },
          create: { scope },
          update: {},
        });
      },
      { maxWait: 10_000, timeout: BACKFILL_TX_TIMEOUT_MS },
    );
  }

  /** ObjectIDs for these entities, after making sure the scope is numbered. */
  async oidsFor(scope: string, entities: readonly string[]): Promise<Map<string, bigint>> {
    if (entities.length === 0) return new Map();
    await this.ensureScope(scope);
    const rows = await this.prisma.featureOid.findMany({
      where: { scope, entity: { in: [...entities] } },
      select: { entity: true, oid: true },
    });
    return new Map(rows.map((r) => [r.entity, r.oid]));
  }

  /** Entities for these ObjectIDs in one scope. An ObjectID from another
   *  layer is not found here, so it can never reach across layers. */
  async entitiesFor(scope: string, oids: readonly bigint[]): Promise<Map<bigint, string>> {
    if (oids.length === 0) return new Map();
    await this.ensureScope(scope);
    const rows = await this.prisma.featureOid.findMany({
      where: { scope, oid: { in: [...oids] } },
      select: { entity: true, oid: true },
    });
    return new Map(rows.map((r) => [r.oid, r.entity]));
  }

  /** Forget the numbers of every layer of a purged item. */
  async forgetItem(itemId: string): Promise<void> {
    await forgetItemOids(this.prisma, itemId);
  }
}
