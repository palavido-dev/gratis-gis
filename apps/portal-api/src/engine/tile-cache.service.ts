// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Client as PgClient } from 'pg';

import { parseIntEnv } from '../common/env.js';

// Re-exported because the aggregate knobs in data-layer.ts and this
// file's own spec import it from here; the helper itself moved to
// common/ when the auth and schema caches started reading knobs too.
export { parseIntEnv };

/**
 * In-process LRU cache for MVT tile buffers and, since the dashboard
 * work, aggregate result JSON (`DataLayerEngine.aggregateFeatures`
 * stores its answers here under `<scope>|agg|<hash>` with a longer
 * TTL and a waiting lane; see `getOrCompute`'s options).
 *
 * The mvtTile path is a hot read: a single map view can fan out
 * to 20-50 tile requests, multiple anonymous clients hit the
 * same popular tiles within seconds of each other, and crawlers
 * (memory: `project_gratisgis_ogc_tiles_pool_storm_2026_05_21`)
 * can drown the Prisma pool by computing the same tile dozens
 * of times in a hot minute. Cache is the first line of defense.
 *
 * Design notes:
 *
 *   - Bounded by BOTH byte count and entry count. Polygon-heavy
 *     county-scale tiles are megabytes; sparse county tiles are
 *     hundreds of bytes. Without a byte cap, a few fat tiles
 *     evict thousands of cheap ones. Without an entry cap a
 *     pathological run of empty tiles fills the table.
 *
 *   - TTL-based staleness. Cached entries expire after the TTL
 *     (60 s by default, matching the existing
 *     `Cache-Control: max-age=60` on the authed route and a
 *     fraction of the 300 s public route). On TTL miss the
 *     entry is dropped and the next request recomputes.
 *
 *   - No cross-replica SHARING. This is an in-process cache. Two
 *     replicas may each compute the same tile once before either
 *     fills its cache. That's acceptable for v1; phase 4
 *     (persistent MinIO-backed cache) addresses sharing properly.
 *
 *   - Cross-replica INVALIDATION, though, is load-bearing and is
 *     done. Every INSERT into `observation` fires
 *     `pg_notify('gg_observation_written', scope)` from a row
 *     trigger (migration 20260903150000). Each process that serves
 *     tiles holds one dedicated LISTEN connection and drops every
 *     cached tile for that scope the moment the write commits.
 *     Before this, an edit made through the map builder stayed
 *     invisible for up to the TTL: the client bumped its `?refresh`
 *     serial, the server ignored the unknown query param, and the
 *     cache handed back the pre-edit tile. A deleted feature that
 *     stays on the map for a minute reads as "delete does not work".
 *     The listener starts lazily on the first tile compute, so the
 *     worker processes, which never serve tiles, never open the
 *     connection.
 *
 *   - ETag generation belongs here: the cache key determines
 *     content identity, so the cache is the right place to mint
 *     a stable ETag. Controllers pass back `If-None-Match`,
 *     this service decides 304 vs 200.
 */
export const OBSERVATION_WRITTEN_CHANNEL = 'gg_observation_written';

@Injectable()
export class TileCacheService implements OnModuleDestroy {
  private readonly log = new Logger(TileCacheService.name);
  /** Defaults sized for a 1 GB-RSS portal-api container. 200 MB
   *  cache is enough headroom for thousands of small tiles and
   *  hundreds of the worst-case 1-2 MB tiles without crowding
   *  the rest of the process. Override via env on memory-tight
   *  deployments. */
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  /** Hard ceiling on the number of distinct compute operations
   *  that can be in flight at the same time. Different from the
   *  in-flight de-dup map's size: this counts the LEADERS only
   *  (computes actually issuing a Postgres query). The de-dup
   *  saves us from N callers all running the same query; this
   *  cap saves us from N hot tiles each running ONE query and
   *  collectively draining the Prisma pool.
   *
   *  The Prisma pool is 25 per replica by default (`DB_POOL_MAX` in
   *  prisma.service.ts; it was 9 when this cap was chosen, memory:
   *  `project_gratisgis_ogc_tiles_pool_storm_2026_05_21`). 8 keeps
   *  tile computes to a third of it so item reads, auth upserts and
   *  writes are never queued behind a pan. */
  private readonly maxConcurrentComputes: number;

  /** Wall-clock cap on a single compute callback. The DB's
   *  statement_timeout is 30s; this is a few seconds past that
   *  so a legitimate-but-slow query can still finish, while a
   *  truly hung promise (driver bug, dead connection the client
   *  didn't notice) cannot pin an activeComputes slot forever.
   *  Without this safety net, observed once post-Prisma-7
   *  driver-adapter migration: enough hung slots accumulated to
   *  permanently saturate the cap, and every subsequent tile
   *  request 503'd until a manual portal-api restart. */
  private readonly computeTimeoutMs: number;

