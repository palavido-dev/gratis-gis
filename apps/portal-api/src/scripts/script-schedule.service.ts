// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { CronJob } from 'cron';
import {
  buildScriptCron,
  normalizeScriptSchedule,
  summarizeScriptSchedule,
} from '@gratis-gis/shared-types';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ScriptsService } from './scripts.service.js';
import { isScriptsEnabled } from './scripts-config.js';

/** How often we re-read schedules from the database. */
const RECONCILE_MS = 60_000;

const jobName = (scriptId: string) => `script-scheduled:${scriptId}`;

/**
 * Runs `script` items on their own schedule (#221).
 *
 * Follows BackupCronService: dynamic CronJobs through SchedulerRegistry
 * rather than `@Cron`, because the expressions live in the database and
 * change without a restart. It differs in one way that shapes the whole
 * file. Backups and housekeeping are singletons, one job under one
 * fixed name. Scripts are many, and the set changes as people create,
 * edit, retype, trash, and restore items.
 *
 * So the source of truth is a periodic reconcile rather than a set of
 * invalidation hooks. Every path that could change a schedule would
 * otherwise need to remember to call us: the generic item PATCH, the
 * trash and restore endpoints, the bulk housekeeping actions, the
 * nightly golden restore that replaces the entire items table under a
 * running process. Wiring all of those is more code, and it is the kind
 * of code that is wrong the moment someone adds an eleventh path.
 * Re-reading the world once a minute cannot drift, and it self-heals
 * after the golden restore for free.
 *
 * The cost is that a schedule change takes up to a minute to take
 * effect. For something whose finest granularity is hourly, that is not
 * a cost worth engineering around.
 *
 * This runs in portal-api behind the leader lock, and only enqueues.
 * The claimer in portal-worker picks the row up exactly as it does for
 * the Run button, so scheduled and manual runs travel identical code
 * from that point on.
 */
@Injectable()
export class ScriptScheduleService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(ScriptScheduleService.name);
  /** scriptId to the cron expression currently registered for it. */
  private readonly registered = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scripts: ScriptsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly leader: LeaderElectionService,
  ) {}

  onApplicationBootstrap(): void {
    // onApplicationBootstrap, not onModuleInit: the leader lock is
    // acquired asynchronously and Nest does not serialize onModuleInit
    // across modules, so reading shouldRun() any earlier races it and
    // silently skips registration on the real leader (#366).
    if (!isScriptsEnabled()) {
      this.log.log('Scripts are off; no schedules registered.');
      return;
    }
    if (!this.leader.shouldRun()) {
      this.log.log(
        'Not the cron leader; script schedules run on another replica.',
      );
      return;
    }
    void this.reconcileSafely();
    this.timer = setInterval(() => void this.reconcileSafely(), RECONCILE_MS);
    // Never hold the process open for this.
    this.timer.unref();
    this.log.log(
      `Script schedules active, re-read every ${RECONCILE_MS / 1000}s.`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const scriptId of [...this.registered.keys()]) {
      this.unregister(scriptId);
    }
  }

  private async reconcileSafely(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.reconcile();
    } catch (err) {
      // A failed read must not kill the timer, and must not tear down
      // jobs that are still perfectly valid. Leaving the previous set
      // registered is the conservative failure: a script runs on the
      // schedule it had a minute ago.
      this.log.error(
        `Could not re-read script schedules: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async reconcile(): Promise<void> {
    // Raw, and selecting only the schedule sub-object, because the
    // Python source lives on the same JSON column and can be a quarter
    // of a megabyte per item. Pulling every script's whole body once a
    // minute to read five integers off it would be a silly amount of
    // traffic for a process that mostly serves requests.
    //
    // The ::"ItemType" cast is required: Prisma maps some enum members
    // to kebab-case, so the parameter would otherwise be compared as
    // text and error. Mirrors items.service.ts.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; schedule: unknown }>
    >(Prisma.sql`
      SELECT id, title, data_json -> 'schedule' AS schedule
        FROM item
       WHERE type = 'script'::"ItemType"
         AND deleted_at IS NULL
    `);

    const desired = new Map<string, { expr: string; title: string }>();
    for (const row of rows) {
      const schedule = normalizeScriptSchedule(row.schedule);
      const expr = buildScriptCron(schedule);
      if (!expr) continue;
      desired.set(row.id, { expr, title: row.title });
    }

    // Drop anything gone or changed. Snapshot the keys first: unregister
    // mutates the map we are walking.
    for (const scriptId of [...this.registered.keys()]) {
      const want = desired.get(scriptId);
      if (!want || want.expr !== this.registered.get(scriptId)) {
        this.unregister(scriptId);
      }
    }

    for (const [scriptId, want] of desired) {
      if (this.registered.has(scriptId)) continue;
      this.register(scriptId, want.expr, want.title);
    }
  }

  private register(scriptId: string, expr: string, title: string): void {
    let job: CronJob;
    try {
      job = new CronJob(expr, () => void this.fire(scriptId, title));
    } catch (err) {
      // Should be unreachable: the expression is synthesized from
      // clamped integers rather than typed by a human. Logged rather
      // than thrown anyway, because one bad script must not stop the
      // other schedules from being registered.
      this.log.error(
        `Script "${title}" (${scriptId}) produced an unusable schedule ` +
          `"${expr}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // cron@4 dropped `.running`; @nestjs/schedule's typing still expects
    // it. addCronJob only touches `.fireOnTick` at runtime. Same cast as
    // BackupCronService.
    this.scheduler.addCronJob(
      jobName(scriptId),
      job as unknown as Parameters<typeof this.scheduler.addCronJob>[1],
    );
    job.start();
    this.registered.set(scriptId, expr);
    this.log.log(`Scheduled "${title}": ${expr}`);
  }

  private unregister(scriptId: string): void {
    this.registered.delete(scriptId);
    try {
      const existing = this.scheduler.getCronJob(jobName(scriptId));
      if (existing) {
        existing.stop();
        this.scheduler.deleteCronJob(jobName(scriptId));
      }
    } catch {
      // getCronJob throws rather than returning undefined when the name
      // is unknown. Expected on first boot and after a schedule is
      // turned off.
    }
  }

  /**
   * One scheduled fire. Enqueues only; the claimer does the rest.
   *
   * Everything is swallowed and logged. A throw escaping a cron tick
   * takes down the timer for that job, which would turn one bad night
   * into a script that never runs again and never says why.
   */
  private async fire(scriptId: string, title: string): Promise<void> {
    if (this.stopping) return;
    // Re-check the leader on every tick, not just at registration. A
    // replica that lost the lock mid-life would otherwise keep firing
    // alongside the new leader and double every scheduled run.
    if (!this.leader.shouldRun()) return;
    try {
      const runId = await this.scripts.enqueueScheduled(scriptId);
      if (runId) {
        this.log.log(`Scheduled run queued for "${title}" (${runId}).`);
      }
    } catch (err) {
      this.log.error(
        `Scheduled run for "${title}" (${scriptId}) could not be queued: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Human-readable current state, for logs and tests. */
  describe(): Array<{ scriptId: string; cron: string }> {
    return [...this.registered.entries()].map(([scriptId, cron]) => ({
      scriptId,
      cron,
    }));
  }
}

export { summarizeScriptSchedule };
