// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Staged-upload service. The data_layer create wizard uploads a
 * spatial file ONCE (typically a 200-500 MB GDB or shapefile zip) and
 * then asks portal-api to (a) probe it for schema metadata and
 * (b) ingest each layer into its own per-layer table. Without
 * staging, every layer ingest demands the same multipart upload
 * again -- a 500 MB GDB with two layers turned a single user-facing
 * "Create item" click into 1.5 GB of upload bandwidth. With staging,
 * the file lands once, gets parked under /tmp/gg-staging/<id>/, and
 * subsequent /items/:id/layers/:layerId/import?stagingId=... calls
 * read straight off disk.
 *
 * On-disk layout (one directory per stagingId):
 *
 *   /tmp/gg-staging/<uuid>/
 *     <safe-original-name>     -- the actual bytes
 *     meta.json                -- { ownerId, originalName, sizeBytes, createdAt }
 *
 * Authorization is per-user: we record the userId at stage time and
 * refuse a getStaging() lookup from anyone else. This is also why the
 * wizard's Create item flow is the only thing that consumes a staging
 * -- shared/team uploads are out of scope for v1.
 *
 * Lifetime: one hour. The cleanup cron runs every 15 minutes and
 * blows away any staging whose meta.createdAt is older than that. A
 * user who pauses on the Create item screen for over an hour will
 * have to re-upload, which we treat as an acceptable trade for
 * bounded disk usage. Stagings are also implicitly bounded by the
 * 1 GB per-file ceiling shared with the rest of the ingest stack.
 */
@Injectable()
export class IngestStagingService implements OnModuleInit {
  private readonly log = new Logger(IngestStagingService.name);

  constructor(private readonly leader: LeaderElectionService) {}

  /** Stagings expire after this many ms of wall-clock age. */
  private readonly maxAgeMs = 60 * 60 * 1000; // 1h

  /** Root of the staging tree on disk. Defaults to a tmpdir-rooted
   *  path; the prod compose overrides it via STAGING_DIR to a named
   *  volume that's mounted in BOTH portal-api (writer) and portal-
   *  worker (reader). Without the shared volume the worker would
   *  ENOENT on every staged file because they live in a different
   *  container's tmpfs. */
  private readonly root =
    process.env.STAGING_DIR && process.env.STAGING_DIR.trim().length > 0
      ? process.env.STAGING_DIR
      : join(tmpdir(), 'gg-staging');

