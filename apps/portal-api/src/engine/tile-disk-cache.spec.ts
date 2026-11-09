// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TileCacheService, tileCacheKey } from './tile-cache.service.js';
import {
  TileDiskCache,
  blockBytes,
  decodeTileFile,
  encodeTileFile,
  materialDigest,
} from './tile-disk-cache.js';

const SCOPE = 'data_layer:11111111-1111-1111-1111-111111111111:0';
const PARENT = 'data_layer:22222222-2222-2222-2222-222222222222:0';

/** Every tile file under `dir`, as paths. */
async function tileFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    for (const name of await readdir(join(dir, shard))) {
      if (name.endsWith('.tile')) out.push(join(dir, shard, name));
    }
  }
  return out;
}

const ENV_KEYS = [
  'TILE_CACHE_DIR',
  'TILE_CACHE_DISK_MAX_BYTES',
  'TILE_CACHE_DISK_MAX_FILES',
  'GG_VERSION',
  'GIT_SHA',
];

/** A payload big enough to be persisted (the floor is 1 KiB). Compare
 *  with `.toString().trimEnd()`. */
const tile = (label: string): Buffer => Buffer.from(label.padEnd(2048));

describe('tile disk cache', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const services: TileCacheService[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-tile-disk-'));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.TILE_CACHE_DIR = dir;
    delete process.env.TILE_CACHE_DISK_MAX_BYTES;
    delete process.env.TILE_CACHE_DISK_MAX_FILES;
    delete process.env.GG_VERSION;
    // A build identity is required for the disk tier to turn on.
    process.env.GIT_SHA = 'abc123';
  });

  afterEach(async () => {
    for (const s of services.splice(0)) await s.onModuleDestroy();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  /** Versions per scope that a test can bump to simulate a write. */
  function makeService(versions: Map<string, number>, salt = 'r1'): {
    cache: TileCacheService;
    probes: string[];
  } {
    const cache = new TileCacheService();
    services.push(cache);
    const probes: string[] = [];
    cache.setScopeVersionSource(async (scope) => {
      probes.push(scope);
      return String(versions.get(scope) ?? 0);
    }, salt);
    return { cache, probes };
  }

  const key = (z = 3, x = 1, y = 2, fp = '') =>
    tileCacheKey({ scope: SCOPE, z, x, y, optsFingerprint: fp });

  async function flushDisk(cache: TileCacheService): Promise<void> {
    await cache.diskTier()?.flush();
  }

  it('is off when TILE_CACHE_DIR is unset, so existing installs are unchanged', async () => {
    delete process.env.TILE_CACHE_DIR;
    const cache = new TileCacheService();
    services.push(cache);
    expect(cache.diskTier()).toBeNull();
    expect(cache.getStats().disk).toBeNull();
    let computes = 0;
    await cache.getOrCompute(key(), async () => {
      computes += 1;
      return tile('t');
    }, { persist: true });
    expect(computes).toBe(1);
  });

  it('is off when the cap is 0 even with a directory set', () => {
    process.env.TILE_CACHE_DISK_MAX_BYTES = '0';
    const cache = new TileCacheService();
    services.push(cache);
    expect(cache.diskTier()).toBeNull();
  });

  it('writes on compute, then serves a memory miss from disk', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const { cache } = makeService(versions);
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return tile('tile-bytes');
    };
    const first = await cache.getOrCompute(key(), compute, { persist: true });
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(1);

    // Drop memory only; the disk copy answers.
    cache.clear();
    const second = await cache.getOrCompute(key(), compute, { persist: true });
    expect(computes).toBe(1);
    expect(second.buf.toString().trimEnd()).toBe('tile-bytes');
    // Same key and bytes, same ETag: a client's If-None-Match still
    // matches after a restart.
    expect(second.etag).toBe(first.etag);
    const stats = cache.getStats();
    expect(stats.diskHits).toBe(1);
    expect(stats.disk?.hits).toBe(1);
    expect(stats.disk?.files).toBe(1);
    expect(stats.disk?.bytes).toBeGreaterThan(0);
    // And the disk hit warmed memory.
    expect(cache.get(key())?.buf.toString().trimEnd()).toBe('tile-bytes');
  });

  it('misses on disk when nothing is stored and counts it', async () => {
    const { cache } = makeService(new Map());
    await cache.getOrCompute(key(), async () => tile('a'), { persist: true });
    expect(cache.getStats().disk?.misses).toBe(1);
    expect(cache.getStats().diskHits).toBe(0);
  });

  it('never writes non-persisted entries (aggregates) to disk', async () => {
    const { cache } = makeService(new Map());
    await cache.getOrCompute(`${SCOPE}|agg|abc`, async () => tile('{}'));
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(0);
  });

  it('a new service instance reads tiles an earlier one wrote (restart)', async () => {
    const versions = new Map([[SCOPE, 7]]);
    const before = makeService(versions).cache;
    await before.getOrCompute(key(), async () => tile('persisted'), { persist: true });
    await before.onModuleDestroy();

    const after = makeService(versions).cache;
    let computes = 0;
    const hit = await after.getOrCompute(key(), async () => {
      computes += 1;
      return tile('recomputed');
    }, { persist: true });
    expect(computes).toBe(0);
    expect(hit.buf.toString().trimEnd()).toBe('persisted');
    await flushDisk(after);
    // The startup scan indexed the existing file.
    expect(after.getStats().disk?.files).toBe(1);
    expect(after.getStats().disk?.scanned).toBe(true);
  });

  it('never serves a tile from before an edit, in this process or after a restart', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const { cache } = makeService(versions);
    await cache.getOrCompute(key(), async () => tile('before-edit'), { persist: true });
    await flushDisk(cache);

    // A write lands: Postgres's version moves and the NOTIFY drops
    // this scope.
    versions.set(SCOPE, 2);
    cache.onObservationWritten(SCOPE);
    const live = await cache.getOrCompute(key(), async () => tile('after-edit'), { persist: true });
    expect(live.buf.toString().trimEnd()).toBe('after-edit');

    // A write this process never heard about (it was down): only the
    // version moves. A fresh instance must not serve either old file.
    versions.set(SCOPE, 3);
    const restarted = makeService(versions).cache;
    const fresh = await restarted.getOrCompute(key(), async () => tile('after-restart'), { persist: true });
    expect(fresh.buf.toString().trimEnd()).toBe('after-restart');
  });

  it('keys a via tile on the parent version too', async () => {
    const versions = new Map([[SCOPE, 1], [PARENT, 1]]);
    const { cache } = makeService(versions);
    const opts = { persist: true, dependsOn: [`${PARENT}|`] };
    await cache.getOrCompute(key(), async () => tile('parent-v1'), opts);
    await flushDisk(cache);

    versions.set(PARENT, 2);
    cache.onObservationWritten(PARENT);
    const hit = await cache.getOrCompute(key(), async () => tile('parent-v2'), opts);
    expect(hit.buf.toString().trimEnd()).toBe('parent-v2');
  });

  it('keeps per-viewer keys apart on disk', async () => {
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    // Same tile, different fingerprints (for example ownRowsOnly for
    // two users): one viewer's file must never answer the other.
    await cache.getOrCompute(key(3, 1, 2, 'userA'), async () => tile('rows-of-A'), { persist: true });
    await flushDisk(cache);
    cache.clear();
    const b = await cache.getOrCompute(key(3, 1, 2, 'userB'), async () => tile('rows-of-B'), { persist: true });
    expect(b.buf.toString().trimEnd()).toBe('rows-of-B');
  });

  it('does not serve tiles written by a build with a different salt or image version', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const old = makeService(versions, 'r1').cache;
    await old.getOrCompute(key(), async () => tile('old-encoder'), { persist: true });
    await old.onModuleDestroy();
    const next = makeService(versions, 'r2').cache;
    const hit = await next.getOrCompute(key(), async () => tile('new-encoder'), { persist: true });
    expect(hit.buf.toString().trimEnd()).toBe('new-encoder');

    await next.onModuleDestroy();
    process.env.GG_VERSION = 'v9.9.9';
    const upgraded = makeService(versions, 'r2').cache;
    const hit2 = await upgraded.getOrCompute(key(), async () => tile('upgraded'), { persist: true });
    expect(hit2.buf.toString().trimEnd()).toBe('upgraded');
  });

  it('skips the disk when a write overtakes the version probe', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const cache = new TileCacheService();
    services.push(cache);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    cache.setScopeVersionSource(async (scope) => {
      await gate;
      return String(versions.get(scope));
    }, 'r1');
    const pending = cache.getOrCompute(key(), async () => tile('x'), { persist: true });
    // The write commits while the probe is still out.
    cache.onObservationWritten(SCOPE);
    release();
    await pending;
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(0);
  });

  it('treats a corrupt or truncated file as a miss and deletes it', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const { cache } = makeService(versions);
    await cache.getOrCompute(key(), async () => tile('good-bytes-here'), { persist: true });
    await flushDisk(cache);
    const [file] = await tileFiles(dir);
    const whole = await readFile(file!);
    await writeFile(file!, whole.subarray(0, whole.length - 3));

    cache.clear();
    let computes = 0;
    const hit = await cache.getOrCompute(key(), async () => {
      computes += 1;
      return tile('recomputed');
    }, { persist: true });
    expect(computes).toBe(1);
    expect(hit.buf.toString().trimEnd()).toBe('recomputed');
    expect(cache.getStats().disk?.corrupt).toBe(1);
    await flushDisk(cache);
    // The bad file was replaced by the recompute's write.
    const again = await readFile(file!);
    expect(again.length).toBeGreaterThan(0);
  });

  it('decode rejects bit flips, wrong material and garbage', () => {
    const m = materialDigest('m');
    const file = encodeTileFile(m, Buffer.from('payload'));
    expect(decodeTileFile(file, m)?.toString()).toBe('payload');
    expect(decodeTileFile(file, materialDigest('other'))).toBeNull();
    const flipped = Buffer.from(file);
    flipped.writeUInt8(flipped.readUInt8(flipped.length - 1) ^ 0xff, flipped.length - 1);
    expect(decodeTileFile(flipped, m)).toBeNull();
    expect(decodeTileFile(Buffer.from('nope'), m)).toBeNull();
    expect(decodeTileFile(Buffer.alloc(0), m)).toBeNull();
  });

  it('evicts least recently used files when over the cap', async () => {
    // Five 4 KiB blocks fit; each 2 KiB payload costs one block.
    const disk = new TileDiskCache({ dir, maxBytes: 5 * 4096, sweepIntervalMs: 0 });
    const payload = Buffer.alloc(2000, 1);
    // Writes run concurrently and enter the LRU order as they finish,
    // so flush after each one to make `a` through `e` the order.
    for (const m of ['a', 'b', 'c', 'd', 'e']) {
      disk.write(m, payload);
      await disk.flush();
    }
    expect(disk.getStats().evictions).toBe(0);
    // Read `a` so `b` becomes the oldest.
    expect(await disk.read('a')).not.toBeNull();
    disk.write('f', payload);
    await disk.flush();
    const stats = disk.getStats();
    expect(stats.bytes).toBeLessThanOrEqual(5 * 4096);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(await disk.read('b')).toBeNull();
    expect(await disk.read('a')).not.toBeNull();
    expect(await disk.read('f')).not.toBeNull();
    expect((await tileFiles(dir)).length).toBe(disk.getStats().files);
    await disk.close();
  });

  it('counts each file as whole 4 KiB blocks', async () => {
    expect(blockBytes(1)).toBe(4096);
    expect(blockBytes(4096)).toBe(4096);
    expect(blockBytes(4097)).toBe(8192);
    const disk = new TileDiskCache({ dir, maxBytes: 1 << 20, sweepIntervalMs: 0 });
    disk.write('one', Buffer.alloc(1500, 1));
    await disk.flush();
    expect(disk.getStats().bytes).toBe(4096);
    await disk.close();
  });

  it('evicts by file count as well as bytes', async () => {
    const disk = new TileDiskCache({
      dir,
      maxBytes: 1 << 30,
      maxFiles: 10,
      sweepIntervalMs: 0,
    });
    // One at a time, so f0 is the oldest (see the test above).
    for (let i = 0; i < 12; i += 1) {
      disk.write(`f${i}`, Buffer.alloc(1500, i));
      await disk.flush();
    }
    const stats = disk.getStats();
    expect(stats.files).toBeLessThanOrEqual(10);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(await disk.read('f0')).toBeNull();
    expect(await disk.read('f11')).not.toBeNull();
    expect((await tileFiles(dir)).length).toBe(disk.getStats().files);
    await disk.close();
  });

  it('does not persist empty or tiny tiles', async () => {
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    await cache.getOrCompute(key(5, 0, 0), async () => Buffer.alloc(0), { persist: true });
    await cache.getOrCompute(key(5, 1, 0), async () => Buffer.alloc(1023, 1), { persist: true });
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(0);
    expect(cache.getStats().disk?.writesSkippedSmall).toBe(2);
  });

  it('rebuilds LRU order from mtimes after a restart and evicts the oldest', async () => {
    const first = new TileDiskCache({ dir, maxBytes: 1 << 20, sweepIntervalMs: 0 });
    const payload = Buffer.alloc(3000, 2);
    for (const m of ['old', 'mid', 'new']) first.write(m, payload);
    await first.close();
    const path = (m: string) => {
      const h = TileDiskCache.hashOf(m);
      return join(dir, h.slice(0, 2), `${h}.tile`);
    };
    const t = Date.now() / 1000;
    await utimes(path('old'), t - 300, t - 300);
    await utimes(path('mid'), t - 200, t - 200);
    await utimes(path('new'), t - 100, t - 100);

    // Restart with a cap that fits two files.
    const fileSize = (await stat(path('old'))).size;
    const second = new TileDiskCache({ dir, maxBytes: Math.floor(blockBytes(fileSize) * 2.5), sweepIntervalMs: 0 });
    await second.start();
    await second.flush();
    expect(second.getStats().files).toBe(2);
    expect(await second.read('old')).toBeNull();
    expect(await second.read('mid')).not.toBeNull();
    expect(await second.read('new')).not.toBeNull();
    await second.close();
  });

  it('bounds queued writes and drops the excess', async () => {
    const disk = new TileDiskCache({
      dir,
      maxBytes: 1 << 20,
      maxConcurrentWrites: 1,
      maxQueuedWrites: 2,
      sweepIntervalMs: 0,
    });
    for (let i = 0; i < 10; i += 1) disk.write(`m${i}`, tile(`p${i}`));
    await disk.flush();
    const stats = disk.getStats();
    expect(stats.writes).toBe(3);
    expect(stats.writesDropped).toBe(7);
    await disk.close();
  });

  it('sweep removes stale temp files and picks up files another replica wrote', async () => {
    const disk = new TileDiskCache({ dir, maxBytes: 1 << 20, sweepIntervalMs: 0, staleTempMs: 1000 });
    await disk.start();
    await disk.flush();
    const other = new TileDiskCache({ dir, maxBytes: 1 << 20, sweepIntervalMs: 0 });
    // Pick a material whose hash lands in shard 00 so the first sweep
    // tick visits it.
    let m = '';
    for (let i = 0; ; i += 1) {
      m = `other-${i}`;
      if (TileDiskCache.hashOf(m).startsWith('00')) break;
    }
    other.write(m, tile('from-replica-2'));
    await other.close();
    const tmp = join(dir, '00', '.leftover.123.abcd.tmp');
    await writeFile(tmp, 'partial');
    const old = Date.now() / 1000 - 3600;
    await utimes(tmp, old, old);

    expect(disk.getStats().files).toBe(0);
    await disk.sweepOnce();
    expect(disk.getStats().files).toBe(1);
    expect(await readdir(join(dir, '00'))).not.toContain('.leftover.123.abcd.tmp');
    await disk.close();
  });

  it('falls back to memory only when the directory is unwritable', async () => {
    if (process.getuid?.() === 0) {
      // Root ignores permission bits; point at a path under a file
      // instead, which no user can create.
      const blocker = join(dir, 'not-a-dir');
      await writeFile(blocker, 'x');
      process.env.TILE_CACHE_DIR = join(blocker, 'tiles');
    } else {
      await chmod(dir, 0o500);
      process.env.TILE_CACHE_DIR = join(dir, 'tiles');
    }
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return tile('mem-only');
    };
    const a = await cache.getOrCompute(key(), compute, { persist: true });
    expect(a.buf.toString().trimEnd()).toBe('mem-only');
    // Memory still works.
    await cache.getOrCompute(key(), compute, { persist: true });
    expect(computes).toBe(1);
    await flushDisk(cache);
    expect(cache.getStats().disk?.enabled).toBe(false);
    // And later persisted computes skip the disk entirely.
    cache.clear();
    await cache.getOrCompute(key(), compute, { persist: true });
    expect(computes).toBe(2);
  });

  it('survives the directory being removed while running', async () => {
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    await cache.getOrCompute(key(1, 0, 0), async () => tile('one'), { persist: true });
    await flushDisk(cache);
    await rm(dir, { recursive: true, force: true });
    cache.clear();
    const hit = await cache.getOrCompute(key(1, 0, 0), async () => tile('two'), { persist: true });
    expect(hit.buf.toString().trimEnd()).toBe('two');
    await flushDisk(cache);
    // The shard directory was made again on the next write.
    cache.clear();
    await cache.getOrCompute(key(1, 0, 0), async () => tile('three'), { persist: true });
    expect(cache.getStats().diskHits).toBe(1);
  });

  it('serves disk hits even when the compute cap is saturated', async () => {
    process.env.TILE_CACHE_MAX_CONCURRENT = '1';
    try {
      const { cache } = makeService(new Map([[SCOPE, 1]]));
      await cache.getOrCompute(key(2, 0, 0), async () => tile('warm'), { persist: true });
      await flushDisk(cache);
      cache.clear();
      let release: () => void = () => {};
      const slow = cache.getOrCompute(key(2, 1, 1), () =>
        new Promise<Buffer>((r) => (release = () => r(tile('slow')))),
      { persist: true });
      // Let the slow compute take the only slot.
      await new Promise((r) => setTimeout(r, 20));
      const hit = await cache.getOrCompute(key(2, 0, 0), async () => tile('x'), { persist: true });
      expect(hit.buf.toString().trimEnd()).toBe('warm');
      release();
      await slow;
    } finally {
      delete process.env.TILE_CACHE_MAX_CONCURRENT;
    }
  });

  it('memoizes the scope version until the scope is written', async () => {
    const versions = new Map([[SCOPE, 1]]);
    const { cache, probes } = makeService(versions);
    for (let x = 0; x < 3; x += 1) {
      await cache.getOrCompute(key(4, x, 0), async () => tile(`t${x}`), { persist: true });
    }
    expect(probes).toEqual([SCOPE]);
    cache.onObservationWritten(SCOPE);
    await cache.getOrCompute(key(4, 9, 0), async () => tile('t9'), { persist: true });
    expect(probes).toEqual([SCOPE, SCOPE]);
  });

  it('computes without the disk when the version probe fails', async () => {
    const cache = new TileCacheService();
    services.push(cache);
    cache.setScopeVersionSource(async () => {
      throw new Error('db down');
    }, 'r1');
    const hit = await cache.getOrCompute(key(), async () => tile('ok'), { persist: true });
    expect(hit.buf.toString().trimEnd()).toBe('ok');
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(0);
  });

  it('stays off without a build identity, so a rebuild cannot serve old tiles', () => {
    delete process.env.GIT_SHA;
    process.env.GG_VERSION = 'dev';
    const cache = new TileCacheService();
    services.push(cache);
    expect(cache.diskTier()).toBeNull();
    process.env.GG_VERSION = 'v1.2.3';
    const tagged = new TileCacheService();
    services.push(tagged);
    expect(tagged.diskTier()).not.toBeNull();
  });

  it('computes instead of queueing when every probe slot is busy', async () => {
    const cache = new TileCacheService();
    services.push(cache);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let probes = 0;
    cache.setScopeVersionSource(async () => {
      probes += 1;
      await gate;
      return '1';
    }, 'r1');
    const scopes = [0, 1, 2, 3].map((i) => `data_layer:aaaaaaaa-0000-0000-0000-00000000000${i}:0`);
    const slow = scopes.map((sc) =>
      cache.getOrCompute(tileCacheKey({ scope: sc, z: 1, x: 0, y: 0, optsFingerprint: '' }),
        async () => tile('slow'), { persist: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(probes).toBe(4);
    // A fifth scope: no slot, so it computes right away.
    const fifth = await cache.getOrCompute(key(), async () => tile('fifth'), { persist: true });
    expect(fifth.buf.toString().trimEnd()).toBe('fifth');
    expect(probes).toBe(4);
    expect(cache.getStats().diskSkippedBusy).toBe(1);
    release();
    await Promise.all(slow);
  });

  it('remembers a failed probe for the TTL instead of re-probing every miss', async () => {
    const cache = new TileCacheService();
    services.push(cache);
    let probes = 0;
    cache.setScopeVersionSource(async () => {
      probes += 1;
      throw new Error('canceling statement due to statement timeout');
    }, 'r1');
    for (let x = 0; x < 3; x += 1) {
      await cache.getOrCompute(key(6, x, 0), async () => tile('t'), { persist: true });
    }
    expect(probes).toBe(1);
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.now() + 120_000);
      await cache.getOrCompute(key(6, 9, 0), async () => tile('t'), { persist: true });
    } finally {
      jest.useRealTimers();
    }
    expect(probes).toBe(2);
  });

  it('removes a stale startup probe file left by a crash', async () => {
    const leftover = join(dir, '.probe-99-deadbeef.tmp');
    await writeFile(leftover, '');
    const old = Date.now() / 1000 - 7200;
    await utimes(leftover, old, old);
    const disk = new TileDiskCache({ dir, maxBytes: 1 << 20, sweepIntervalMs: 0 });
    await disk.start();
    await disk.flush();
    expect(await readdir(dir)).not.toContain('.probe-99-deadbeef.tmp');
    await disk.close();
  });

  it('writes only a digest of the key to disk, never the key text', async () => {
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    const secret = 'ownRowsOnly-user-0f0f0f';
    await cache.getOrCompute(key(3, 1, 2, secret), async () => tile('t'), { persist: true });
    await flushDisk(cache);
    const [file] = await tileFiles(dir);
    const raw = await readFile(file!);
    expect(raw.includes(Buffer.from(secret))).toBe(false);
    expect(raw.includes(Buffer.from(SCOPE))).toBe(false);
  });

  it('resetAfterRestore drops memory and every disk file', async () => {
    const { cache } = makeService(new Map([[SCOPE, 1]]));
    await cache.getOrCompute(key(), async () => tile('pre-restore'), { persist: true });
    await flushDisk(cache);
    expect(await tileFiles(dir)).toHaveLength(1);
    await cache.resetAfterRestore();
    expect(await tileFiles(dir)).toHaveLength(0);
    expect(cache.get(key())).toBeNull();
    expect(cache.getStats().disk?.files).toBe(0);
  });
});