  /** Map insertion order is LRU order in V8: we delete + re-set
   *  on hit to move the entry to the most-recently-used end. */
  private readonly entries = new Map<string, CacheEntry>();
  private currentBytes = 0;

  /** In-flight computes keyed by cache key. When a tile request
   *  arrives while the same key is being computed for another
   *  caller, both await the same Promise instead of issuing two
   *  Postgres queries. Cleared in `finally` so a failed compute
   *  doesn't poison the slot. The entry also counts who is still
   *  waiting for the answer, so a queued compute whose every caller
   *  has hung up can be withdrawn from its lane (see `awaitEntry`). */
  private readonly inFlight = new Map<string, InFlightEntry>();

  /** Lightweight counters surfaced through getStats() for the
   *  perf-dashboard workstream when it lands. */
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private coalesced = 0;
  private rejectedOverload = 0;
  private abandoned = 0;
  private activeComputes = 0;
  private invalidations = 0;

  /**
   * Which invalidation each key prefix (`<scope>|`) last saw, as a
   * position in a monotonic sequence rather than a timestamp, so two
   * events in the same millisecond still order. A compute that
   * STARTED before the invalidation read the pre-write state, and its
   * result must not be stored even though it finishes after the drop;
   * without this a write landing mid-compute would be cached over for
   * a full TTL.
   */
  private invalidationSeq = 0;
  private readonly invalidatedAtSeq = new Map<string, number>();
  /**
   * Sequence position of the last `clear()`. A compute that straddles
   * a clear read state of unknown freshness relative to whatever
   * prompted the clear (the listener coming up, an operator reset),
   * so it is served but not stored, the same as a mid-compute write.
   */
  private clearedAtSeq = 0;

  /**
   * Keys that must ALSO drop when some other prefix is invalidated.
   * A via aggregate is keyed under the child scope but its answer
   * depends on the parent scope's rows too; a write to the parent
   * would otherwise leave it stale for a TTL.
   *
   * `dependencyPrefixes` is the reverse index (key to the prefixes it
   * registered under) so that evicting, expiring or clearing a key
   * removes it from every set it sits in. Without it the sets only
   * ever grew: an aggregate that was evicted for space stayed listed
   * under its parent until that parent was next written.
   */
  private readonly dependents = new Map<string, Set<string>>();
  private readonly dependencyPrefixes = new Map<string, Set<string>>();

  /**
   * Named concurrency lanes for computes that should WAIT when the
   * lane is full instead of failing. Tiles fail fast (a 503 with
   * Retry-After is fine for a map that will ask again on the next
   * pan); a dashboard widget has one shot, and 43 aggregate queries
   * in flight at once is exactly what pushed the last ones past the
   * 30 s statement timeout on the demo.
   *
   * The queue is bounded too (`lane.maxQueued`). Unbounded, a pan
   * storm queued about 40 s of aggregate work that nobody was still
   * waiting for by the time it ran; past the bound the lane fails
   * fast like a tile does, and a waiter whose callers have all hung
   * up is withdrawn before it ever reaches Postgres.
   */
  private readonly lanes = new Map<string, Lane>();

  /** Dedicated LISTEN connection; null until the first compute. */
  private listener: PgClient | null = null;
  private listenerStarting = false;
  private listenerStopped = false;
  private listenerRetryMs = 1_000;

  constructor() {
    this.maxBytes = parseIntEnv('TILE_CACHE_MAX_BYTES', 200 * 1024 * 1024);
    this.maxEntries = parseIntEnv('TILE_CACHE_MAX_ENTRIES', 50_000);
    this.ttlMs = parseIntEnv('TILE_CACHE_TTL_MS', 60_000);
    this.maxConcurrentComputes = parseIntEnv(
      'TILE_CACHE_MAX_CONCURRENT',
      8,
    );
    this.computeTimeoutMs = parseIntEnv(
      'TILE_CACHE_COMPUTE_TIMEOUT_MS',
      35_000,
    );
  }

