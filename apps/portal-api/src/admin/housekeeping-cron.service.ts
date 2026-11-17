// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import {
  HousekeepingScheduleService,
  type HousekeepingConfig,
} from './housekeeping-schedule.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * Registers the scheduled-housekeeping cron job and keeps it in
 * sync with the admin-editable config. Mirrors BackupCronService:
 * we own a single CronJob identity in SchedulerRegistry and the
 * schedule service's onConfigChange listener triggers re-registration
 * without a process restart.
 *
 * The job is registered whenever scheduleMode != 'off'. Even with
 * every toggle off a run still has work: users past their explicit
 * end date are disabled and the Keycloak user mirror is reconciled,
 * neither of which has a toggle (03-7).
 *
 * Why onApplicationBootstrap and not onModuleInit (#366): the
 * leader lock is acquired asynchronously inside
 * LeaderElectionService.onModuleInit, and Nest does not strictly
 * serialize onModuleInit hooks across modules even when the import
 * graph looks like it should. Gating from onModuleInit raced the
 * leader-lock query and silently skipped cron registration on the
 * eventual leader, leaving housekeeping un-scheduled until the
 * next deploy. The schedule is now registered on every replica and
 * each tick checks leadership, because leadership can move at
 * runtime.
 */
@Injectable()
export class HousekeepingCronService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(HousekeepingCronService.name);
  private static readonly JOB_NAME = 'housekeeping-scheduled';
  /** Every replica re-reads housekeeping_config this often. */
  private static readonly CONFIG_POLL_MS = 60_000;
  private configTimer: ReturnType<typeof setInterval> | undefined;
  /** What the current job was built from; null before the first apply. */
  private appliedKey: string | null = null;
  /** Boot time, for the interrupted-run sweep window. */
  private readonly bootedAt = Date.now();
  private interruptedSwept = false;
  /**
   * The interrupted-run sweep waits for this replica to hold the
   * leader lock, which is taken asynchronously, but only this long
   * after boot. A replica that gains leadership much later did not
   * just restart, and a run in flight on the other replica is real.
   */
  private static readonly SWEEP_WINDOW_MS = 3 * 60_000;

  constructor(
    private readonly schedule: HousekeepingScheduleService,
    private readonly scheduler: SchedulerRegistry,
    private readonly leader: LeaderElectionService,
  ) {}

  async onApplicationBootstrap() {
    // Every replica registers the schedule and each tick checks
    // leadership (runSafely). Registering only on the boot-time leader
    // left housekeeping unscheduled once leadership moved, and kept
    // the ex-leader firing after a handoff.
    const cfg = await this.schedule.getConfig();
    this.apply(cfg);
    this.schedule.onConfigChange((next) => this.apply(next));
    await this.sweepInterruptedRuns();
    // A config save runs the listener only on the replica that served
    // it. Every replica re-reads the row on a short poll so a save
    // that landed on the other one still takes effect here.
    this.configTimer = setInterval(() => {
      void this.sweepInterruptedRuns();
      void this.schedule
        .getConfig()
        .then((next) => this.apply(next))
        .catch((e: unknown) =>
          this.log.warn(
            `Housekeeping config re-read failed: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }, HousekeepingCronService.CONFIG_POLL_MS);
    this.configTimer.unref?.();
  }

  /**
   * Once, on the leader, soon after boot: fail housekeeping runs a
   * dead process left 'running' (03-12).
   */
  async sweepInterruptedRuns(): Promise<void> {
    if (this.interruptedSwept) return;
    if (Date.now() - this.bootedAt > HousekeepingCronService.SWEEP_WINDOW_MS) {
      this.interruptedSwept = true;
      return;
    }
    if (!this.leader.shouldRun()) return;
    this.interruptedSwept = true;
    try {
      await this.schedule.failInterruptedRuns();
    } catch (e) {
      this.log.warn(
        `Interrupted housekeeping run sweep failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  onModuleDestroy() {
    if (this.configTimer) clearInterval(this.configTimer);
    this.unregister();
  }

  private apply(cfg: HousekeepingConfig) {
    // Re-register only when something that decides the job changed,
    // so the poll does not reset it every minute.
    const key = [
      cfg.scheduleMode,
      cfg.effectiveCron ?? '',
      cfg.autoTrashEnabled,
      cfg.autoDisableEnabled,
      cfg.recomputeExtentsEnabled,
      cfg.fieldQueueAutoPruneEnabled,
    ].join('|');
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    this.unregister();

    if (cfg.scheduleMode === 'off') {
      this.log.log(
        'Scheduled housekeeping is off; the manual /admin/housekeeping page still works.',
      );
      return;
    }
    const expr = cfg.effectiveCron;
    if (!expr) {
      this.log.warn(
        `Housekeeping schedule mode "${cfg.scheduleMode}" produced no cron expression; nothing registered.`,
      );
      return;
    }

    let job: CronJob;
    try {
      job = new CronJob(expr, () => this.runSafely());
    } catch (e) {
      this.log.error(
        `Invalid housekeeping cron expression "${expr}": ${(e as Error).message}.`,
      );
      return;
    }
    // cron@4 dropped the `.running` property that @nestjs/schedule's
    // CronJob<null, null> type still requires; addCronJob's runtime
    // path only reads `.fireOnTick`, which v4 keeps. Cast to bridge
    // the type gap until @nestjs/schedule catches up to cron@4.
    this.scheduler.addCronJob(
      HousekeepingCronService.JOB_NAME,
      job as unknown as Parameters<typeof this.scheduler.addCronJob>[1],
    );
    job.start();
    this.log.log(
      `Scheduled housekeeping registered: ${cfg.scheduleSummary} (${expr})`,
    );
  }

  private unregister() {
    try {
      const existing = this.scheduler.getCronJob(
        HousekeepingCronService.JOB_NAME,
      );
      if (existing) {
        existing.stop();
        this.scheduler.deleteCronJob(HousekeepingCronService.JOB_NAME);
      }
    } catch {
      // getCronJob throws when the name isn't registered; first
      // boot and off->on transitions land here.
    }
  }

  private async runSafely() {
    // Leadership is checked per tick: it can move at runtime.
    if (!this.leader.shouldRun()) return;
    try {
      const res = await this.schedule.runOnce({
        trigger: 'scheduled',
        startedBy: null,
      });
      this.log.log(
        `Scheduled housekeeping ${res.id} ${res.status}: ` +
          `trashed=${res.itemsTrashed} disabled=${res.usersDisabled}`,
      );
    } catch (e) {
      this.log.error(
        `Scheduled housekeeping threw: ${(e as Error).message}`,
      );
    }
  }
}
