// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Logger } from '@nestjs/common';

import type { BackupService } from './backup.service.js';
import type { OffsiteSettings } from './offsite-config.js';
import {
  OFFSITE_FORMAT,
  sealedSize,
  sealStream,
  unsealStream,
  type OffsitePrivateKey,
  type OffsitePublicKey,
} from './offsite-crypto.js';
import {
  MIRROR_RUN_RE,
  OFFSITE_LAYOUT,
  partitionByDate,
  selectExpired,
  setAsideReason,
  stampFromName,
  suspectDate,
  type ArtifactTrust,
  type OffsiteArtifact,
} from './offsite-rules.js';
import {
  artifactTrust,
  checkSignature,
  signManifest,
  type CopyCheck,
  type MirrorManifest,
  type OffsiteSigningKey,
  type OffsiteVerifyKey,
} from './offsite-sign.js';
import {
  deleteObject,
  getObjectStream,
  getSmall,
  listObjects,
  putSmall,
  uploadStream,
  type S3Like,
} from './offsite-store.js';
import { readTarEntry, streamTarEntry } from './tar-cli.js';

/** One line of a mirror run's file index (encrypted in the bucket). */
export interface MirrorIndexLine {
  /** Object key in the portal's bucket. */
  k: string;
  /** Encrypted file name under mirror/objects/. */
  o: string;
  /** Plain size in bytes. */
  s: number;
  /** Content type. */
  t?: string;
  /** Size of the encrypted file in the bucket. */
  z: number;
  /** SHA-256 of the encrypted file in the bucket, hex. */
  h: string;
}

/** A row of the server's own record of mirrored files. */
export interface MirrorIndexRow {
  /** The file's name in the bucket: new and random for every upload. */
  name: string;
  /** Which stored file and version it holds (see mirrorSourceId). */
  source: string;
  keyFingerprint: string;
  plainBytes: number;
  sealedBytes: number;
  /** SHA-256 of the encrypted file, hex; null for rows made before it was recorded. */
  sealedSha256: string | null;
  contentType: string | null;
  lastRunAt: Date;
}

/**
 * The server's own record of what mirror mode uploaded. The bucket is
 * encrypted to a key this server does not hold, so it can never read
 * a run's file list back; this record is how it knows which files are
 * already there. Losing it costs a full upload: every file is uploaded
 * again under a new name, and nothing already in the bucket changes.
 */
export interface MirrorIndexStore {
  /** The newest row for each of these sources. */
  find(target: string, sources: string[]): Promise<Map<string, MirrorIndexRow>>;
  /** Which of these bucket names the index holds. */
  known(target: string, names: string[]): Promise<Set<string>>;
  record(target: string, row: MirrorIndexRow): Promise<void>;
  /** Move lastRunAt forward to `runAt` for these names. */
  touch(target: string, names: string[], runAt: Date): Promise<void>;
  /** Names whose newest run is older than `before`, oldest first. */
  olderThan(target: string, before: Date, limit: number): Promise<string[]>;
  remove(target: string, names: string[]): Promise<void>;
  /** Note a mirror run this server starts, before it uploads anything. */
  recordRun(target: string, runId: string): Promise<void>;
  /** The mirror runs this server started. */
  runIds(target: string): Promise<Set<string>>;
  forgetRuns(target: string, runIds: string[]): Promise<void>;
}