  /**
   * Look up a cached tile. Returns null on miss, expiry, or
   * empty key. Promotes the entry to MRU on hit.
   */
  get(key: string): CacheHit | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.dropEntry(key);
      this.misses += 1;
      return null;
    }
    // Promote: delete + re-set moves the entry to the most-recent
    // end of the map's insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { buf: entry.buf, etag: entry.etag };
  }

  /**
   * Store a tile in the cache. Replaces any prior entry for the
   * same key and adjusts the byte counter. Evicts oldest entries
   * until both byte and count budgets are satisfied.
   *
   * Returns the ETag for the stored entry so the caller can set
   * the response header from the same value.
   */
  set(key: string, buf: Buffer, ttlMs: number = this.ttlMs): string {
    const prior = this.entries.get(key);
    if (prior !== undefined) {
      // Replace bytes only; a dependency the caller registered for
      // this key before storing it must survive the store.
      this.currentBytes -= prior.buf.length;
      this.entries.delete(key);
    }
    const etag = computeEtag(key, buf);
    this.entries.set(key, {
      buf,
      etag,
      expiresAt: Date.now() + ttlMs,
    });
    this.currentBytes += buf.length;

    // Evict from the LRU end (Map iterator order = insertion
    // order = LRU when we move-to-end on hit).
    while (
      (this.currentBytes > this.maxBytes ||
        this.entries.size > this.maxEntries) &&
      this.entries.size > 0
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      if (!this.dropEntry(oldestKey)) break;
      this.evictions += 1;
    }

    return etag;
  }

  /**
   * Remove one entry and every dependency registration that points at
   * it. The single exit for a key, whatever the reason (eviction,
   * expiry, invalidation), so the dependents index cannot outlive the
   * entries it describes. Returns false when the key was not stored.
   */
  private dropEntry(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.currentBytes -= entry.buf.length;
    this.entries.delete(key);
    this.unregisterDependencies(key);
    return true;
  }

  private unregisterDependencies(key: string): void {
    const prefixes = this.dependencyPrefixes.get(key);
    if (!prefixes) return;
    this.dependencyPrefixes.delete(key);
    for (const prefix of prefixes) {
      const set = this.dependents.get(prefix);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.dependents.delete(prefix);
    }
  }

  /**
   * Cache-aware single-flight wrapper. Three states:
   *
   *   - HIT: stored entry is fresh -> return it directly, no
   *     compute, no Postgres traffic.
   *   - JOINING: another caller is currently computing this
   *     key -> await their Promise instead of starting a second
   *     compute. This is the load-shedding move that stops the
   *     pool-storm pattern (memory:
   *     `project_gratisgis_ogc_tiles_pool_storm_2026_05_21`).
   *   - MISS: nobody has it -> we run `compute`, store the
   *     result, and return.
   *
   * The compute callback is responsible for the actual work
   * (PostGIS query, ST_AsMVT, byte assembly). This wrapper
   * orchestrates the cache + de-dup around it.
   *
   * If `compute` throws, the in-flight slot is cleared so the
   * NEXT caller can retry rather than awaiting a dead Promise.
   *
   * `opts.signal` is the caller's HTTP request, in effect. A caller
   * whose signal aborts stops waiting and gets `TileCacheAbortedError`;
   * the compute itself is withdrawn only if it is still queued in a
   * lane AND nobody else is waiting for it. A compute that has already
   * started, or that other callers coalesced onto, runs to completion
   * and is stored: the work is sunk and the next request wants it.
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<Buffer>,
    opts: {
      /** Entry lifetime; defaults to the tile TTL. */
      ttlMs?: number;
      /**
       * Other key prefixes whose invalidation must drop this entry
       * too (a via aggregate's parent scope).
       */
      dependsOn?: readonly string[];
      /**
       * Wait in a named lane instead of failing when too many
       * computes are running. Each lane has its own limit; omit it
       * to use the tile behaviour (fail fast with an overload error).
       * `maxQueued` bounds the lane's waiting list; past it the call
       * fails fast with `TileCacheOverloadError` like a tile does.
       */
      lane?: { name: string; limit: number; maxQueued?: number };
      /**
       * Run outside both the tile cap and any lane. For a small
       * compute that is a prerequisite of another compute which
       * ALREADY holds a slot (the via key resolution inside a laned
       * aggregate or a capped tile): counting it again would make a
       * held slot wait on a free slot, which under load is a
       * deadlock in a lane and a spurious 503 under the tile cap.
       * The caller's own slot is what bounds this work.
       */
      exemptFromCap?: boolean;
      /** Stop waiting when this aborts; see the docblock. */
      signal?: AbortSignal;
    } = {},
  ): Promise<CacheHit> {
    // Phase 1: cache hit.
    const cached = this.get(key);
    if (cached !== null) return cached;

    // Phase 2: in-flight. Someone else is already computing
    // this key; join their promise.
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      this.coalesced += 1;
      return this.awaitEntry(pending, opts.signal);
    }

    // A caller that has already hung up must not become a leader:
    // the compute would run for nobody and the answer would be stored
    // for a key nobody asked for.
    if (opts.signal?.aborted) throw new TileCacheAbortedError();

    // Phase 3: we're the leader. Cap the number of concurrent
    // leaders so we don't drain the Prisma pool when many
    // DIFFERENT tiles arrive at once (the in-flight map already
    // handles the same-tile case). Excess returns a typed
    // overload error so the controller can map it to 503 with
    // Retry-After, unless the caller asked for a lane, in which case
    // it queues, or declared itself exempt (see the option's doc).
    const lane = opts.lane;
    const counted = !lane && !opts.exemptFromCap;
    if (counted && this.activeComputes >= this.maxConcurrentComputes) {
      this.rejectedOverload += 1;
      throw new TileCacheOverloadError(
        this.activeComputes,
        this.maxConcurrentComputes,
      );
    }

    this.ensureListener();

    // Register the in-flight slot before awaiting so concurrent
    // callers see it. A laned compute takes its lane slot INSIDE the
    // promise, so joiners that arrive while it queues still coalesce
    // onto it instead of queueing their own copy.
    // A laned compute is bounded by its lane, not by the tile cap, so
    // queued aggregates never make the map's tiles 503.
    if (counted) this.activeComputes += 1;
    const seqAtStart = this.invalidationSeq;
    const entry: InFlightEntry = {
      promise: undefined as unknown as Promise<CacheHit>,
      waiting: 0,
      withdraw: null,
    };
    const promise: Promise<CacheHit> = (async () => {
      // Acquiring the lane is the only step that can be withdrawn
      // (see `awaitEntry`), and a withdrawn acquire never held a slot,
      // so it sits outside the try whose finally releases one.
      if (lane) await this.acquireLane(lane, entry);
      try {
        // Wall-clock timeout safety net. Without this, a Prisma
        // query that never resolves AND never rejects (observed
        // once post-Prisma-7 driver-adapter migration: a hung
        // connection that the driver didn't surface as an error)
        // would pin the activeComputes slot forever. After enough
        // hung slots accumulate, the cap saturates permanently and
        // every subsequent tile request 503s. The DB's
        // statement_timeout is 30s, so this 35s ceiling is a few
        // seconds past the longest legitimate compute and far
        // shorter than "forever". On timeout we throw so the
        // finally below decrements the counter; the caller maps
        // the rejection to a 503 just like any other compute
        // failure.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const buf = await Promise.race<Buffer>([
          compute(),
          new Promise<Buffer>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `tile compute exceeded ${this.computeTimeoutMs}ms`,
                  ),
                ),
              this.computeTimeoutMs,
            );
          }),
        ]).finally(() => {
          // A finished compute must not leave its timer pending: it
          // held the process open for 35 s after every tile in tests.
          if (timer) clearTimeout(timer);
        });
        // A write to this scope, or to any scope this entry depends
        // on, landed while we were computing: serve the bytes, but do
        // not cache what may already be stale. The next request
        // recomputes. Checking the parents here matters because the
        // dependency is not registered until the store below, so an
        // `invalidatePrefix(parent)` during the compute had nothing
        // to drop.
        if (this.invalidatedSince(seqAtStart, key, opts.dependsOn)) {
          return { buf, etag: computeEtag(key, buf) };
        }
        // Register before storing, not after: nothing yields between
        // the two, but a store that evicts this very key (a buffer
        // larger than the byte cap) prunes the registration on the
        // way out, whereas registering afterwards would leave a
        // dependent with no entry behind it.
        for (const dep of opts.dependsOn ?? []) this.registerDependency(dep, key);
        const etag = this.set(key, buf, opts.ttlMs);
        return { buf, etag };
      } finally {
        if (lane) this.releaseLane(lane.name);
        else if (counted) this.activeComputes -= 1;
      }
    })().finally(() => {
      this.inFlight.delete(key);
    });
    entry.promise = promise;
    this.inFlight.set(key, entry);
    return this.awaitEntry(entry, opts.signal);
  }

  /**
   * Wait for an in-flight compute on behalf of one caller. Without a
   * signal this is the bare promise. With one, the caller stops
   * waiting the moment it aborts and gets `TileCacheAbortedError`;
   * and if it was the last caller still waiting on a compute that has
   * not yet left its lane queue, the compute is withdrawn, because
   * running it would only warm the cache for a request nobody made.
   *
   * Callers without a signal are counted as waiting forever, so a
   * signal-less joiner keeps an abandoned leader's compute alive.
   */
  private async awaitEntry(
    entry: InFlightEntry,
    signal: AbortSignal | undefined,
  ): Promise<CacheHit> {
    entry.waiting += 1;
    if (!signal) return entry.promise;
    if (signal.aborted) {
      this.leave(entry);
      throw new TileCacheAbortedError();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new TileCacheAbortedError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([entry.promise, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      this.leave(entry);
    }
  }

  private leave(entry: InFlightEntry): void {
    entry.waiting -= 1;
    if (entry.waiting === 0 && entry.withdraw) {
      this.abandoned += 1;
      // The rejection this produces has no listener left by
      // definition; swallow it so it does not surface as an unhandled
      // rejection for a request that already went away.
      entry.promise.catch(() => {});
      entry.withdraw();
    }
  }

  /**
   * Drop every entry whose key starts with `prefix`. The mvtTile
   * builder composes keys as `<scope>|<z>/<x>/<y>|<optsHash>` so
   * passing `<scope>|` invalidates every cached tile for a
   * particular data_layer sublayer at once. Use after a write
   * lands and the next reader should see fresh state.
   */
  invalidatePrefix(prefix: string): number {
    this.invalidationSeq += 1;
    this.invalidatedAtSeq.set(prefix, this.invalidationSeq);
    this.invalidations += 1;
    let dropped = 0;
    // Deleting from a Map while iterating its keys is defined
    // behaviour in JS (the iterator skips deleted entries).
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix) && this.dropEntry(key)) dropped += 1;
    }
    const dependents = this.dependents.get(prefix);
    if (dependents) {
      // Copy first: dropEntry mutates this set through the reverse index.
      for (const key of [...dependents]) {
        if (this.dropEntry(key)) dropped += 1;
      }
      // Whatever is left registered a dependency but was never stored
      // (or was stored and replaced by a plain set()); its promise to
      // drop has been kept, so forget it.
      this.dependents.delete(prefix);
      for (const key of dependents) {
        const prefixes = this.dependencyPrefixes.get(key);
        if (!prefixes) continue;
        prefixes.delete(prefix);
        if (prefixes.size === 0) this.dependencyPrefixes.delete(key);
      }
    }
    return dropped;
  }

  /**
   * Whether `key`'s own prefix, any prefix in `dependsOn`, or a full
   * clear was invalidated after sequence position `since`.
   */
  private invalidatedSince(
    since: number,
    key: string,
    dependsOn: readonly string[] | undefined,
  ): boolean {
    if (this.clearedAtSeq > since) return true;
    const own = key.slice(0, key.indexOf('|') + 1);
    if ((this.invalidatedAtSeq.get(own) ?? 0) > since) return true;
    for (const dep of dependsOn ?? []) {
      if ((this.invalidatedAtSeq.get(dep) ?? 0) > since) return true;
    }
    return false;
  }

  /** Make `key` drop whenever `prefix` is invalidated. */
  registerDependency(prefix: string, key: string): void {
    let set = this.dependents.get(prefix);
    if (!set) {
      set = new Set();
      this.dependents.set(prefix, set);
    }
    set.add(key);
    let prefixes = this.dependencyPrefixes.get(key);
    if (!prefixes) {
      prefixes = new Set();
      this.dependencyPrefixes.set(key, prefixes);
    }
    prefixes.add(prefix);
  }

  /**
   * Number of stored keys registered to drop when `prefix` is
   * invalidated. Exposed for the spec, which needs to see that
   * eviction, expiry and clear prune the index; production code has
   * no reason to call it.
   */
  dependentCount(prefix: string): number {
    return this.dependents.get(prefix)?.size ?? 0;
  }

  /**
   * Take a slot in a lane, waiting in FIFO order when it is full.
   * Throws `TileCacheOverloadError` synchronously (inside the caller's
   * async wrapper, so it surfaces as a rejection) when the waiting
   * list is already at `maxQueued`. While queued, `entry.withdraw`
   * removes the waiter and rejects with `TileCacheAbortedError`; it is
   * cleared the moment the waiter is granted a slot, so a compute that
   * has started can no longer be withdrawn.
   */
  private acquireLane(
    spec: { name: string; limit: number; maxQueued?: number },
    entry: InFlightEntry,
  ): Promise<void> {
    let lane = this.lanes.get(spec.name);
    if (!lane) {
      lane = { limit: spec.limit, maxQueued: Infinity, active: 0, waiters: [] };
      this.lanes.set(spec.name, lane);
    }
    lane.limit = spec.limit;
    lane.maxQueued = spec.maxQueued ?? Infinity;
    if (lane.active < lane.limit) {
      lane.active += 1;
      return Promise.resolve();
    }
    if (lane.waiters.length >= lane.maxQueued) {
      this.rejectedOverload += 1;
      throw new TileCacheOverloadError(
        lane.active + lane.waiters.length,
        lane.limit + lane.maxQueued,
        `lane "${spec.name}" running plus queued`,
      );
    }
    const held = lane;
    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        entry.withdraw = null;
        held.active += 1;
        resolve();
      };
      held.waiters.push(waiter);
      entry.withdraw = () => {
        const at = held.waiters.indexOf(waiter);
        if (at >= 0) held.waiters.splice(at, 1);
        entry.withdraw = null;
        reject(new TileCacheAbortedError());
      };
    });
  }

  private releaseLane(name: string): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    lane.active -= 1;
    const next = lane.waiters.shift();
    if (next) next();
  }

  /**
   * Drop the entire cache. Useful for tests and ops-driven
   * cache reset. Cheap; the references go to the GC.
   */
  clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
    this.dependents.clear();
    this.dependencyPrefixes.clear();
    // The per-prefix record exists only to judge computes that were
    // in flight when a prefix dropped; with nothing stored it is dead
    // weight, and it would otherwise grow by one entry per distinct
    // scope ever written for the life of the process. The clear
    // itself takes a sequence position so those in-flight computes
    // still refuse to store.
    this.invalidatedAtSeq.clear();
    this.invalidationSeq += 1;
    this.clearedAtSeq = this.invalidationSeq;
  }

  /**
   * Handle one write notification. Exposed so the spec can drive it
   * without a database; production calls arrive from the LISTEN
   * connection. The payload is the observation scope
   * (`data_layer:<itemId>:<layerId>`), which is exactly the key
   * prefix the tile builder uses.
   */
  onObservationWritten(scope: string): number {
    if (!scope) return 0;
    return this.invalidatePrefix(`${scope}|`);
  }

  /**
   * Open the LISTEN connection once, on the first tile compute.
   * Failure is logged and retried with backoff; while the listener
   * is down the cache degrades to TTL-only staleness, which is what
   * it was before the listener existed. Never throws into the tile
   * path.
   */
  private ensureListener(): void {
    if (this.listener || this.listenerStarting || this.listenerStopped) return;
    const url = process.env.DATABASE_URL;
    if (!url) return;
    this.listenerStarting = true;
    const client = new PgClient({ connectionString: url });
    client.on('notification', (msg) => {
      if (msg.channel !== OBSERVATION_WRITTEN_CHANNEL) return;
      this.onObservationWritten(msg.payload ?? '');
    });
    const restart = (why: string) => {
      if (this.listener === client) this.listener = null;
      client.removeAllListeners();
      void client.end().catch(() => {});
      if (this.listenerStopped) return;
      this.log.warn(
        `tile invalidation listener ${why}; retrying in ${this.listenerRetryMs}ms`,
      );
      setTimeout(() => {
        this.listenerStarting = false;
        this.ensureListener();
      }, this.listenerRetryMs).unref();
      this.listenerRetryMs = Math.min(this.listenerRetryMs * 2, 30_000);
    };
    client.on('error', (err) => restart(`errored (${err.message})`));
    client.on('end', () => restart('closed'));
    void client
      .connect()
      .then(() => client.query(`LISTEN ${OBSERVATION_WRITTEN_CHANNEL}`))
      .then(() => {
        this.listener = client;
        this.listenerStarting = false;
        this.listenerRetryMs = 1_000;
        // Anything cached before the listener was up may already be
        // stale; start clean rather than trust it.
        this.clear();
        this.log.log(`listening on ${OBSERVATION_WRITTEN_CHANNEL} for tile invalidation`);
      })
      .catch((err: unknown) => {
        restart(`failed to connect (${err instanceof Error ? err.message : String(err)})`);
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.listenerStopped = true;
    const client = this.listener;
    this.listener = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => {});
    }
  }

  /**
   * Snapshot of cache vitals, hooked into the perf dashboard
   * workstream when it lands. Cheap; safe to call frequently.
   */
  getStats(): TileCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.currentBytes,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      coalesced: this.coalesced,
      rejectedOverload: this.rejectedOverload,
      abandoned: this.abandoned,
      invalidations: this.invalidations,
      listening: this.listener !== null,
      inFlight: this.inFlight.size,
      activeComputes: this.activeComputes,
      maxConcurrentComputes: this.maxConcurrentComputes,
      hitRate:
        this.hits + this.misses > 0
          ? this.hits / (this.hits + this.misses)
          : 0,
    };
  }
}

