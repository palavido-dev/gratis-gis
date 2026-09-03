// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  TileCacheOverloadError,
  TileCacheService,
  matchesIfNoneMatch,
  optsFingerprint,
  tileCacheKey,
  tileOverloadRetryAfterSeconds,
} from './tile-cache.service.js';

describe('TileCacheService', () => {
  describe('get/set round-trip', () => {
    it('stores and returns a tile buffer', () => {
      const cache = new TileCacheService();
      const key = 'scope-a|6/24/17|';
      const buf = Buffer.from('hello');
      const etag = cache.set(key, buf);
      const hit = cache.get(key);
      expect(hit).not.toBeNull();
      expect(hit?.buf).toBe(buf);
      expect(hit?.etag).toBe(etag);
    });

    it('returns null on miss', () => {
      const cache = new TileCacheService();
      expect(cache.get('missing-key')).toBeNull();
    });

    it('returns a stable, content-derived ETag', () => {
      const cache = new TileCacheService();
      const key = 'scope-a|6/24/17|';
      const buf = Buffer.from('hello');
      const etag1 = cache.set(key, buf);
      cache.clear();
      const etag2 = cache.set(key, buf);
      // Same key + same buffer -> same ETag, even across cache
      // clears. Otherwise If-None-Match would have to invalidate
      // every time the cache fills.
      expect(etag1).toBe(etag2);
    });

    it('changes ETag when the buffer changes', () => {
      const cache = new TileCacheService();
      const key = 'scope-a|6/24/17|';
      const etagA = cache.set(key, Buffer.from('content-A'));
      const etagB = cache.set(key, Buffer.from('content-B'));
      expect(etagA).not.toBe(etagB);
    });
  });

  describe('TTL expiry', () => {
    it('treats entries older than the TTL as misses', () => {
      const cache = new TileCacheService();
      const key = 'scope-a|6/24/17|';
      cache.set(key, Buffer.from('hello'));
      expect(cache.get(key)).not.toBeNull();
      // Roll the clock forward past the default TTL.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(Date.now() + 120_000);
        expect(cache.get(key)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('LRU eviction', () => {
    it('evicts the oldest entry when the entry cap is exceeded', () => {
      // Use a tiny cap so the eviction is observable. The
      // env override path is the documented configuration
      // mechanism; setting it before construction is the
      // right way to test the policy.
      const prevMax = process.env.TILE_CACHE_MAX_ENTRIES;
      const prevBytes = process.env.TILE_CACHE_MAX_BYTES;
      process.env.TILE_CACHE_MAX_ENTRIES = '2';
      process.env.TILE_CACHE_MAX_BYTES = String(1024 * 1024);
      try {
        const cache = new TileCacheService();
        cache.set('A', Buffer.from('a'));
        cache.set('B', Buffer.from('b'));
        cache.set('C', Buffer.from('c'));
        // A was the least-recently-used; it should be gone.
        expect(cache.get('A')).toBeNull();
        expect(cache.get('B')).not.toBeNull();
        expect(cache.get('C')).not.toBeNull();
      } finally {
        if (prevMax !== undefined) process.env.TILE_CACHE_MAX_ENTRIES = prevMax;
        else delete process.env.TILE_CACHE_MAX_ENTRIES;
        if (prevBytes !== undefined)
          process.env.TILE_CACHE_MAX_BYTES = prevBytes;
        else delete process.env.TILE_CACHE_MAX_BYTES;
      }
    });

    it('promotes on hit so a recently-touched entry survives', () => {
      const prevMax = process.env.TILE_CACHE_MAX_ENTRIES;
      const prevBytes = process.env.TILE_CACHE_MAX_BYTES;
      process.env.TILE_CACHE_MAX_ENTRIES = '2';
      process.env.TILE_CACHE_MAX_BYTES = String(1024 * 1024);
      try {
        const cache = new TileCacheService();
        cache.set('A', Buffer.from('a'));
        cache.set('B', Buffer.from('b'));
        // Promote A by reading it, then insert a third.
        cache.get('A');
        cache.set('C', Buffer.from('c'));
        // B (now the LRU) should be evicted, A should survive.
        expect(cache.get('A')).not.toBeNull();
        expect(cache.get('B')).toBeNull();
        expect(cache.get('C')).not.toBeNull();
      } finally {
        if (prevMax !== undefined) process.env.TILE_CACHE_MAX_ENTRIES = prevMax;
        else delete process.env.TILE_CACHE_MAX_ENTRIES;
        if (prevBytes !== undefined)
          process.env.TILE_CACHE_MAX_BYTES = prevBytes;
        else delete process.env.TILE_CACHE_MAX_BYTES;
      }
    });
  });

  describe('invalidatePrefix', () => {
    it('drops every entry whose key starts with the prefix', () => {
      const cache = new TileCacheService();
      cache.set('scope-a|6/24/17|', Buffer.from('a-1'));
      cache.set('scope-a|7/49/35|', Buffer.from('a-2'));
      cache.set('scope-b|6/24/17|', Buffer.from('b-1'));
      const dropped = cache.invalidatePrefix('scope-a|');
      expect(dropped).toBe(2);
      expect(cache.get('scope-a|6/24/17|')).toBeNull();
      expect(cache.get('scope-a|7/49/35|')).toBeNull();
      expect(cache.get('scope-b|6/24/17|')).not.toBeNull();
    });
  });

  describe('write invalidation', () => {
    it('drops every tile of the written scope and nothing else', () => {
      const cache = new TileCacheService();
      cache.set('data_layer:i:a|6/24/17|', Buffer.from('a-1'));
      cache.set('data_layer:i:a|7/49/35|x', Buffer.from('a-2'));
      cache.set('data_layer:i:b|6/24/17|', Buffer.from('b-1'));
      // The payload is the bare scope; the service appends the
      // separator so scope 'i:a' cannot match a scope 'i:ab'.
      cache.set('data_layer:i:ab|6/24/17|', Buffer.from('ab-1'));
      expect(cache.onObservationWritten('data_layer:i:a')).toBe(2);
      expect(cache.get('data_layer:i:a|6/24/17|')).toBeNull();
      expect(cache.get('data_layer:i:b|6/24/17|')).not.toBeNull();
      expect(cache.get('data_layer:i:ab|6/24/17|')).not.toBeNull();
      expect(cache.onObservationWritten('')).toBe(0);
    });

    it('does not cache a compute that started before the write landed', async () => {
      // The compute read the pre-write state; storing its result
      // after the invalidation would pin stale bytes for a full TTL.
      const cache = new TileCacheService();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const compute = jest.fn(async () => {
        await gate;
        return Buffer.from('pre-write');
      });
      const pending = cache.getOrCompute('data_layer:i:a|6/24/17|', compute);
      await new Promise((r) => setTimeout(r, 5));
      cache.onObservationWritten('data_layer:i:a');
      release();
      const result = await pending;
      expect(result.buf.toString()).toBe('pre-write');
      expect(result.etag).toMatch(/^"/);
      expect(cache.get('data_layer:i:a|6/24/17|')).toBeNull();
      // A compute that starts after the write is cached normally.
      const fresh = await cache.getOrCompute('data_layer:i:a|6/24/17|', async () =>
        Buffer.from('post-write'),
      );
      expect(fresh.buf.toString()).toBe('post-write');
      expect(cache.get('data_layer:i:a|6/24/17|')?.buf.toString()).toBe('post-write');
    });
  });

  describe('lanes and dependencies (aggregate results)', () => {
    it('queues laned computes past the lane limit instead of failing, in order', async () => {
      const cache = new TileCacheService();
      const order: string[] = [];
      const gates: Array<() => void> = [];
      const compute = (name: string) => async () => {
        order.push(`start ${name}`);
        await new Promise<void>((r) => gates.push(r));
        return Buffer.from(name);
      };
      const lane = { name: 'agg', limit: 2 };
      const a = cache.getOrCompute('s|agg|a', compute('a'), { lane });
      const b = cache.getOrCompute('s|agg|b', compute('b'), { lane });
      const c = cache.getOrCompute('s|agg|c', compute('c'), { lane });
      await new Promise((r) => setTimeout(r, 5));
      // Two running, the third waiting; nothing threw.
      expect(order).toEqual(['start a', 'start b']);
      gates.shift()!();
      await a;
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toEqual(['start a', 'start b', 'start c']);
      gates.shift()!();
      gates.shift()!();
      expect((await b).buf.toString()).toBe('b');
      expect((await c).buf.toString()).toBe('c');
      // Laned work never consumed a tile slot.
      expect(cache.getStats().activeComputes).toBe(0);
    });

    it('coalesces an identical request that arrives while the leader is queued', async () => {
      const cache = new TileCacheService();
      let release!: () => void;
      const blocker = cache.getOrCompute(
        's|agg|x',
        async () => {
          await new Promise<void>((r) => (release = r));
          return Buffer.from('x');
        },
        { lane: { name: 'one', limit: 1 } },
      );
      const compute = jest.fn(async () => Buffer.from('y'));
      const first = cache.getOrCompute('s|agg|y', compute, { lane: { name: 'one', limit: 1 } });
      const second = cache.getOrCompute('s|agg|y', compute, { lane: { name: 'one', limit: 1 } });
      // The blocker's compute starts on a later tick (after its lane
      // slot resolves), so `release` is not assigned synchronously.
      await new Promise((r) => setTimeout(r, 5));
      release();
      await blocker;
      expect((await first).buf.toString()).toBe('y');
      expect((await second).buf.toString()).toBe('y');
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('drops an entry when a prefix it depends on is invalidated', async () => {
      const cache = new TileCacheService();
      await cache.getOrCompute('child|agg|k', async () => Buffer.from('v'), {
        dependsOn: ['parent|'],
      });
      expect(cache.get('child|agg|k')).not.toBeNull();
      expect(cache.onObservationWritten('parent')).toBe(1);
      expect(cache.get('child|agg|k')).toBeNull();
      // And the child's own prefix still drops it too.
      await cache.getOrCompute('child|agg|k', async () => Buffer.from('v'), {
        dependsOn: ['parent|'],
      });
      expect(cache.onObservationWritten('child')).toBe(1);
      expect(cache.get('child|agg|k')).toBeNull();
    });

    it('honours a per-entry TTL', () => {
      const cache = new TileCacheService();
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      cache.set('s|agg|t', Buffer.from('v'), 1_000);
      spy.mockReturnValue(now + 999);
      expect(cache.get('s|agg|t')).not.toBeNull();
      spy.mockReturnValue(now + 1_001);
      expect(cache.get('s|agg|t')).toBeNull();
      spy.mockRestore();
    });
  });

  describe('getOrCompute single-flight', () => {
    it('returns the cached entry on hit without calling compute', async () => {
      const cache = new TileCacheService();
      cache.set('key', Buffer.from('cached'));
      const compute = jest.fn(async () => Buffer.from('fresh'));
      const result = await cache.getOrCompute('key', compute);
      expect(result.buf.toString()).toBe('cached');
      expect(compute).not.toHaveBeenCalled();
    });

    it('computes once and stores on miss', async () => {
      const cache = new TileCacheService();
      const compute = jest.fn(async () => Buffer.from('fresh'));
      const result = await cache.getOrCompute('key', compute);
      expect(result.buf.toString()).toBe('fresh');
      expect(compute).toHaveBeenCalledTimes(1);
      // Subsequent reads return the cached value.
      const again = cache.get('key');
      expect(again?.buf.toString()).toBe('fresh');
    });

    it('coalesces concurrent callers into one compute', async () => {
      const cache = new TileCacheService();
      let resolveCompute: ((b: Buffer) => void) | null = null;
      const computePromise = new Promise<Buffer>((resolve) => {
        resolveCompute = resolve;
      });
      const compute = jest.fn(async () => computePromise);

      // Fire three callers in parallel; they should all join the
      // same in-flight compute.
      const p1 = cache.getOrCompute('key', compute);
      const p2 = cache.getOrCompute('key', compute);
      const p3 = cache.getOrCompute('key', compute);

      // Compute should have been invoked only once.
      expect(compute).toHaveBeenCalledTimes(1);
      expect(cache.getStats().inFlight).toBe(1);

      // Resolve the underlying compute; all three callers
      // resolve to the same buffer.
      resolveCompute!(Buffer.from('coalesced-result'));
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.buf.toString()).toBe('coalesced-result');
      expect(r2.buf.toString()).toBe('coalesced-result');
      expect(r3.buf.toString()).toBe('coalesced-result');
      expect(compute).toHaveBeenCalledTimes(1);
      // Two of the three were coalesced (the leader counted as
      // a miss in get(), the joiners as coalesced).
      expect(cache.getStats().coalesced).toBe(2);
      // The slot was cleared after the compute resolved.
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('clears the in-flight slot after a failed compute so the next caller can retry', async () => {
      const cache = new TileCacheService();
      const compute = jest
        .fn<Promise<Buffer>, []>()
        .mockRejectedValueOnce(new Error('postgres down'))
        .mockResolvedValueOnce(Buffer.from('recovered'));
      await expect(cache.getOrCompute('key', compute)).rejects.toThrow(
        'postgres down',
      );
      expect(cache.getStats().inFlight).toBe(0);
      // Retry succeeds and caches.
      const result = await cache.getOrCompute('key', compute);
      expect(result.buf.toString()).toBe('recovered');
      expect(compute).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrency cap', () => {
    it('rejects new computes when the cap is at saturation', async () => {
      const prev = process.env.TILE_CACHE_MAX_CONCURRENT;
      process.env.TILE_CACHE_MAX_CONCURRENT = '2';
      try {
        const cache = new TileCacheService();
        // Pin two computes in flight (don't resolve them yet).
        const gates: Array<(b: Buffer) => void> = [];
        const compute = (idx: number) => async () =>
          new Promise<Buffer>((resolve) => {
            gates[idx] = resolve;
          });
        const p1 = cache.getOrCompute('A', compute(0));
        const p2 = cache.getOrCompute('B', compute(1));
        // Active count == cap; third should reject with the
        // typed overload error.
        await expect(
          cache.getOrCompute('C', compute(2)),
        ).rejects.toBeInstanceOf(TileCacheOverloadError);
        expect(cache.getStats().rejectedOverload).toBe(1);
        // Release the pinned computes so the test exits.
        gates[0]!(Buffer.from('a'));
        gates[1]!(Buffer.from('b'));
        await Promise.all([p1, p2]);
        // After release, the next attempt can succeed.
        const r = await cache.getOrCompute('D', async () => Buffer.from('d'));
        expect(r.buf.toString()).toBe('d');
      } finally {
        if (prev !== undefined) process.env.TILE_CACHE_MAX_CONCURRENT = prev;
        else delete process.env.TILE_CACHE_MAX_CONCURRENT;
      }
    });

    it('coalesced followers do not count against the cap', async () => {
      const prev = process.env.TILE_CACHE_MAX_CONCURRENT;
      process.env.TILE_CACHE_MAX_CONCURRENT = '1';
      try {
        const cache = new TileCacheService();
        let resolveCompute: ((b: Buffer) => void) | null = null;
        const compute = jest.fn(
          async () =>
            new Promise<Buffer>((resolve) => {
              resolveCompute = resolve;
            }),
        );
        const p1 = cache.getOrCompute('K', compute);
        // Second caller for the SAME key should coalesce, not
        // trip the cap.
        const p2 = cache.getOrCompute('K', compute);
        expect(cache.getStats().rejectedOverload).toBe(0);
        resolveCompute!(Buffer.from('shared'));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.buf).toBe(r2.buf);
        expect(compute).toHaveBeenCalledTimes(1);
      } finally {
        if (prev !== undefined) process.env.TILE_CACHE_MAX_CONCURRENT = prev;
        else delete process.env.TILE_CACHE_MAX_CONCURRENT;
      }
    });
  });

  describe('tileOverloadRetryAfterSeconds', () => {
    it('returns a small positive integer', () => {
      const v = tileOverloadRetryAfterSeconds();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(60);
    });
  });

  describe('stats', () => {
    it('tracks hits, misses, and evictions', () => {
      const cache = new TileCacheService();
      cache.set('A', Buffer.from('a'));
      cache.get('A');
      cache.get('A');
      cache.get('missing');
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
    });
  });
});

describe('tileCacheKey', () => {
  it('is deterministic across calls with the same args', () => {
    const a = tileCacheKey({ scope: 's', z: 6, x: 24, y: 17, optsFingerprint: '' });
    const b = tileCacheKey({ scope: 's', z: 6, x: 24, y: 17, optsFingerprint: '' });
    expect(a).toBe(b);
  });

  it('distinguishes different z/x/y', () => {
    const a = tileCacheKey({ scope: 's', z: 6, x: 24, y: 17, optsFingerprint: '' });
    const b = tileCacheKey({ scope: 's', z: 6, x: 24, y: 18, optsFingerprint: '' });
    expect(a).not.toBe(b);
  });

  it('distinguishes different scopes', () => {
    const a = tileCacheKey({ scope: 's1', z: 6, x: 24, y: 17, optsFingerprint: '' });
    const b = tileCacheKey({ scope: 's2', z: 6, x: 24, y: 17, optsFingerprint: '' });
    expect(a).not.toBe(b);
  });
});

describe('optsFingerprint', () => {
  it('returns an empty string when no options are present', () => {
    expect(optsFingerprint({})).toBe('');
  });

  it('is stable across permuted field order', () => {
    const a = optsFingerprint({
      fields: [
        { name: 'a', type: 'text' },
        { name: 'b', type: 'int' },
      ],
    });
    const b = optsFingerprint({
      fields: [
        { name: 'b', type: 'int' },
        { name: 'a', type: 'text' },
      ],
    });
    expect(a).toBe(b);
  });

  it('changes when fields differ', () => {
    const a = optsFingerprint({ fields: [{ name: 'a', type: 'text' }] });
    const b = optsFingerprint({ fields: [{ name: 'b', type: 'text' }] });
    expect(a).not.toBe(b);
  });
});

describe('matchesIfNoneMatch', () => {
  it('matches the exact ETag', () => {
    expect(matchesIfNoneMatch('"abc"', '"abc"')).toBe(true);
  });

  it('matches against a list of candidates', () => {
    expect(matchesIfNoneMatch('"x", "abc", "y"', '"abc"')).toBe(true);
  });

  it('matches the wildcard', () => {
    expect(matchesIfNoneMatch('*', '"abc"')).toBe(true);
  });

  it('matches across weak ETag prefix', () => {
    expect(matchesIfNoneMatch('W/"abc"', '"abc"')).toBe(true);
  });

  it('returns false when the header is missing', () => {
    expect(matchesIfNoneMatch(undefined, '"abc"')).toBe(false);
  });

  it('returns false when no candidate matches', () => {
    expect(matchesIfNoneMatch('"x", "y"', '"abc"')).toBe(false);
  });
});