/** Prisma calls MirrorIndexStore needs; the real client and test fakes both fit. */
export interface MirrorIndexPrisma {
  backupOffsiteObject: {
    findMany(args: unknown): Promise<
      Array<{
        name: string;
        source: string;
        keyFingerprint: string;
        plainBytes: bigint;
        sealedBytes: bigint;
        sealedSha256: string | null;
        contentType: string | null;
        lastRunAt: Date;
      }>
    >;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  backupOffsiteMirrorRun: {
    findMany(args: unknown): Promise<Array<{ runId: string }>>;
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

export class PrismaMirrorIndex implements MirrorIndexStore {
  constructor(private readonly prisma: MirrorIndexPrisma) {}

  async find(target: string, sources: string[]) {
    const out = new Map<string, MirrorIndexRow>();
    if (sources.length === 0) return out;
    // Newest first, so the first row seen for a source is its newest.
    const rows = await this.prisma.backupOffsiteObject.findMany({
      where: { target, source: { in: sources } },
      orderBy: { lastRunAt: 'desc' },
    });
    for (const r of rows) {
      if (out.has(r.source)) continue;
      out.set(r.source, {
        name: r.name,
        source: r.source,
        keyFingerprint: r.keyFingerprint,
        plainBytes: Number(r.plainBytes),
        sealedBytes: Number(r.sealedBytes),
        sealedSha256: r.sealedSha256 ?? null,
        contentType: r.contentType,
        lastRunAt: r.lastRunAt,
      });
    }
    return out;
  }

  async known(target: string, names: string[]) {
    if (names.length === 0) return new Set<string>();
    const rows = await this.prisma.backupOffsiteObject.findMany({
      where: { target, name: { in: names } },
      select: { name: true },
    });
    return new Set(rows.map((r) => r.name));
  }

  async record(target: string, row: MirrorIndexRow) {
    const data = {
      source: row.source,
      keyFingerprint: row.keyFingerprint,
      plainBytes: BigInt(row.plainBytes),
      sealedBytes: BigInt(row.sealedBytes),
      sealedSha256: row.sealedSha256,
      contentType: row.contentType,
      uploadedAt: new Date(),
      lastRunAt: row.lastRunAt,
    };
    await this.prisma.backupOffsiteObject.upsert({
      where: { target_name: { target, name: row.name } },
      create: { target, name: row.name, ...data },
      update: data,
    });
  }

  async touch(target: string, names: string[], runAt: Date) {
    if (names.length === 0) return;
    await this.prisma.backupOffsiteObject.updateMany({
      where: { target, name: { in: names }, lastRunAt: { lt: runAt } },
      data: { lastRunAt: runAt },
    });
  }

  async olderThan(target: string, before: Date, limit: number) {
    const rows = await this.prisma.backupOffsiteObject.findMany({
      where: { target, lastRunAt: { lt: before } },
      orderBy: { lastRunAt: 'asc' },
      take: limit,
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async remove(target: string, names: string[]) {
    if (names.length === 0) return;
    await this.prisma.backupOffsiteObject.deleteMany({ where: { target, name: { in: names } } });
  }

  async recordRun(target: string, runId: string) {
    await this.prisma.backupOffsiteMirrorRun.upsert({
      where: { target_runId: { target, runId } },
      create: { target, runId },
      update: {},
    });
  }

  async runIds(target: string) {
    const rows = await this.prisma.backupOffsiteMirrorRun.findMany({
      where: { target },
      select: { runId: true },
    });
    return new Set(rows.map((r) => r.runId));
  }

  async forgetRuns(target: string, runIds: string[]) {
    if (runIds.length === 0) return;
    await this.prisma.backupOffsiteMirrorRun.deleteMany({
      where: { target, runId: { in: runIds } },
    });
  }
}

/**
 * Which bucket and folder a row of the local index belongs to. A new
 * endpoint, bucket or folder starts from nothing.
 */
export function mirrorTarget(s: Pick<OffsiteSettings, 'endpoint' | 'bucket' | 'prefix'>): string {
  return createHash('sha256')
    .update(`${s.endpoint ?? ''}\n${s.bucket ?? ''}\n${s.prefix}`)
    .digest('hex');
}

/**
 * Which stored file and version a mirrored file holds, for the local
 * index only (never a name in the bucket): an HMAC, under a key only
 * this server has, of the public key's fingerprint and the file's key,
 * size and ETag. A changed file, or a new public key, gives a new
 * source, so it is uploaded again.
 */
export function mirrorSourceId(
  nameKey: Buffer,
  fingerprint: Buffer,
  key: string,
  size: number,
  etag: string | null,
): string {
  return createHmac('sha256', nameKey)
    .update(`v1\0${fingerprint.toString('hex')}\0${key}\0${size}\0${etag ?? ''}`)
    .digest('hex');
}

/**
 * A new name for a file about to be uploaded: 32 random bytes, and
 * never a name the bucket already lists. Every upload gets its own
 * name, so no upload ever replaces a file an earlier run refers to,
 * even when the local index was lost. The name says nothing about the
 * file.
 */
export function newMirrorObjectName(inBucket: { get(name: string): number | undefined }): string {
  for (;;) {
    const name = `${randomBytes(32).toString('hex')}${OFFSITE_LAYOUT.sealed}`;
    if (inBucket.get(name) === undefined) return name;
  }
}

/** Folder name of a mirror run: the archive's time stamp and run id. */
export function mirrorRunId(filename: string | null, runId: string, startedAt: Date): string {
  const m = filename ? /^backup-(.+)-[0-9a-f]{8}\.tar\.gz$/.exec(filename) : null;
  const stamp = m ? m[1]! : startedAt.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `${stamp}-${runId.slice(0, 8)}`;
}

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  local: () => { s3: S3Like; bucket: string };
}

async function* lines(text: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest = '';
  for await (const c of text) {
    rest += c.toString('utf8');
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line) yield line;
    }
  }
  if (rest) yield rest;
}

async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  yield buf;
}

/** A file's bytes, opened only when first read. */
async function* readFileLazily(file: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(file)) yield chunk as Buffer;
}

const BATCH = 500;

/**
 * Retention reads at most this many done markers with a bad signature
 * per pass; older complete runs are then left for a later pass.
 */
export const MAX_SET_ASIDE_CHECKED = 100;

/** A file the local index does not know must be at least this old to be removed. */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many such files are removed per pass. */
export const MAX_ORPHANS_PER_PASS = 1000;

export type MirrorRun = OffsiteArtifact & { keys: string[]; sealedBytes: number };

/** Mirror runs as one retention pass sees them (see classifyRuns). */
export interface ClassifiedRuns {
  runs: MirrorRun[];
  /** The first run whose done marker could not be read or parsed. */
  unreadable: string | null;
  /** Complete runs not checked this pass. */
  unchecked: number;
}

/** The largest file index a mirror run writes: about 13 million files. */
export const MAX_INDEX_BYTES = 2 * 1024 ** 3;

const OBJECT_NAME_RE = /^[0-9a-f]{64}\.enc$/;
const RECORD = 40;

/**
 * The bucket's mirrored files by name and stored size, packed: 32
 * bytes of name and 8 of size per file (about 40 MB per million
 * files), searched by halving. Names that are not mirror file names
 * are ignored.
 */
export class PackedListing {
  private buf = Buffer.alloc(RECORD * 1024);
  private count = 0;
  private sorted = true;
  private last: Buffer | null = null;

  get size(): number {
    return this.count;
  }

  add(name: string, size: number): void {
    if (!OBJECT_NAME_RE.test(name)) return;
    if ((this.count + 1) * RECORD > this.buf.length) {
      const next = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(next, 0, 0, this.count * RECORD);
      this.buf = next;
    }
    const at = this.count * RECORD;
    this.buf.write(name.slice(0, 64), at, 32, 'hex');
    this.buf.writeDoubleBE(size, at + 32);
    const rec = this.buf.subarray(at, at + 32);
    if (this.last && Buffer.compare(this.last, rec) > 0) this.sorted = false;
    this.last = rec;
    this.count += 1;
  }