/**
 * Compose the cache key for a tile. Centralized so cache reads
 * and writes use exactly the same shape and a future revision
 * (multi-CRS tile matrices, different MVT extents) has one
 * place to grow.
 */
export function tileCacheKey(args: {
  scope: string;
  z: number;
  x: number;
  y: number;
  optsFingerprint: string;
}): string {
  return `${args.scope}|${args.z}/${args.x}/${args.y}|${args.optsFingerprint}`;
}

/**
 * Compose the cache key for an aggregate result: the whole request,
 * hashed, under the layer's scope prefix so a write to the layer drops
 * it along with the layer's tiles. `request` is hashed through
 * `stableJson`, so callers may pass it in any key order and with
 * optional fields left undefined. What the request contains (how
 * `asOf` is keyed, for one) is the caller's business; see
 * `DataLayerEngine.aggregateFeatures`.
 */
export function aggregateCacheKey(scope: string, request: unknown): string {
  const hash = createHash('sha256')
    .update(stableJson(request))
    .digest('base64url')
    .slice(0, 32);
  return `${scope}|agg|${hash}`;
}

/**
 * Compose the cache key for a relate's resolved parent key set: the
 * parent field, the parent's compiled content predicates and the asOf
 * bucket, hashed, under the PARENT scope's prefix. Living under the
 * parent prefix is what makes a parent write drop it: `invalidatePrefix`
 * matches by prefix and the mid-compute check reads the key's own
 * prefix, so no separate dependency registration is needed.
 */
