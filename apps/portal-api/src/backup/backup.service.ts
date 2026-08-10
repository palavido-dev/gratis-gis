// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { writeTarGz, type TarEntry } from './tar-pack.js';

/**
 * Thrown when an admin asked a running backup to stop. Distinct from a
 * failure so the row can record "cancelled" rather than blaming
 * pg_dump for the SIGTERM we sent it.
 */
export class BackupCancelledError extends Error {
  constructor() {
    super('Backup cancelled by an administrator.');
    this.name = 'BackupCancelledError';
  }
}

/**
 * How often a running backup checks whether it has been asked to stop.
 * The poll is one indexed lookup by primary key; two seconds is
 * responsive to a human clicking Cancel while being nothing against a
 * run that streams tens of thousands of objects.
 */
const CANCEL_POLL_MS = 2000;

/**
 * A `running` row older than this is treated as abandoned rather than
 * as a reason to refuse a new backup. Without the bound, one killed
 * process would block every future run, which is the same ratchet that
 * gated retention behind success.
 */
const RUNNING_ROW_STALE_MS = 6 * 60 * 60 * 1000;

/** Human-readable bytes for operator-facing refusal messages. Local
 *  copy, matching tile-layer.service.ts and import.ts; not worth a
 *  shared module for three call sites in three unrelated features. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export type ScheduleMode = 'off' | 'daily' | 'weekly' | 'monthly' | 'custom';

/**
 * How old a `running` BackupRun has to be before startup treats it as
 * abandoned. Deliberately far beyond any real backup: the largest
 * archive on the demo is about 3 GB and seals in a few minutes, so six
 * hours cannot catch a live run even on a much slower host with a much
 * bigger bucket. See BackupService.reclaimStaleRuns.
 */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;

/**
 * User-facing config shape the admin page edits. All values are
 * effective values: i.e. the DB row merged over the env defaults
 * so the UI can show what's actually running without having to
 * know the fallback order.
 */
export interface BackupConfig {
  /** Absolute path where archives are written. */
  archiveDirectory: string;
  /** 'off' disables the scheduler entirely. */
  scheduleMode: ScheduleMode;
  /** Local-time hour of day (0-23) the scheduled run fires. */
  scheduleHour: number;
  scheduleMinute: number;
  /** Only meaningful when scheduleMode === 'weekly'. 0=Sun..6=Sat. */
  scheduleDayOfWeek: number | null;
  /** Only meaningful when scheduleMode === 'monthly'. 1-28. */
  scheduleDayOfMonth: number | null;
  /** Raw cron expression used when scheduleMode === 'custom'. */
  customCron: string | null;
  /** How many successful backups to keep before the oldest drops. */
  retentionCount: number;
  /** Display-only: a plain-English summary of the schedule. */
  scheduleSummary: string;
  /** Display-only: the cron expression the scheduler is actually
   *  registered with right now, or null when mode==='off'. */
  effectiveCron: string | null;
}

/**
 * Patch shape accepted by updateConfig(). Each field is optional;
 * omitted fields keep their current value. Null on archiveDirectory
 * / retentionCount / customCron explicitly clears the DB override
 * so the env default takes over again.
 */
export interface BackupConfigPatch {
  archiveDirectory?: string | null;
  scheduleMode?: ScheduleMode;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDayOfWeek?: number | null;
  scheduleDayOfMonth?: number | null;
  customCron?: string | null;
  retentionCount?: number | null;
}

/**
 * Layout of the JSON manifest dropped into every archive. Everything
 * a restore routine needs to know about the archive it's holding,
 * without having to parse the dump files.
 */
interface BackupManifest {
  /** Format version of the archive layout. Bump when the directory
   *  layout changes in a way that breaks older restore code. */
  version: 1;
  /** ISO timestamp the run started. */
  createdAt: string;
  /** 'manual' or 'scheduled'. */
  trigger: string;
  /** Portal app version from package.json (best-effort). */
  portalVersion: string | null;
  /** Database URL with password redacted. */
  databaseUrl: string;
  /** Names of the dumped databases, in archive order. */
  databases: string[];
  /** Whether MinIO objects are included, and how many. */
  minio: {
    bucket: string;
    objectCount: number;
    totalBytes: number;
  };
  /** Portal commit hash if available at runtime (GIT_SHA env). */
  gitSha: string | null;
}

