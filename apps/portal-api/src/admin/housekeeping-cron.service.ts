import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import {
  HousekeepingScheduleService,
  type HousekeepingConfig,
} from './housekeeping-schedule.service.js';

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
 */
@Injectable()
export class HousekeepingCronService implements OnModuleInit {
  private readonly log = new Logger(HousekeepingCronService.name);
  private static readonly JOB_NAME = 'housekeeping-scheduled';

  constructor(
    private readonly schedule: HousekeepingScheduleService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    const cfg = await this.schedule.getConfig();
    this.apply(cfg);
    this.schedule.onConfigChange((next) => this.apply(next));
  }

  private apply(cfg: HousekeepingConfig) {
    this.unregister();

    if (cfg.scheduleMode === 'off') {
      this.log.log(
        'Scheduled housekeeping is off; the manual /admin/housekeeping page still works.',
      );
      return;
    }
    if (!cfg.autoTrashEnabled && !cfg.autoDisableEnabled) {
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
    this.scheduler.addCronJob(HousekeepingCronService.JOB_NAME, job);
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