export function viaKeysCacheKey(parentScope: string, request: unknown): string {
  const hash = createHash('sha256')
    .update(stableJson(request))
    .digest('base64url')
    .slice(0, 32);
  return `${parentScope}|viakeys|${hash}`;
}

/**
 * Keys that are already part of the cache key by other means, and so
 * must not also feed the fingerprint. Everything else in the options
 * object does, whether or not this file has heard of it.
 */
const FINGERPRINT_IGNORED = new Set(['itemId', 'layerId', 'z', 'x', 'y']);

/**
 * Compute a stable fingerprint over the per-tile options that change
 * output bytes. Used as part of the cache key so a request with
 * different options stores under a separate slot.
 *
 * **This hashes every option it is given, not a hand written list.**
 * The list version was a cache-poisoning bug waiting for its third
 * option: adding an argument that changes the bytes, and forgetting
 * to add it here, means two different tiles share one slot and the
 * first request to arrive decides what everyone sees. TypeScript
 * cannot catch that, and the failure is invisible, because a wrong
 * tile still renders. Hashing by default inverts it: a new option
 * costs at worst a cache miss, never a wrong answer.
 *
 * `ownRowsOnly` carries a user id and therefore PARTITIONS the cache
 * per viewer. That is deliberate and it is load-bearing: a row-scoped
 * viewer and an unscoped one must never share a slot, or the first
 * unscoped request to warm a tile would serve every row to the scoped
 * viewer afterwards. Only row-scoped shares pay the extra slots; the
 * common unscoped tile keeps the empty fingerprint and one shared
 * entry. `where` and `via` partition it the same way and for the same
 * reason.
 */
