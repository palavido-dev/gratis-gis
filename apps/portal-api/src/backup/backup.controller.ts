// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Optional,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
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
import {
  AllowWhenBackupUiDisabled,
  BackupUiEnabledGuard,
  backupUiDisabled,
} from './backup-ui-switch.js';
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
import { OffsiteService } from './offsite.service.js';
import { RestoreTestService } from './restore-test.service.js';

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

/**
 * Off-site settings patch. Secrets are write-only: the response never
 * echoes them, and an omitted secret keeps the saved one.
 */
export class UpdateOffsiteDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsBoolean()
  enabled?: boolean | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300)
  endpoint?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  region?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(63)
  bucket?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  prefix?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsBoolean()
  pathStyle?: boolean | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(256)
  accessKeyId?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(512)
  secretAccessKey?: string | null;

  /** The admin's public key (ggpub1:...). Never a private key. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  publicKey?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(3650)
  retentionDays?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(90)
  alertDays?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1)
  mirrorThresholdBytes?: number | null;
}

/** "Take over this folder": the start of the install id that owns it now. */
export class TakeOverOffsiteDto {
  @IsString() @MaxLength(40)
  owner!: string;
}

/** "Check my key": a public key or its fingerprint, pasted again. */
export class CheckOffsiteKeyDto {
  @IsString() @MaxLength(200)
  value!: string;
}

/** "Check my verify key": a verify key or its fingerprint, pasted again. */
export class CheckOffsiteVerifyKeyDto {
  @IsString() @MaxLength(400)
  value!: string;
}

/** Start a backup test; confirmBytes when free space cannot be measured. */
export class StartRestoreTestDto {
  @IsOptional() @IsInt() @Min(0)
  confirmBytes?: number;
}

/** BigInt columns of a run as strings, for JSON. */
function serializeRun<T extends { sizeBytes: bigint | null; offsiteBytes?: bigint | null }>(r: T) {
  return {
    ...r,
    sizeBytes: r.sizeBytes === null ? null : r.sizeBytes.toString(),
    offsiteBytes:
      r.offsiteBytes === null || r.offsiteBytes === undefined ? null : r.offsiteBytes.toString(),
  };
}

