// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

/**
 * Second tier of the tile cache: MVT buffers kept on disk so a restart
 * does not start every map cold. `TileCacheService` owns one of these
 * when `TILE_CACHE_DIR` is set and stays the only caller; it hands in
 * the full "material" a file is filed under (the memory key plus the
 * data versions of every scope the tile reads, see
 * `TileCacheService.diskMaterial`). This class knows nothing about
 * scopes or authorization. It stores bytes under a name and gives them
 * back only to a caller who presents the same name.
 *
 * Layout: `<dir>/<hh>/<sha256 hex>.tile`, where `hh` is the first two
 * hex characters of the hash. 256 shard directories keep each one
 * small, and let the background sweep look at one shard per tick
 * instead of walking the whole tree.
 *
 * File format, little endian:
 *
 *   0  4  magic "GGTC"
 *   4  1  format version (2)
 *   5  3  reserved, zero
 *   8  4  payload length in bytes
 *  12  4  CRC-32 of digest and payload
 *  16 32  SHA-256 digest of the material
 *  48     payload
 *
 * Only the digest of the material is stored, never the material
 * itself: the material holds request-derived text (filters, a user id
 * for row-scoped shares) that has no business on disk. The digest is
 * compared on read, so a file renamed or copied in from elsewhere is a
 * miss rather than a wrong tile. The length and checksum catch a
 * truncated or corrupt file, which is deleted and treated as a miss.
 *
 * Writes go to a temp file in the same shard directory and are renamed
 * into place, so a reader sees either the old file or the new one and
 * never a partial one. A crash mid-write leaves a temp file that the
 * sweep removes once it is an hour old.
 *
 * Eviction is least recently used. The in-memory index is a Map in LRU
 * order. A disk hit moves the file to the end and, at most once a
 * minute per file, touches its mtime, so the order survives a restart:
 * the startup scan rebuilds the index sorted by mtime. Sizes are
 * counted in whole 4 KiB blocks, which is what a file costs on the
 * filesystem. Over the byte cap or the file cap, the oldest files go
 * until both are at 90%. The file cap also bounds this index's heap
 * (about 150 bytes per file).
 *
 * Payloads under `minPayloadBytes` (empty and near-empty tiles) are not
 * written: they are cheap to recompute, and a crawler walking empty
 * ocean would otherwise fill the cap with one block per tile.
 *
 * Replicas sharing one directory each keep their own index. The sweep
 * reconciles 8 of the 256 shards per tick, so a full pass takes 32
 * ticks (16 minutes at the default 30 s). Between passes each replica
 * sees only its own writes, so two replicas can together hold up to
 * about twice the cap for that long before their sweeps catch up.
 *
 * Every failure is a miss or a skipped write, never an exception into
 * the tile path. A directory that cannot be created or written turns
 * the tier off for the life of the process after one log line.
 */
export interface TileDiskCacheOptions {
  dir: string;
  maxBytes: number;
  /** Writes running at once. Default 4. */
  maxConcurrentWrites?: number;
  /** Writes waiting for a slot; past this a write is dropped. Default 64. */
  maxQueuedWrites?: number;
  /** Hard limit on files. Default 100,000. */
  maxFiles?: number;
  /** Payloads smaller than this are not written. Default 1024. */
  minPayloadBytes?: number;
  /** Eight shards are rescanned per tick. Default 30 s. 0 turns it off. */
  sweepIntervalMs?: number;
  /** Minimum gap between mtime touches of one file. Default 60 s. */
  touchIntervalMs?: number;
  /** Temp files older than this are removed by the sweep. Default 1 h. */
  staleTempMs?: number;
  log?: { warn(msg: string): void; log(msg: string): void };
}

export interface TileDiskStats {
  /** False when TILE_CACHE_DIR is unset, the cap is 0, or the
   *  directory could not be used. */
  enabled: boolean;
  /** Bytes in tile files this process knows about. */
  bytes: number;
  files: number;
  maxBytes: number;
  maxFiles: number;
  /** True once the startup scan has indexed what was already there. */
  scanned: boolean;
  hits: number;
  misses: number;
  writes: number;
  /** Writes skipped because the write queue was full. */
  writesDropped: number;
  /** Writes skipped because the payload was under the minimum. */
  writesSkippedSmall: number;
  evictions: number;
  /** Files that failed validation and were deleted. */
  corrupt: number;
  /** IO errors other than "not found". */
  errors: number;
}