  async onModuleInit() {
    // Make sure the staging root exists before anybody tries to write
    // to it. Idempotent.
    await mkdir(this.root, { recursive: true }).catch((err) => {
      this.log.warn(
        `Could not create staging root ${this.root}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
    // Sweep any stagings left behind by a previous process that died
    // mid-flight. They would otherwise leak disk forever (the cleanup
    // cron would eventually catch them, but better to do it on boot).
    await this.cleanupStaleSync().catch(() => {
      // Already logged inside; swallow so a bad disk doesn't block boot.
    });
  }

  /**
   * Persist `buffer` under a fresh stagingId and return that id along
   * with the metadata we wrote alongside. The stagingId is suitable
   * for round-tripping back to the client and presenting to a later
   * /items/:id/layers/:layerId/import?stagingId=... call.
   */
  async stage(input: {
    buffer: Buffer;
    originalName: string;
    ownerId: string;
  }): Promise<{
    stagingId: string;
    filePath: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const stagingId = randomUUID();
    const dir = join(this.root, stagingId);
    await mkdir(dir, { recursive: true });
    const fileName = safeFilename(input.originalName);
    const filePath = join(dir, fileName);
    await writeFile(filePath, input.buffer);
    const meta: StagingMeta = {
      ownerId: input.ownerId,
      originalName: input.originalName,
      sizeBytes: input.buffer.length,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    this.log.log(
      `Staged ${input.originalName} (${input.buffer.length} B) as ${stagingId} for user ${input.ownerId}`,
    );
    return {
      stagingId,
      filePath,
      originalName: input.originalName,
      sizeBytes: input.buffer.length,
    };
  }

  /**
   * Like `stage`, but the upload is already on disk (multer disk
   * storage) so we MOVE it into the staging area rather than writing
   * a buffer. This keeps a large upload off the API replica's heap:
   * nothing is ever held in memory. `input.filePath` is consumed
   * (moved away), so the caller only needs to clean up its now-empty
   * temp dir.
   */
  async stageFromPath(input: {
    filePath: string;
    originalName: string;
    ownerId: string;
  }): Promise<{
    stagingId: string;
    filePath: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const stagingId = randomUUID();
    const dir = join(this.root, stagingId);
    await mkdir(dir, { recursive: true });
    const fileName = safeFilename(input.originalName);
    const filePath = join(dir, fileName);
    // rename is instant within a filesystem; fall back to copy+unlink
    // across devices (multer's tmpdir may be on a different mount than
    // the staging root).
    try {
      await rename(input.filePath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(input.filePath, filePath);
        await rm(input.filePath, { force: true }).catch(() => {});
      } else {
        throw err;
      }
    }
    const sizeBytes = (await stat(filePath)).size;
    const meta: StagingMeta = {
      ownerId: input.ownerId,
      originalName: input.originalName,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    this.log.log(
      `Staged ${input.originalName} (${sizeBytes} B) as ${stagingId} for user ${input.ownerId}`,
    );
    return {
      stagingId,
      filePath,
      originalName: input.originalName,
      sizeBytes,
    };
  }

  /**
   * Stream variant of stage() for callers whose source is already a
   * Readable (the analysis bridge pulling a multi-hundred-MB contour
   * GeoJSON artifact out of MinIO). stage() forces the whole payload
   * through one Buffer, which held entire artifacts in worker-process
   * memory; piping straight to disk keeps peak memory at pipe-buffer
   * size regardless of artifact size. Same on-disk layout and meta
   * contract as stage(), so getStaging() consumers cannot tell the
   * difference.
   */
  async stageStream(input: {
    stream: NodeJS.ReadableStream;
    originalName: string;
    ownerId: string;
  }): Promise<{
    stagingId: string;
    filePath: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const stagingId = randomUUID();
    const dir = join(this.root, stagingId);
    await mkdir(dir, { recursive: true });
    const fileName = safeFilename(input.originalName);
    const filePath = join(dir, fileName);
    try {
      await pipeline(input.stream, createWriteStream(filePath));
    } catch (err) {
      // A half-written staging must not survive: the id was never
      // returned so nothing references it, and meta.json is written
      // after the bytes on purpose so the cleanup cron's meta-less
      // fallback would catch a crash between these two steps.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    // Size comes from the file itself; a stream has no trustworthy
    // up-front length.
    const sizeBytes = (await stat(filePath)).size;
    const meta: StagingMeta = {
      ownerId: input.ownerId,
      originalName: input.originalName,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    this.log.log(
      `Staged ${input.originalName} (${sizeBytes} B, streamed) as ${stagingId} for user ${input.ownerId}`,
    );
    return {
      stagingId,
      filePath,
      originalName: input.originalName,
      sizeBytes,
    };
  }

  /**
   * Resolve a stagingId to the on-disk file path, verifying that the
   * caller is the user who staged it. Throws NotFoundException for an
   * unknown / expired id and ForbiddenException for an id that
   * belongs to someone else (a stagingId leaked into a wrong session
   * should not give that session access to the staged bytes).
   */
  async getStaging(
    stagingId: string,
    callerUserId: string,
  ): Promise<{ filePath: string; originalName: string; sizeBytes: number }> {
    if (!stagingId || !/^[0-9a-f-]{8,40}$/i.test(stagingId)) {
      throw new NotFoundException(`Unknown stagingId "${stagingId}".`);
    }
    const dir = join(this.root, stagingId);
    if (!existsSync(dir)) {
      throw new NotFoundException(
        `Staging "${stagingId}" not found (it may have expired; re-upload to retry).`,
      );
    }
    const metaRaw = await readFile(join(dir, 'meta.json'), 'utf8').catch(
      () => null,
    );
    if (!metaRaw) {
      throw new NotFoundException(
        `Staging "${stagingId}" is missing its meta record (re-upload to retry).`,
      );
    }
    let meta: StagingMeta;
    try {
      meta = JSON.parse(metaRaw) as StagingMeta;
    } catch {
      throw new NotFoundException(
        `Staging "${stagingId}" has a corrupt meta record (re-upload to retry).`,
      );
    }
    if (meta.ownerId !== callerUserId) {
      throw new ForbiddenException(
        'That staging belongs to a different user.',
      );
    }
    const filePath = join(dir, safeFilename(meta.originalName));
    if (!existsSync(filePath)) {
      throw new NotFoundException(
        `Staging "${stagingId}" file is missing (re-upload to retry).`,
      );
    }
    return {
      filePath,
      originalName: meta.originalName,
      sizeBytes: meta.sizeBytes,
    };
  }

  /**
   * Delete a single staging on demand. Best-effort -- callers should
   * not depend on this returning to confirm cleanup, since the cron
   * will eventually catch it anyway. Used by Create-item-success
   * paths that want to reclaim disk eagerly when ingest succeeds.
   */
  async dropStaging(stagingId: string): Promise<void> {
    if (!stagingId) return;
    // Same shape gate as getStaging: refuse anything that isn't a
    // hex / hyphen UUID-shaped token before it lands in a join().
    // Without the gate, a caller passing '../../bin' would resolve
    // outside this.root.
    if (!/^[0-9a-f-]{8,40}$/i.test(stagingId)) return;
    const dir = join(this.root, stagingId);
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      this.log.warn(
        `Failed to drop staging ${stagingId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
  }

  /**
   * Periodic cleanup. Walks the staging root and removes any
   * directory whose meta.createdAt is older than maxAgeMs. Also
   * deletes meta-less directories older than maxAgeMs (a stage()
   * that crashed before writing meta.json). Runs every 15 min.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupStaleScheduled(): Promise<void> {
    // Multi-replica safety: only the leader sweeps. The staging volume
    // is shared so any replica's cleanup would scan the same set, but
    // letting all of them race produces ENOENT noise + duplicate
    // recursive deletes.
    if (!this.leader.shouldRun()) return;
    await this.cleanupStaleSync();
  }

  private async cleanupStaleSync(): Promise<void> {
    if (!existsSync(this.root)) return;
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      this.log.warn(
        `Staging cleanup could not read ${this.root}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return;
    }
    const now = Date.now();
    let removed = 0;
    for (const id of entries) {
      const dir = join(this.root, id);
      const metaPath = join(dir, 'meta.json');
      let createdAt: number | null = null;
      try {
        const metaRaw = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as StagingMeta;
        createdAt = Date.parse(meta.createdAt);
      } catch {
        // No meta or bad meta: fall back to directory mtime.
        try {
          const st = await stat(dir);
          createdAt = st.mtimeMs;
        } catch {
          continue;
        }
      }
      if (createdAt === null || Number.isNaN(createdAt)) continue;
      if (now - createdAt > this.maxAgeMs) {
        await rm(dir, { recursive: true, force: true }).catch((err) => {
          this.log.warn(
            `Failed to remove expired staging ${id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
        removed += 1;
      }
    }
    if (removed > 0) {
      this.log.log(`Removed ${removed} expired staging${removed === 1 ? '' : 's'}.`);
    }
  }
}

interface StagingMeta {
  ownerId: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Mirrors the safeFilename helper in ingest.service.ts. Kept local so
 * the staging service does not import from the GDAL-loading service
 * (which has heavier transitive deps).
 *
 * Defends against path-traversal: the user-supplied name flows into
 * join(this.root, stagingId, safeFilename(name)) so a malicious
 * `../../etc/x` could otherwise escape the staging root. Steps:
 *   1. basename() strips any path segments,
 *   2. char filter scrubs everything outside [A-Za-z0-9._-],
 *   3. leading and trailing dots are replaced so `..` / `.hidden`
 *      cannot survive,
 *   4. empty / single-underscore results fall back to upload.bin.
 *
 * Keep these two helpers in sync.
 */
function safeFilename(name: string): string {
  const fileOnly = basename(name);
  let base = fileOnly.replace(/[^\w.-]/g, '_');
  base = base.replace(/^\.+/, '_').replace(/\.+$/, '_');
  return base.length > 0 && base !== '_' ? base : 'upload.bin';
}
