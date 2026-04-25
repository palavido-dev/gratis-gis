import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
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
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as tar from 'tar';

import { PrismaService } from '../prisma/prisma.service.js';

export type ScheduleMode = 'off' | 'daily' | 'weekly' | 'monthly' | 'custom';

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
    const run = await this.prisma.backupRun.create({
      data: {
        trigger,
        ...(startedBy ? { startedBy } : {}),
      },
    });
    this.log.log(`Backup ${run.id} started (${trigger})`);

    const { archiveDirectory: backupDir } = await this.getConfig();
    const timestamp = run.startedAt
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('Z', '');
    const stageDir = path.join(backupDir, `.stage-${run.id}`);
    const filename = `backup-${timestamp}-${run.id.slice(0, 8)}.tar.gz`;
    const finalPath = path.join(backupDir, filename);

    try {
      await fs.mkdir(stageDir, { recursive: true });
      await fs.mkdir(path.join(stageDir, 'postgres'), { recursive: true });
      await fs.mkdir(path.join(stageDir, 'minio'), { recursive: true });

      // 1. Postgres dump via pg_dump. Custom format (-Fc) is self-
      //    compressing and supports partial restores via pg_restore,
      //    which we'll want for disaster-recovery scenarios.
      const dbName = this.extractDbName(
        this.cfg.get<string>('DATABASE_URL', ''),
      );
      const dumpPath = path.join(
        stageDir,
        'postgres',
        `${dbName || 'gratisgis'}.dump`,
      );
      await this.runPgDump(dumpPath);

      // 2. MinIO mirror. We stream each object straight to disk so a
      //    big bucket doesn't pin the whole thing in memory.
      const minioStats = await this.mirrorMinio(path.join(stageDir, 'minio'));

      // 3. Manifest: enough context to drive a restore without
      //    reopening the dump files.
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
          objectCount: minioStats.count,
          totalBytes: minioStats.bytes,
        },
        gitSha: this.cfg.get<string>('GIT_SHA') || null,
      };
      await fs.writeFile(
        path.join(stageDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      // 4. Seal the archive. tar.c streams directly to gzip + file,
      //    so at no point do we hold the entire archive in memory.
      //    cwd/stage root means the paths inside the tar are relative
      //    (postgres/..., minio/..., manifest.json): portable.
      await tar.c(
        {
          gzip: true,
          file: finalPath,
          cwd: stageDir,
        },
        ['postgres', 'minio', 'manifest.json'],
      );

      const stat = await fs.stat(finalPath);
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
        `Backup ${run.id} finished: ${filename} (${stat.size} bytes)`,
      );

      // 5. Enforce retention. Done after the new row is finalised so
      //    we never delete the just-written archive as part of the
      //    same run. Manual runs deliberately do NOT trigger retention
      //    sweeps; those happen on the scheduled path.
      if (trigger === 'scheduled') {
        await this.enforceRetention();
      }

      return this.getRun(run.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`Backup ${run.id} failed: ${msg}`);
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: msg.slice(0, 500),
        },
      });
      // Best-effort cleanup: an empty/partial archive is worse than
      // no archive, because the admin page would think it succeeded.
      await fs.rm(finalPath, { force: true });
      return this.getRun(run.id);
    } finally {
      // Stage dir goes away regardless: on success its contents are
      // already inside the tar; on failure they're orphaned bytes
      // we don't want cluttering BACKUP_DIR.
      await fs.rm(stageDir, { recursive: true, force: true });
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
  async deleteRun(runId: string) {
    const run = await this.getRun(runId);
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
   * in a row failed" while the last 7 successful archives still sit
   * on disk. Called by the scheduler after a successful run.
   */
  async enforceRetention(): Promise<{ removed: number }> {
    const cap = (await this.getConfig()).retentionCount;
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
  private async runPgDump(outPath: string) {
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
        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (c) => stderrChunks.push(c));
        child.stdout.pipe(out);
        out.on('error', reject);
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) return resolve();
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

  // ---------------------------------------------------------------
  // Private: MinIO mirror
  // ---------------------------------------------------------------

  /**
   * Stream every object in the configured bucket into `targetDir/`,
   * preserving the object-key tree as directory structure. Returns
   * totals for the manifest.
   */
  private async mirrorMinio(
    targetDir: string,
  ): Promise<{ count: number; bytes: number }> {
    let continuation: string | undefined;
    let count = 0;
    let bytes = 0;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const outPath = path.join(targetDir, obj.Key);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        const get = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key }),
        );
        const body = get.Body;
        if (!body) continue;
        const readable =
          body instanceof Readable ? body : Readable.fromWeb(body as never);
        await pipeline(readable, createWriteStream(outPath));
        count += 1;
        bytes += Number(obj.Size ?? 0);
      }
      continuation = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuation);
    return { count, bytes };
  }

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
