// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupService, type BackupConfig } from './backup.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';

/**
 * Registers the scheduled backup job and keeps it in sync with the
 * admin-editable config. We own the single CronJob identity under
 * SchedulerRegistry; BackupService.onConfigChange lets the admin
 * form push a new expression here and we tear down + re-register
 * without a restart.
 *
 * Mode === 'off' means no job at all: we deregister whatever's
 * running and don't register a replacement. Flipping back to 'daily'
 * (or whatever) from the admin form re-registers from scratch.
 *
 * Why onApplicationBootstrap and not onModuleInit (#366): the
 * leader lock is acquired asynchronously inside
 * LeaderElectionService.onModuleInit, and Nest does not strictly
 * serialize onModuleInit hooks across modules. We previously raced
 * the leader-lock query on some boots and silently skipped cron
 * registration on the eventual leader. onApplicationBootstrap fires
 * after every module's onModuleInit chain has resolved, so
 * leader.shouldRun() has its final value. Mirrors the fix in
 * HousekeepingCronService and KeycloakAdminService.
 */
@Injectable()
export class BackupCronService implements OnApplicationBootstrap {
  private readonly log = new Logger(BackupCronService.name);
  private static readonly JOB_NAME = 'backup-scheduled';
  /** One minute: a dead run is visible in the UI within a poll or
   *  two of the five-minute liveness threshold expiring. */
  private static readonly RECLAIM_INTERVAL_MS = 60_000;
  private reclaimTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly backup: BackupService,
    private readonly scheduler: SchedulerRegistry,
    private readonly leader: LeaderElectionService,
  ) {}

  async onApplicationBootstrap() {
    // Periodic dead-run sweep, registered on EVERY replica and gated
    // per tick. Leadership is re-verified continuously and can move
    // (the 0.9.17 fix), so tying this to the boot-time leader check
    // would freeze reclaim on the replica that happened to boot as
    // follower. The boot-time reclaim below still exists for the
    // common case; this timer is what catches a run whose process
    // dies WITHOUT a restart following it, and what flips the admin
    // page's "In progress" phantom to failed within minutes instead
    // of leaving it until the next boot.
    this.reclaimTimer = setInterval(() => {
      void (async () => {
        if (!this.leader.shouldRun()) return;
        try {
          const n = await this.backup.reclaimStaleRuns();
          if (n > 0) {
            this.log.warn(
              `Periodic sweep reclaimed ${n} dead backup run(s).`,
            );
          }
        } catch (e) {
          this.log.warn(
            `Periodic dead-run sweep failed: ${(e as Error).message}`,
          );
        }
      })();
    }, BackupCronService.RECLAIM_INTERVAL_MS);
    this.reclaimTimer.unref?.();

    // Multi-replica safety: only the leader registers the cron.
    // Backups write to the shared portal-api-backups volume, but the
    // pg_dump process itself is a heavyweight operation we never
    // want fanned out across replicas. The leader is the single
    // writer; followers handle download/list traffic and never
    // generate new archives.
    if (!this.leader.shouldRun()) {
      this.log.log(
        'Skipping backup cron registration on this replica (not the cron leader).',
      );
      this.backup.onConfigChange((next) => this.apply(next));
      return;
    }
    // Before scheduling anything, close out runs that a previous
    // process died in the middle of. Only runs whose liveness beat has
    // gone stale are touched, so a live backup can never be reclaimed.
    // Failure here must not stop the cron from registering: a missed
    // reclaim is a stale row, a missed registration is no backups at
    // all.
    try {
      const reclaimed = await this.backup.reclaimStaleRuns();
      if (reclaimed > 0) {
        this.log.warn(
          `Reclaimed ${reclaimed} abandoned backup run(s) on startup. ` +
            'Each was showing as "In progress" in the admin UI.',
        );
      }
    } catch (e) {
      this.log.error(
        `Stale-run reclaim failed: ${(e as Error).message}. ` +
          'Continuing to cron registration.',
      );
    }

    const cfg = await this.backup.getConfig();
    this.apply(cfg);
    this.backup.onConfigChange((next) => this.apply(next));
  }

  /**
   * Tear down the existing cron (if any) and register one that
   * matches the given effective config. Invalid cron expressions
   * are logged loudly and left un-registered; the admin can fix
   * them in the UI and save again without restarting the process.
   */
  private apply(cfg: BackupConfig) {
    if (!this.leader.shouldRun()) return;
    this.unregister();

    if (cfg.scheduleMode === 'off') {
      this.log.log(
        'Automatic backups are turned off; manual runs still work.',
      );
      return;
    }

    const expr = cfg.effectiveCron;
    if (!expr) {
      this.log.warn(
        `Schedule mode is "${cfg.scheduleMode}" but no cron expression ` +
          'resolved; scheduled backups will not run until the config is fixed.',
      );
      return;
    }

    let job: CronJob;
    try {
      job = new CronJob(expr, () => this.runSafely());
    } catch (e) {
      this.log.error(
        `Invalid cron expression "${expr}": ${(e as Error).message}. ` +
          'Scheduled backups will NOT run until this is fixed.',
      );
      return;
    }
    // cron@4 dropped `.running`; @nestjs/schedule's typing still
    // expects it. addCronJob only touches `.fireOnTick` at runtime
    // (which v4 keeps). Cast to bridge the type gap.
    this.scheduler.addCronJob(
      BackupCronService.JOB_NAME,
      job as unknown as Parameters<typeof this.scheduler.addCronJob>[1],
    );
    job.start();
    this.log.log(
      `Scheduled backup registered: ${cfg.scheduleSummary} (${expr})`,
    );
  }

  private unregister() {
    try {
      const existing = this.scheduler.getCronJob(BackupCronService.JOB_NAME);
      if (existing) {
        existing.stop();
        this.scheduler.deleteCronJob(BackupCronService.JOB_NAME);
      }
    } catch {
      // getCronJob throws when the name isn't registered; that's
      // fine on first boot and after an off→on transition.
    }
  }

  /**
   * Guarded wrapper so a thrown error inside runBackup doesn't kill
   * the cron timer.
   */
  private async runSafely() {
    try {
      const res = await this.backup.runBackup('scheduled', null);
      this.log.log(
        `Scheduled backup ${res.id} finished: status=${res.status}`,
      );
    } catch (e) {
      this.log.error(
        `Scheduled backup threw: ${(e as Error).message}`,
      );
    }
  }
}