@ApiTags('admin', 'backup')
@ApiBearerAuth()
// GRATIS_DISABLE_BACKUP_UI closes every route here except the
// availability probe the web uses to hide the page.
@UseGuards(AdminGuard, OperatorOrgGuard, BackupUiEnabledGuard)
@Controller('admin/backup')
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly restore: BackupRestoreService,
    private readonly mode: MaintenanceModeService,
    private readonly prisma: PrismaService,
    private readonly mail: EmailTransport,
    @Optional() private readonly audit?: AdminAuditService,
    // Optional only so older specs can build the controller without
    // them; the module always provides both.
    @Optional() private readonly offsiteService?: OffsiteService,
    @Optional() private readonly restoreTestService?: RestoreTestService,
  ) {}

  private offsite(): OffsiteService {
    if (!this.offsiteService) throw new Error('Off-site backups are not available.');
    return this.offsiteService;
  }

  private restoreTest(): RestoreTestService {
    if (!this.restoreTestService) throw new Error('Backup tests are not available.');
    return this.restoreTestService;
  }

  private readonly recoveryAnnounced = new Set<string>();

  private note(
    user: AuthUser,
    action:
      | 'backup.config'
      | 'backup.run'
      | 'backup.restore'
      | 'backup.cancel'
      | 'backup.delete'
      | 'backup.offsite'
      | 'backup.test',
    targetId: string,
    outcome: 'succeeded' | 'failed',
    detail?: Record<string, string | number | boolean | null>,
  ): void {
    if (!this.audit) return;
    void this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action,
      targetType: 'backup',
      targetId,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  /** Whether this install turned the backup surface off. */
  @Get('availability')
  @AllowWhenBackupUiDisabled()
  availability() {
    return { disabled: backupUiDisabled() };
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
    return runs.map((r) => serializeRun(r));
  }

  @Post('runs')
  async runNow(@CurrentUser() user: AuthUser) {
    const run = await this.backup.runBackup('manual', user.id);
    // runBackup returns a failed or cancelled run instead of throwing.
    this.note(user, 'backup.run', run.id, run.status === 'succeeded' ? 'succeeded' : 'failed');
    return serializeRun(run);
  }

  // ---------------------------------------------------------------
  // Off-site copies
  // ---------------------------------------------------------------

  /** Settings and status. Secrets appear only as "set" flags. */
  @Get('offsite')
  getOffsite() {
    return this.offsite().getPublicConfig();
  }

  @Patch('offsite')
  async updateOffsite(@CurrentUser() user: AuthUser, @Body() dto: UpdateOffsiteDto) {
    const updated = await this.offsite().updateConfig(dto, user.id);
    const change = updated.savedKeyChange;
    // A changed public key is written to the audit log with both
    // fingerprints (they are not secret).
    this.note(
      user,
      'backup.offsite',
      user.orgId,
      'succeeded',
      change
        ? {
            keyChanged: true,
            oldKeyFingerprint: change.from ?? 'none',
            newKeyFingerprint: change.to ?? 'none',
          }
        : undefined,
    );
    return updated;
  }

  /**
   * After a restore on a new server: make this portal the owner of the
   * bucket folder the old one wrote to. The admin types the start of
   * the old install id, which the refusal message shows.
   */
  @Post('offsite/take-over')
  @HttpCode(200)
  async takeOverOffsite(@CurrentUser() user: AuthUser, @Body() dto: TakeOverOffsiteDto) {
    const res = await this.offsite().takeOverFolder(dto.owner);
    this.note(user, 'backup.offsite', user.orgId, 'succeeded', {
      folderTakenOverFrom: res.previousOwner,
    });
    return res;
  }

  /** Write, list and delete one small file in the bucket. */
  @Post('offsite/test')
  testOffsite() {
    return this.offsite().testConnection();
  }

  /**
   * Compare a pasted public key or fingerprint with the key off-site
   * copies are encrypted to. The pasted text is not stored or logged.
   */
  @Post('offsite/check-key')
  @HttpCode(200)
  checkOffsiteKey(@Body() dto: CheckOffsiteKeyDto) {
    return this.offsite().checkKey(dto.value);
  }

  /**
   * Make a new signing key for off-site copies. The old verify key stays
   * trusted for the copies it signed. Audited with both fingerprints
   * (they are not secret); the operator admins get a notice. The
   * private half is never in the answer.
   */
  @Post('offsite/signing-key')
  @HttpCode(200)
  async replaceOffsiteSigningKey(@CurrentUser() user: AuthUser) {
    const res = await this.offsite().replaceSigningKey(user.id, 'admin');
    this.note(user, 'backup.offsite', user.orgId, 'succeeded', {
      signingKeyChanged: true,
      oldVerifyKeyFingerprint: res.from ?? 'none',
      newVerifyKeyFingerprint: res.to,
    });
    return { signing: await this.offsite().signingInfo() };
  }

  /**
   * Compare a pasted verify key or fingerprint with the key off-site
   * copies are signed with. The pasted text is not stored or logged.
   */
  @Post('offsite/check-verify-key')
  @HttpCode(200)
  checkOffsiteVerifyKey(@Body() dto: CheckOffsiteVerifyKeyDto) {
    return this.offsite().checkVerifyKey(dto.value);
  }

  /** Upload one finished backup again. Answers once it has started. */
  @Post('runs/:id/offsite')
  async retryOffsite(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.offsite().retry(id);
    this.note(user, 'backup.offsite', id, 'succeeded');
    return { started: true };
  }

  // ---------------------------------------------------------------
  // Test latest backup (scratch restore)
  // ---------------------------------------------------------------

  /** Database size and free space, so the page can warn before a test. */
  @Get('restore-tests/preflight')
  restoreTestPreflight() {
    return this.restoreTest().preflight();
  }

  /** Restore the newest archive's database into a scratch database. */
  @Post('restore-tests')
  async startRestoreTest(@CurrentUser() user: AuthUser, @Body() dto: StartRestoreTestDto) {
    const test = await this.restoreTest().start(user.id, dto.confirmBytes ?? null);
    this.note(user, 'backup.test', test.id, 'succeeded');
    return test;
  }

  @Get('restore-tests')
  listRestoreTests() {
    return this.restoreTest().recent(10);
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
    const { size } = await stat(p);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    // pipeline, not pipe: pipe left the file open after an aborted
    // download (holding a deleted archive's space) and never ended
    // the response on a read error. pipeline closes both ends.
    try {
      await pipeline(createReadStream(p), res);
    } catch {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    }
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