  /** Call once after the last add. Providers list in name order; sort if one did not. */
  finish(): void {
    if (this.sorted) return;
    const order = Array.from({ length: this.count }, (_, i) => i);
    order.sort((a, b) =>
      Buffer.compare(
        this.buf.subarray(a * RECORD, a * RECORD + 32),
        this.buf.subarray(b * RECORD, b * RECORD + 32),
      ),
    );
    const next = Buffer.alloc(Math.max(this.count, 1) * RECORD);
    order.forEach((from, to) =>
      this.buf.copy(next, to * RECORD, from * RECORD, from * RECORD + RECORD),
    );
    this.buf = next;
    this.sorted = true;
  }

  /** The stored size of a mirror file, or undefined when it is not listed. */
  get(name: string): number | undefined {
    if (!OBJECT_NAME_RE.test(name)) return undefined;
    const want = Buffer.from(name.slice(0, 64), 'hex');
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = Buffer.compare(this.buf.subarray(mid * RECORD, mid * RECORD + 32), want);
      if (c === 0) return this.buf.readDoubleBE(mid * RECORD + 32);
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }
}

/**
 * The run's file index, written line by line to a file next to the
 * local archive instead of being held in memory, then uploaded from
 * there. Removed afterwards, whatever happens.
 */
class IndexFile {
  private out: ReturnType<typeof createWriteStream> | null = null;
  bytes = 0;
  lines = 0;
  constructor(
    readonly dir: string,
    readonly file: string,
    readonly limit: number,
  ) {}

  static async open(nextTo: string, limit: number): Promise<IndexFile> {
    const dir = await fs.mkdtemp(path.join(path.dirname(nextTo), '.offsite-index-'));
    const f = new IndexFile(dir, path.join(dir, 'objects.jsonl'), limit);
    f.out = createWriteStream(f.file, { flags: 'wx', mode: 0o600 });
    return f;
  }

  async write(line: string): Promise<void> {
    const b = Buffer.from(`${line}\n`, 'utf8');
    if (this.bytes + b.length > this.limit) {
      throw new Error(
        `The file index of this mirror run would be larger than ${Math.max(1, Math.round(this.limit / 1024 ** 3))} GB.`,
      );
    }
    this.bytes += b.length;
    this.lines += 1;
    if (!this.out!.write(b)) {
      await new Promise<void>((resolve, reject) => {
        const out = this.out!;
        const done = (e?: Error) => {
          out.off('drain', done);
          out.off('error', done);
          if (e) reject(e);
          else resolve();
        };
        out.once('drain', done);
        out.once('error', done);
      });
    }
  }

  async close(): Promise<void> {
    const out = this.out;
    this.out = null;
    if (!out) return;
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  }

  async remove(): Promise<void> {
    if (this.out) this.out.destroy();
    this.out = null;
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

/** How old a left-over index folder must be before startup removes it. */
export const INDEX_LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove `.offsite-index-*` folders a crashed process left in the
 * archive directory, once neither the folder nor its file has changed
 * for a day. Returns how many were removed; never throws.
 */
export async function sweepIndexLeftovers(dir: string, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('.offsite-index-')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory()) continue;
      let changed = st.mtimeMs;
      try {
        changed = Math.max(changed, (await fs.lstat(path.join(full, 'objects.jsonl'))).mtimeMs);
      } catch {
        // No index file inside: the folder's own time decides.
      }
      if (now - changed < INDEX_LEFTOVER_AGE_MS) continue;
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return removed;
}

/**
 * Incremental mirror for large object stores.
 *
 * Instead of the whole archive, a run uploads the database dump (read
 * straight out of the local archive), the archive's manifest, an index
 * of every stored file, and only the files that are new or changed
 * since they were last uploaded. Each file is encrypted on its own.
 *
 * Whether a file is already in the bucket comes from the server's
 * local index and the bucket's listing, never from reading the bucket
 * back. Files deleted on the portal stay in the bucket until no
 * retained run can refer to them.
 */
export class OffsiteMirror {
  /** Largest file index a run may write. Lowered in tests. */
  maxIndexBytes = MAX_INDEX_BYTES;
  /** Unknown files removed per retention pass at most. Lowered in tests. */
  maxOrphansPerPass = MAX_ORPHANS_PER_PASS;

  constructor(
    private readonly log: Logger | null,
    private readonly backup: Pick<BackupService, 'sourceStore'> | null,
  ) {}

  private runsPrefix(s: OffsiteSettings) {
    return `${s.prefix}${OFFSITE_LAYOUT.mirrorRuns}`;
  }
  private objectsPrefix(s: OffsiteSettings) {
    return `${s.prefix}${OFFSITE_LAYOUT.mirrorObjects}`;
  }

