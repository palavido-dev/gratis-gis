// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OBSERVATION_WRITTEN_CHANNEL,
  TileCacheAbortedError,
  TileCacheOverloadError,
  TileCacheService,
  aggregateCacheKey,
  matchesIfNoneMatch,
  optsFingerprint,
  parseIntEnv,
  stableJson,
  tileCacheKey,
  tileOverloadRetryAfterSeconds,
  viaKeysCacheKey,
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

    it('does not store a dependent compute when its parent is written mid-compute', async () => {
      // The dependency is only registered when the result is stored,
      // so a parent write during the compute has nothing to drop; the
      // sequence check has to cover the parents, not just the own key.
      const cache = new TileCacheService();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const pending = cache.getOrCompute(
        'child|agg|k',
        async () => {
          await gate;
          return Buffer.from('pre-parent-write');
        },
        { dependsOn: ['parent|'] },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(cache.onObservationWritten('parent')).toBe(0);
      release();
      const result = await pending;
      expect(result.buf.toString()).toBe('pre-parent-write');
      expect(cache.get('child|agg|k')).toBeNull();
      expect(cache.dependentCount('parent|')).toBe(0);
      // A compute that starts after the parent write stores normally.
      await cache.getOrCompute('child|agg|k', async () => Buffer.from('fresh'), {
        dependsOn: ['parent|'],
      });
      expect(cache.get('child|agg|k')?.buf.toString()).toBe('fresh');
      expect(cache.dependentCount('parent|')).toBe(1);
    });

    it('prunes the dependents index when a dependent entry is evicted', async () => {
      const prevMax = process.env.TILE_CACHE_MAX_ENTRIES;
      process.env.TILE_CACHE_MAX_ENTRIES = '1';
      try {
        const cache = new TileCacheService();
        await cache.getOrCompute('child|agg|k', async () => Buffer.from('v'), {
          dependsOn: ['parent|'],
        });
        expect(cache.dependentCount('parent|')).toBe(1);
        cache.set('other|6/24/17|', Buffer.from('o'));
        expect(cache.get('child|agg|k')).toBeNull();
        expect(cache.dependentCount('parent|')).toBe(0);
        // With nothing registered, a parent write drops nothing and
        // does not throw over the missing index entry.
        expect(cache.onObservationWritten('parent')).toBe(0);
      } finally {
        if (prevMax !== undefined) process.env.TILE_CACHE_MAX_ENTRIES = prevMax;
        else delete process.env.TILE_CACHE_MAX_ENTRIES;
      }
    });

    it('prunes the dependents index when a dependent entry expires', async () => {
      const cache = new TileCacheService();
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await cache.getOrCompute('child|agg|k', async () => Buffer.from('v'), {
          dependsOn: ['parent|'],
          ttlMs: 1_000,
        });
        expect(cache.dependentCount('parent|')).toBe(1);
        spy.mockReturnValue(now + 1_001);
        expect(cache.get('child|agg|k')).toBeNull();
        expect(cache.dependentCount('parent|')).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('prunes the dependents index and the invalidation record on clear', async () => {
      const cache = new TileCacheService();
      await cache.getOrCompute('child|agg|k', async () => Buffer.from('v'), {
        dependsOn: ['parent|'],
      });
      cache.onObservationWritten('unrelated');
      cache.clear();
      const internals = cache as unknown as {
        invalidatedAtSeq: Map<string, number>;
        dependents: Map<string, Set<string>>;
      };
      expect(internals.invalidatedAtSeq.size).toBe(0);
      expect(internals.dependents.size).toBe(0);
      expect(cache.dependentCount('parent|')).toBe(0);
      expect(cache.onObservationWritten('parent')).toBe(0);
    });

    it('does not store a compute that straddled a clear', async () => {
      // clear() is what the listener calls when it connects, on the
      // grounds that anything cached before it was up may be stale;
      // a compute in flight at that moment is in the same position.
      const cache = new TileCacheService();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const pending = cache.getOrCompute('s|6/24/17|', async () => {
        await gate;
        return Buffer.from('old');
      });
      await new Promise((r) => setTimeout(r, 5));
      cache.clear();
      release();
      expect((await pending).buf.toString()).toBe('old');
      expect(cache.get('s|6/24/17|')).toBeNull();
    });
  });

  describe('lane back-pressure and client disconnect', () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));

    /** Pin `limit` computes in the lane; returns their release gates. */
    function fillLane(cache: TileCacheService, lane: { name: string; limit: number; maxQueued?: number }) {
      const gates: Array<() => void> = [];
      const running: Array<Promise<unknown>> = [];
      for (let i = 0; i < lane.limit; i += 1) {
        running.push(
          cache.getOrCompute(
            `s|agg|pin${i}`,
            async () => {
              await new Promise<void>((r) => gates.push(r));
              return Buffer.from(`pin${i}`);
            },
            { lane },
          ),
        );
      }
      return { gates, running };
    }

    it('removes an aborted waiter from the queue and never runs its compute', async () => {
      const cache = new TileCacheService();
      const lane = { name: 'agg', limit: 1 };
      const { gates, running } = fillLane(cache, lane);
      await tick();
      const ac = new AbortController();
      const compute = jest.fn(async () => Buffer.from('never'));
      const queued = cache.getOrCompute('s|agg|q', compute, { lane, signal: ac.signal });
      const after = cache.getOrCompute('s|agg|after', async () => Buffer.from('after'), { lane });
      await tick();
      ac.abort();
      await expect(queued).rejects.toBeInstanceOf(TileCacheAbortedError);
      // Free the lane: the withdrawn waiter must not have taken the
      // slot, so `after` runs next and the aborted compute never does.
      gates.shift()!();
      await Promise.all(running);
      expect((await after).buf.toString()).toBe('after');
      expect(compute).not.toHaveBeenCalled();
      expect(cache.get('s|agg|q')).toBeNull();
      expect(cache.getStats().abandoned).toBe(1);
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('refuses a caller whose signal is already aborted without registering anything', async () => {
      const cache = new TileCacheService();
      const ac = new AbortController();
      ac.abort();
      const compute = jest.fn(async () => Buffer.from('x'));
      await expect(
        cache.getOrCompute('s|agg|dead', compute, { lane: { name: 'agg', limit: 1 }, signal: ac.signal }),
      ).rejects.toBeInstanceOf(TileCacheAbortedError);
      expect(compute).not.toHaveBeenCalled();
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('fails fast with an overload error once the lane queue is full', async () => {
      const cache = new TileCacheService();
      const lane = { name: 'agg', limit: 1, maxQueued: 2 };
      const { gates, running } = fillLane(cache, lane);
      await tick();
      const q1 = cache.getOrCompute('s|agg|q1', async () => Buffer.from('q1'), { lane });
      const q2 = cache.getOrCompute('s|agg|q2', async () => Buffer.from('q2'), { lane });
      await tick();
      const rejected = jest.fn(async () => Buffer.from('q3'));
      await expect(
        cache.getOrCompute('s|agg|q3', rejected, { lane }),
      ).rejects.toBeInstanceOf(TileCacheOverloadError);
      expect(rejected).not.toHaveBeenCalled();
      expect(cache.getStats().rejectedOverload).toBe(1);
      // The queued ones are unaffected and still run in order.
      gates.shift()!();
      await Promise.all(running);
      expect((await q1).buf.toString()).toBe('q1');
      expect((await q2).buf.toString()).toBe('q2');
      // With the queue drained, a new request queues again normally.
      const q4 = await cache.getOrCompute('s|agg|q4', async () => Buffer.from('q4'), { lane });
      expect(q4.buf.toString()).toBe('q4');
    });

    it('lets a joiner stop waiting without cancelling the shared compute', async () => {
      const cache = new TileCacheService();
      let release!: () => void;
      const compute = jest.fn(async () => {
        await new Promise<void>((r) => (release = r));
        return Buffer.from('shared');
      });
      const leader = cache.getOrCompute('s|agg|k', compute, { lane: { name: 'agg', limit: 1 } });
      const ac = new AbortController();
      const joiner = cache.getOrCompute('s|agg|k', compute, {
        lane: { name: 'agg', limit: 1 },
        signal: ac.signal,
      });
      await tick();
      ac.abort();
      await expect(joiner).rejects.toBeInstanceOf(TileCacheAbortedError);
      // The leader is still waiting, so the compute runs to completion
      // and is stored.
      release();
      expect((await leader).buf.toString()).toBe('shared');
      expect(compute).toHaveBeenCalledTimes(1);
      expect(cache.get('s|agg|k')?.buf.toString()).toBe('shared');
      expect(cache.getStats().abandoned).toBe(0);
    });

    it('keeps a queued compute alive for a joiner after its leader aborts', async () => {
      const cache = new TileCacheService();
      const lane = { name: 'agg', limit: 1 };
      const { gates, running } = fillLane(cache, lane);
      await tick();
      const ac = new AbortController();
      const compute = jest.fn(async () => Buffer.from('kept'));
      const leader = cache.getOrCompute('s|agg|k', compute, { lane, signal: ac.signal });
      // A joiner with no signal never leaves, so the leader's abort
      // must not withdraw the compute from under it.
      const joiner = cache.getOrCompute('s|agg|k', compute, { lane });
      await tick();
      ac.abort();
      await expect(leader).rejects.toBeInstanceOf(TileCacheAbortedError);
      gates.shift()!();
      await Promise.all(running);
      expect((await joiner).buf.toString()).toBe('kept');
      expect(compute).toHaveBeenCalledTimes(1);
      expect(cache.getStats().abandoned).toBe(0);
    });

    it('does not withdraw a compute that has already started', async () => {
      const cache = new TileCacheService();
      let release!: () => void;
      const compute = jest.fn(async () => {
        await new Promise<void>((r) => (release = r));
        return Buffer.from('finished');
      });
      const ac = new AbortController();
      const only = cache.getOrCompute('s|agg|k', compute, {
        lane: { name: 'agg', limit: 1 },
        signal: ac.signal,
      });
      await tick();
      expect(compute).toHaveBeenCalledTimes(1);
      ac.abort();
      await expect(only).rejects.toBeInstanceOf(TileCacheAbortedError);
      // The query is already running; its answer is worth keeping for
      // the next caller, who is one pan away.
      release();
      await tick();
      expect(cache.get('s|agg|k')?.buf.toString()).toBe('finished');
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('runs an exempt compute outside the tile cap and outside any lane', async () => {
      const prev = process.env.TILE_CACHE_MAX_CONCURRENT;
      process.env.TILE_CACHE_MAX_CONCURRENT = '1';
      try {
        const cache = new TileCacheService();
        let release!: (b: Buffer) => void;
        const pinned = cache.getOrCompute('t|0/0/0|', () => new Promise<Buffer>((r) => (release = r)));
        // The cap is saturated; a plain compute would 503.
        await expect(cache.getOrCompute('t|0/0/1|', async () => Buffer.from('x'))).rejects.toBeInstanceOf(
          TileCacheOverloadError,
        );
        // The exempt one runs anyway and does not touch the counter.
        const keys = await cache.getOrCompute('p|viakeys|h', async () => Buffer.from('["a"]'), {
          exemptFromCap: true,
        });
        expect(keys.buf.toString()).toBe('["a"]');
        expect(cache.getStats().activeComputes).toBe(1);
        release(Buffer.from('t'));
        await pinned;
        expect(cache.getStats().activeComputes).toBe(0);
      } finally {
        if (prev !== undefined) process.env.TILE_CACHE_MAX_CONCURRENT = prev;
        else delete process.env.TILE_CACHE_MAX_CONCURRENT;
      }
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

describe('aggregateCacheKey', () => {
  it('sits under the scope prefix with an agg marker', () => {
    const key = aggregateCacheKey('data_layer:i:l', { aggs: [{ fn: 'count' }] });
    expect(key.startsWith('data_layer:i:l|agg|')).toBe(true);
  });

  it('is stable across key order and undefined optional fields', () => {
    const a = aggregateCacheKey('s', { groupBy: ['x'], aggs: [{ fn: 'count' }], via: undefined });
    const b = aggregateCacheKey('s', { aggs: [{ fn: 'count' }], groupBy: ['x'] });
    expect(a).toBe(b);
  });

  it('changes when the request changes', () => {
    const a = aggregateCacheKey('s', { aggs: [{ fn: 'count' }] });
    const b = aggregateCacheKey('s', { aggs: [{ fn: 'sum', field: 'v' }] });
    expect(a).not.toBe(b);
  });
});

describe('viaKeysCacheKey', () => {
  it('sits under the parent scope prefix so a parent write drops it', () => {
    const key = viaKeysCacheKey('data_layer:p:l', { parentField: 'id', asOf: 'now', filters: [] });
    expect(key.startsWith('data_layer:p:l|viakeys|')).toBe(true);
    const cache = new TileCacheService();
    cache.set(key, Buffer.from('["a"]'));
    expect(cache.onObservationWritten('data_layer:p:l')).toBe(1);
    expect(cache.get(key)).toBeNull();
  });

  it('separates the default asOf from an explicit instant and one parent filter from another', () => {
    const base = { parentField: 'id', asOf: 'now', filters: [] };
    expect(viaKeysCacheKey('s', base)).toBe(viaKeysCacheKey('s', { ...base }));
    expect(viaKeysCacheKey('s', base)).not.toBe(
      viaKeysCacheKey('s', { ...base, asOf: '2026-01-01T00:00:00.000Z' }),
    );
    expect(viaKeysCacheKey('s', base)).not.toBe(
      viaKeysCacheKey('s', { ...base, filters: [{ strings: ['AND x = ', ''], values: [1] }] }),
    );
  });
});

describe('stableJson', () => {
  it('sorts keys at every level', () => {
    expect(stableJson({ b: { d: 1, c: 2 }, a: [3, { f: 1, e: 2 }] })).toBe(
      '{"a":[3,{"e":2,"f":1}],"b":{"c":2,"d":1}}',
    );
  });

  it('omits undefined-valued keys like JSON.stringify does', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('never emits the text "undefined"', () => {
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson([undefined])).toBe('[null]');
  });
});

describe('parseIntEnv', () => {
  const NAME = 'TILE_CACHE_SPEC_KNOB';
  afterEach(() => {
    delete process.env[NAME];
  });

  it('falls back when unset, empty or not a number', () => {
    expect(parseIntEnv(NAME, 7)).toBe(7);
    process.env[NAME] = '';
    expect(parseIntEnv(NAME, 7)).toBe(7);
    process.env[NAME] = 'many';
    expect(parseIntEnv(NAME, 7)).toBe(7);
  });

  it('accepts zero by default and refuses it under a floor of one', () => {
    process.env[NAME] = '0';
    expect(parseIntEnv(NAME, 7)).toBe(0);
    expect(parseIntEnv(NAME, 7, { min: 1 })).toBe(7);
    process.env[NAME] = '-1';
    expect(parseIntEnv(NAME, 7)).toBe(7);
  });
});

describe('OBSERVATION_WRITTEN_CHANNEL', () => {
  it('is the channel the observation trigger notifies on', () => {
    // The constant has no importer outside this service, so nothing
    // would fail if the two spellings drifted: the listener would
    // simply never hear a write and the cache would fall back to TTL
    // staleness, which is exactly the outage the trigger was added
    // to end. Pin the migration text to the constant.
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'prisma',
        'migrations',
        '20260903150000_observation_notify_trigger',
        'migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain(`pg_notify('${OBSERVATION_WRITTEN_CHANNEL}'`);
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