const MAGIC = Buffer.from('GGTC', 'ascii');
const FORMAT_VERSION = 2;
const DIGEST_BYTES = 32;
const HEADER_BYTES = 16 + DIGEST_BYTES;
const BLOCK_BYTES = 4096;
const SHARDS_PER_SWEEP = 8;
/** What a file of `n` bytes occupies on a typical filesystem. */
export function blockBytes(n: number): number {
  return Math.max(1, Math.ceil(n / BLOCK_BYTES)) * BLOCK_BYTES;
}
const FILE_RE = /^[0-9a-f]{64}\.tile$/;
const SHARD_RE = /^[0-9a-f]{2}$/;
const TEMP_SUFFIX = '.tmp';

interface IndexEntry {
  size: number;
  /** Last time this process read or wrote the file, or its mtime. */
  usedAt: number;
}

/** SHA-256 of the material; the file name is its hex form. */
export function materialDigest(material: string): Buffer {
  return createHash('sha256').update(material).digest();
}

export function encodeTileFile(digest: Buffer, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(crc32(payload, crc32(digest)) >>> 0, 12);
  digest.copy(header, 16);
  return Buffer.concat([header, payload]);
}

/**
 * The payload of `data` if it is a whole, intact tile file filed under
 * exactly `digest`; null otherwise.
 */
export function decodeTileFile(data: Buffer, digest: Buffer): Buffer | null {
  if (data.length < HEADER_BYTES) return null;
  if (!data.subarray(0, 4).equals(MAGIC)) return null;
  if (data.readUInt8(4) !== FORMAT_VERSION) return null;
  const payLen = data.readUInt32LE(8);
  if (HEADER_BYTES + payLen !== data.length) return null;
  const stored = data.subarray(16, HEADER_BYTES);
  if (!stored.equals(digest)) return null;
  const payload = data.subarray(HEADER_BYTES);
  if ((crc32(payload, crc32(stored)) >>> 0) !== data.readUInt32LE(12)) return null;
  // Copy out so the cached Buffer does not pin the header.
  return Buffer.from(payload);
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
}

export class TileDiskCache {
  readonly dir: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private readonly minPayloadBytes: number;
  private readonly maxConcurrentWrites: number;
  private readonly maxQueuedWrites: number;
  private readonly sweepIntervalMs: number;
  private readonly touchIntervalMs: number;
  private readonly staleTempMs: number;
  private readonly log: { warn(msg: string): void; log(msg: string): void };

  /** null until first use; resolves to whether the tier is usable. */
  private ready: Promise<boolean> | null = null;
  private disabled = false;
  private closed = false;
  private scanned = false;

  /** hash -> entry, in LRU order (oldest first). */
  private index = new Map<string, IndexEntry>();
  private bytes = 0;
  private readonly madeShards = new Set<string>();

  private activeWrites = 0;
  private readonly writeQueue: Array<() => void> = [];
  /** Hashes being written now or queued, so one tile is written once. */
  private readonly pendingHashes = new Set<string>();
  private readonly idle: Array<() => void> = [];

  private evicting: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private nextShard = 0;
  private sweeping: Promise<void> | null = null;
  private scanning: Promise<void> | null = null;
  private readonly loggedCodes = new Set<string>();

  private hits = 0;
  private misses = 0;
  private writes = 0;
  private writesDropped = 0;
  private writesSkippedSmall = 0;
  private evictions = 0;
  private corrupt = 0;
  private errors = 0;

  constructor(opts: TileDiskCacheOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes;
    this.maxFiles = Math.max(1, opts.maxFiles ?? 100_000);
    this.minPayloadBytes = Math.max(0, opts.minPayloadBytes ?? 1024);
    this.maxConcurrentWrites = Math.max(1, opts.maxConcurrentWrites ?? 4);
    this.maxQueuedWrites = Math.max(0, opts.maxQueuedWrites ?? 64);
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
    this.touchIntervalMs = opts.touchIntervalMs ?? 60_000;
    this.staleTempMs = opts.staleTempMs ?? 60 * 60_000;
    this.log = opts.log ?? { warn: () => {}, log: () => {} };
  }

  static hashOf(material: string): string {
    return materialDigest(material).toString('hex');
  }

  private pathOf(hash: string): string {
    return join(this.dir, hash.slice(0, 2), `${hash}.tile`);
  }

