// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Logger } from '@nestjs/common';

import type { BackupService } from './backup.service.js';
import type { OffsiteSettings } from './offsite-config.js';
import { SealKeyCache, sealStream, unsealStream, type SealKey } from './offsite-crypto.js';
import {
  OFFSITE_LAYOUT,
  selectExpired,
  stampFromName,
  unreferencedObjects,
  type OffsiteArtifact,
} from './offsite-rules.js';
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

/** One line of a mirror run's file index. */
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

/**
 * The name a stored file gets in the bucket: a hash of its key, size
 * and ETag. A changed file gets a new name, so older runs still find
 * the version they recorded, and the bucket never shows the portal's
 * own file names.
 */
export function mirrorObjectName(key: string, size: number, etag: string | null): string {
  return `${createHash('sha256')
    .update(`${key}\0${size}\0${etag ?? ''}`)
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

/**
 * Incremental mirror for large object stores.
 *
 * Instead of the whole archive, a run uploads the database dump (read
 * straight out of the local archive), the archive's manifest, an index
 * of every stored file, and only the files that are new or changed
 * since the newest complete mirror run. Each file is encrypted on its
 * own. Files deleted on the portal stay in the bucket until no
 * retained run refers to them.
 */
export class OffsiteMirror {
  readonly available = true;

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

  /** Read one run's index. */
  private async *readIndex(
    s3: S3Like,
    s: OffsiteSettings,
    runId: string,
    cache: SealKeyCache,
  ): AsyncGenerator<MirrorIndexLine> {
    const body = await getObjectStream(
      s3,
      s.bucket!,
      `${this.runsPrefix(s)}${runId}/objects.jsonl${OFFSITE_LAYOUT.sealed}`,
    );
    for await (const line of lines(unsealStream(body, s.passphrase!, cache))) {
      yield JSON.parse(line) as MirrorIndexLine;
    }
  }

  async upload(a: {
    s3: S3Like;
    s: OffsiteSettings;
    key: SealKey;
    run: { id: string; filename: string | null; startedAt: Date };
    archivePath: string;
    signal: AbortSignal;
    beat: () => Promise<void>;
  }): Promise<{ key: string; bytes: number; sha256: string }> {
    if (!this.backup) throw new Error('Mirror upload needs the backup service.');
    const { s3, s } = a;
    const cache = new SealKeyCache(4);
    const runId = mirrorRunId(a.run.filename, a.run.id, a.run.startedAt);
    const folder = `${this.runsPrefix(s)}${runId}/`;

    // Files the newest complete run already holds, with their types.
    const known = new Map<string, string | undefined>();
    const previous = (await this.listRuns(s3, s)).find((r) => r.complete && r.id !== runId);
    if (previous) {
      for await (const l of this.readIndex(s3, s, previous.id, cache)) known.set(l.o, l.t);
    }

    const src = this.backup.sourceStore();
    const index: string[] = [];
    let sent = 0;
    let uploaded = 0;
    let reused = 0;
    for await (const o of listObjects(src.s3, src.bucket, '')) {
      if (a.signal.aborted) throw new Error('Stopped.');
      const name = mirrorObjectName(o.key, o.size, o.etag);
      if (known.has(name)) {
        const t = known.get(name);
        index.push(JSON.stringify({ k: o.key, o: name, s: o.size, ...(t ? { t } : {}) }));
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
        key: `${this.objectsPrefix(s)}${name}`,
        body: sealStream(got.Body as AsyncIterable<Buffer>, a.key),
        signal: a.signal,
      });
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
      await a.beat();
    }

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
        body: sealStream(tar.stream as AsyncIterable<Buffer>, a.key),
        signal: a.signal,
        onPart: a.beat,
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
      body: sealStream(once(manifestBuf), a.key),
      signal: a.signal,
    });
    sent += man.bytes;
    const idx = await uploadStream(s3, {
      bucket: s.bucket!,
      key: `${folder}objects.jsonl${OFFSITE_LAYOUT.sealed}`,
      body: sealStream(
        once(Buffer.from(index.join('\n') + (index.length ? '\n' : ''), 'utf8')),
        a.key,
      ),
      signal: a.signal,
    });
    sent += idx.bytes;

    // Written last: its presence marks the run complete.
    const done = {
      format: 'GRCV2',
      kind: 'mirror',
      runId: a.run.id,
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
   * complete one), then files no remaining run refers to. Files are
   * only collected while a complete run remains, and only once they
   * are past a grace period, since a run uploads its files before it
   * writes the index that names them.
   */
  async enforceRetention(s: OffsiteSettings, s3: S3Like, now: Date): Promise<number> {
    const runs = await this.listRuns(s3, s);
    if (runs.length === 0) return 0;
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
    if (kept.length === 0 || !s.passphrase) return removed;
    const referenced = new Set<string>();
    const cache = new SealKeyCache(4);
    for (const r of kept) {
      for await (const l of this.readIndex(s3, s, r.id, cache))
        referenced.add(`${this.objectsPrefix(s)}${l.o}`);
    }
    const all = [];
    for await (const o of listObjects(s3, s.bucket!, this.objectsPrefix(s))) all.push(o);
    for (const k of unreferencedObjects(all, referenced, now)) {
      await deleteObject(s3, s.bucket!, k);
      removed += 1;
    }
    return removed;
  }

  // ---------------------------------------------------------------
  // Restore helpers for offsite-cli
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
    const cache = new SealKeyCache(2);

    const fetchTo = async (key: string, file: string, sha?: string) => {
      const hash = createHash('sha256');
      const body = await getObjectStream(s3, s.bucket!, key);
      async function* tap(): AsyncGenerator<Buffer> {
        for await (const c of body) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
          hash.update(b);
          yield b;
        }
      }
      const partial = `${file}.partial`;
      try {
        await pipeline(
          Readable.from(unsealStream(tap(), s.passphrase!, cache)),
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
  ) {
    const i = args.indexOf('--run');
    const s3 = io.offsite(s);
    const run = await this.pickRun(s3, s, i >= 0 ? (args[i + 1] ?? null) : null);
    const local = io.local();
    const cache = new SealKeyCache(8);
    let count = 0;
    for await (const l of this.readIndex(s3, s, run.id, cache)) {
      const body = await getObjectStream(s3, s.bucket!, `${this.objectsPrefix(s)}${l.o}`);
      await local.s3.send(
        new PutObjectCommand({
          Bucket: local.bucket,
          Key: l.k,
          Body: Readable.from(unsealStream(body, s.passphrase!, cache)),
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
