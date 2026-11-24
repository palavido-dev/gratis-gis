// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
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
import { OFFSITE_LAYOUT, selectExpired, stampFromName, type OffsiteArtifact } from './offsite-rules.js';
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
}

/** A row of the server's own record of mirrored files. */
export interface MirrorIndexRow {
  name: string;
  keyFingerprint: string;
  plainBytes: number;
  sealedBytes: number;
  contentType: string | null;
  lastRunAt: Date;
}

/**
 * The server's own record of what mirror mode uploaded. The bucket is
 * encrypted to a key this server does not hold, so it can never read
 * a run's file list back; this record is how it knows which files are
 * already there. Losing it is harmless: every file is uploaded again.
 */
export interface MirrorIndexStore {
  find(target: string, names: string[]): Promise<Map<string, MirrorIndexRow>>;
  record(target: string, row: MirrorIndexRow): Promise<void>;
  /** Move lastRunAt forward to `runAt` for these names. */
  touch(target: string, names: string[], runAt: Date): Promise<void>;
  /** Names whose newest run is older than `before`, oldest first. */
  olderThan(target: string, before: Date, limit: number): Promise<string[]>;
  remove(target: string, names: string[]): Promise<void>;
}

/** Prisma calls MirrorIndexStore needs; the real client and test fakes both fit. */
export interface MirrorIndexPrisma {
  backupOffsiteObject: {
    findMany(args: unknown): Promise<
      Array<{
        name: string;
        keyFingerprint: string;
        plainBytes: bigint;
        sealedBytes: bigint;
        contentType: string | null;
        lastRunAt: Date;
      }>
    >;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

export class PrismaMirrorIndex implements MirrorIndexStore {
  constructor(private readonly prisma: MirrorIndexPrisma) {}

  async find(target: string, names: string[]) {
    const out = new Map<string, MirrorIndexRow>();
    if (names.length === 0) return out;
    const rows = await this.prisma.backupOffsiteObject.findMany({
      where: { target, name: { in: names } },
    });
    for (const r of rows) {
      out.set(r.name, {
        name: r.name,
        keyFingerprint: r.keyFingerprint,
        plainBytes: Number(r.plainBytes),
        sealedBytes: Number(r.sealedBytes),
        contentType: r.contentType,
        lastRunAt: r.lastRunAt,
      });
    }
    return out;
  }

  async record(target: string, row: MirrorIndexRow) {
    const data = {
      keyFingerprint: row.keyFingerprint,
      plainBytes: BigInt(row.plainBytes),
      sealedBytes: BigInt(row.sealedBytes),
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
 * The name a stored file gets in the bucket: an HMAC, under a key only
 * this server has, of the public key's fingerprint and the file's key,
 * size and ETag. A changed file, or a new public key, gives a new
 * name, so older runs still find the version they recorded and no file
 * is ever overwritten with one encrypted to another key. Without the
 * server's key the name says nothing about the file.
 */
export function mirrorObjectName(
  nameKey: Buffer,
  fingerprint: Buffer,
  key: string,
  size: number,
  etag: string | null,
): string {
  return `${createHmac('sha256', nameKey)
    .update(`v1\0${fingerprint.toString('hex')}\0${key}\0${size}\0${etag ?? ''}`)
    .digest('hex')}${OFFSITE_LAYOUT.sealed}`;
}

const RUN_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+-[0-9a-f]{8}$/;

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

const BATCH = 500;

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

  /** Mirror runs in the bucket, newest first, with their keys. */
  async listRuns(
    s3: S3Like,
    s: OffsiteSettings,
  ): Promise<Array<OffsiteArtifact & { keys: string[] }>> {
    const prefix = this.runsPrefix(s);
    const byId = new Map<string, OffsiteArtifact & { keys: string[] }>();
    for await (const o of listObjects(s3, s.bucket!, prefix)) {
      const rest = o.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) continue;
      const id = rest.slice(0, slash);
      const cur = byId.get(id) ?? {
        id,
        createdAt: stampFromName(id) ?? o.lastModified ?? new Date(0),
        complete: false,
        keys: [],
      };
      cur.keys.push(o.key);
      if (rest.slice(slash + 1) === OFFSITE_LAYOUT.doneMarker) cur.complete = true;
      byId.set(id, cur);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Read one run's file list. Needs the private key: restore only. */
  private async *readIndex(
    s3: S3Like,
    s: OffsiteSettings,
    runId: string,
    key: OffsitePrivateKey,
  ): AsyncGenerator<MirrorIndexLine> {
    const body = await getObjectStream(
      s3,
      s.bucket!,
      `${this.runsPrefix(s)}${runId}/objects.jsonl${OFFSITE_LAYOUT.sealed}`,
    );
    for await (const line of lines(unsealStream(body, key))) {
      yield JSON.parse(line) as MirrorIndexLine;
    }
  }

  async upload(a: {
    s3: S3Like;
    s: OffsiteSettings;
    publicKey: OffsitePublicKey;
    nameKey: Buffer;
    index: MirrorIndexStore;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    signal: AbortSignal;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    if (!this.backup) throw new Error('Mirror upload needs the backup service.');
    const { s3, s, publicKey: pub } = a;
    const runId = mirrorRunId(a.run.filename, a.run.id, a.run.startedAt);
    const runAt = stampFromName(runId) ?? a.run.startedAt;
    const folder = `${this.runsPrefix(s)}${runId}/`;
    const target = mirrorTarget(s);
    const fp = pub.fingerprintText;

    // What the bucket holds now, by name and size. A file the local
    // index lists but the bucket lost (a lifecycle rule, a hand
    // delete) is uploaded again.
    const inBucket = new Map<string, number>();
    const objectsPrefix = this.objectsPrefix(s);
    for await (const o of listObjects(s3, s.bucket!, objectsPrefix)) {
      inBucket.set(o.key.slice(objectsPrefix.length), o.size);
      if (a.signal.aborted) throw new Error('Stopped.');
    }

    const src = this.backup.sourceStore();
    const index: string[] = [];
    let sent = 0;
    let uploaded = 0;
    let reused = 0;

    const handle = async (batch: Array<{ key: string; size: number; etag: string | null }>) => {
      const named = batch.map((o) => ({
        o,
        name: mirrorObjectName(a.nameKey, pub.fingerprint, o.key, o.size, o.etag),
      }));
      const known = await a.index.find(
        target,
        named.map((n) => n.name),
      );
      const touched: string[] = [];
      for (const { o, name } of named) {
        if (a.signal.aborted) throw new Error('Stopped.');
        const row = known.get(name);
        if (
          row &&
          row.keyFingerprint === fp &&
          row.plainBytes === o.size &&
          inBucket.get(name) === row.sealedBytes
        ) {
          index.push(
            JSON.stringify({
              k: o.key,
              o: name,
              s: o.size,
              ...(row.contentType ? { t: row.contentType } : {}),
            }),
          );
          touched.push(name);
          reused += 1;
          continue;
        }
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
          keyFingerprint: fp,
          plainBytes: size,
          sealedBytes: up.bytes,
          contentType: got.ContentType ?? null,
          lastRunAt: runAt,
        });
        inBucket.set(name, up.bytes);
        sent += up.bytes;
        uploaded += 1;
        index.push(
          JSON.stringify({
            k: o.key,
            o: name,
            s: size,
            ...(got.ContentType ? { t: got.ContentType } : {}),
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
    const indexBuf = Buffer.from(index.join('\n') + (index.length ? '\n' : ''), 'utf8');
    const idx = await uploadStream(s3, {
      bucket: s.bucket!,
      key: `${folder}objects.jsonl${OFFSITE_LAYOUT.sealed}`,
      body: sealStream(once(indexBuf), pub),
      expectedBytes: sealedSize(indexBuf.length),
      signal: a.signal,
    });
    sent += idx.bytes;

    // Written last: its presence marks the run complete.
    const done = {
      format: OFFSITE_FORMAT,
      kind: 'mirror',
      runId: a.run.id,
      installId: s.installId,
      keyFingerprint: fp,
      createdAt: a.run.startedAt.toISOString(),
      database: { name: db, sealedBytes: dump.bytes, sealedSha256: dump.sha256 },
      index: { files: index.length, sealedSha256: idx.sha256 },
      uploaded,
      reused,
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
   * Delete mirror runs older than the window (never the newest
   * complete one), then files no remaining run can refer to.
   *
   * Works from the bucket listing and the local index only. A file's
   * row says the newest run that referred to it; every retained
   * complete run is at least as new as the oldest one, so a file whose
   * newest run is older than that is referred to by none. Files the
   * local index does not know are never deleted. The row goes first,
   * so a stop half way leaves a file the next run uploads again rather
   * than a row for a file that is gone.
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
  ): Promise<{ removed: number; unknownKept: number }> {
    const runs = await this.listRuns(s3, s);
    if (runs.length === 0) return { removed: 0, unknownKept: 0 };
    let removed = 0;
    const expired = new Set(selectExpired(runs, now, s.retentionDays));
    for (const r of runs.filter((x) => expired.has(x.id))) {
      const ordered = [...r.keys].sort(
        (x, y) =>
          Number(y.endsWith(OFFSITE_LAYOUT.doneMarker)) -
          Number(x.endsWith(OFFSITE_LAYOUT.doneMarker)),
      );
      for (const k of ordered) {
        await deleteObject(s3, s.bucket!, k);
        removed += 1;
      }
    }
    const kept = runs.filter((r) => !expired.has(r.id) && r.complete);
    if (kept.length === 0 || !index || !collectFiles) return { removed, unknownKept: 0 };
    const oldest = new Date(Math.min(...kept.map((r) => r.createdAt.getTime())));
    const target = mirrorTarget(s);
    const objectsPrefix = this.objectsPrefix(s);
    for (;;) {
      const names = await index.olderThan(target, oldest, BATCH);
      if (names.length === 0) break;
      await index.remove(target, names);
      for (const n of names) {
        await deleteObject(s3, s.bucket!, `${objectsPrefix}${n}`);
        removed += 1;
      }
      if (names.length < BATCH) break;
    }
    // Report, never delete, files the local index does not know (left
    // by a restore or by an earlier index).
    let unknownKept = 0;
    let batch: string[] = [];
    const countUnknown = async () => {
      const known = await index.find(target, batch);
      unknownKept += batch.filter((n) => !known.has(n)).length;
      batch = [];
    };
    for await (const o of listObjects(s3, s.bucket!, objectsPrefix)) {
      batch.push(o.key.slice(objectsPrefix.length));
      if (batch.length >= BATCH) await countUnknown();
    }
    if (batch.length) await countUnknown();
    return { removed, unknownKept };
  }

  // ---------------------------------------------------------------
  // Restore helpers for offsite-cli (they hold the private key)
  // ---------------------------------------------------------------

  private async pickRun(s3: S3Like, s: OffsiteSettings, wanted: string | null) {
    if (wanted !== null && !RUN_ID.test(wanted))
      throw new Error('--run must be a mirror run name.');
    const runs = (await this.listRuns(s3, s)).filter((r) => r.complete && RUN_ID.test(r.id));
    const run = wanted ? runs.find((r) => r.id === wanted) : runs[0];
    if (!run)
      throw new Error(
        wanted ? `No complete mirror run named ${wanted}.` : 'No complete mirror run was found.',
      );
    return run;
  }

  /** Download and decrypt a mirror run's dump and manifest into --out. */
  async cliFetch(
    io: CliIo & { offsite: (s: OffsiteSettings) => S3Like },
    args: string[],
    s: OffsiteSettings,
    key: OffsitePrivateKey,
  ) {
    const val = (n: string) => {
      const i = args.indexOf(n);
      return i >= 0 ? (args[i + 1] ?? null) : null;
    };
    const outDir = val('--out');
    if (!outDir) throw new Error('--out is required.');
    const s3 = io.offsite(s);
    const run = await this.pickRun(s3, s, val('--run'));
    const folder = `${this.runsPrefix(s)}${run.id}/`;
    const done = JSON.parse(
      (await getSmall(s3, s.bucket!, `${folder}${OFFSITE_LAYOUT.doneMarker}`)).toString('utf8'),
    ) as {
      database?: { name?: string; sealedSha256?: string };
      index?: { files?: number };
    };
    const dir = path.join(outDir, run.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const fetchTo = async (objectKey: string, file: string, sha?: string) => {
      const hash = createHash('sha256');
      const body = await getObjectStream(s3, s.bucket!, objectKey);
      async function* tap(): AsyncGenerator<Buffer> {
        for await (const c of body) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
          hash.update(b);
          yield b;
        }
      }
      const partial = `${file}.partial`;
      // A run stopped half way leaves this behind.
      await fs.rm(partial, { force: true });
      try {
        await pipeline(
          Readable.from(unsealStream(tap(), key)),
          createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
        );
        if (sha && hash.digest('hex') !== sha) {
          throw new Error(
            'The downloaded dump does not match the checksum recorded when it was uploaded.',
          );
        }
        await fs.rename(partial, file);
      } catch (e) {
        await fs.rm(partial, { force: true });
        throw e;
      }
    };
    io.err(`Downloading and decrypting mirror run ${run.id}...`);
    await fetchTo(
      `${folder}database.dump${OFFSITE_LAYOUT.sealed}`,
      path.join(dir, 'database.dump'),
      done.database?.sealedSha256,
    );
    await fetchTo(
      `${folder}manifest.json${OFFSITE_LAYOUT.sealed}`,
      path.join(dir, 'manifest.json'),
    );
    const db = done.database?.name ?? 'gratisgis';
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(db))
      throw new Error('The run names an unexpected database.');
    io.out(`run=${run.id}`);
    io.out(`dump=${path.join(dir, 'database.dump')}`);
    io.out(`database=${db}`);
    io.out(`objects=${Number(done.index?.files ?? 0)}`);
  }

  /** Put every file a mirror run names back into the local store. */
  async cliPutObjects(
    io: CliIo & { offsite: (s: OffsiteSettings) => S3Like },
    args: string[],
    s: OffsiteSettings,
    key: OffsitePrivateKey,
  ) {
    const i = args.indexOf('--run');
    const s3 = io.offsite(s);
    const run = await this.pickRun(s3, s, i >= 0 ? (args[i + 1] ?? null) : null);
    const local = io.local();
    let count = 0;
    for await (const l of this.readIndex(s3, s, run.id, key)) {
      const body = await getObjectStream(s3, s.bucket!, `${this.objectsPrefix(s)}${l.o}`);
      await local.s3.send(
        new PutObjectCommand({
          Bucket: local.bucket,
          Key: l.k,
          Body: Readable.from(unsealStream(body, key)),
          ContentLength: l.s,
          ContentType: l.t ?? 'application/octet-stream',
        }),
      );
      count += 1;
      if (count % 500 === 0) io.err(`  ${count} files put back...`);
    }
    io.out(`objects=${count}`);
  }
}
