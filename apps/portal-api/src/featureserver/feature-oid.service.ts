// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { RunAsSystem, runAsSystem } from '../common/tenant-context.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dataLayerScopes, forgetItemOids } from './feature-oid.js';

/** Scopes backfilled per cron run, so a big install spreads the work. */
const SCOPES_PER_RUN = 20;
/** One scope's backfill may run long on a big layer; imports do the same. */
const BACKFILL_TX_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * How long a FeatureServer request waits for its layer's backfill.
 * Small layers finish well inside this, so they work on first touch.
 * A big layer keeps numbering in the background and the request gets
 * a 503, so no request holds a connection for the whole backfill.
 */
export const REQUEST_BACKFILL_WAIT_MS = 15_000;
/** Shown to the client while a big layer is still being numbered. */
export const LAYER_PREPARING_MESSAGE =
  'This layer is being prepared for ArcGIS clients. Try again in a minute.';
/** Key namespace of the per-scope backfill lock, so its keys cannot
 *  match another advisory lock user's. */
const BACKFILL_LOCK_PREFIX = 'feature-oid-backfill|';

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
  /** Backfills running in this process, by scope. */
  private readonly running = new Map<string, Promise<void>>();

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
   * Make sure every feature ever written to `scope` has an ObjectID,
   * waiting as long as that takes. For the cron and other background
   * work; requests use `ensureScopeForRequest`.
   *
   * Idempotent and safe beside live writes: the trigger numbers new
   * features while this runs, and both skip what already has a number.
   * Older features are numbered in the order they were first written,
   * so ObjectIDs ascend with age within a layer.
   */
  async ensureScope(scope: string): Promise<void> {
    const running = this.running.get(scope);
    if (running) return running;
    if (await this.isMarked(scope)) return;
    await this.startBackfill(scope);
  }

  /**
   * As `ensureScope`, but waits at most `REQUEST_BACKFILL_WAIT_MS`.
   * When the backfill takes longer it carries on in the background and
   * this throws a 503, so the client tries again a little later.
   */
  async ensureScopeForRequest(scope: string): Promise<void> {
    if (!(await this.backfillWithin(scope, REQUEST_BACKFILL_WAIT_MS))) {
      throw new ServiceUnavailableException(LAYER_PREPARING_MESSAGE);
    }
  }

  /** True when the scope is numbered within `ms`, false when its
   *  backfill is still running (and keeps running) after that. */
  private async backfillWithin(scope: string, ms: number): Promise<boolean> {
    let backfill = this.running.get(scope);
    if (!backfill) {
      if (await this.isMarked(scope)) return true;
      backfill = this.startBackfill(scope);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([backfill.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async isMarked(scope: string): Promise<boolean> {
    return (await this.prisma.featureOidScope.findUnique({ where: { scope } })) !== null;
  }

  /**
   * Start the backfill of one scope, or join the one already running in
   * this process. ArcGIS Pro sends several queries per layer at once,
   * and each would otherwise start the same long transaction.
   */
  private startBackfill(scope: string): Promise<void> {
    const running = this.running.get(scope);
    if (running) return running;
    // Numbering a layer is not work for the user whose request started
    // it, and it can outlive that request.
    const backfill = runAsSystem('feature-oid-backfill', () => this.backfill(scope)).finally(() => {
      this.running.delete(scope);
    });
    this.running.set(scope, backfill);
    // A request that stopped waiting no longer listens for the result.
    // Log a failure here so it is never an unhandled rejection. The
    // scope stays unmarked, so the next request or cron run retries.
    backfill.catch((err: unknown) => {
      this.log.warn(`ObjectID backfill of ${scope} failed: ${String(err)}`);
    });
    return backfill;
  }

  private async backfill(scope: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // A layer of millions of features takes longer than the app
        // role's statement_timeout. Lift it for this transaction only.
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 0');
        // One backfill per scope across every API replica. Released at
        // commit or rollback. $executeRaw because the lock returns void.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BACKFILL_LOCK_PREFIX + scope}, 0))`;
        // Another replica may have finished this scope while we waited.
        if (await tx.featureOidScope.findUnique({ where: { scope } })) return;
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

  /**
   * ObjectIDs for these entities. Its one caller asks for features an
   * edit just wrote, which the trigger numbered already. So when the
   * scope's backfill outlasts the short request wait, or fails (it is
   * logged), this still answers instead of throwing.
   * Failing here would report a committed edit as failed, and a client
   * that retried it would add the features twice.
   */
  async oidsFor(scope: string, entities: readonly string[]): Promise<Map<string, bigint>> {
    if (entities.length === 0) return new Map();
    await this.backfillWithin(scope, REQUEST_BACKFILL_WAIT_MS).catch(() => false);
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
    await this.ensureScopeForRequest(scope);
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
