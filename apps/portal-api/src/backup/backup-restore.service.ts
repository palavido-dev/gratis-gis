// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TileCacheService } from '../engine/tile-cache.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup.service.js';
import { MaintenanceModeService } from './maintenance-mode.service.js';
import { extractTarGz, readTarEntry } from './tar-cli.js';

/**
 * What sits inside every archive the backup service writes.
 * Mirrors BackupService's manifest shape; we redeclare the relevant
 * fields here so restore can be compiled + tested independently of
 * the backup side's internal types.
 */
export interface ArchiveManifest {
  version: 1;
  createdAt: string;
  trigger: string;
  databaseUrl: string;
  databases: string[];
  minio: { bucket: string; objectCount: number; totalBytes: number };
  gitSha?: string | null;
  portalVersion?: string | null;
  appliedMigrations?: string[];
}

/**
 * The restore stopped before it changed anything (no pg_restore, no
 * object writes). The controller then lifts the maintenance it
 * raised instead of holding the portal as if a restore had failed
 * half way.
 */
export class RestoreNotStartedError extends Error {}

/**
 * Compare the archive's applied migrations with the running portal's.
 * Returns null when they match, otherwise the reason to refuse.
 * pg_restore `--clean` only drops objects that are in the archive, so
 * any difference leaves a schema the running code does not expect.
 */
export function schemaMismatch(
  archive: string[],
  live: string[],
  archiveVersion: string | null | undefined,
): string | null {
  const a = new Set(archive);
  const l = new Set(live);
  const missing = live.filter((m) => !a.has(m));
  const extra = archive.filter((m) => !l.has(m));
  if (missing.length === 0 && extra.length === 0) return null;
  const made = archiveVersion ? ` (GratisGIS ${archiveVersion})` : '';
  if (extra.length === 0) {
    return (
      `This archive${made} was made before ${missing.length} database ` +
      `migration(s) this portal runs, starting with ${missing[0]}. ` +
      'An in-portal restore cannot convert an older schema. Restore it ' +
      'on the GratisGIS release that made it, then upgrade.'
    );
  }
  if (missing.length === 0) {
    return (
      `This archive${made} has ${extra.length} database migration(s) ` +
      `this portal does not know, starting with ${extra[0]}. Upgrade ` +
      'the portal to the release that made it before restoring.'
    );
  }
  return (
    `This archive${made} has a different database schema from this ` +
    `portal (${missing.length} migration(s) missing, ${extra.length} ` +
    'unknown). Restore it on the GratisGIS release that made it.'
  );
}

/** Parse the `_prisma_migrations` COPY block that
 *  `pg_restore --data-only --table=_prisma_migrations -f -` prints.
 *  Returns the sorted names of finished, not rolled back, rows, or
 *  null when the block is missing. */
export function parseMigrationsCopy(sql: string): string[] | null {
  const lines = sql.split('\n');
  const start = lines.findIndex((l) =>
    /^COPY\s+(?:"?public"?\.)?"?_prisma_migrations"?\s*\(/.test(l),
  );
  if (start < 0) return null;
  const header = lines[start] ?? '';
  const cols = header
    .slice(header.indexOf('(') + 1, header.indexOf(')'))
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''));
  const iName = cols.indexOf('migration_name');
  const iFinished = cols.indexOf('finished_at');
  const iRolled = cols.indexOf('rolled_back_at');
  if (iName < 0 || iFinished < 0 || iRolled < 0) return null;
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '\\.') break;
    const f = line.split('\t');
    if (f[iFinished] === '\\N' || f[iRolled] !== '\\N') continue;
    const name = f[iName];
    if (name) names.push(name);
  }
  return names.sort();
}

/**
 * pg_restore --clean drops each object before recreating it. On the
 * partitions of `observation` (PRIMARY KEY (id, tx_time), inherited
 * from the parent) the per-partition DROP CONSTRAINT fails with
 * "cannot drop inherited constraint", pg_restore carries on, the
 * parent's drop then removes the partitions, and everything is
 * recreated from the dump. The run still exits 1. Those errors are
 * harmless; any other error is not.
 */