  /**
   * Create the directory and prove it is writable, once. Starts the
   * startup scan and the sweep timer in the background. Never rejects.
   */
  start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        const probe = join(
          this.dir,
          `.probe-${process.pid}-${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`,
        );
        await writeFile(probe, '');
        await unlink(probe);
      } catch (err) {
        this.disabled = true;
        this.log.warn(
          `tile disk cache at ${this.dir} is not usable (${errCode(err)}); ` +
            'serving tiles from memory only',
        );
        return false;
      }
      if (this.closed) return false;
      this.scanning = this.scan().finally(() => {
        this.scanning = null;
      });
      if (this.sweepIntervalMs > 0) {
        this.sweepTimer = setInterval(() => {
          void this.sweepOnce();
        }, this.sweepIntervalMs);
        this.sweepTimer.unref();
      }
      this.log.log(
        `tile disk cache at ${this.dir}, cap ${this.maxBytes} bytes`,
      );
      return true;
    })();
    return this.ready;
  }

  get enabled(): boolean {
    return !this.disabled && !this.closed;
  }

  /** The stored payload for `material`, or null on any kind of miss. */
  async read(material: string): Promise<Buffer | null> {
    if (!(await this.start()) || this.closed) {
      this.misses += 1;
      return null;
    }
    const digest = materialDigest(material);
    const hash = digest.toString('hex');
    const path = this.pathOf(hash);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') this.recordError('read', err);
      this.forget(hash);
      this.misses += 1;
      return null;
    }
    const payload = decodeTileFile(data, digest);
    if (payload === null) {
      this.corrupt += 1;
      this.misses += 1;
      this.forget(hash);
      await unlink(path).catch(() => {});
      return null;
    }
    this.hits += 1;
    this.markUsed(hash, blockBytes(data.length), path);
    return payload;
  }

  /**
   * Store `payload` under `material` in the background. Bounded: at
   * most `maxConcurrentWrites` run at once and `maxQueuedWrites` wait;
   * past that the write is dropped, since a cache that queues without
   * bound turns a pan storm into a memory leak.
   */
  write(material: string, payload: Buffer): void {
    if (!this.enabled) return;
    if (payload.length < this.minPayloadBytes) {
      this.writesSkippedSmall += 1;
      return;
    }
    // A single file larger than the whole cap would evict everything
    // and then itself.
    if (blockBytes(HEADER_BYTES + payload.length) > this.maxBytes) return;
    const digest = materialDigest(material);
    const hash = digest.toString('hex');
    if (this.pendingHashes.has(hash)) return;
    if (
      this.activeWrites >= this.maxConcurrentWrites &&
      this.writeQueue.length >= this.maxQueuedWrites
    ) {
      this.writesDropped += 1;
      return;
    }
    this.pendingHashes.add(hash);
    const run = () => {
      this.activeWrites += 1;
      void this.writeNow(hash, digest, payload).finally(() => {
        this.activeWrites -= 1;
        this.pendingHashes.delete(hash);
        const next = this.writeQueue.shift();
        if (next) next();
        else if (this.activeWrites === 0) this.resolveIdle();
      });
    };
    if (this.activeWrites < this.maxConcurrentWrites) run();
    else this.writeQueue.push(run);
  }

  private async writeNow(
    hash: string,
    digest: Buffer,
    payload: Buffer,
  ): Promise<void> {
    if (!(await this.start()) || this.closed) return;
    const shard = hash.slice(0, 2);
    const shardDir = join(this.dir, shard);
    const final = this.pathOf(hash);
    const tmp = join(
      shardDir,
      `.${hash}.${process.pid}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`,
    );
    const data = encodeTileFile(digest, payload);
    try {
      if (!this.madeShards.has(shard)) {
        await mkdir(shardDir, { recursive: true });
        this.madeShards.add(shard);
      }
      try {
        await writeFile(tmp, data, { flag: 'wx' });
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
        // Someone removed the directory under us (an operator
        // clearing the cache): make it again and retry once.
        await mkdir(shardDir, { recursive: true });
        await writeFile(tmp, data, { flag: 'wx' });
      }
      await rename(tmp, final);
    } catch (err) {
      if (errCode(err) === 'ENOENT') this.madeShards.delete(shard);
      this.recordError('write', err);
      await unlink(tmp).catch(() => {});
      return;
    }
    this.writes += 1;
    this.markUsed(hash, blockBytes(data.length));
    this.scheduleEvict();
  }

  /** Move `hash` to the most recent end and keep the byte count right. */
  private markUsed(hash: string, size: number, touchPath?: string): void {
    const now = Date.now();
    const prior = this.index.get(hash);
    if (prior) {
      this.bytes -= prior.size;
      this.index.delete(hash);
    }
    let usedAt = now;
    if (touchPath) {
      // Touch the mtime so LRU order survives a restart, but not on
      // every hit: a hot tile would otherwise cost a metadata write
      // per request. A file this process has not indexed yet may
      // carry an old mtime, so it is always touched.
      if (!prior || now - prior.usedAt >= this.touchIntervalMs) {
        const at = new Date(now);
        void utimes(touchPath, at, at).catch(() => {});
      } else {
        usedAt = prior.usedAt;
      }
    }
    this.index.set(hash, { size, usedAt });
    this.bytes += size;
  }

  private forget(hash: string): void {
    const prior = this.index.get(hash);
    if (!prior) return;
    this.bytes -= prior.size;
    this.index.delete(hash);
  }

  private overCap(): boolean {
    return this.bytes > this.maxBytes || this.index.size > this.maxFiles;
  }

  private scheduleEvict(): void {
    if (!this.overCap() || this.evicting) return;
    this.evicting = this.evict().finally(() => {
      this.evicting = null;
    });
  }

  /** Remove least recently used files until 90% of both caps. */
  private async evict(): Promise<void> {
    const byteTarget = Math.floor(this.maxBytes * 0.9);
    const fileTarget = Math.floor(this.maxFiles * 0.9);
    while ((this.bytes > byteTarget || this.index.size > fileTarget) && !this.closed) {
      const oldest = this.index.keys().next();
      if (oldest.done) break;
      const hash = oldest.value;
      const entry = this.index.get(hash)!;
      this.index.delete(hash);
      this.bytes -= entry.size;
      try {
        await unlink(this.pathOf(hash));
        this.evictions += 1;
      } catch (err) {
        if (errCode(err) !== 'ENOENT') this.recordError('evict', err);
      }
    }
  }

  /**
   * Index what is already on disk, oldest mtime first, so a restart
   * keeps both the files and their LRU order. Runs once in the
   * background after `start`; reads work before it finishes (a read
   * goes straight to the file's path), and entries added meanwhile
   * stay at the recent end.
   */
  private async scan(): Promise<void> {
    const found: Array<{ hash: string; size: number; mtime: number }> = [];
    let shards: string[];
    try {
      const names = await readdir(this.dir);
      shards = names.filter((s) => SHARD_RE.test(s));
      // A crash between writing and removing the startup probe leaves
      // it in the root; clear old ones here.
      await this.removeStaleTemps(
        this.dir,
        names.filter((n) => n.startsWith('.probe-') && n.endsWith(TEMP_SUFFIX)),
      );
    } catch (err) {
      this.recordError('scan', err);
      this.scanned = true;
      return;
    }
    for (const shard of shards) {
      if (this.closed) return;
      for (const f of await this.listShard(shard)) found.push(f);
    }
    found.sort((a, b) => a.mtime - b.mtime);
    const live = this.index;
    const rebuilt = new Map<string, IndexEntry>();
    for (const f of found) {
      if (!live.has(f.hash)) rebuilt.set(f.hash, { size: f.size, usedAt: f.mtime });
    }
    for (const [hash, entry] of live) rebuilt.set(hash, entry);
    this.index = rebuilt;
    this.bytes = 0;
    for (const entry of rebuilt.values()) this.bytes += entry.size;
    this.scanned = true;
    this.scheduleEvict();
    await this.evicting;
  }

  /**
   * Tile files in one shard, with stale temp files removed on the way.
   * Stats run a few at a time so one shard never queues thousands of
   * calls on the libuv pool at once.
   */
  private async listShard(
    shard: string,
  ): Promise<Array<{ hash: string; size: number; mtime: number }>> {
    const shardDir = join(this.dir, shard);
    let names: string[];
    try {
      names = await readdir(shardDir);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') this.recordError('scan', err);
      return [];
    }
    const out: Array<{ hash: string; size: number; mtime: number }> = [];
    const now = Date.now();
    const BATCH = 32;
    for (let i = 0; i < names.length; i += BATCH) {
      await Promise.all(
        names.slice(i, i + BATCH).map(async (name) => {
          const isTile = FILE_RE.test(name);
          const isTemp = name.endsWith(TEMP_SUFFIX);
          if (!isTile && !isTemp) return;
          const path = join(shardDir, name);
          try {
            const st = await stat(path);
            if (isTemp) {
              if (now - st.mtimeMs > this.staleTempMs) await unlink(path);
              return;
            }
            out.push({ hash: name.slice(0, 64), size: blockBytes(st.size), mtime: st.mtimeMs });
          } catch {
            // Gone between readdir and stat: another replica evicted it.
          }
        }),
      );
    }
    return out;
  }

  private async removeStaleTemps(dir: string, names: string[]): Promise<void> {
    const now = Date.now();
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs > this.staleTempMs) await unlink(path);
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Rescan shards and reconcile the index with it: pick up files
   * another replica sharing the directory wrote, drop ones it evicted,
   * clear old temp files, and evict if over the cap. One shard per
   * tick keeps the cost flat however many files there are; the whole
   * tree is reconciled every 256 ticks.
   */
  sweepOnce(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      if (!this.enabled || !this.scanned) return;
      for (let i = 0; i < SHARDS_PER_SWEEP; i += 1) {
        const shard = this.nextShard.toString(16).padStart(2, '0');
        this.nextShard = (this.nextShard + 1) % 256;
        if (this.nextShard === 0) {
          try {
            const names = await readdir(this.dir);
            await this.removeStaleTemps(
              this.dir,
              names.filter((n) => n.startsWith('.probe-') && n.endsWith(TEMP_SUFFIX)),
            );
          } catch {
            // The directory may be gone; the next write recreates it.
          }
        }
        const files = await this.listShard(shard);
        const onDisk = new Set(files.map((f) => f.hash));
        for (const hash of [...this.index.keys()]) {
          if (hash.startsWith(shard) && !onDisk.has(hash)) this.forget(hash);
        }
        for (const f of files) {
          if (!this.index.has(f.hash)) {
            this.index.set(f.hash, { size: f.size, usedAt: f.mtime });
            this.bytes += f.size;
          }
        }
      }
      this.scheduleEvict();
      await this.evicting;
    })().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private recordError(op: string, err: unknown): void {
    this.errors += 1;
    const code = errCode(err);
    const tag = `${op}:${code}`;
    if (this.loggedCodes.has(tag)) return;
    this.loggedCodes.add(tag);
    this.log.warn(`tile disk cache ${op} failed in ${this.dir} (${code}); continuing`);
  }

  private resolveIdle(): void {
    for (const fn of this.idle.splice(0)) fn();
  }

  /**
   * Wait until the startup scan, queued writes and any eviction they
   * started have finished. For tests and shutdown; the tile path never
   * waits on the disk tier's writes.
   */
  async flush(): Promise<void> {
    await this.ready;
    await this.scanning;
    if (this.activeWrites > 0 || this.writeQueue.length > 0) {
      await new Promise<void>((resolve) => this.idle.push(resolve));
    }
    await this.evicting;
  }

  /**
   * Delete every tile file. For after an in-app restore, which rewrites
   * the database without a NOTIFY. Correctness does not depend on it
   * (files are named by data version), but a restore is the one event
   * that can bring old versions back, and starting clean is cheap.
   * Runs shard by shard; failures are logged once and ignored.
   */
  async purge(): Promise<void> {
    if (!this.enabled || !(await this.start())) return;
    await this.flush();
    this.index = new Map();
    this.bytes = 0;
    for (let i = 0; i < 256; i += 1) {
      const shardDir = join(this.dir, i.toString(16).padStart(2, '0'));
      let names: string[];
      try {
        names = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!FILE_RE.test(name)) continue;
        await unlink(join(shardDir, name)).catch((err: unknown) => {
          if (errCode(err) !== 'ENOENT') this.recordError('purge', err);
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.flush().catch(() => {});
    this.closed = true;
  }

  getStats(): TileDiskStats {
    return {
      enabled: this.enabled,
      bytes: this.bytes,
      files: this.index.size,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      scanned: this.scanned,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      writesDropped: this.writesDropped,
      writesSkippedSmall: this.writesSkippedSmall,
      evictions: this.evictions,
      corrupt: this.corrupt,
      errors: this.errors,
    };
  }
}