export function optsFingerprint(opts: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(opts).sort()) {
    if (FINGERPRINT_IGNORED.has(key)) continue;
    const value = opts[key];
    // An absent option and an option explicitly set to its default
    // have to fingerprint alike, or every caller that spreads
    // `{ ...maybeUndefined }` fragments the cache for nothing.
    if (value === undefined || value === null || value === false) continue;
    if (key === 'fields' && Array.isArray(value)) {
      // Sort fields by name so caller order does not fragment the
      // cache. The portal always emits field arrays in schema order
      // today, but a renderer that reshuffles them should not lose
      // the cache hit.
      const fields = (value as ReadonlyArray<{ name: string; type?: string }>)
        .map((f) => `${f.name}:${f.type ?? ''}`)
        .sort()
        .join(',');
      if (fields !== '') parts.push(`fields=${fields}`);
      continue;
    }
    parts.push(`${key}=${stableJson(value)}`);
  }
  // Short-circuit the all-empty case so the cache key for a bare
  // /items/.../tile request stays human-readable in logs.
  if (parts.length === 0) return '';
  return createHash('sha1')
    .update(parts.join('|'))
    .digest('base64url')
    .slice(0, 16);
}

interface CacheEntry {
  buf: Buffer;
  etag: string;
  expiresAt: number;
}