  /**
   * Mirror runs in the bucket, newest first, with their keys and
   * stored size. Only folders named as the portal names runs count.
   */
  async listRuns(s3: S3Like, s: OffsiteSettings, signal?: AbortSignal): Promise<MirrorRun[]> {
    const prefix = this.runsPrefix(s);
    const byId = new Map<string, MirrorRun>();
    for await (const o of listObjects(s3, s.bucket!, prefix, signal)) {
      const rest = o.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const id = rest.slice(0, slash);
      if (!MIRROR_RUN_RE.test(id)) continue;
      const cur = byId.get(id) ?? {
        id,
        createdAt: stampFromName(id) ?? o.lastModified ?? new Date(0),
        complete: false,
        keys: [],
        lastModified: null,
        sealedBytes: 0,
      };
      cur.keys.push(o.key);
      cur.sealedBytes += o.size;
      if (o.lastModified && (!cur.lastModified || o.lastModified < cur.lastModified)) {
        cur.lastModified = o.lastModified;
      }
      if (rest.slice(slash + 1) === OFFSITE_LAYOUT.doneMarker) cur.complete = true;
      byId.set(id, cur);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Read a run's done marker and check its signature against `trusted`
   * (and, when given, the install ids expected for this folder).
   * `trust` is how the server's retention counts it. `readError` is set
   * when the marker could not be read or is not a JSON object; such a
   * run is never counted as unsigned.
   */
  async checkRun(
    s3: S3Like,
    s: OffsiteSettings,
    runId: string,
    trusted: readonly OffsiteVerifyKey[],
    installIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    check: CopyCheck;
    trust: ArtifactTrust;
    done: Record<string, unknown> | null;
    readError: boolean;
  }> {
    let done: Record<string, unknown> | null = null;
    try {
      const raw: unknown = JSON.parse(
        (
          await getSmall(
            s3,
            s.bucket!,
            `${this.runsPrefix(s)}${runId}/${OFFSITE_LAYOUT.doneMarker}`,
            signal,
          )
        ).toString('utf8'),
      );
      done =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
    } catch (e) {
      if (signal?.aborted) throw e;
      done = null;
    }
    if (!done) {
      return {
        check: {
          trust: 'bad',
          manifest: null,
          signer: null,
          reason: 'The done marker could not be read.',
        },
        trust: 'bad',
        done: null,
        readError: true,
      };
    }
    const check = checkSignature(done, trusted, {
      kind: 'mirror',
      prefix: s.prefix,
      name: runId,
      installIds,
    });
    return { check, trust: artifactTrust(check, done, s.installId), done, readError: false };
  }

  async upload(a: {
    s3: S3Like;
    s: OffsiteSettings;
    publicKey: OffsitePublicKey;
    signingKey: OffsiteSigningKey;
    nameKey: Buffer;
    index: MirrorIndexStore;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    signal: AbortSignal;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    if (!this.backup) throw new Error('Mirror upload needs the backup service.');
    const { s3, s } = a;
    const runId = mirrorRunId(a.run.filename, a.run.id, a.run.startedAt);
    const runAt = stampFromName(runId) ?? a.run.startedAt;
    const folder = `${this.runsPrefix(s)}${runId}/`;
    const target = mirrorTarget(s);

    // What the bucket holds now, by name and size, packed (see
    // PackedListing). A file the local index lists but the bucket lost
    // (a lifecycle rule, a hand delete) is uploaded again.
    const inBucket = new PackedListing();
    const objectsPrefix = this.objectsPrefix(s);
    for await (const o of listObjects(s3, s.bucket!, objectsPrefix, a.signal)) {
      inBucket.add(o.key.slice(objectsPrefix.length), o.size);
      if (a.signal.aborted) throw new Error('Stopped.');
    }
    inBucket.finish();

    const src = this.backup.sourceStore();
    const index = await IndexFile.open(a.archivePath, this.maxIndexBytes);
    try {
      return await this.uploadRun(a, { runId, runAt, folder, target, inBucket, src, index });
    } finally {
      await index.remove();
    }
  }

  private async uploadRun(
    a: Parameters<OffsiteMirror['upload']>[0],
    r: {
      runId: string;
      runAt: Date;
      folder: string;
      target: string;
      inBucket: PackedListing;
      src: ReturnType<BackupService['sourceStore']>;
      index: IndexFile;
    },
  ): Promise<{ key: string; bytes: number; sha256: string }> {
    const { s3, s, publicKey: pub } = a;
    const { runId, runAt, folder, target, inBucket, src, index } = r;
    const fp = pub.fingerprintText;
    const objectsPrefix = this.objectsPrefix(s);
    let sent = 0;
    let uploaded = 0;
    let reused = 0;

    // Noted before anything is uploaded, so clean-up knows this run
    // folder is this server's even if the run stops half way.
    await a.index.recordRun(target, runId);

    const handle = async (batch: Array<{ key: string; size: number; etag: string | null }>) => {
      const named = batch.map((o) => ({
        o,
        source: mirrorSourceId(a.nameKey, pub.fingerprint, o.key, o.size, o.etag),
      }));
      const known = await a.index.find(
        target,
        named.map((n) => n.source),
      );
      const touched: string[] = [];
      for (const { o, source } of named) {
        if (a.signal.aborted) throw new Error('Stopped.');
        const row = known.get(source);
        // Reused only with a recorded checksum: the signed index names
        // the checksum of every file it refers to.
        if (
          row &&
          row.keyFingerprint === fp &&
          row.plainBytes === o.size &&
          row.sealedSha256 !== null &&
          inBucket.get(row.name) === row.sealedBytes
        ) {
          await index.write(
            JSON.stringify({
              k: o.key,
              o: row.name,
              s: o.size,
              ...(row.contentType ? { t: row.contentType } : {}),
              z: row.sealedBytes,
              h: row.sealedSha256,
            }),
          );
          touched.push(row.name);
          reused += 1;
          continue;
        }
        // Not known, or no longer in the bucket as recorded: upload it
        // under a new name. Whatever an earlier run left under another
        // name stays as it is.
        const name = newMirrorObjectName(inBucket);
        let got: { Body?: unknown; ContentLength?: number; ContentType?: string };
        try {
          got = (await src.s3.send(new GetObjectCommand({ Bucket: src.bucket, Key: o.key }), {
            abortSignal: a.signal,
          })) as typeof got;
        } catch (e) {
          // Deleted after the listing: leave it out, as the archive does.
          const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
          if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) continue;
          throw e;
        }
        if (!got.Body) throw new Error(`Object "${o.key}" returned no body.`);
        const size = Number(got.ContentLength ?? o.size);
        const up = await uploadStream(s3, {
          bucket: s.bucket!,
          key: `${objectsPrefix}${name}`,
          body: sealStream(got.Body as AsyncIterable<Buffer>, pub),
          expectedBytes: sealedSize(size),
          signal: a.signal,
        });
        await a.index.record(target, {
          name,
          source,
          keyFingerprint: fp,
          plainBytes: size,
          sealedBytes: up.bytes,
          sealedSha256: up.sha256,
          contentType: got.ContentType ?? null,
          lastRunAt: runAt,
        });
        sent += up.bytes;
        uploaded += 1;
        await index.write(
          JSON.stringify({
            k: o.key,
            o: name,
            s: size,
            ...(got.ContentType ? { t: got.ContentType } : {}),
            z: up.bytes,
            h: up.sha256,
          }),
        );
      }
      await a.index.touch(target, touched, runAt);
    };

    let batch: Array<{ key: string; size: number; etag: string | null }> = [];
    for await (const o of listObjects(src.s3, src.bucket, '')) {
      batch.push(o);
      if (batch.length >= BATCH) {
        await handle(batch);
        batch = [];
      }
    }
    await handle(batch);

    // The database dump, straight from the local archive.
    const manifestBuf = await readTarEntry(a.archivePath, 'manifest.json');
    if (!manifestBuf) throw new Error('The archive has no manifest.json.');
    const manifest = JSON.parse(manifestBuf.toString('utf8')) as { databases?: unknown };
    const db =
      Array.isArray(manifest.databases) && typeof manifest.databases[0] === 'string'
        ? manifest.databases[0]
        : 'gratisgis';
    const tar = streamTarEntry(a.archivePath, `postgres/${db}.dump`);
    let dump;
    try {
      dump = await uploadStream(s3, {
        bucket: s.bucket!,
        key: `${folder}database.dump${OFFSITE_LAYOUT.sealed}`,
        body: sealStream(tar.stream as AsyncIterable<Buffer>, pub),
        signal: a.signal,
      });
      await tar.done;
    } catch (e) {
      tar.kill();
      throw e;
    }
    sent += dump.bytes;

    const man = await uploadStream(s3, {
      bucket: s.bucket!,
      key: `${folder}manifest.json${OFFSITE_LAYOUT.sealed}`,
      body: sealStream(once(manifestBuf), pub),
      expectedBytes: sealedSize(manifestBuf.length),
      signal: a.signal,
    });
    sent += man.bytes;
    await index.close();
    const idx = await uploadStream(s3, {
      bucket: s.bucket!,
      key: `${folder}objects.jsonl${OFFSITE_LAYOUT.sealed}`,
      body: sealStream(readFileLazily(index.file), pub),
      expectedBytes: sealedSize(index.bytes),
      signal: a.signal,
    });
    sent += idx.bytes;

    // Written last: its presence marks the run complete. The signature
    // binds the run, its time, the portal, the folder and the name, size
    // and checksum of the dump, the manifest and the file index; the
    // index holds the checksum of every mirrored file.
    if (!s.installId) throw new Error('This portal has no install id yet.');
    const rel = (k: string) => k.slice(s.prefix.length);
    const done = {
      format: OFFSITE_FORMAT,
      kind: 'mirror',
      runId: a.run.id,
      installId: s.installId,
      keyFingerprint: fp,
      createdAt: a.run.startedAt.toISOString(),
      database: { name: db, sealedBytes: dump.bytes, sealedSha256: dump.sha256 },
      index: { files: index.lines, sealedSha256: idx.sha256 },
      uploaded,
      reused,
      signature: signManifest(
        {
          kind: 'mirror',
          format: OFFSITE_FORMAT,
          install: s.installId,
          prefix: s.prefix,
          run: runId,
          created: a.run.startedAt.toISOString(),
          key: fp,
          'dump.name': rel(`${folder}database.dump${OFFSITE_LAYOUT.sealed}`),
          'dump.bytes': String(dump.bytes),
          'dump.sha256': dump.sha256,
          'manifest.name': rel(`${folder}manifest.json${OFFSITE_LAYOUT.sealed}`),
          'manifest.bytes': String(man.bytes),
          'manifest.sha256': man.sha256,
          'index.name': rel(`${folder}objects.jsonl${OFFSITE_LAYOUT.sealed}`),
          'index.bytes': String(idx.bytes),
          'index.sha256': idx.sha256,
          'index.files': String(index.lines),
        },
        a.signingKey,
      ),
    };
    await putSmall(
      s3,
      s.bucket!,
      `${folder}${OFFSITE_LAYOUT.doneMarker}`,
      Buffer.from(JSON.stringify(done, null, 2)),
    );
    this.log?.log(`Mirror run ${runId}: ${uploaded} file(s) uploaded, ${reused} already there.`);
    return { key: folder, bytes: sent, sha256: dump.sha256 };
  }

  /**
   * List the mirror runs and check the done marker of each complete
   * one with a usable date, newest first, for retention. Stops at the
   * first marker that cannot be read or parsed (`unreadable`): the
   * caller then deletes nothing. After MAX_SET_ASIDE_CHECKED runs with a
   * bad signature, older complete runs are not checked this pass
   * (`unchecked`) and are left out of `runs`: never deleted, and no
   * file is collected while any is left out.
   */
  async classifyRuns(
    s3: S3Like,
    s: OffsiteSettings,
    now: Date,
    trusted: readonly OffsiteVerifyKey[],
    signal?: AbortSignal,
  ): Promise<ClassifiedRuns> {
    const all = await this.listRuns(s3, s, signal);
    const runs: MirrorRun[] = [];
    let bad = 0;
    let unchecked = 0;
    for (const r of all) {
      if (!r.complete || suspectDate(r, now)) {
        runs.push(r);
        continue;
      }
      if (bad >= MAX_SET_ASIDE_CHECKED) {
        unchecked += 1;
        continue;
      }
      if (signal?.aborted) throw signal.reason as Error;
      const c = await this.checkRun(s3, s, r.id, trusted, [], signal);
      if (c.readError) return { runs: [], unreadable: `mirror:${r.id}`, unchecked: 0 };
      r.trust = c.trust;
      if (c.trust === 'bad') bad += 1;
      runs.push(r);
    }
    return { runs, unreadable: null, unchecked };
  }

  /**
   * Delete mirror runs older than the window (never the newest
   * complete one), then files no remaining run can refer to. `classified`
   * comes from classifyRuns; with an unreadable marker nothing is done.
   *
   * Works from the bucket listing and the local index only. A file's
   * row says the newest run that referred to it; every retained
   * complete run is at least as new as the oldest one, so a file whose
   * newest run is older than that is referred to by none. The row goes
   * first, so a stop half way leaves a file the index does not know
   * rather than a row for a file that is gone.
   *
   * A file the local index does not know (left by a lost or emptied
   * index, a restore, or a run stopped half way) may still be named by
   * a run made before the index was lost. It is removed only when every
   * run folder in the bucket is one this server started with its
   * current index (see MirrorIndexStore.recordRun), so no run can name
   * it; and only when the bucket says it is older than
   * ORPHAN_GRACE_MS, at most MAX_ORPHANS_PER_PASS per pass. Until the
   * older runs age out, such files are kept and counted.
   *
   * `collectFiles` is false while another upload may be running; then
   * only runs are removed.
   */
  async enforceRetention(
    s: OffsiteSettings,
    s3: S3Like,
    now: Date,
    index: MirrorIndexStore | null,
    collectFiles: boolean,
    classified: ClassifiedRuns,
    signal?: AbortSignal,
  ): Promise<{
    removed: number;
    unknownKept: number;
    orphansRemoved: number;
    suspect: Array<{ id: string; why: 'future' | 'after-upload' | 'bad-signature' | null }>;
  }> {
    // A stopped upload's clean-up stops too: its claim is already gone.
    const stop = () => {
      if (signal?.aborted) throw signal.reason as Error;
    };
    const none = { removed: 0, unknownKept: 0, orphansRemoved: 0, suspect: [] };
    if (classified.unreadable !== null) return none;
    const runs = classified.runs;
    if (runs.length === 0) return none;
    const { usable, suspect } = partitionByDate(runs, now);
    const suspectIds = suspect.map((r) => ({ id: r.id, why: setAsideReason(r, now) }));
    const target = mirrorTarget(s);
    let removed = 0;
    const expired = new Set(selectExpired(runs, now, s.retentionDays));
    for (const r of runs.filter((x) => expired.has(x.id))) {
      const ordered = [...r.keys].sort(
        (x, y) =>
          Number(y.endsWith(OFFSITE_LAYOUT.doneMarker)) -
          Number(x.endsWith(OFFSITE_LAYOUT.doneMarker)),
      );
      for (const k of ordered) {
        stop();
        await deleteObject(s3, s.bucket!, k, signal);
        removed += 1;
      }
      if (index) await index.forgetRuns(target, [r.id]);
    }
    // Runs with a suspect date never decide which files are old.
    const kept = usable.filter((r) => !expired.has(r.id) && r.complete);
    if (kept.length === 0 || !index || !collectFiles || classified.unchecked > 0) {
      return { removed, unknownKept: 0, orphansRemoved: 0, suspect: suspectIds };
    }
    const oldest = new Date(Math.min(...kept.map((r) => r.createdAt.getTime())));
    const objectsPrefix = this.objectsPrefix(s);
    for (;;) {
      stop();
      const names = await index.olderThan(target, oldest, BATCH);
      if (names.length === 0) break;
      await index.remove(target, names);
      for (const n of names) {
        await deleteObject(s3, s.bucket!, `${objectsPrefix}${n}`, signal);
        removed += 1;
      }
      if (names.length < BATCH) break;
    }

    // Files the local index does not know. Every run folder now in the
    // bucket must be one this server started; run ids it noted whose
    // folder is gone are forgotten.
    stop();
    const folders = (await this.listRuns(s3, s, signal)).map((r) => r.id);
    const ours = await index.runIds(target);
    const allOurs = folders.every((id) => ours.has(id));
    const inBucket = new Set(folders);
    await index.forgetRuns(
      target,
      [...ours].filter((id) => !inBucket.has(id)),
    );
    const graceEnd = now.getTime() - ORPHAN_GRACE_MS;
    let unknownKept = 0;
    let orphansRemoved = 0;
    let batch: Array<{ name: string; lastModified: Date | null }> = [];
    const sweep = async () => {
      const known = await index.known(
        target,
        batch.map((b) => b.name),
      );
      for (const b of batch) {
        if (known.has(b.name)) continue;
        const old = b.lastModified !== null && b.lastModified.getTime() < graceEnd;
        if (allOurs && old && orphansRemoved < this.maxOrphansPerPass) {
          stop();
          await deleteObject(s3, s.bucket!, `${objectsPrefix}${b.name}`, signal);
          orphansRemoved += 1;
          removed += 1;
        } else {
          unknownKept += 1;
        }
      }
      batch = [];
    };
    for await (const o of listObjects(s3, s.bucket!, objectsPrefix, signal)) {
      const name = o.key.slice(objectsPrefix.length);
      // Only names mirror mode writes.
      if (!OBJECT_NAME_RE.test(name)) continue;
      batch.push({ name, lastModified: o.lastModified });
      if (batch.length >= BATCH) await sweep();
    }
    if (batch.length) await sweep();
    return { removed, unknownKept, orphansRemoved, suspect: suspectIds };
  }

  // ---------------------------------------------------------------
  // Restore helpers for offsite-cli (they hold the private key)
  // ---------------------------------------------------------------

  /**
   * Download and decrypt a chosen mirror run's dump, manifest and file
   * index into --out, then check that every file the index lists is in
   * the bucket with its recorded size. Nothing is changed anywhere
   * else, so the restore script can stop before it touches the
   * database. With a signed manifest (`signed`: the signature verified)
   * each object is checked against it (size and SHA-256 of the
   * encrypted bytes) before it is decrypted, and `done` is not used.
   * Without one, the done marker's unsigned checksums are used where
   * there are any: they catch damage, not a deliberate change.
   */
  async cliFetch(
    io: CliIo & { offsite: (s: OffsiteSettings) => S3Like },
    args: string[],
    s: OffsiteSettings,
    key: OffsitePrivateKey,
    runId: string,
    signed: MirrorManifest | null,
    done: Record<string, unknown> | null,
  ) {
    const val = (n: string) => {
      const i = args.indexOf(n);
      return i >= 0 ? (args[i + 1] ?? null) : null;
    };
    const outDir = val('--out');
    if (!outDir) throw new Error('--out is required.');
    if (!MIRROR_RUN_RE.test(runId)) throw new Error('Unexpected mirror run name.');
    const s3 = io.offsite(s);
    const folder = `${this.runsPrefix(s)}${runId}/`;
    const d = (signed ? {} : (done ?? {})) as {
      database?: { sealedSha256?: unknown };
      index?: { files?: unknown; sealedSha256?: unknown };
    };
    const dir = path.join(outDir, runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const unchecked = (sha: unknown): ObjectCheck | null =>
      typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? { bytes: null, sha256: sha } : null;
    const part = (p: 'dump' | 'manifest' | 'index'): ObjectCheck | null =>
      signed ? { bytes: Number(signed[`${p}.bytes`]), sha256: signed[`${p}.sha256`] } : null;
    io.err(`Downloading, checking and decrypting mirror run ${runId}...`);
    await fetchChecked(
      s3,
      s.bucket!,
      `${folder}database.dump${OFFSITE_LAYOUT.sealed}`,
      path.join(dir, 'database.dump'),
      part('dump') ?? unchecked(d.database?.sealedSha256),
      key,
    );
    const manifestFile = path.join(dir, 'manifest.json');
    await fetchChecked(
      s3,
      s.bucket!,
      `${folder}manifest.json${OFFSITE_LAYOUT.sealed}`,
      manifestFile,
      part('manifest'),
      key,
    );
    // The database name from the decrypted manifest, which the signed
    // record covers; never from the plain done marker.
    let db = 'gratisgis';
    try {
      const man = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { databases?: unknown };
      if (Array.isArray(man.databases) && typeof man.databases[0] === 'string') {
        db = man.databases[0];
      }
    } catch {
      throw new Error("The run's manifest is damaged.");
    }
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(db))
      throw new Error('The run names an unexpected database.');

    // Every file the index lists must be in the bucket, with the size
    // the index records, before the restore changes anything.
    const indexFile = path.join(dir, 'objects.jsonl');
    await fetchChecked(
      s3,
      s.bucket!,
      `${folder}objects.jsonl${OFFSITE_LAYOUT.sealed}`,
      indexFile,
      part('index') ?? unchecked(d.index?.sealedSha256),
      key,
    );
    io.err('Checking that every file of the run is in the bucket...');
    const listed = new PackedListing();
    const objectsPrefix = this.objectsPrefix(s);
    for await (const o of listObjects(s3, s.bucket!, objectsPrefix)) {
      listed.add(o.key.slice(objectsPrefix.length), o.size);
    }
    listed.finish();
    let count = 0;
    for await (const text of lines(readFileLazily(indexFile))) {
      const l = parseIndexLine(text, signed !== null);
      const size = listed.get(l.o);
      if (size === undefined) {
        throw new Error(
          `The run's file ${l.o} is not in the bucket. Nothing was restored; choose another copy.`,
        );
      }
      if (l.z !== undefined && size !== l.z) {
        throw new Error(
          `The run's file ${l.o} has ${size} bytes in the bucket; the run's index says ${l.z}. Nothing was restored; choose another copy.`,
        );
      }
      count += 1;
    }
    if (signed && count !== Number(signed['index.files'])) {
      throw new Error(
        `The file index lists ${count} files; the signed run says ${signed['index.files']}.`,
      );
    }
    io.out(`run=${runId}`);
    io.out(`dump=${path.join(dir, 'database.dump')}`);
    io.out(`database=${db}`);
    io.out(`objects=${count}`);
  }

  /**
   * Put every file a chosen mirror run names back into the local store.
   * With a signed manifest (the signature verified) the file index is
   * checked against it, and each file against the index, before it is
   * decrypted.
   */
  async cliPutObjects(
    io: CliIo & { offsite: (s: OffsiteSettings) => S3Like },
    s: OffsiteSettings,
    key: OffsitePrivateKey,
    runId: string,
    verified: MirrorManifest | null,
    workDir: string,
  ) {
    if (!MIRROR_RUN_RE.test(runId)) throw new Error('Unexpected mirror run name.');
    const s3 = io.offsite(s);
    const local = io.local();
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    const work = await fs.mkdtemp(path.join(workDir, '.offsite-put-'));
    let count = 0;
    try {
      const indexFile = path.join(work, 'objects.jsonl');
      await fetchChecked(
        s3,
        s.bucket!,
        `${this.runsPrefix(s)}${runId}/objects.jsonl${OFFSITE_LAYOUT.sealed}`,
        indexFile,
        verified
          ? { bytes: Number(verified['index.bytes']), sha256: verified['index.sha256'] }
          : null,
        key,
      );
      for await (const text of lines(readFileLazily(indexFile))) {
        const l = parseIndexLine(text, verified !== null);
        await withCheckedDownload(
          s3,
          s.bucket!,
          `${this.objectsPrefix(s)}${l.o}`,
          path.join(work, 'object.enc'),
          l.h !== undefined ? { bytes: l.z ?? null, sha256: l.h } : null,
          (sealed) =>
            local.s3.send(
              new PutObjectCommand({
                Bucket: local.bucket,
                Key: l.k,
                Body: Readable.from(unsealStream(sealed, key)),
                ContentLength: l.s,
                ContentType: l.t ?? 'application/octet-stream',
              }),
            ),
        );
        count += 1;
        if (count % 500 === 0) io.err(`  ${count} files put back...`);
      }
      if (verified && count !== Number(verified['index.files'])) {
        throw new Error(
          `The file index lists ${count} files; the signed run says ${verified['index.files']}.`,
        );
      }
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
    io.out(`objects=${count}`);
  }
}

/** Expected size and SHA-256 of an encrypted object. */
export interface ObjectCheck {
  bytes: number | null;
  sha256: string;
}

const MAX_INDEX_LINE = 64 * 1024;

/**
 * One line of a downloaded file index. In a verified run every line
 * must carry the checksum of its file.
 */
export function parseIndexLine(
  text: string,
  needChecksum: boolean,
): Partial<MirrorIndexLine> & Pick<MirrorIndexLine, 'k' | 'o' | 's'> {
  if (text.length > MAX_INDEX_LINE) throw new Error('A line of the file index is too long.');
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('The file index is damaged.');
  }
  const ok =
    typeof j.k === 'string' &&
    j.k.length > 0 &&
    j.k.length <= 1024 &&
    typeof j.o === 'string' &&
    OBJECT_NAME_RE.test(j.o) &&
    typeof j.s === 'number' &&
    Number.isSafeInteger(j.s) &&
    j.s >= 0 &&
    (j.t === undefined || typeof j.t === 'string') &&
    (j.z === undefined || (typeof j.z === 'number' && Number.isSafeInteger(j.z) && j.z >= 0)) &&
    (j.h === undefined || (typeof j.h === 'string' && /^[0-9a-f]{64}$/.test(j.h)));
  if (!ok) throw new Error('The file index is damaged.');
  if (needChecksum && (j.h === undefined || j.z === undefined)) {
    throw new Error('The signed file index lists a file without its checksum.');
  }
  return j as unknown as Partial<MirrorIndexLine> & Pick<MirrorIndexLine, 'k' | 'o' | 's'>;
}

/**
 * Download an object into an open, new file, counting and hashing its
 * bytes, and fail when it does not match `expect`. Nothing is
 * decrypted here. The caller reads the checked bytes back through the
 * same handle, so what was checked is what gets decrypted.
 */
export async function downloadChecked(
  s3: S3Like,
  bucket: string,
  objectKey: string,
  fh: fs.FileHandle,
  expect: ObjectCheck | null,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const body = await getObjectStream(s3, bucket, objectKey);
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    // Stop as soon as it is larger than the record says.
    if (expect && expect.bytes !== null && bytes + b.length > expect.bytes) {
      throw new Error(
        `The downloaded object is larger than the ${expect.bytes} bytes its record says. Nothing was decrypted.`,
      );
    }
    hash.update(b);
    let off = 0;
    while (off < b.length) {
      const { bytesWritten } = await fh.write(b, off, b.length - off, bytes + off);
      off += bytesWritten;
    }
    bytes += b.length;
  }
  const sha256 = hash.digest('hex');
  if (expect && expect.bytes !== null && expect.bytes !== bytes) {
    throw new Error(
      `The downloaded object has ${bytes} bytes; the signed record says ${expect.bytes}. Nothing was decrypted.`,
    );
  }
  if (expect && expect.sha256 !== sha256) {
    throw new Error(
      'The downloaded object does not match the checksum in its signed record. Nothing was decrypted.',
    );
  }
  return { bytes, sha256 };
}

/** The bytes of an open file from the start, through its handle. */
export async function* readHandle(fh: fs.FileHandle): AsyncGenerator<Buffer> {
  for await (const c of fh.createReadStream({ start: 0, autoClose: false })) yield c as Buffer;
}

/**
 * Download into a new scratch file, check, and only then hand the
 * checked bytes to `use`. The scratch file is removed afterwards.
 */
export async function withCheckedDownload<T>(
  s3: S3Like,
  bucket: string,
  objectKey: string,
  scratch: string,
  expect: ObjectCheck | null,
  use: (sealed: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  // A run stopped half way leaves this behind.
  await fs.rm(scratch, { force: true });
  const fh = await fs.open(scratch, 'wx+', 0o600);
  try {
    await downloadChecked(s3, bucket, objectKey, fh, expect);
    return await use(readHandle(fh));
  } finally {
    await fh.close();
    await fs.rm(scratch, { force: true });
  }
}

/**
 * Download, check, then decrypt one object to `file`. The decrypted
 * file appears only when the check passed and every record verified.
 */
export async function fetchChecked(
  s3: S3Like,
  bucket: string,
  objectKey: string,
  file: string,
  expect: ObjectCheck | null,
  key: OffsitePrivateKey,
): Promise<void> {
  const partial = `${file}.partial`;
  await fs.rm(partial, { force: true });
  try {
    await withCheckedDownload(
      s3,
      bucket,
      objectKey,
      `${file}.enc.partial`,
      expect,
      async (sealed) => {
        await pipeline(
          Readable.from(unsealStream(sealed, key)),
          createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        );
      },
    );
    await fs.rename(partial, file);
  } finally {
    await fs.rm(partial, { force: true });
  }
}
