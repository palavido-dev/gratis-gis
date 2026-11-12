// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { containedPayloadFile, payloadFileName } from './ingest-disk-path.js';

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
 *     <stored-name>            the actual bytes
 *     meta.json                { ownerId, originalName, storedName, sizeBytes, createdAt }
 *
 * `storedName` is the plain file name the bytes were written under.
 * Stagings written before it existed have no `storedName`; for those
 * getStaging() falls back to safeFilename(originalName), the rule
 * those versions used.
 *
 * Authorization is per-user: we record the userId at stage time and
 * refuse a getStaging() lookup from anyone else. This is also why the
 * wizard's Create item flow is the only thing that consumes a staging
 * -- shared/team uploads are out of scope for v1.
 *
 * Lifetime: one hour. The cleanup cron runs every 30 minutes and
 * blows away any staging whose meta.createdAt is older than that,
 * unless an import job still queued or running reads from it. A
 * user who pauses on the Create item screen for over an hour will
 * have to re-upload, which we treat as an acceptable trade for
 * bounded disk usage. Stagings are also bounded by the free-disk
 * check each upload passes and the 50 GB sanity ceiling shared with
 * the rest of the ingest stack.
 */
const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for one string shaped like the UUIDs stage() mints. */
export function isStagingId(value: unknown): value is string {
  return typeof value === 'string' && STAGING_ID.test(value);
}

/**
 * The filesystem that holds staged uploads. Prod mounts STAGING_DIR
 * as its own volume, so free-space checks must look there and not at
 * the container's tmpdir. Without STAGING_DIR the staging tree sits
 * under tmpdir(), so that is the filesystem to measure.
 */
export function stagingDiskPath(): string {
  return process.env.STAGING_DIR?.trim() || tmpdir();
}

/**
 * Resolve `child` under `root` and refuse anything that lands outside
 * it. Returns null for an escape so callers pick their own error.
 */
function insideRoot(root: string, ...parts: string[]): string | null {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  return target.startsWith(base + sep) ? target : null;
}

@Injectable()
export class IngestStagingService implements OnModuleInit {
  private readonly log = new Logger(IngestStagingService.name);