export interface CacheHit {
  buf: Buffer;
  etag: string;
}

/** One compute in progress, plus who is still waiting for it. */
interface InFlightEntry {
  promise: Promise<CacheHit>;
  /** Callers awaiting the promise; signal-less ones never leave. */
  waiting: number;
  /** Set only while the compute is queued in a lane. */
  withdraw: (() => void) | null;
}

interface Lane {
  limit: number;
  maxQueued: number;
  active: number;
  waiters: Array<() => void>;
}

/**
 * Thrown by `TileCacheService.getOrCompute()` when the
 * concurrency cap is exceeded, or when a lane's waiting list is
 * full. Controllers should catch this specifically and map to HTTP
 * 503 with a `Retry-After` header, not 500. Carries the active/cap
 * counts so the response or log line can explain the reject.
 */
export class TileCacheOverloadError extends Error {
  constructor(
    readonly active: number,
    readonly cap: number,
    what = 'concurrent computes',
  ) {
    super(`Tile cache at capacity: ${active}/${cap} ${what}`);
    this.name = 'TileCacheOverloadError';
  }
}

/**
 * Thrown to a `getOrCompute()` caller whose `signal` aborted before
 * its answer arrived. The client is gone: controllers should end the
 * response quietly rather than log or map it to a status. Never
 * reaches a caller that did not pass a signal.
 */
