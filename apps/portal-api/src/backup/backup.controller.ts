// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';

import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  Optional,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Response } from 'express';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { AdminGuard } from '../admin/admin.guard.js';
import { OperatorOrgGuard } from './operator-org.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { BackupService } from './backup.service.js';
import {
  BackupRestoreService,
  RestoreNotStartedError,
} from './backup-restore.service.js';
import { MaintenanceModeService, failedRestore } from './maintenance-mode.service.js';
import { EmailTransport } from '../notifications/email-transport.js';
import {
  announceRecoveryFailure,
  readRecoveryStatus,
  recoveryBanner,
  shouldAnnounceRecovery,
} from './recovery-status.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Admin-only surface for the backup system. Scope: read config,
 * update config, list runs, start a run, download an archive,
 * delete a row. Restore lives in a separate flow (#62) because
 * mixing it into the same controller invites finger-memory
 * mistakes between "download last good" and "overwrite everything".
 */

const SCHEDULE_MODES = ['off', 'daily', 'weekly', 'monthly', 'custom'] as const;

class RestoreConfirmDto {
  /** Must match the portal's display name (case-insensitive, trimmed).
   *  This catches the "wrong portal" finger-memory mistake: you can't
   *  accidentally restore Acme Corp's archive onto Beta Industries
   *  just by clicking the button. We compare to `org.name` instead of
   *  `org.slug` so the admin-facing prompt can use the same string
   *  they see in the top bar and on the login page. */
  @IsString() @MaxLength(200)
  confirmName!: string;
}

class UpdateConfigDto {
  // archiveDirectory: string | null: empty string / null clears the
  // override so the env BACKUP_DIR default comes back into play.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  archiveDirectory?: string | null;

  @IsOptional()
  @IsEnum(SCHEDULE_MODES)
  scheduleMode?: (typeof SCHEDULE_MODES)[number];

  @IsOptional() @IsInt() @Min(0) @Max(23)
  scheduleHour?: number;

  @IsOptional() @IsInt() @Min(0) @Max(59)
  scheduleMinute?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(0) @Max(6)
  scheduleDayOfWeek?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(1) @Max(28)
  scheduleDayOfMonth?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString() @MaxLength(120)
  customCron?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(1) @Max(1000)
  retentionCount?: number | null;
}

@ApiTags('admin', 'backup')
@ApiBearerAuth()
@UseGuards(AdminGuard, OperatorOrgGuard)
@Controller('admin/backup')
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly restore: BackupRestoreService,
    private readonly mode: MaintenanceModeService,
    private readonly prisma: PrismaService,
    private readonly mail: EmailTransport,
    @Optional() private readonly audit?: AdminAuditService,
  ) {}

  private readonly recoveryAnnounced = new Set<string>();

  private note(
    user: AuthUser,
    action: 'backup.config' | 'backup.run' | 'backup.restore' | 'backup.cancel' | 'backup.delete',
    targetId: string,
    outcome: 'succeeded' | 'failed',
  ): void {
    if (!this.audit) return;
    void this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action,
      targetType: 'backup',
      targetId,
      outcome,
    });
  }

  @Get('config')
  getConfig() {
    return this.backup.getConfig();
  }

  @Patch('config')
  async updateConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateConfigDto,
  ) {
    // Passing the whole DTO works because every key matches the
    // patch shape on the service side; the service itself does the
    // range / enum / cron-shape validation that class-validator
    // can't express cleanly.
    const updated = await this.backup.updateConfig(dto, user.id);
    this.note(user, 'backup.config', user.orgId, 'succeeded');
    return updated;
  }

  @Get('runs')
  async listRuns() {
    // BigInt doesn't JSON.stringify natively; cast sizeBytes to
    // string here so the admin page can format it without a runtime
    // surprise. (Keeping BigInt in the DB is still worth it: it's
    // the right domain type for "bytes of a backup archive".)
    // archiveOnDisk rides along so the page only offers Download /
    // Restore for archives that still exist.
    const runs = await this.backup.listRunsWithArchiveState();
    return runs.map((r) => ({
      ...r,
      sizeBytes: r.sizeBytes === null ? null : r.sizeBytes.toString(),
    }));
  }

  @Post('runs')
  async runNow(@CurrentUser() user: AuthUser) {
    const run = await this.backup.runBackup('manual', user.id);
    this.note(user, 'backup.run', run.id, 'succeeded');
    return {
      ...run,
      sizeBytes:
        run.sizeBytes === null ? null : (run.sizeBytes as bigint).toString(),
    };
  }

  /**
   * Stream the archive bytes back to the admin. Express needs the
   * @Res() escape hatch because Nest's JSON response pipeline
   * doesn't fit a multi-gigabyte binary download.
   */
  @Get('runs/:id/download')
  async download(
    @Param('id') id: string,
    @Res({ passthrough: false }) res: Response,
  ) {
    const { path: p, filename } = await this.backup.resolveArchivePath(id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    createReadStream(p).pipe(res);
  }

  /**
   * Ask a running backup to stop.
   *
   * This exists because Delete was previously the only per-run action,
   * so an admin wanting to stop a run reached for it, and it removed
   * the bookkeeping while pg_dump carried on writing. There was
   * nothing anywhere that could signal the work itself.
   */
  @Post('runs/:id/cancel')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.backup.requestCancel(id);
    this.note(user, 'backup.cancel', id, 'succeeded');
    return result;
  }

  /**
   * Age of the newest archive on disk. Answers the one question the
   * admin page could not: is this portal actually being backed up.
   */
  @Get('health')
  async health() {
    const base = await this.backup.getHealth();
    const recovery = await readRecoveryStatus(
      process.env.GRATIS_RECOVERY_STATUS_FILE,
    );
    const to = process.env.GRATIS_RECOVERY_NOTICE_TO;
    if (shouldAnnounceRecovery(this.recoveryAnnounced, recovery, to)) {
      try {
        await announceRecoveryFailure(this.mail, to!, recovery!);
      } catch {
        this.recoveryAnnounced.delete(
          `${recovery!.outcome}:${recovery!.phase}`,
        );
      }
    }
    return {
      ...base,
      recovery,
      recoveryBanner: recoveryBanner(recovery),
    };
  }

  @Delete('runs/:id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.backup.deleteRun(id);
    this.note(user, 'backup.delete', id, 'succeeded');
    return result;
  }

  // ---------------------------------------------------------------
  // Restore: separate namespace to keep the finger-memory hazard
  // ("I meant Delete, not Restore") away from the normal flow.
  // ---------------------------------------------------------------

  /**
   * Preview what the archive contains without touching anything.
   * The UI calls this first so the admin sees "you are about to
   * restore a backup from Tuesday with 340 items + 52 MB of
   * uploads" before hitting the scary button.
   */
  @Get('runs/:id/restore/preview')
  async restorePreview(@Param('id') id: string) {
    return this.restore.peekArchive(id);
  }

  /**
   * Execute the destructive restore. Admin must pass the current
   * org slug as `confirmSlug`: if it doesn't match, we refuse
   * before even reading the archive.
   */
  @Post('runs/:id/restore')
  async runRestore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RestoreConfirmDto,
  ) {
    // The portal's display name is the confirmation phrase. This is
    // the cheapest "are you sure?" gate that actually catches the
    // common mistake (wrong portal / wrong archive). Comparison is
    // case-insensitive and whitespace-trimmed, matching the client
    // so admins don't get bounced on a cap / trailing-space mismatch.
    const org = await this.prisma.organization.findFirst({
      where: { id: user.orgId },
      select: { name: true },
    });
    if (!org) {
      throw new BadRequestException('Could not resolve your organization.');
    }
    const typed = (dto.confirmName ?? '').trim().toLowerCase();
    const expected = org.name.trim().toLowerCase();
    if (typed !== expected) {
      throw new BadRequestException(
        `The name you typed doesn't match this portal's name. Expected "${org.name}".`,
      );
    }

    // While maintenance is on, a restore may start only to recover
    // from a failed one, and never while this replica is running one.
    // Any other maintenance (a restore in progress, an admin's manual
    // switch) refuses, as the middleware used to for every restore.
    const before = this.mode.snapshot();
    if (
      before.active &&
      (this.mode.isHeldLocally() || !failedRestore(before.reason))
    ) {
      throw new ConflictException(
        'Maintenance is on and no failed restore is waiting to be re-run. Wait for the current restore to finish, or turn maintenance off first.',
      );
    }

    // Refusals that need no maintenance window (a live backup, an
    // archive whose schema does not match this portal) come first,
    // so they never leave a failed-restore hold behind.
    await this.restore.preflight(id);

    // Flip maintenance mode BEFORE we touch anything; the global
    // middleware then 503s unrelated requests that are in flight or
    // arriving during the restore window. Awaited so the shared flag
    // is persisted (and the other replica will pick it up) before the
    // restore starts dropping the schema.
    // replaceReason when re-running after a failed restore: the
    // banner should say a restore is running, and the check above
    // then refuses a second one started on the other replica.
    await this.mode.activate(
      `Restoring backup ${id.slice(0, 8)}… Initiated by ${user.username ?? user.id.slice(0, 8)}.`,
      { replaceReason: before.active },
    );
    try {
      const audit = await this.restore.runRestore({
        runId: id,
        startedBy: user.id,
      });
      // Success only: drop maintenance so traffic resumes against a
      // consistent DB+bucket. #233: on failure we deliberately keep
      // maintenance on so a half-applied restore cannot serve users.
      await this.mode.deactivate();
      this.note(user, 'backup.restore', id, 'succeeded');
      return audit;
    } catch (err) {
      this.note(user, 'backup.restore', id, 'failed');
      if (err instanceof RestoreNotStartedError) {
        // Nothing was changed. Lift the maintenance this request
        // raised, unless maintenance was already on before it.
        if (!before.active) await this.mode.deactivate();
        else if (before.reason) {
          // Put the failed-restore hold back as it was.
          await this.mode.activate(before.reason, { replaceReason: true });
        }
        throw new ConflictException(err.message);
      }
      const msg = err instanceof Error ? err.message : String(err);
      await this.mode.activate(
        `Restore of backup ${id.slice(0, 8)} failed and left the portal in an inconsistent state. Maintenance stays on until an admin finishes or re-runs the restore. Last error: ${msg.slice(0, 300)}`,
        { replaceReason: true },
      );
      throw err;
    }
  }

  /** Status endpoint the UI polls while a restore is in flight. */
  @Get('restore/status')
  async restoreStatus() {
    const maintenance = this.restore.maintenanceSnapshot();
    const recent = await this.restore.recentRestores(5);
    return { maintenance, recent };
  }
}