  constructor(
    private readonly leader: LeaderElectionService,
    // Optional so the bare-construction specs keep working. Every Nest
    // graph that provides this service has the global PrismaModule.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

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
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fileName = notMetaFile(safeFilename(input.originalName));
    const filePath = join(dir, fileName);
    await writeFile(filePath, input.buffer, { mode: 0o600 });
    const meta: StagingMeta = {
      ownerId: input.ownerId,
      originalName: plainLabel(input.originalName),
      storedName: fileName,
      sizeBytes: input.buffer.length,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    this.log.log(`Staged upload (${input.buffer.length} B) as ${stagingId}`);
    return {
      stagingId,
      filePath,
      originalName: plainLabel(input.originalName),
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
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // The source path was chosen by the disk-upload pin, not by the
    // request filename. Resolve it and refuse anything that is not
    // that file, then keep the same server-chosen name in staging.
    const source = containedPayloadFile(input.filePath);
    const payloadName = payloadFileName(basename(source));
    const storedName = payloadName ? notMetaFile(payloadName) : null;
    if (!storedName) {
      throw new BadRequestException('Upload file was not accepted.');
    }
    const filePath = join(dir, storedName);
    // rename is instant within a filesystem; fall back to copy+unlink
    // across devices (multer's tmpdir may be on a different mount than
    // the staging root).
    try {
      await rename(source, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(source, filePath);
        await rm(source, { force: true }).catch(() => {});
      } else {
        throw err;
      }
    }
    const sizeBytes = (await stat(filePath)).size;
    const meta: StagingMeta = {
      ownerId: input.ownerId,
      originalName: plainLabel(input.originalName),
      storedName,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    this.log.log(`Staged upload (${sizeBytes} B) as ${stagingId}`);
    return {
      stagingId,
      filePath,
      originalName: plainLabel(input.originalName),
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
    /**
     * Name to store the bytes under. Must be a `serverUploadName`
     * result. The resumable import upload passes one so a staged file
     * gets the same name the multipart path would have given it.
     */
    storedName?: string;
  }): Promise<{
    stagingId: string;
    filePath: string;
    originalName: string;
    sizeBytes: number;
  }> {
    let chosen = safeFilename(input.originalName);
    if (input.storedName !== undefined) {
      const stored = payloadFileName(input.storedName);
      if (!stored) {
        throw new BadRequestException('Upload file was not accepted.');
      }
      chosen = stored;
    }
    const stagingId = randomUUID();
    const dir = join(this.root, stagingId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const fileName = notMetaFile(chosen);
    const filePath = join(dir, fileName);
    try {
      await pipeline(input.stream, createWriteStream(filePath, { mode: 0o600 }));
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
      originalName: plainLabel(input.originalName),
      storedName: fileName,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    this.log.log(`Staged upload (${sizeBytes} B, streamed) as ${stagingId}`);
    return {
      stagingId,
      filePath,
      originalName: plainLabel(input.originalName),
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
  ): Promise<{
    filePath: string;
    originalName: string;
    sizeBytes: number;
    /** Feature count per source layer, from the probe that ran when
     *  the file was staged (see recordLayerCounts). */
    layerCounts?: Map<string, number>;
  }> {
    // Only a UUID minted by stage() is a staging id, and the resolved
    // directory must sit directly inside the staging root.
    if (!isStagingId(stagingId)) {
      throw new NotFoundException('Unknown stagingId.');
    }
    const dir = insideRoot(this.root, stagingId);
    if (!dir) {
      throw new NotFoundException('Unknown stagingId.');
    }
    const id = stagingId;
    if (!existsSync(dir)) {
      throw new NotFoundException(
        'Staging was not found. It may have expired; re-upload to retry.',
      );
    }
    const rootReal = realpathSync(this.root);
    const dirReal = realpathSync(dir);
    const rel = relative(rootReal, dirReal);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || rel !== id) {
      throw new NotFoundException('Staging was not found.');
    }
    const metaRaw = await readFile(join(dirReal, 'meta.json'), 'utf8').catch(
      () => null,
    );
    if (!metaRaw) {
      throw new NotFoundException(
        'Staging is missing its meta record. Re-upload to retry.',
      );
    }
    let meta: StagingMeta;
    try {
      meta = JSON.parse(metaRaw) as StagingMeta;
    } catch {
      throw new NotFoundException(
        'Staging has a corrupt meta record. Re-upload to retry.',
      );
    }
    if (meta.ownerId !== callerUserId) {
      throw new ForbiddenException(
        'That staging belongs to a different user.',
      );
    }
    const stored = storedFileName(meta);
    if (!stored) {
      throw new NotFoundException('Staging file was not accepted.');
    }
    const filePath = join(dirReal, stored);
    const fileRel = relative(dirReal, filePath);
    if (fileRel !== stored || isAbsolute(fileRel)) {
      throw new NotFoundException('Staging file was not accepted.');
    }
    if (!existsSync(filePath)) {
      throw new NotFoundException(
        'Staging file is missing. Re-upload to retry.',
      );
    }
    const layerCounts = await readLayerCounts(join(dirReal, COUNTS_FILE));
    return {
      filePath,
      originalName: meta.originalName,
      sizeBytes: meta.sizeBytes,
      ...(layerCounts ? { layerCounts } : {}),
    };
  }

  /**
   * Keep the per-layer feature counts the staging probe found. Each
   * import job needs its layer's count for the progress bar, and
   * reprobing the file for it ran a full synchronous GDAL scan on the
   * API event loop once per queued layer. Best effort.
   */
  async recordLayerCounts(
    stagingId: string,
    callerUserId: string,
    layers: ReadonlyArray<{ name: string; featureCount: number }>,
  ): Promise<void> {
    try {
      const { filePath } = await this.getStaging(stagingId, callerUserId);
      const pairs = layers
        .filter((l) => typeof l.name === 'string' && Number.isFinite(l.featureCount))
        .map((l) => [l.name, l.featureCount] as const);
      await writeFile(join(dirname(filePath), COUNTS_FILE), JSON.stringify(pairs), {
        mode: 0o600,
      });
    } catch {
      /* the job then just starts without a total */
    }
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
   * that crashed before writing meta.json). Runs every 30 min.
   *
   * A staging that a queued or running import job still reads from is
   * kept whatever its age. The import worker runs one job at a time,
   * so a multi-layer upload, or anything queued behind a county-sized
   * import, can easily wait over an hour; deleting its file then fails
   * an import the user was already told was queued.
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

  /**
   * Staging ids an unfinished import job still needs, or null when that
   * cannot be read. A failed read skips the sweep: deleting a file a
   * job needs is worse than keeping one an extra half hour.
   */
  private async stagingIdsInUse(): Promise<Set<string> | null> {
    if (!this.prisma) return new Set();
    try {
      const rows = await this.prisma.importJob.findMany({
        where: { status: { in: [...STAGING_SWEEP_KEEPS_JOB_STATES] } },
        select: { stagingId: true },
      });
      return new Set(rows.map((r) => r.stagingId));
    } catch (err) {
      this.log.warn(
        `Staging cleanup skipped; could not read import jobs: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
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
    const inUse = await this.stagingIdsInUse();
    if (inUse === null) return;
    const now = Date.now();
    let removed = 0;
    for (const id of entries) {
      if (inUse.has(id)) continue;
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

/** Exported for the spec. */
export const STAGING_SWEEP_KEEPS_JOB_STATES = ['queued', 'running'] as const;

/** Per-layer feature counts next to meta.json, as [name, count] pairs.
 *  The leading dot keeps it apart from any stored upload name, which
 *  never starts with a dot. */
const COUNTS_FILE = '.layer-counts.json';

async function readLayerCounts(path: string): Promise<Map<string, number> | null> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const pairs = JSON.parse(raw) as unknown;
    if (!Array.isArray(pairs)) return null;
    const out = new Map<string, number>();
    for (const p of pairs) {
      if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'number') {
        out.set(p[0], p[1]);
      }
    }
    return out;
  } catch {
    return null;
  }
}

interface StagingMeta {
  ownerId: string;
  originalName: string;
  /** File name inside the staging directory. Absent on stagings
   *  written before this field existed. */
  storedName?: string;
  sizeBytes: number;
  createdAt: string;
}

/** Display label for an upload name: printable ASCII, no path. */
function plainLabel(name: string): string {
  const base = basename(typeof name === 'string' ? name : '');
  const chars: string[] = [];
  for (let i = 0; i < base.length && chars.length < 120; i += 1) {
    const ch = base.charAt(i);
    const ok =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '.' ||
      ch === '_' ||
      ch === '-' ||
      ch === ' ';
    if (ok) chars.push(ch);
  }
  return chars.join('') || 'upload';
}

/**
 * File name of the staged bytes, or null when meta.json names
 * anything other than a plain file inside the staging directory.
 * Disk uploads store a `serverUploadName` result; buffer and stream
 * stagings store safeFilename(originalName). Both are fixed points of
 * their own rule, so a value that a rule would change (a separator,
 * `..`, a leading dot) is refused. Stagings written before
 * `storedName` existed fall back to safeFilename(originalName).
 */
function storedFileName(meta: StagingMeta): string | null {
  const candidate =
    typeof meta.storedName === 'string'
      ? meta.storedName
      : typeof meta.originalName === 'string'
        ? safeFilename(meta.originalName)
        : '';
  if (
    candidate.length === 0 ||
    candidate === '.' ||
    candidate === '..' ||
    candidate === 'meta.json'
  ) {
    return null;
  }
  if (candidate.includes('/') || candidate.includes('\\')) return null;
  if (payloadFileName(candidate)) return candidate;
  return safeFilename(candidate) === candidate ? candidate : null;
}

/** An upload literally named meta.json must not overwrite the record. */
function notMetaFile(name: string): string {
  return name === 'meta.json' ? 'upload_meta.json' : name;
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
  base = base.replace(/^\.+/, '_').replace(/(?<!\.)\.+$/, '_');
  return base.length > 0 && base !== '_' ? base : 'upload.bin';
}
