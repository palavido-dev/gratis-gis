// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
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
 * The job is registered only when the config actually has work to
 * do: scheduleMode != 'off' AND at least one of auto-trash /
 * auto-disable is enabled. This avoids spinning a cron just to do
 * nothing every night.
 *
 * Why onApplicationBootstrap and not onModuleInit (#366): the
 * leader lock is acquired asynchronously inside
 * LeaderElectionService.onModuleInit, and Nest does not strictly
 * serialize onModuleInit hooks across modules even when the import
 * graph looks like it should. Gating from onModuleInit raced the
 * leader-lock query and silently skipped cron registration on the
 * eventual leader, leaving housekeeping un-scheduled until the
 * next deploy. onApplicationBootstrap fires only after every
 * module's onModuleInit chain has resolved, so leader.shouldRun()
 * has its final value. Same fix shipped in
 * KeycloakAdminService for the same reason.
 */
@Injectable()
export class HousekeepingCronService implements OnApplicationBootstrap {
  private readonly log = new Logger(HousekeepingCronService.name);
  private static readonly JOB_NAME = 'housekeeping-scheduled';

  constructor(
    private readonly schedule: HousekeepingScheduleService,
    private readonly scheduler: SchedulerRegistry,
    private readonly leader: LeaderElectionService,
  ) {}

  async onApplicationBootstrap() {
    // Multi-replica safety: only the leader registers and runs the
    // cron. Followers skip registration entirely so the dynamic
    // SchedulerRegistry cron doesn't fire on every replica. We
    // re-evaluate on config changes either way; a config change
    // received by a follower replica is a no-op (apply() short-
    // circuits below).
    // Register by leadership alone. shouldRun() is false while
    // maintenance is on, and a leader that booted mid-restore (crash
    // left the marker) would otherwise never register its schedule:
    // clearing the marker without a restart would leave it off for
    // good. Each run checks shouldRun() instead.
    if (!this.leader.holdsLock()) {
      this.log.log(
        'Skipping housekeeping cron registration on this replica (not the cron leader).',
      );
      // Subscribe to config changes anyway so a future leader handoff
      // would pick up the latest config -- safe because apply() also
      // gates on holdsLock.
      this.schedule.onConfigChange((next) => this.apply(next));
      return;
    }
    const cfg = await this.schedule.getConfig();
    this.apply(cfg);
    this.schedule.onConfigChange((next) => this.apply(next));
  }

  private apply(cfg: HousekeepingConfig) {
    if (!this.leader.holdsLock()) return;
    this.unregister();

    if (cfg.scheduleMode === 'off') {
      this.log.log(
        'Scheduled housekeeping is off; the manual /admin/housekeeping page still works.',
      );
      return;
    }
    if (
      !cfg.autoTrashEnabled &&
      !cfg.autoDisableEnabled &&
      !cfg.recomputeExtentsEnabled
    ) {
      this.log.log(
        'Schedule set but no auto-actions enabled; nothing to register.',
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
    // Per-run gate: leadership can move, and maintenance pauses runs.
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
