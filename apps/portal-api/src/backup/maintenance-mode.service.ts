// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Flag that the restore flow raises while it is actively rewriting
 * the database + object store. A global middleware reads it and
 * short-circuits unrelated requests with 503 so a live user session
 * can't race a destructive restore.
 *
 * The flag is backed by a `system_setting` row (key `maintenance`)
 * and mirrored into an in-memory cache refreshed on a short poll, so
 * the middleware stays a synchronous boolean read while BOTH
 * portal-api replicas honour a restore triggered on either of them.
 * The earlier in-memory-only flag quiesced only the replica that
 * received the restore POST; the other kept serving reads and writes
 * against a schema being dropped. Prod runs two replicas.
 *
 * The replica that triggers a restore sets its own cache immediately
 * (so it is in maintenance before the first poll), and the DB write
 * propagates to the other replica within one poll interval.
 */
const MAINTENANCE_KEY = 'maintenance';

/** A host restore creates this file before it writes and deletes it
 *  only after every component is restored. While the file exists the
 *  API stays in maintenance even if the database flag was replaced
 *  by a dump. An unreadable path fails closed. */
export function recoveryMaintenanceFileActive(
  file: string | undefined = process.env.GRATIS_RECOVERY_MAINTENANCE_FILE,
): boolean {
  if (!file) return false;
  // statSync, not existsSync: existsSync answers false for EACCES,
  // ENOTDIR or an unmounted volume, which let a replica serve a
  // half-restored database. Only "no such file" means no hold.
  try {
    statSync(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Marker the in-portal restore writes before pg_restore starts and
 * removes only after the restore finished. It lives in BACKUP_DIR,
 * the volume every portal-api replica mounts, so the other replica
 * stays in maintenance while pg_restore replaces `system_setting`
 * (which drops the maintenance row and then loads the archive's own
 * inactive row). A process that dies mid-restore leaves the marker,
 * so the portal stays in maintenance after a restart.
 */
export function restoreMarkerPath(
  backupDir: string = process.env.BACKUP_DIR || './backups',
): string {
  return path.join(path.resolve(backupDir), '.restore-in-progress');
}

/** True when the maintenance reason is a failed-restore hold. */
export function failedRestore(reason: string | null): boolean {
  if (!reason) return false;
  return /restore/i.test(reason) && /fail|inconsistent/i.test(reason);
}

const POLL_MS = 2_000;

type MaintenanceValue = {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
};

@Injectable()
export class MaintenanceModeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceModeService.name);
  private active = false;
  private reason: string | null = null;
  private startedAt: Date | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** Process-local hold for the replica running a restore. The 2 s
   *  poll cannot clear it, so a `system_setting` table that pg_restore
   *  dropped or reloaded with `active:false` does not reopen this
   *  replica while the restore is still writing. */
  private localHold: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly leader?: LeaderElectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Leader crons pause while maintenance is on (restore running or
    // a failed restore holding the portal).
    this.leader?.pauseWhile(() => this.isActive());
    await this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, POLL_MS);
    // Never let the poll hold a process (or a Jest worker) open.
    this.pollTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  isActive(): boolean {
    return (
      this.active ||
      this.localHold !== null ||
      recoveryMaintenanceFileActive() ||
      recoveryMaintenanceFileActive(restoreMarkerPath())
    );
  }

  snapshot() {
    const file = recoveryMaintenanceFileActive();
    const marker = recoveryMaintenanceFileActive(restoreMarkerPath());
    let reason = this.reason;
    if (!reason && this.localHold) reason = this.localHold;
    if (!reason && marker) {
      reason =
        'An in-portal restore did not finish. The database may be inconsistent.';
    }
    if (!reason && file) reason = 'host recovery did not finish';
    return {
      active: this.active || this.localHold !== null || file || marker,
      reason,
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  /** True while this process is running a restore. */
  isHeldLocally(): boolean {
    return this.localHold !== null;
  }

  /**
   * Start a restore hold: a local hold the poll cannot clear, plus
   * the shared marker file. Throws if the marker cannot be written,
   * so a restore never starts without a crash-safe hold.
   */
  async beginRestoreHold(reason: string): Promise<void> {
    this.localHold = reason;
    try {
      const marker = restoreMarkerPath();
      await fs.mkdir(path.dirname(marker), { recursive: true });
      // Only presence matters. The body is a fixed payload plus a
      // server timestamp, never caller text: the reason can carry
      // request data, and this file sits on a shared volume an
      // operator reads by hand.
      await fs.writeFile(
        marker,
        `${JSON.stringify({ maintenance: true, phase: 'in-portal-restore', startedAt: new Date().toISOString() })}\n`,
        { flag: 'w' },
      );
    } catch (err) {
      this.localHold = null;
      throw err;
    }
  }

  /**
   * Write the maintenance row again. pg_restore replaced
   * `system_setting` with the archive's copy, which a normal backup
   * stores as inactive. Called right after pg_restore, never during
   * it: a row inserted before the data phase would make the COPY of
   * `system_setting` fail on its primary key.
   */
  async reassertHold(): Promise<void> {
    const reason = this.localHold ?? this.reason ?? 'Restoring a backup.';
    this.active = true;
    this.reason = reason;
    this.startedAt ??= new Date();
    await this.write({
      active: true,
      reason,
      startedAt: this.startedAt.toISOString(),
    });
  }

  /**
   * End the restore hold. `succeeded` removes the marker; after a
   * failure the marker stays so the portal stays in maintenance even
   * if the maintenance row cannot be written.
   */
  async endRestoreHold(succeeded: boolean): Promise<void> {
    if (succeeded) {
      await fs.rm(restoreMarkerPath(), { force: true });
    }
    this.localHold = null;
  }

  async activate(
    reason: string,
    opts: { replaceReason?: boolean } = {},
  ): Promise<void> {
    if (this.active && !opts.replaceReason) {
      this.log.warn(
        `activate() called while maintenance mode was already on (reason: ${this.reason}); keeping original reason + timestamp`,
      );
    } else {
      // Reflect locally at once so the triggering replica is in
      // maintenance before the next poll tick. replaceReason (#233)
      // lets a failed restore rewrite the banner without a gap of
      // deactivated maintenance.
      this.active = true;
      this.reason = reason;
      if (!opts.replaceReason || !this.startedAt) {
        this.startedAt = new Date();
      }
      this.log.warn(`Maintenance mode ON: ${reason}`);
    }
    await this.write({
      active: true,
      reason: this.reason,
      startedAt: (this.startedAt ?? new Date()).toISOString(),
    });
  }

  async deactivate(): Promise<void> {
    if (this.active) {
      this.log.log(
        `Maintenance mode OFF (was on for ${Math.round(
          (Date.now() - (this.startedAt?.getTime() ?? Date.now())) / 1000,
        )}s)`,
      );
    }
    this.active = false;
    this.reason = null;
    this.startedAt = null;
    await this.write({ active: false, reason: null, startedAt: null });
  }

  private applyValue(value: MaintenanceValue | null): void {
    if (!value || value.active !== true) {
      this.active = false;
      this.reason = null;
      this.startedAt = null;
      return;
    }
    this.active = true;
    this.reason = value.reason;
    this.startedAt = value.startedAt ? new Date(value.startedAt) : null;
  }

  private async refresh(): Promise<void> {
    try {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: MAINTENANCE_KEY },
      });
      this.applyValue((row?.value as MaintenanceValue | undefined) ?? null);
    } catch (err) {
      // Keep the last known state rather than flapping if the DB is
      // briefly unreachable. A restore that has already dropped the
      // schema is exactly when a read can fail, and losing the flag
      // then would reopen the portal mid-restore.
      this.log.warn(
        `maintenance-mode refresh failed, keeping last known state: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async write(value: MaintenanceValue): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: MAINTENANCE_KEY },
      create: { key: MAINTENANCE_KEY, value },
      update: { value },
    });
  }
}