const INHERITED_CONSTRAINT_ERROR =
  /^pg_restore: error: could not execute query: ERROR: {1,2}cannot drop inherited constraint "[^"]+" of relation "[^"]+"$/;

/**
 * Null when a pg_restore run succeeded, counting only the known
 * inherited-constraint errors as harmless; otherwise the reason it
 * failed. Every error line must be a known one, and pg_restore's own
 * "errors ignored on restore: N" count must match them, so an error
 * we did not see (or could not parse) still fails.
 */
export function pgRestoreFailure(code: number | null, stderr: string): string | null {
  if (code === 0) return null;
  const lines = stderr.split(/\r?\n/);
  const errors = lines.filter((l) => l.startsWith('pg_restore: error:'));
  const unknown = errors.filter((l) => !INHERITED_CONSTRAINT_ERROR.test(l));
  const tail = stderr.trim().slice(-500) || '(no output)';
  if (code !== 1 || errors.length === 0 || unknown.length > 0) {
    const first = unknown[0] ?? lines.find((l) => l.trim()) ?? '';
    return `exit code ${code}. ${first ? `${first.slice(0, 300)} ` : ''}Last output: ${tail}`;
  }
  const ignored = /errors ignored on restore: (\d+)/.exec(stderr);
  if (!ignored || Number(ignored[1]) !== errors.length) {
    return `exit code ${code} with an error count that does not match the known errors. Last output: ${tail}`;
  }
  return null;
}

/**
 * Bytes a restore needs free on the archive volume: the unpacked
 * bucket plus the dump (estimated by the archive's size), with 2%
 * and 64 MB of headroom for tar padding and the filesystem.
 */
export function restoreSpaceNeeded(bucketBytes: number, archiveBytes: number): number {
  return Math.ceil((bucketBytes + archiveBytes) * 1.02) + 64 * 1024 * 1024;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Restore a previously-created backup archive onto the running
 * portal. Strictly destructive: the database is wiped and repopulated
 * from the archive's pg_dump, and the MinIO bucket is emptied and
 * remirrored from the archive's object tree.
 *
 * Contract:
 *   1. Caller MUST have flipped MaintenanceModeService into the
 *      "restoring" state before calling `runRestore()`. We double-
 *      check but the controller owns the outer gate because the
 *      restore itself can't activate maintenance mode any earlier
 *      (mutation requests that arrived during the milliseconds
 *      between "admin clicked Restore" and "pg_restore starts" must
 *      also be blocked).
 *   2. This method is deliberately synchronous from the caller's
 *      perspective: one admin clicking Restore blocks on the
 *      request until the system is back up. No job queue. No async
 *      handoff. That keeps the behaviour model simple: if the HTTP
 *      call succeeds, you're restored; if it fails, you see why.
 *   3. Audit row is written LAST, after the new DB state is in, so
 *      the record of the destructive event is on the restored side
 *      rather than the pre-restore side. If we wrote it first,
 *      pg_restore would wipe the row.
 *
 * Out of scope for this phase (see #65):
 *   - Atomic side-DB swap (zero-downtime).
 *   - Archive upload from the admin's laptop (Phase 1 restores from
 *     an existing BackupRun row on the same deployment).
 *   - Selective restore (subset of tables, single MinIO object).
 */
@Injectable()
export class BackupRestoreService {
  private readonly log = new Logger(BackupRestoreService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly backup: BackupService,
    private readonly mode: MaintenanceModeService,
    private readonly tileCache: TileCacheService,
  ) {
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

  // ---------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------

  async recentRestores(limit = 20) {
    return this.prisma.backupRestore.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  /** Status the admin UI polls while a restore is in flight. */
  maintenanceSnapshot() {
    return this.mode.snapshot();
  }

  /**
   * Inspect the archive for a given run without touching any data.
   * Used by the confirm step so the admin sees what they're about
   * to overwrite themselves with.
   */
  async peekArchive(runId: string) {
    const { path: archivePath } = await this.backup.resolveArchivePath(runId);
    const manifest = await this.extractManifest(archivePath);
    if (manifest.version !== 1) {
      throw new BadRequestException(
        `Archive manifest version ${manifest.version} isn't supported by this portal. Upgrade before restoring.`,
      );
    }
    if (manifest.appliedMigrations) {
      await this.assertSchemaMatches(
        manifest.appliedMigrations,
        manifest.portalVersion,
        (m) => new BadRequestException(m),
      );
    }
    const stat = await fs.stat(archivePath);
    return {
      runId,
      filename: path.basename(archivePath),
      sizeBytes: stat.size,
      manifest,
    };
  }

  /**
   * Checks that need no maintenance window. The controller runs them
   * before it raises maintenance, so a refused restore never leaves
   * the portal in a failed-restore hold.
   */
  async preflight(runId: string): Promise<void> {
    const live = await this.backup.liveRun();
    if (live) {
      throw new ConflictException(
        `A backup is running (started ${live.startedAt.toISOString()}). Wait for it to finish or cancel it before restoring.`,
      );
    }
    await this.peekArchive(runId);
  }

  /**
   * Execute the destructive restore. Caller must have already
   * flipped maintenance mode on. Returns the audit row once the
   * restore completes. Throws RestoreNotStartedError when it stopped
   * before changing anything.
   */
  async runRestore(args: { runId: string; startedBy: string }) {
    if (!this.mode.isActive()) {
      throw new RestoreNotStartedError(
        'Maintenance mode must be active before runRestore(). The controller is supposed to handle this; refusing as a safety net.',
      );
    }
    // Set once the hold is in place and pg_restore may have run.
    // Everything before it changes nothing, so any failure before it
    // is reported as "not started" (the controller then lifts the
    // maintenance it raised instead of holding the portal).
    let started = false;
    const notStarted = (msg: string) => new RestoreNotStartedError(msg);
    let stageDir: string | null = null;
    let filename = '';

    try {
      // Re-checked inside maintenance: the other replica can start a
      // scheduled backup until it sees the flag (one poll interval).
      const live = await this.backup.liveRun();
      if (live) {
        throw notStarted(
          `A backup is running (started ${live.startedAt.toISOString()}). Wait for it to finish or cancel it before restoring.`,
        );
      }

      const resolved = await this.backup.resolveArchivePath(args.runId);
      const archivePath = resolved.path;
      filename = resolved.filename;
      this.log.warn(
        `RESTORE STARTING: user=${args.startedBy} archive=${filename}`,
      );
      // Unpacking needs room for the whole bucket plus the dump on the
      // archive volume, which also holds the retained archives.
      await this.assertRoomToUnpack(archivePath);
      stageDir = path.join(path.dirname(archivePath), `.restore-${Date.now()}`);
      await fs.mkdir(stageDir, { recursive: true });

      // 1. Extract the archive into a staging dir. We shell out to
      //    the system tar so we don't carry the npm `tar` dep (#47).
      await extractTarGz(archivePath, stageDir).catch((e: unknown) => {
        throw notStarted(e instanceof Error ? e.message : String(e));
      });

      const manifest = await this.readStagedManifest(stageDir).catch(() => {
        throw notStarted('Archive manifest.json is missing or not valid JSON.');
      });
      if (manifest.version !== 1) {
        throw notStarted(
          `Archive manifest version ${manifest.version} isn't supported.`,
        );
      }

      const dumpRel = path.join(
        'postgres',
        `${manifest.databases[0] ?? 'gratisgis'}.dump`,
      );
      const dumpPath = path.join(stageDir, dumpRel);
      await fs.access(dumpPath).catch(() => {
        throw notStarted(`Archive is missing ${dumpRel}`);
      });

      // 2. The archive's schema must be the running portal's schema.
      //    Archives made before the manifest carried the list are
      //    read from the dump itself.
      const archiveMigrations =
        manifest.appliedMigrations ?? (await this.readDumpMigrations(dumpPath));
      if (!archiveMigrations) {
        throw notStarted(
          'Could not read which database migrations this archive contains, so it cannot be checked against this portal. Restore it with the host recovery tools on the release that made it.',
        );
      }
      await this.assertSchemaMatches(
        archiveMigrations,
        manifest.portalVersion,
        notStarted,
      );

      // A backup started on the other replica before it saw the flag
      // can begin after the check at the top (unpacking the archive
      // takes time). Check again right before the hold, the last
      // point at which refusing changes nothing.
      const lateLive = await this.backup.liveRun();
      if (lateLive) {
        throw notStarted(
          `A backup started while the restore was preparing (started ${lateLive.startedAt.toISOString()}). Wait for it to finish or cancel it before restoring.`,
        );
      }

      // 3. Backup history lives in the database the restore replaces.
      //    Keep the live rows: they describe the archives on disk.
      const history = await this.snapshotBackupHistory();

      // 4. Hold maintenance through the whole restore. The local hold
      //    covers this replica, the marker file covers the other one
      //    and survives a crash. Written before pg_restore starts.
      await this.mode
        .beginRestoreHold(
          `Restoring backup ${args.runId.slice(0, 8)}. An interrupted restore leaves maintenance on.`,
        )
        .catch((e: unknown) => {
          throw notStarted(
            `Could not write the restore marker, so the restore did not start: ${
              e instanceof Error ? e.message : e
            }`,
          );
        });
      started = true;

      // 5. Restore postgres with --clean --if-exists.
      await this.runPgRestore(dumpPath);
      // The archive's own `system_setting` row (inactive) is now in
      // place. Put the maintenance row back before anything else.
      await this.mode.reassertHold();
      await this.restoreBackupHistory(history);

      // 6. Rebuild the MinIO bucket. #233: PUT archive objects first
      //    (overwrite in place), then delete keys that were not in
      //    the archive.
      await this.restoreMinio(path.join(stageDir, 'minio'));

      // 6b. pg_restore rewrote the observation log without firing the
      //     NOTIFY the tile cache listens for. Drop this replica's
      //     cached tiles and the disk tier's files so nothing from the
      //     pre-restore data is served. Best effort: a failure here
      //     must not turn a good restore into a failed one.
      await this.tileCache.resetAfterRestore().catch((err: unknown) => {
        this.log.warn(
          `tile cache reset after restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // 7. Write the audit row on the restored DB.
      const audit = await this.prisma.backupRestore.create({
        data: {
          fromRunId: args.runId,
          filename,
          finishedAt: new Date(),
          status: 'succeeded',
          startedBy: args.startedBy,
        },
      });
      await this.mode.endRestoreHold(true);
      started = false;
      this.log.warn(
        `RESTORE SUCCEEDED: audit=${audit.id} archive=${filename}`,
      );
      return audit;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`RESTORE FAILED: ${msg}`);
      if (started) {
        // Keep the marker: the database may be half restored.
        await this.mode.endRestoreHold(false);
        throw new Error(msg);
      }
      // Nothing was changed yet (a missing archive, a full disk, a
      // database blip while reading history): not a failed restore.
      if (e instanceof RestoreNotStartedError) throw e;
      throw notStarted(msg);
    } finally {
      if (stageDir) await fs.rm(stageDir, { recursive: true, force: true });
    }
  }

  /**
   * Refuse before unpacking when the archive volume cannot hold the
   * unpacked bucket and dump. The archive's own size stands in for
   * the dump (the dump is already compressed, so it is about its size
   * inside the archive). Fails open when statfs fails, like the
   * backup side's check.
   */
  private async assertRoomToUnpack(archivePath: string): Promise<void> {
    const manifest = await this.extractManifest(archivePath);
    const archiveBytes = (await fs.stat(archivePath)).size;
    const needed = restoreSpaceNeeded(manifest.minio?.totalBytes ?? 0, archiveBytes);
    const dir = path.dirname(archivePath);
    let free: number;
    try {
      const st = await fs.statfs(dir);
      free = Number(st.bavail) * Number(st.bsize);
    } catch (err) {
      this.log.warn(
        `statfs(${dir}) failed: ${err instanceof Error ? err.message : err}. Restoring without a space check.`,
      );
      return;
    }
    if (needed > free) {
      throw new RestoreNotStartedError(
        `Not enough space to unpack this backup. It needs about ${formatGb(needed)} ` +
          `and the backup folder has ${formatGb(free)} free. Free space or delete ` +
          'older backups, then try again. Nothing was changed.',
      );
    }
  }

  /** Live backup history, read before pg_restore replaces it. */
  async snapshotBackupHistory() {
    const [runs, notices, restores] = await Promise.all([
      this.prisma.backupRun.findMany(),
      this.prisma.backupFailureNotice.findMany(),
      this.prisma.backupRestore.findMany(),
    ]);
    return { runs, notices, restores };
  }

  /**
   * Put the live backup history back after pg_restore. The archive's
   * copy shows its own run as `running` (the dump is taken mid-run),
   * which reclaim would close as failed with a false "backup failed"
   * notice, and it lacks every run made after it. The live rows match
   * the archives on disk, so they win.
   */
  async restoreBackupHistory(
    history: Awaited<ReturnType<BackupRestoreService['snapshotBackupHistory']>>,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.backupRun.deleteMany({}),
      this.prisma.backupRun.createMany({ data: history.runs }),
      this.prisma.backupFailureNotice.deleteMany({}),
      this.prisma.backupFailureNotice.createMany({ data: history.notices }),
      this.prisma.backupRestore.deleteMany({}),
      this.prisma.backupRestore.createMany({ data: history.restores }),
    ]);
  }

  private async assertSchemaMatches(
    archive: string[],
    archiveVersion: string | null | undefined,
    toError: (msg: string) => Error,
  ): Promise<void> {
    const live = await this.backup.appliedMigrations();
    const why = schemaMismatch(archive, live, archiveVersion);
    if (why) throw toError(why);
  }

  /**
   * Read the applied migrations out of the dump's `_prisma_migrations`
   * data without touching the database. Null when the dump has no
   * such table or the read fails.
   */
  private async readDumpMigrations(dumpPath: string): Promise<string[] | null> {
    const container = this.cfg.get<string>('BACKUP_PGDUMP_DOCKER_CONTAINER', '');
    const args = [
      '--data-only',
      '--table=_prisma_migrations',
      '-f',
      '-',
    ];
    try {
      const out = container
        ? await this.captureCmd('docker', ['exec', '-i', container, 'pg_restore', ...args], dumpPath)
        : await this.captureCmd('pg_restore', [...args, dumpPath]);
      return parseMigrationsCopy(out);
    } catch (e) {
      this.log.warn(
        `Could not read migrations from the dump: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  /** Read the manifest without extracting the whole archive. */
  private async extractManifest(archivePath: string): Promise<ArchiveManifest> {
    // Pull just the manifest.json entry's bytes via `tar -xzO`,
    // which writes the selected entry to stdout and skips
    // everything else. Cheaper than extracting the full archive
    // when all we need is the version + database name to decide
    // whether the archive is even compatible.
    const buf = await readTarEntry(archivePath, 'manifest.json');
    if (!buf) {
      throw new NotFoundException(
        'Archive is missing manifest.json; it may not be a GratisGIS backup.',
      );
    }
    try {
      return JSON.parse(buf.toString('utf8')) as ArchiveManifest;
    } catch {
      throw new BadRequestException(
        'Archive manifest.json is not valid JSON.',
      );
    }
  }

  private async readStagedManifest(stageDir: string): Promise<ArchiveManifest> {
    const p = path.join(stageDir, 'manifest.json');
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as ArchiveManifest;
  }

  /**
   * Invoke pg_restore with --clean --if-exists so every object in
   * the schema is dropped and recreated. Host binary or docker exec,
   * same switch as pg_dump. See pgRestoreFailure() for the errors
   * this schema always produces and why they are let through.
   */
  private async runPgRestore(dumpPath: string) {
    const raw = this.cfg.get<string>('DATABASE_URL', '');
    if (!raw) throw new Error('DATABASE_URL is not set; cannot run pg_restore');
    const url = this.sanitizeDbUrl(raw);
    const container = this.cfg.get<string>(
      'BACKUP_PGDUMP_DOCKER_CONTAINER',
      '',
    );
    const args = [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-d',
      url,
    ];

    if (container) {
      // Docker mode: copy the dump into the container, then run
      // pg_restore there. pg_restore reads from a file, not stdin,
      // so we can't pipe like pg_dump's -> file. We use `docker cp`
      // to ferry the dump into /tmp inside the container, restore,
      // then rm it.
      const inContainerPath = `/tmp/gg-restore-${Date.now()}.dump`;
      await this.runCmd('docker', ['cp', dumpPath, `${container}:${inContainerPath}`]);
      try {
        await this.runPgRestoreCmd('docker', [
          'exec',
          '-e',
          `PG_URL=${url}`,
          container,
          'sh',
          '-c',
          `pg_restore --clean --if-exists --no-owner --no-privileges -d "$PG_URL" ${inContainerPath}`,
        ]);
      } finally {
        // Best-effort cleanup; if this fails we've left a dump file
        // in the postgres container. Non-fatal.
        await this.runCmd('docker', [
          'exec',
          container,
          'rm',
          '-f',
          inContainerPath,
        ]).catch(() => {});
      }
    } else {
      await this.runPgRestoreCmd('pg_restore', [...args, dumpPath]);
    }
  }

  /**
   * Run pg_restore and judge its stderr with pgRestoreFailure(): the
   * known partition errors are logged and let through, anything else
   * fails the restore.
   */
  private runPgRestoreCmd(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const stderr: Buffer[] = [];
      child.stderr.on('data', (c: Buffer) => stderr.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        const text = Buffer.concat(stderr).toString('utf8');
        const why = pgRestoreFailure(code, text);
        if (why) return reject(new Error(`pg_restore failed: ${why}`));
        if (code !== 0) {
          this.log.warn(
            'pg_restore reported only the known "cannot drop inherited constraint" errors for observation partitions; the restore is complete.',
          );
        }
        resolve();
      });
    });
  }

  /**
   * Walk the staged `minio/` tree and PUT every file back into the
   * bucket, preserving relative paths as keys. Streams each file to
   * keep memory bounded even for large attachments. After a full
   * PUT pass, deletes bucket keys that were not in the archive so
   * the live store matches the backup without a pre-empty (#233).
   */
  private async restoreMinio(srcDir: string) {
    const exists = await fs
      .access(srcDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      this.log.warn(
        'Archive has no minio/ directory; skipping object-store restore.',
      );
      return;
    }
    const restoredKeys = new Set<string>();
    const walk = async (dir: string, prefix: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(full, rel);
        } else if (e.isFile()) {
          const stat = await fs.stat(full);
          await this.s3.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: rel,
              Body: createReadStream(full),
              ContentLength: stat.size,
            }),
          );
          restoredKeys.add(rel);
        }
      }
    };
    await walk(srcDir, '');

    // Sweep keys the archive did not restore. Batched like emptyBucket.
    let continuation: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      const stale = (res.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k && !restoredKeys.has(k));
      if (stale.length) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: stale.map((Key) => ({ Key })) },
          }),
        );
      }
      continuation = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuation);
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  /** Minimal URL sanitiser: same rationale as BackupService's. */
  private sanitizeDbUrl(url: string): string {
    try {
      const u = new URL(url);
      u.search = ''; // pg_restore doesn't care about Prisma params either
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * Promise-wrapped spawn. Buffers stderr for a helpful error
   * message on non-zero exit; stdout is discarded because the tools
   * we invoke here don't produce useful stdout.
   */
  private captureCmd(
    bin: string,
    args: string[],
    stdinFile?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: [stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (c: Buffer) => out.push(c));
      child.stderr?.on('data', (c: Buffer) => err.push(c));
      child.on('error', reject);
      if (stdinFile && child.stdin) {
        const src = createReadStream(stdinFile);
        src.on('error', reject);
        child.stdin.on('error', () => undefined);
        src.pipe(child.stdin);
      }
      child.on('close', (code) => {
        if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
        reject(
          new Error(
            `${bin} exited with code ${code}: ${Buffer.concat(err).toString('utf8').slice(-300)}`,
          ),
        );
      });
    });
  }

  private runCmd(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderr: Buffer[] = [];
      child.stderr.on('data', (c) => stderr.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const tail = Buffer.concat(stderr).toString('utf8').slice(-500);
        reject(
          new Error(
            `${bin} ${args.slice(0, 2).join(' ')}… exited with code ${code}: ${tail || '(no stderr)'}`,
          ),
        );
      });
    });
  }
}
