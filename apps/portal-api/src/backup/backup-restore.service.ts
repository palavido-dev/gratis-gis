import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as tar from 'tar';

import { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup.service.js';
import { MaintenanceModeService } from './maintenance-mode.service.js';

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
    const stat = await fs.stat(archivePath);
    return {
      runId,
      filename: path.basename(archivePath),
      sizeBytes: stat.size,
      manifest,
    };
  }

  /**
   * Execute the destructive restore. Caller must have already
   * flipped maintenance mode on. Returns the audit row once the
   * restore completes.
   */
  async runRestore(args: { runId: string; startedBy: string }) {
    if (!this.mode.isActive()) {
      throw new Error(
        'Maintenance mode must be active before runRestore(). The controller is supposed to handle this; refusing as a safety net.',
      );
    }

    const { path: archivePath, filename } = await this.backup.resolveArchivePath(
      args.runId,
    );
    this.log.warn(
      `RESTORE STARTING: user=${args.startedBy} archive=${filename}`,
    );
    const stageDir = path.join(
      path.dirname(archivePath),
      `.restore-${Date.now()}`,
    );
    await fs.mkdir(stageDir, { recursive: true });

    const failWith = async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`RESTORE FAILED: ${msg}`);
      // Clean the staging dir on failure; leaving half-extracted
      // tarball bytes lying around is confusing the next time someone
      // debugs BACKUP_DIR.
      await fs.rm(stageDir, { recursive: true, force: true });
      // We cannot write the audit row on the "pre-restore" DB when
      // we failed mid-restore: pg_restore may have partially
      // rewritten the schema. Best we can do is log + return.
      throw new Error(msg);
    };

    try {
      // 1. Extract the archive into a staging dir.
      await tar.x({ file: archivePath, cwd: stageDir });

      const manifest = await this.readStagedManifest(stageDir);
      if (manifest.version !== 1) {
        return failWith(
          `Archive manifest version ${manifest.version} isn't supported.`,
        );
      }

      // 2. Restore postgres. The dump is in custom format; we use
      //    pg_restore with --clean --if-exists to drop & recreate
      //    every object in our schema before reloading. This assumes
      //    the portal's DB user owns the schema.
      const dumpRel = path.join(
        'postgres',
        `${manifest.databases[0] ?? 'gratisgis'}.dump`,
      );
      const dumpPath = path.join(stageDir, dumpRel);
      await fs.access(dumpPath).catch(() => {
        throw new Error(`Archive is missing ${dumpRel}`);
      });
      await this.runPgRestore(dumpPath);

      // 3. Rebuild the MinIO bucket. Empty existing contents first
      //    (batched delete); then PUT every file from the archive's
      //    `minio/` directory preserving the relative path as the key.
      await this.emptyBucket();
      await this.restoreMinio(path.join(stageDir, 'minio'));

      // 4. Write the audit row on the restored DB. We know the
      //    schema is intact because pg_restore just rebuilt it.
      const audit = await this.prisma.backupRestore.create({
        data: {
          fromRunId: args.runId,
          filename,
          finishedAt: new Date(),
          status: 'succeeded',
          startedBy: args.startedBy,
        },
      });
      this.log.warn(
        `RESTORE SUCCEEDED: audit=${audit.id} archive=${filename}`,
      );
      return audit;
    } catch (e) {
      return failWith(e);
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  /** Read the manifest without extracting the whole archive. */
  private async extractManifest(archivePath: string): Promise<ArchiveManifest> {
    let raw: string | null = null;
    await tar.t({
      file: archivePath,
      filter: (p) => p === 'manifest.json',
      onReadEntry: (entry) => {
        const chunks: Buffer[] = [];
        entry.on('data', (c: Buffer) => chunks.push(c));
        entry.on('end', () => {
          raw = Buffer.concat(chunks).toString('utf8');
        });
      },
    });
    if (!raw) {
      throw new NotFoundException(
        'Archive is missing manifest.json; it may not be a GratisGIS backup.',
      );
    }
    try {
      return JSON.parse(raw) as ArchiveManifest;
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
   * same switch as pg_dump.
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
        await this.runCmd('docker', [
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
      await this.runCmd('pg_restore', [...args, dumpPath]);
    }
  }

  private async emptyBucket() {
    let continuation: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      const keys = (res.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k);
      if (keys.length) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }
      continuation = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuation);
  }

  /**
   * Walk the staged `minio/` tree and PUT every file back into the
   * bucket, preserving relative paths as keys. Streams each file to
   * keep memory bounded even for large attachments.
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
        }
      }
    };
    await walk(srcDir, '');
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