/**
 * Core backup service: produces a .tar.gz containing a pg_dump of
 * the portal database + a flat copy of the MinIO bucket + a
 * manifest.json. One archive per run, written atomically to
 * BACKUP_DIR.
 *
 * Non-goals for this first cut (tracked under #59-restore):
 *   - Keycloak state: the dev compose uses KC_DB=dev-file (H2 inside
 *     the container, not persisted to a volume), so there's nothing
 *     stable to snapshot. Prod deployments with a JDBC Keycloak need
 *     a separate strategy; we surface this limitation clearly in the
 *     admin UI so nobody expects Keycloak users to survive a restore.
 *   - Encryption at rest: archives are plain .tar.gz. Operators that
 *     need encrypted offsite copies should wrap them with their own
 *     tooling (age, gpg, S3 SSE). We don't want to ship key material
 *     inside the app.
 *   - Incremental / differential backups: out of scope. Full dump
 *     every run keeps restore simple; retention handles the space.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly log = new Logger(BackupService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {
    // Reuse the same MinIO creds StorageService uses: if one works
    // the other does, which keeps the admin "backup failed" surface
    // from pointing at two different auth issues.
    const endpoint = cfg.get<string>('MINIO_ENDPOINT', 'http://localhost:9000');
    const accessKeyId = cfg.get<string>('MINIO_ACCESS_KEY', 'gratisgis');
    const secretAccessKey = cfg.get<string>('MINIO_SECRET_KEY', 'devpassword');
    this.bucket = cfg.get<string>('MINIO_BUCKET', 'gratisgis');
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  async onModuleInit() {
    // Ensure the archive directory exists at startup so a "Run now"
    // click doesn't race with a missing directory. If the operator
    // has pointed this at a path the process can't write to, we
    // want that failure to surface in the log before the first run.
    const config = await this.getConfig();
    try {
      await fs.mkdir(config.archiveDirectory, { recursive: true });
    } catch (e) {
      this.log.error(
        `Archive directory ${config.archiveDirectory} is not creatable; backups will fail until this is fixed: ${(e as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------
  // Config: DB row merged over env defaults
  // ---------------------------------------------------------------

  /**
   * Listener hook the cron service registers so it can re-register
   * its CronJob whenever the schedule changes. Keeps BackupService
   * from having to know about the scheduler directly.
   */
  private configListeners: Array<(cfg: BackupConfig) => void | Promise<void>> =
    [];
  onConfigChange(fn: (cfg: BackupConfig) => void | Promise<void>) {
    this.configListeners.push(fn);
  }

  /**
   * Fetch the effective config. Reads the singleton backup_config
   * row (creating it on first call) and merges it over env defaults.
   * Also computes display-only fields (plain-English summary,
   * effective cron) so the admin UI doesn't have to reproduce the
   * mapping logic.
   */
  async getConfig(): Promise<BackupConfig> {
    const row = await this.ensureConfigRow();
    const mode = (row.scheduleMode as ScheduleMode) ?? 'daily';
    const hour = row.scheduleHour;
    const minute = row.scheduleMinute;
    const dow = row.scheduleDayOfWeek;
    const dom = row.scheduleDayOfMonth;
    const customCron = row.customCron;
    const effectiveCron = this.buildCron({
      mode,
      hour,
      minute,
      dayOfWeek: dow,
      dayOfMonth: dom,
      customCron,
    });
    return {
      archiveDirectory:
        row.archiveDirectory && row.archiveDirectory.length > 0
          ? row.archiveDirectory
          : this.envBackupDir(),
      scheduleMode: mode,
      scheduleHour: hour,
      scheduleMinute: minute,
      scheduleDayOfWeek: dow,
      scheduleDayOfMonth: dom,
      customCron,
      retentionCount:
        row.retentionCount !== null && row.retentionCount > 0
          ? row.retentionCount
          : this.envRetentionCount(),
      scheduleSummary: this.summarizeSchedule({
        mode,
        hour,
        minute,
        dayOfWeek: dow,
        dayOfMonth: dom,
        customCron,
      }),
      effectiveCron,
    };
  }

  /**
   * Apply an admin patch. Writes the changed columns to the
   * singleton row, re-ensures the archive directory exists if the
   * admin moved it, and notifies any registered listeners (i.e. the
   * cron service) so the scheduler can pick up a new expression
   * without a restart.
   */
  async updateConfig(patch: BackupConfigPatch, updatedBy: string | null) {
    // Validate before we touch the DB: nothing worse than committing
    // half a change and then bailing.
    if (patch.scheduleMode && !this.isScheduleMode(patch.scheduleMode)) {
      throw new Error(`Unknown scheduleMode: ${patch.scheduleMode}`);
    }
    if (patch.scheduleHour !== undefined) {
      this.requireRange('scheduleHour', patch.scheduleHour, 0, 23);
    }
    if (patch.scheduleMinute !== undefined) {
      this.requireRange('scheduleMinute', patch.scheduleMinute, 0, 59);
    }
    if (patch.scheduleDayOfWeek !== undefined && patch.scheduleDayOfWeek !== null) {
      this.requireRange('scheduleDayOfWeek', patch.scheduleDayOfWeek, 0, 6);
    }
    if (patch.scheduleDayOfMonth !== undefined && patch.scheduleDayOfMonth !== null) {
      this.requireRange('scheduleDayOfMonth', patch.scheduleDayOfMonth, 1, 28);
    }
    if (patch.retentionCount !== undefined && patch.retentionCount !== null) {
      this.requireRange('retentionCount', patch.retentionCount, 1, 1000);
    }
    if (patch.customCron !== undefined && patch.customCron !== null) {
      // Bare minimum shape check; the cron library is authoritative.
      // We just want to reject obviously-wrong input before saving.
      if (!/^(\S+\s+){4}\S+$/.test(patch.customCron.trim())) {
        throw new Error(
          'Custom schedule must be a 5-field cron expression (e.g. "0 2 * * *")',
        );
      }
    }

    const row = await this.ensureConfigRow();
    const updated = await this.prisma.backupConfig.update({
      where: { id: row.id },
      data: {
        ...(patch.archiveDirectory !== undefined && {
          archiveDirectory:
            typeof patch.archiveDirectory === 'string'
              ? patch.archiveDirectory.trim() || null
              : null,
        }),
        ...(patch.scheduleMode !== undefined && {
          scheduleMode: patch.scheduleMode,
        }),
        ...(patch.scheduleHour !== undefined && {
          scheduleHour: patch.scheduleHour,
        }),
        ...(patch.scheduleMinute !== undefined && {
          scheduleMinute: patch.scheduleMinute,
        }),
        ...(patch.scheduleDayOfWeek !== undefined && {
          scheduleDayOfWeek: patch.scheduleDayOfWeek,
        }),
        ...(patch.scheduleDayOfMonth !== undefined && {
          scheduleDayOfMonth: patch.scheduleDayOfMonth,
        }),
        ...(patch.customCron !== undefined && {
          customCron: patch.customCron,
        }),
        ...(patch.retentionCount !== undefined && {
          retentionCount: patch.retentionCount,
        }),
        ...(updatedBy ? { updatedBy } : {}),
      },
    });
    // Make sure the directory actually exists so the very next run
    // doesn't need to think about it. Failure here is not fatal
    // the run-time attempt will surface the real error if the
    // operator typed a path the process can't write to.
    const dir =
      updated.archiveDirectory && updated.archiveDirectory.length > 0
        ? updated.archiveDirectory
        : this.envBackupDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      this.log.warn(
        `Admin set archiveDirectory to ${dir}, but it could not be created: ${(e as Error).message}`,
      );
    }
    const effective = await this.getConfig();
    for (const fn of this.configListeners) {
      try {
        await fn(effective);
      } catch (e) {
        this.log.warn(
          `Config-change listener threw: ${(e as Error).message}`,
        );
      }
    }
    return effective;
  }

  /**
   * Upsert the singleton backup_config row, returning its current
   * state. Keeping all callers routed through here means only one
   * place has to know that this table has at most one row.
   */
  private async ensureConfigRow() {
    const existing = await this.prisma.backupConfig.findFirst();
    if (existing) return existing;
    return this.prisma.backupConfig.create({ data: {} });
  }

  /**
   * Compose a cron expression from the structured schedule fields.
   * Returns null for mode==='off' (caller should unregister the job).
   */
  private buildCron(s: {
    mode: ScheduleMode;
    hour: number;
    minute: number;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    customCron: string | null;
  }): string | null {
    switch (s.mode) {
      case 'off':
        return null;
      case 'daily':
        return `${s.minute} ${s.hour} * * *`;
      case 'weekly':
        return `${s.minute} ${s.hour} * * ${s.dayOfWeek ?? 0}`;
      case 'monthly':
        return `${s.minute} ${s.hour} ${s.dayOfMonth ?? 1} * *`;
      case 'custom':
        return s.customCron?.trim() || null;
    }
  }

  /** Human-readable version of the schedule for the admin UI. */
  private summarizeSchedule(s: {
    mode: ScheduleMode;
    hour: number;
    minute: number;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    customCron: string | null;
  }): string {
    const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
    const days = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    switch (s.mode) {
      case 'off':
        return 'Automatic backups are turned off';
      case 'daily':
        return `Every day at ${time}`;
      case 'weekly': {
        const day = days[s.dayOfWeek ?? 0] ?? 'Sunday';
        return `Every ${day} at ${time}`;
      }
      case 'monthly':
        return `On day ${s.dayOfMonth ?? 1} of each month at ${time}`;
      case 'custom':
        return s.customCron
          ? `Custom schedule (${s.customCron})`
          : 'Custom schedule (not set)';
    }
  }

  private isScheduleMode(v: string): v is ScheduleMode {
    return ['off', 'daily', 'weekly', 'monthly', 'custom'].includes(v);
  }

  private requireRange(field: string, v: number, lo: number, hi: number) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`${field} must be an integer between ${lo} and ${hi}`);
    }
  }

  private envBackupDir(): string {
    const raw = this.cfg.get<string>('BACKUP_DIR', './backups');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  private envRetentionCount(): number {
    const raw = Number(this.cfg.get<string>('BACKUP_RETENTION_COUNT', '7'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
  }

  // ---------------------------------------------------------------
  // Run history
  // ---------------------------------------------------------------

  listRuns(limit = 50) {
    return this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  async getRun(id: string) {
    const run = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Backup run not found');
    return run;
  }

  // ---------------------------------------------------------------
  // Run a backup
  // ---------------------------------------------------------------

  /**
   * Mark abandoned runs failed and sweep the staging directories they
   * left behind.
   *
   * A backup is owned by one process: `runBackup` marks its own row
   * failed in a catch and drops the stage dir in a finally. Neither
   * runs if the process is killed mid-backup (OOM, container
   * recreate, host reboot), so the row stays `running` forever and a
   * multi-GB `.stage-<id>` directory stays on disk forever.
   *
   * That is not hypothetical. Prod carried a run stuck `running` since
   * 2026-07-25 with its stage dir still present, and because the admin
   * page renders it as "In progress" it read as a backup that was
   * merely slow rather than one that died 16 days earlier.
   *
   * Leader-only, and only for runs older than the cutoff, so this can
   * never mark a genuinely in-flight backup as failed. Nothing here
   * touches sealed archives: a stuck row never produced one.
   */
  async reclaimStaleRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const stale = await this.prisma.backupRun.findMany({
      where: { status: 'running', startedAt: { lt: cutoff } },
      select: { id: true, startedAt: true },
    });
    if (stale.length === 0) return 0;

    const { archiveDirectory: backupDir } = await this.getConfig();
    for (const run of stale) {
      const age = Math.round(
        (Date.now() - run.startedAt.getTime()) / 3_600_000,
      );
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error:
            `Abandoned: still marked running ${age}h after it started, ` +
            'so the process that owned it died before it could finish. ' +
            'Reclaimed on startup.',
        },
      });
      // The stage dir is the orphaned bytes the finally never got to.
      await fs.rm(path.join(backupDir, `.stage-${run.id}`), {
        recursive: true,
        force: true,
      });
      this.log.warn(
        `Reclaimed abandoned backup ${run.id} (started ${age}h ago) and ` +
          'removed its staging directory.',
      );
    }
    return stale.length;
  }

  /**
   * Execute a backup. Creates the BackupRun row first (status=running)
   * so an admin watching the page can see the run is in flight, then
   * streams pg_dump + MinIO into a staging dir, seals the archive,
   * and finalises the row. On failure, the row is marked failed and
   * the partial staging dir is removed: we never leave a half-tarred
   * archive in the target directory.
   *
   * @param trigger 'manual' (user-initiated) or 'scheduled' (cron).
   * @param startedBy User id for manual runs; null for scheduled.
   * @returns The final BackupRun row (already persisted).
   */
  async runBackup(
    trigger: 'manual' | 'scheduled',
    startedBy: string | null,
  ) {
    // Refuse a second concurrent run. Two replicas share one archive
    // volume and `POST /admin/backup/runs` carries only AdminGuard, so
    // nothing stopped two backups from staging at once and doubling
    // the peak. Bounded by staleness on purpose: an abandoned row from
    // a killed process must not lock out every future backup, which is
    // the same shape as the retention ratchet.
    const active = await this.prisma.backupRun.findFirst({
      where: {
        status: 'running',
        startedAt: { gte: new Date(Date.now() - RUNNING_ROW_STALE_MS) },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (active) {
      throw new ConflictException(
        `A backup is already running (started ${active.startedAt.toISOString()}). ` +
          'Wait for it to finish or cancel it first.',
      );
    }

    const run = await this.prisma.backupRun.create({
      data: {
        trigger,
        ...(startedBy ? { startedBy } : {}),
      },
    });
    this.log.log(`Backup ${run.id} started (${trigger})`);

    // Cancellation is a durable flag: the cancel request lands on
    // whichever replica the proxy picks, which is usually not this
    // one. The AbortController is the local end of that signal.
    //
    // The poll runs on its OWN timer rather than being called from the
    // archive loop. Driving it from the loop meant it could only fire
    // BETWEEN members, so a cancel issued while streaming a multi-GB
    // point cloud waited for that whole object to finish: measured at
    // ~60s against a 2s poll interval on the first live test. On a
    // timer the signal reaches the in-flight S3 read and pg_dump
    // immediately, which is the entire reason those two are wired to
    // an AbortSignal in the first place.
    const abort = new AbortController();
    let cancelled = false;
    // Declared here, STARTED inside the try below. Starting it here
    // would leak it: `getConfig()` sits between this point and the
    // try, so a config failure would leave a timer querying the
    // database every couple of seconds for the life of the process.
    let cancelPoll: ReturnType<typeof setInterval> | undefined;
    const startCancelPoll = () => {
      cancelPoll = setInterval(() => {
        void (async () => {
          try {
            const row = await this.prisma.backupRun.findUnique({
              where: { id: run.id },
              select: { cancelRequestedAt: true },
            });
            // A row that vanished counts as cancelled: an admin
            // deleted it underneath us, and continuing would only
            // produce an archive nothing can reference.
            if (!row || row.cancelRequestedAt) {
              cancelled = true;
              abort.abort();
            }
          } catch (e) {
            // A database blip must not kill a running backup. Worst
            // case a cancel is noticed one tick later.
            this.log.warn(
              `Backup ${run.id}: cancel poll failed: ${
                e instanceof Error ? e.message : e
              }`,
            );
          }
        })();
      }, CANCEL_POLL_MS);
      // Never hold the event loop open on this timer alone.
      cancelPoll.unref?.();
    };

    /** Cheap synchronous gate between members. The timer does the
     *  querying; this just gives a clean exit point with a proper
     *  error instead of letting a torn-down stream surface as a
     *  size-mismatch further down. */
    const checkCancelled = (): void => {
      if (abort.signal.aborted) throw new BackupCancelledError();
    };

    const { archiveDirectory: backupDir } = await this.getConfig();
    const timestamp = run.startedAt
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('Z', '');
    const stageDir = path.join(backupDir, `.stage-${run.id}`);
    const filename = `backup-${timestamp}-${run.id.slice(0, 8)}.tar.gz`;
    const finalPath = path.join(backupDir, filename);
    // Published by rename, never written under its final name. A
    // killed run therefore cannot leave anything matching the
    // retention sweep's /^backup-.*\.tar\.gz$/, which previously
    // ranked a truncated archive FIRST (newest ISO timestamp) and
    // protected it while evicting good ones. The dot prefix also
    // keeps it out of directory listings an operator scans by eye.
    const partialPath = path.join(backupDir, `.partial-${run.id}.tar.gz`);

    // Retention BEFORE the payload, reserving room for this run.
    //
    // This is the fix for the ratchet that turned one bad night into
    // sixteen: retention used to be reachable ONLY from the success
    // path of a scheduled run, so the single mechanism that frees
    // space was gated behind the operation that lack of space
    // prevents. Once a run failed for want of disk, nothing could
    // ever reclaim any. Sweeping first, on every trigger, means a
    // manual "Run now" can break the deadlock by hand.
    try {
      await this.enforceRetention(1);
    } catch (e) {
      // Never fatal: a retention failure must not stop a backup.
      this.log.warn(
        `Pre-run retention sweep failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    try {
      // Inside the try, so the finally below always clears it.
      startCancelPoll();
      await fs.mkdir(stageDir, { recursive: true });
      await fs.mkdir(path.join(stageDir, 'postgres'), { recursive: true });

      // 1. Postgres dump. Custom format (-Fc) is self-compressing and
      //    supports partial restores via pg_restore. This is the one
      //    member that cannot stream: pg_dump writes to stdout with no
      //    declared length, and a tar member header needs its size up
      //    front. Staging it costs little (the dump is a rounding
      //    error next to the bucket) and it is why the stage dir still
      //    exists at all.
      const dbName = this.extractDbName(
        this.cfg.get<string>('DATABASE_URL', ''),
      );
      const dumpName = `${dbName || 'gratisgis'}.dump`;
      const dumpPath = path.join(stageDir, 'postgres', dumpName);
      await this.runPgDump(dumpPath, abort.signal);
      const dumpSize = (await fs.stat(dumpPath)).size;
      checkCancelled();

      // 2. Plan the archive from a list-only pass. Metadata only, no
      //    bodies: this is what makes an accurate preflight possible
      //    and what lets the manifest carry real totals while still
      //    being written FIRST (a v1-compatible reordering that makes
      //    a future cheap peek possible).
      const plan = await this.planMinioArchive();

      // 3. Refuse loudly rather than filling the volume. The old
      //    design had no check at all and drove the disk to 1.4% free,
      //    taking the object store down with it, then died inside gzip
      //    with "No space left on device". Note this probes the ARCHIVE
      //    directory: the two existing statfs probes in this repo point
      //    at '/' and tmpdir(), neither of which is this filesystem,
      //    which is why the product's own disk gauge read healthy.
      await this.assertRoomForArchive(backupDir, plan.totalBytes + dumpSize);

      const manifest: BackupManifest = {
        version: 1,
        createdAt: run.startedAt.toISOString(),
        trigger,
        portalVersion: this.readPortalVersion(),
        databaseUrl: this.redactDbUrl(
          this.cfg.get<string>('DATABASE_URL', ''),
        ),
        databases: [dbName || 'gratisgis'],
        minio: {
          bucket: this.bucket,
          objectCount: plan.count,
          totalBytes: plan.totalBytes,
        },
        gitSha: this.cfg.get<string>('GIT_SHA') || null,
      };

      // 4. Seal, streaming object bodies straight from S3 into the
      //    archive. Nothing is mirrored to disk, so peak occupancy is
      //    (dump + archive) instead of (bucket + dump + archive).
      await writeTarGz(
        partialPath,
        this.archiveEntries(
          manifest,
          dumpName,
          dumpPath,
          plan.keys,
          checkCancelled,
          abort.signal,
        ),
      );

      const stat = await fs.stat(partialPath);
      // Publish atomically. Until this rename the archive does not
      // exist under a name anything looks for.
      await fs.rename(partialPath, finalPath);

      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          filename,
          sizeBytes: BigInt(stat.size),
        },
      });
      this.log.log(
        `Backup ${run.id} finished: ${filename} (${stat.size} bytes, ` +
          `${plan.count} objects)`,
      );
    } catch (e) {
      // The signal wins over the error type. Aborting mid-body tears
      // down the S3 stream, so the packer sees a member that delivered
      // fewer bytes than its header promised and reports a size
      // mismatch. That is a correct complaint about a corrupt archive
      // but the wrong story to tell an operator who just clicked
      // Cancel, so anything that surfaces while the signal is aborted
      // is reported as the cancellation it actually is.
      const wasCancelled = cancelled || abort.signal.aborted || e instanceof BackupCancelledError;
      const msg = wasCancelled
        ? 'Cancelled by an administrator.'
        : e instanceof Error
          ? e.message
          : String(e);
      // A cancellation is not an incident. It still lands as `failed`
      // because the run produced no archive and BackupStatus has no
      // fourth value, but the message says which it was and the health
      // signal below keys off archives on disk rather than row status,
      // so a cancelled run never reads as a broken backup system.
      if (wasCancelled) {
        this.log.log(`Backup ${run.id} cancelled by an administrator.`);
      } else {
        this.log.error(`Backup ${run.id} failed: ${msg}`);
      }
      // Disk first, bookkeeping second. The old order recorded the
      // failure before cleaning up, so when the update threw (the row
      // had been deleted underneath a running backup) the partial
      // archive was stranded AND the original error was replaced by a
      // Prisma one. Cleanup must never be downstream of a fallible
      // database write.
      await fs.rm(partialPath, { force: true }).catch(() => undefined);
      await this.prisma.backupRun
        .update({
          where: { id: run.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            error: msg.slice(0, 500),
          },
        })
        .catch((dbErr: unknown) => {
          // Losing the row is not a reason to lose the reason.
          this.log.error(
            `Backup ${run.id}: could not record the failure (${
              dbErr instanceof Error ? dbErr.message : dbErr
            }). Original failure above.`,
          );
        });
    } finally {
      // First, always. A leaked interval would keep querying for a run
      // that finished, once every couple of seconds, forever.
      if (cancelPoll) clearInterval(cancelPoll);
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(partialPath, { force: true }).catch(() => undefined);
    }

    // Deliberately outside the try: a sealed, recorded, successful
    // archive must not be routed into the catch by a later hiccup.
    // Retention used to run INSIDE it, so a database blip after the
    // seal flipped the row to failed and then deleted the archive.
    if (trigger === 'scheduled') {
      try {
        await this.enforceRetention();
      } catch (e) {
        this.log.warn(
          `Post-run retention sweep failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return this.getRun(run.id);
  }

  /**
   * List every object with its size, without fetching a single body.
   *
   * Two jobs: it is the input to the free-space preflight, and it lets
   * the manifest carry accurate totals while being written as the
   * FIRST archive member rather than the last.
   */
  private async planMinioArchive(): Promise<{
    keys: Array<{ key: string; size: number }>;
    count: number;
    totalBytes: number;
  }> {
    const keys: Array<{ key: string; size: number }> = [];
    let totalBytes = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        const size = Number(obj.Size ?? 0);
        keys.push({ key: obj.Key, size });
        totalBytes += size;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { keys, count: keys.length, totalBytes };
  }

  /**
   * Refuse the run if the archive cannot fit, with the numbers in the
   * message. Mirrors the shape of the tile-layer upload preflight.
   *
   * `payloadBytes` is the uncompressed sum. gzip is left out of the
   * estimate on purpose: this corpus is COG, PMTiles, LAZ, JPEG and an
   * already-zlib-compressed pg_dump, so the ratio is close to 1:1 and
   * assuming otherwise is how you talk yourself into a run that cannot
   * finish. Overhead covers tar block padding (~1 KiB per member).
   *
   * Fails OPEN when statfs itself fails, matching tile-layer: a broken
   * probe should not block a backup, and a genuine ENOSPC is now
   * survivable (atomic publish, cleanup in the finally).
   */
  private async assertRoomForArchive(
    dir: string,
    payloadBytes: number,
  ): Promise<void> {
    const required = Math.ceil(payloadBytes * 1.02) + 16 * 1024 * 1024;
    let free: number;
    try {
      const st = await fs.statfs(dir);
      free = Number(st.bavail) * Number(st.bsize);
    } catch (err) {
      this.log.warn(
        `statfs(${dir}) failed: ${err instanceof Error ? err.message : err}. ` +
          'Proceeding without a space preflight.',
      );
      return;
    }
    if (required > free) {
      throw new Error(
        `Not enough space for this backup. It needs about ` +
          `${formatBytes(required)} and ${dir} has ${formatBytes(free)} free. ` +
          'Lower the retention count, move the archive directory to a larger ' +
          'volume, or free space and run again. Nothing was written.',
      );
    }
  }

  /**
   * The archive, as a stream of members.
   *
   * Order is manifest, dump, objects. Manifest first is v1-compatible
   * (both readers locate it by name) and is a precondition for ever
   * making the peek cheap, which today gunzips the whole payload to
   * read one small file at the end.
   */
  private async *archiveEntries(
    manifest: BackupManifest,
    dumpName: string,
    dumpPath: string,
    keys: ReadonlyArray<{ key: string; size: number }>,
    checkCancelled: () => void,
    signal: AbortSignal,
  ): AsyncGenerator<TarEntry> {
    yield {
      kind: 'buffer',
      name: 'manifest.json',
      body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    };

    const dumpSize = (await fs.stat(dumpPath)).size;
    yield {
      kind: 'stream',
      name: `postgres/${dumpName}`,
      size: dumpSize,
      open: () => createReadStream(dumpPath),
    };

    for (const { key } of keys) {
      // Clean exit point between members. A cancel landing mid-body is
      // handled by the signal itself, which aborts the in-flight GET.
      checkCancelled();
      const get = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
      const body = get.Body;
      if (!body) {
        // Previously a bare `continue`, which dropped the object from
        // the archive without dropping it from the counts, so a
        // partial backup reported a full one. A backup that cannot
        // read an object is not a backup.
        throw new Error(`Object "${key}" returned no body; refusing to seal.`);
      }
      // Size from the GET, never from the listing. The portal keeps
      // serving during a backup, so a listing size can be stale by the
      // time the body arrives, and a tar member header commits to its
      // length before the bytes. See the size contract in tar-pack.ts.
      const size = Number(get.ContentLength ?? 0);
      yield {
        kind: 'stream',
        name: `minio/${key}`,
        size,
        open: () =>
          body instanceof Readable ? body : Readable.fromWeb(body as never),
      };
    }
  }

  // ---------------------------------------------------------------
  // Archive file operations (download / delete)
  // ---------------------------------------------------------------

  /**
   * Absolute path to the archive on disk for a given run, plus the
   * original filename (for Content-Disposition). Throws if the run
   * or the file isn't usable: callers (controller) map this to 404.
   */
  async resolveArchivePath(runId: string) {
    const run = await this.getRun(runId);
    if (run.status !== 'succeeded' || !run.filename) {
      throw new NotFoundException('Backup archive is not available');
    }
    const { archiveDirectory } = await this.getConfig();
    const p = path.join(archiveDirectory, run.filename);
    try {
      await fs.access(p);
    } catch {
      throw new NotFoundException(
        'Backup file is missing on disk; it may have been moved or manually deleted',
      );
    }
    return { path: p, filename: run.filename };
  }

  /**
   * Remove a backup archive AND its run row. Used by the admin UI
   * delete button and by the retention sweep. Idempotent: a missing
   * file just gets the row cleaned up anyway so the table stays
   * consistent with what's on disk.
   */
  /**
   * Ask a running backup to stop.
   *
   * Sets a durable flag; the run polls it and tears down pg_dump and
   * the in-flight S3 read through its own AbortController. Cross
   * replica by construction, which an in-memory registry would not be:
   * prod runs two portal-api replicas and this request lands on
   * whichever one the proxy picked.
   *
   * Idempotent. Cancelling an already-finished run is a no-op rather
   * than an error, because the admin clicking Cancel cannot know
   * whether the run finished a second earlier.
   */
  async requestCancel(runId: string) {
    const run = await this.getRun(runId);
    if (run.status !== 'running') {
      return { cancelled: false, status: run.status };
    }
    await this.prisma.backupRun.update({
      where: { id: run.id },
      data: { cancelRequestedAt: new Date() },
    });
    this.log.log(`Backup ${run.id}: cancellation requested.`);
    return { cancelled: true, status: 'running' as const };
  }

  /**
   * Age of the newest archive ON DISK, plus whether that is overdue
   * for the configured schedule.
   *
   * Deliberately computed from the directory rather than from
   * `backup_run`. The archives are the durable half: this deployment
   * drops and restores the whole database nightly from a golden
   * snapshot while explicitly excluding the backups volume, so rows
   * are reverted every morning and a row-based health check reports
   * whatever golden happened to capture. That is exactly how sixteen
   * days without a backup rendered as seven healthy runs.
   */
  async getHealth(): Promise<{
    lastArchiveAt: string | null;
    ageHours: number | null;
    archiveCount: number;
    overdue: boolean;
    reason: string;
  }> {
    const cfg = await this.getConfig();
    let newest: Date | null = null;
    let count = 0;
    try {
      for (const name of await fs.readdir(cfg.archiveDirectory)) {
        if (!/^backup-.*\.tar\.gz$/.test(name)) continue;
        count += 1;
        const st = await fs.stat(path.join(cfg.archiveDirectory, name));
        if (!newest || st.mtime > newest) newest = st.mtime;
      }
    } catch (err) {
      return {
        lastArchiveAt: null,
        ageHours: null,
        archiveCount: 0,
        overdue: true,
        reason: `Could not read the archive directory: ${
          err instanceof Error ? err.message : err
        }`,
      };
    }
    if (!newest) {
      return {
        lastArchiveAt: null,
        ageHours: null,
        archiveCount: 0,
        overdue: cfg.scheduleMode !== 'off',
        reason:
          cfg.scheduleMode === 'off'
            ? 'No archives, and scheduled backups are off.'
            : 'No backup archives exist.',
      };
    }
    const ageHours = (Date.now() - newest.getTime()) / 3_600_000;
    // Two scheduled windows of slack before calling it overdue, so one
    // missed night is a warning rather than an alarm, but a silent
    // week is impossible to miss.
    const windowHours =
      cfg.scheduleMode === 'monthly' ? 24 * 31 : cfg.scheduleMode === 'weekly' ? 24 * 7 : 24;
    const overdue = cfg.scheduleMode !== 'off' && ageHours > windowHours * 2;
    return {
      lastArchiveAt: newest.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      archiveCount: count,
      overdue,
      reason: overdue
        ? `The newest backup is ${Math.round(ageHours)}h old; the schedule is ${cfg.scheduleSummary}.`
        : `Newest backup is ${Math.round(ageHours)}h old.`,
    };
  }

  async deleteRun(runId: string) {
    const run = await this.getRun(runId);
    // Refuse to delete a live run. Deleting one was worse than a
    // no-op: `filename` is null until the success update, so nothing
    // came off disk, while the row the running process needs to record
    // its own outcome was destroyed. That is how a failed backup left
    // a 9 GB partial archive with no row, invisible to the UI and
    // unreachable by retention.
    if (run.status === 'running') {
      throw new ConflictException(
        'That backup is still running. Cancel it first, then delete it.',
      );
    }
    if (run.filename) {
      const { archiveDirectory } = await this.getConfig();
      const p = path.join(archiveDirectory, run.filename);
      await fs.rm(p, { force: true });
    }
    await this.prisma.backupRun.delete({ where: { id: run.id } });
    return { deleted: run.id };
  }

  /**
   * Keep only the most recent N successful backups. Failed runs are
   * NOT counted against the cap: operators want to see "these three
   * in a row failed" while the last N successful archives still sit
   * on disk.
   *
   * `reserve` shrinks the cap for this sweep so a run can make room
   * for the archive it is about to write. runBackup calls it with 1
   * before starting and 0 after a successful scheduled run.
   *
   * Called from BOTH ends of runBackup and on both triggers. It used
   * to be reachable only from the success path of a SCHEDULED run,
   * which meant the one mechanism that frees disk was gated behind
   * the operation that lack of disk prevents. One failed night then
   * locked the portal out of backups permanently, and a manual run
   * could not break it either.
   */
  async enforceRetention(reserve = 0): Promise<{ removed: number }> {
    const cap = Math.max(
      1,
      (await this.getConfig()).retentionCount - Math.max(0, reserve),
    );
    const successful = await this.prisma.backupRun.findMany({
      where: { status: 'succeeded' },
      orderBy: { startedAt: 'desc' },
      skip: cap,
    });
    let removed = 0;
    for (const old of successful) {
      try {
        await this.deleteRun(old.id);
        removed += 1;
      } catch (e) {
        this.log.warn(
          `Retention: could not delete ${old.id}: ${(e as Error).message}`,
        );
      }
    }

    // File-level safety net. The DB-row sweep above only knows about
    // runs still in backup_run. On a deployment whose database is
    // periodically rolled back to a snapshot (e.g. the public demo
    // that resets nightly), those rows revert and every archive they
    // described becomes an orphan no DB-driven sweep can ever see, so
    // the files pile up unbounded. Also prune the archive DIRECTORY
    // directly: keep the newest `cap` archives by their ISO-
    // timestamped filename and delete the rest. Scoped to the
    // backup-*.tar.gz naming so staging dirs and anything else are
    // never touched.
    try {
      const { archiveDirectory } = await this.getConfig();
      const archives = (await fs.readdir(archiveDirectory))
        .filter((f) => /^backup-.*\.tar\.gz$/.test(f))
        .sort()
        .reverse(); // newest first (ISO timestamps sort chronologically)
      for (const stale of archives.slice(cap)) {
        try {
          await fs.unlink(path.join(archiveDirectory, stale));
          removed += 1;
        } catch (e) {
          this.log.warn(
            `Retention: could not remove orphan ${stale}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.log.warn(
        `Retention: archive-directory sweep failed: ${(e as Error).message}`,
      );
    }
    return { removed };
  }

  // ---------------------------------------------------------------
  // Private: pg_dump
  // ---------------------------------------------------------------

  /**
   * Invoke pg_dump in either "host" (binary on PATH) or "docker"
   * (docker exec <container> pg_dump) mode. Connection parameters
   * come from DATABASE_URL so operators never have to re-encode
   * credentials here.
   *
   * We pipe stdout straight to a file stream rather than buffering
   * through Node, so a 5 GB dump doesn't need 5 GB of RAM.
   */
  private async runPgDump(outPath: string, signal?: AbortSignal) {
    const raw = this.cfg.get<string>('DATABASE_URL', '');
    if (!raw) throw new Error('DATABASE_URL is not set; cannot run pg_dump');
    // Prisma's DATABASE_URL carries non-libpq params (notably
    // `?schema=public`, plus pool tuning like `connection_limit`,
    // `pool_timeout`, `pgbouncer`). pg_dump parses the URI with libpq
    // and rejects anything it doesn't recognise, so we sanitise the
    // URL before handing it off.
    const url = this.sanitizeDbUrlForPgDump(raw);
    const container = this.cfg.get<string>(
      'BACKUP_PGDUMP_DOCKER_CONTAINER',
      '',
    );
    const extraArgs = ['-Fc', '--no-owner', '--no-privileges'];

    // Host mode: pg_dump takes the URL as the last positional arg.
    // Docker mode: we `docker exec <c> pg_dump <same args>`: the
    // container has pg_dump on PATH. We pass the URL via env to avoid
    // leaking it into the process list visible to other container
    // tenants.
    const bin = container ? 'docker' : 'pg_dump';
    const args = container
      ? ['exec', '-e', `PG_URL=${url}`, container, 'sh', '-c',
         `pg_dump "$PG_URL" ${extraArgs.join(' ')}`]
      : [...extraArgs, url];

    const out = createWriteStream(outPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Cancellation. Without this the child was unreachable: it was
        // a local inside a promise executor with no handle kept
        // anywhere, so a "cancel" could only ever have removed the
        // bookkeeping and left pg_dump running. SIGTERM first so the
        // server-side query is torn down cleanly; the close handler
        // below turns the non-zero exit into the rejection.
        const onAbort = () => {
          child.kill('SIGTERM');
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (c) => stderrChunks.push(c));
        child.stdout.pipe(out);
        out.on('error', reject);
        child.on('error', reject);
        child.on('close', (code) => {
          signal?.removeEventListener('abort', onAbort);
          if (code === 0) return resolve();
          if (signal?.aborted) {
            return reject(new BackupCancelledError());
          }
          const tail = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
          reject(
            new Error(
              `pg_dump exited with code ${code}: ${tail || '(no stderr)'}`,
            ),
          );
        });
      });
    } finally {
      // Ensure the file stream is flushed whether the child succeeded
      // or not: otherwise the tar step might read a truncated file.
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
  }

  // Removed: mirrorMinio(). It copied the whole bucket to disk before
  // sealing, which is the intermediate copy that made a backup need
  // roughly 2x (bucket + dump) free and left this deployment with no
  // operating point at any retention setting. Object bodies now go
  // straight from S3 into the archive; see archiveEntries() above and
  // tar-pack.ts. It also silently skipped bodyless objects while still
  // counting them, so a partial backup reported a complete one.

  // ---------------------------------------------------------------
  // Private: helpers
  // ---------------------------------------------------------------

  private extractDbName(url: string): string | null {
    // postgresql://user:pass@host:port/dbname?query
    const m = url.match(/\/([^/?]+)(\?|$)/);
    return m?.[1] ?? null;
  }

  /**
   * Strip Prisma-specific query parameters that libpq/pg_dump doesn't
   * understand (e.g. `schema=public` causes `invalid URI query parameter:
   * "schema"`). We allowlist the libpq URI params we want to forward;
   * anything else gets dropped. Empty query string is removed entirely
   * so the URL looks clean in any logged output.
   */
  private sanitizeDbUrlForPgDump(url: string): string {
    // libpq-recognised URI parameters that actually affect the dump.
    // https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS
    const libpqAllow = new Set([
      'sslmode',
      'sslrootcert',
      'sslcert',
      'sslkey',
      'sslpassword',
      'sslcrl',
      'sslcompression',
      'connect_timeout',
      'application_name',
      'fallback_application_name',
      'client_encoding',
      'options',
      'keepalives',
      'keepalives_idle',
      'keepalives_interval',
      'keepalives_count',
      'tcp_user_timeout',
      'replication',
      'gssencmode',
      'target_session_attrs',
    ]);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      // If the URL is malformed we can't sanitise: return it
      // untouched so the pg_dump spawn surfaces a clear error.
      return url;
    }
    const kept: string[] = [];
    u.searchParams.forEach((value, key) => {
      if (libpqAllow.has(key)) kept.push(`${key}=${encodeURIComponent(value)}`);
    });
    u.search = kept.length ? `?${kept.join('&')}` : '';
    return u.toString();
  }

  private redactDbUrl(url: string): string {
    // Turn postgresql://user:pass@host:port/db into postgresql://user:***@host:port/db
    return url.replace(/(:\/\/[^:]+:)[^@]*(@)/, '$1***$2');
  }

  private readPortalVersion(): string | null {
    // npm / pnpm exposes the running package's version via env at
    // spawn time. If unset (e.g. the process was started by
    // `node dist/main.js` directly), we just record null: this
    // field is informational on the manifest and not load-bearing.
    return process.env.npm_package_version ?? null;
  }
}