export class TileCacheAbortedError extends Error {
  constructor() {
    super('Tile cache caller aborted before the compute finished');
    this.name = 'TileCacheAbortedError';
  }
}

export interface TileCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  maxEntries: number;
  ttlMs: number;
  hits: number;
  misses: number;
  evictions: number;
  /** Times a concurrent request awaited another caller's
   *  in-flight compute instead of starting its own. The bigger
   *  this gets relative to `misses`, the more work the cache
   *  is saving by de-duplicating tile-storm traffic. */
  coalesced: number;
  /** Times getOrCompute() rejected a new compute because the
   *  concurrency cap was at saturation or a lane's queue was full.
   *  Maps to HTTP 503s emitted to clients. */
  rejectedOverload: number;
  /** Times a queued compute was withdrawn from its lane because
   *  every caller waiting for it had aborted. Work Postgres never
   *  saw. */
  abandoned: number;
  /** Times a write notification (or a manual call) dropped every
   *  cached tile for a scope. */
  invalidations: number;
  /** Whether the LISTEN connection that drives invalidation is up.
   *  False in a process that has never served a tile, and while a
   *  dropped connection is being retried. */
  listening: boolean;
  /** Current number of in-flight compute slots. */
  inFlight: number;
  /** Number of leaders actively running a compute (subset of
   *  inFlight that aren't coalesced followers). */
  activeComputes: number;
  /** Configured concurrency ceiling. */
  maxConcurrentComputes: number;
  hitRate: number;
}

/**
 * Strong ETag form: `"<sha1-16>"`. Derived from the cache key +
 * a short hash of the buffer so two tiles that happen to share a
 * key (shouldn't, but defensive) still produce different ETags.
 */
function computeEtag(key: string, buf: Buffer): string {
  const hash = createHash('sha1');
  hash.update(key);
  hash.update(buf);
  return `"${hash.digest('base64url').slice(0, 16)}"`;
}

/**
 * JSON.stringify isn't stable across key orderings; round-trip
 * through sorted keys so `{a:1,b:2}` and `{b:2,a:1}` produce the
 * same fingerprint.
 *
 * Follows JSON.stringify on the two things it does with `undefined`:
 * a key whose value is undefined is omitted, so `{ a: 1, b: undefined }`
 * and `{ a: 1 }` hash alike (callers spread optional request fields
 * and must not fragment the cache for it), and a bare undefined (or
 * a function) becomes `null` rather than the text "undefined", which
 * is not JSON. Shared by the tile fingerprint and the aggregate cache
 * key; it used to exist twice with those two behaviours differing.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableJson(v)).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableJson(record[k]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Format a `Retry-After` value (seconds) appropriate for an
 * overload reject. Short fixed value: we just want the client
 * to back off momentarily; the next request will likely hit a
 * freed compute slot. Centralized so all three tile controllers
 * agree on the value.
 */
export function tileOverloadRetryAfterSeconds(): number {
  return 2;
}

/**
 * RFC 7232 `If-None-Match` matcher. Returns true iff the request
 * header's list of ETag candidates contains either the server's
 * ETag or the wildcard ``*``. Tolerant of weak ETag prefixes
 * (``W/``) and the surrounding quoting that some HTTP libraries
 * strip when round-tripping.
 *
 * Pulled out of the cache class so every tile controller can use
 * the same matcher without re-implementing the parser.
 */
export function matchesIfNoneMatch(
  requestHeader: string | string[] | undefined,
  currentEtag: string,
): boolean {
  if (!requestHeader || !currentEtag) return false;
  const raw = Array.isArray(requestHeader)
    ? requestHeader.join(',')
    : requestHeader;
  const candidates = raw.split(',').map((s) => s.trim());
  const normalized = normalizeEtag(currentEtag);
  for (const c of candidates) {
    if (c === '*') return true;
    if (normalizeEtag(c) === normalized) return true;
  }
  return false;
}

function normalizeEtag(etag: string): string {
  let v = etag.trim();
  if (v.startsWith('W/')) v = v.slice(2);
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

