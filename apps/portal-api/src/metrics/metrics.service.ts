// SPDX-License-Identifier: AGPL-3.0-or-later
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from '@prometheus-io/client';

// A value import: Nest reads the constructor's parameter types at
// runtime to inject PrismaService, so `import type` would break DI.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService, type DbPoolStats } from '../prisma/prisma.service.js';
import { FAILED_WINDOW_SECONDS, JOB_TYPES, JobMetricsReader } from './job-metrics.js';

/**
 * What /metrics reads from the tile cache. A structural subset of
 * TileCacheService.getStats(), so this module depends on the counters
 * it reports and nothing else in that file. A new cache tier can add
 * fields to getStats() without touching this interface.
 */
export interface TileCacheCounters {
  hits: number;
  misses: number;
  evictions: number;
  coalesced: number;
  rejectedOverload: number;
  invalidations: number;
  entries: number;
  bytes: number;
  maxBytes: number;
  inFlight: number;
}

export interface TileCacheStatsSource {
  getStats(): TileCacheCounters;
}

export interface DbPoolStatsSource {
  poolStats(): DbPoolStats;
}

export const TILE_CACHE_STATS = Symbol('TILE_CACHE_STATS');
export const DB_POOL_STATS = Symbol('DB_POOL_STATS');

const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/**
 * Owns the Prometheus registry for one portal-api process.
 *
 * Nothing is registered and no collector runs until enable() is
 * called, which installMetrics() does only when METRICS_TOKEN is set.
 * An install without the token pays nothing: no event loop monitor,
 * no GC observer, no per-request timing.
 *
 * Label rule for everything here: fixed sets or route templates only.
 * No org, item, layer, user or job identifier is ever a label value.
 */
@Injectable()
export class MetricsService {
  private registry: Registry | null = null;
  private httpDuration: Histogram<'method' | 'route' | 'status_class'> | null =
    null;
  private tileRequests: Counter<'kind' | 'surface' | 'status_class'> | null =
    null;
  private readonly jobs: JobMetricsReader;

  constructor(
    prisma: PrismaService,
    @Optional() @Inject(TILE_CACHE_STATS)
    private readonly tileCache: TileCacheStatsSource | null,
    @Optional() @Inject(DB_POOL_STATS)
    private readonly dbPool: DbPoolStatsSource | null,
  ) {
    this.jobs = new JobMetricsReader(prisma);
  }

  get enabled(): boolean {
    return this.registry !== null;
  }

  enable(): void {
    if (this.registry) return;
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });

    this.httpDuration = new Histogram({
      name: 'gratisgis_http_request_duration_seconds',
      help: 'HTTP request duration by method, route template and status class. The _count series is the request count.',
      labelNames: ['method', 'route', 'status_class'],
      buckets: HTTP_BUCKETS,
      registers: [registry],
    });
    this.tileRequests = new Counter({
      name: 'gratisgis_tile_requests_total',
      help: 'Tile requests by tile kind (vector, raster), surface (public is /api/public, portal is everything else) and status class.',
      labelNames: ['kind', 'surface', 'status_class'],
      registers: [registry],
    });

    this.registerTileCache(registry);
    this.registerDbPool(registry);
    this.registerJobs(registry);
    this.registry = registry;
  }

  observeHttp(
    labels: { method: string; route: string; status_class: string },
    seconds: number,
  ): void {
    this.httpDuration?.observe(labels, seconds);
  }

  countTile(labels: {
    kind: string;
    surface: string;
    status_class: string;
  }): void {
    this.tileRequests?.inc(labels);
  }

  get contentType(): string {
    return this.registry?.contentType ?? 'text/plain';
  }

  async render(): Promise<string> {
    if (!this.registry) throw new Error('metrics are not enabled');
    return this.registry.metrics();
  }

  private registerTileCache(registry: Registry): void {
    const source = this.tileCache;
    if (!source) return;
    // The cache keeps its own monotonic counters; each scrape copies
    // them in. reset() then inc() is how this client sets a counter
    // to an externally owned total.
    const counter = (
      name: string,
      help: string,
      read: (s: TileCacheCounters) => number,
    ) =>
      new Counter({
        name,
        help,
        registers: [registry],
        collect() {
          this.reset();
          this.inc(Math.max(0, read(source.getStats())));
        },
      });
    const gauge = (
      name: string,
      help: string,
      read: (s: TileCacheCounters) => number,
    ) =>
      new Gauge({
        name,
        help,
        registers: [registry],
        collect() {
          this.set(read(source.getStats()));
        },
      });
    counter(
      'gratisgis_tile_cache_hits_total',
      'In-process tile and aggregate cache lookups that found a fresh entry.',
      (s) => s.hits,
    );
    counter(
      'gratisgis_tile_cache_misses_total',
      'In-process tile and aggregate cache lookups that found nothing fresh.',
      (s) => s.misses,
    );
    counter(
      'gratisgis_tile_cache_evictions_total',
      'Entries dropped to stay inside the byte or entry cap.',
      (s) => s.evictions,
    );
    counter(
      'gratisgis_tile_cache_coalesced_total',
      'Requests that waited on another request computing the same tile.',
      (s) => s.coalesced,
    );
    counter(
      'gratisgis_tile_cache_rejected_overload_total',
      'Computes refused because the concurrency cap or a lane queue was full (served as 503).',
      (s) => s.rejectedOverload,
    );
    counter(
      'gratisgis_tile_cache_invalidations_total',
      'Scope invalidations after a write.',
      (s) => s.invalidations,
    );
    gauge(
      'gratisgis_tile_cache_entries',
      'Entries held in the in-process tile cache.',
      (s) => s.entries,
    );
    gauge(
      'gratisgis_tile_cache_bytes',
      'Bytes held in the in-process tile cache.',
      (s) => s.bytes,
    );
    gauge(
      'gratisgis_tile_cache_max_bytes',
      'Configured byte cap of the in-process tile cache.',
      (s) => s.maxBytes,
    );
    gauge(
      'gratisgis_tile_cache_in_flight',
      'Tile computes in progress, leaders and waiting followers.',
      (s) => s.inFlight,
    );
  }

  private registerDbPool(registry: Registry): void {
    const source = this.dbPool;
    if (!source) return;
    new Gauge({
      name: 'gratisgis_db_pool_connections',
      help: 'Connections in the Prisma pool by state (in_use, idle).',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        const s = source.poolStats();
        this.set({ state: 'in_use' }, Math.max(0, s.total - s.idle));
        this.set({ state: 'idle' }, s.idle);
      },
    });
    new Gauge({
      name: 'gratisgis_db_pool_waiting',
      help: 'Queries waiting for a free connection in the Prisma pool.',
      registers: [registry],
      collect() {
        this.set(source.poolStats().waiting);
      },
    });
    new Gauge({
      name: 'gratisgis_db_pool_max',
      help: 'Configured size of the Prisma pool (DB_POOL_MAX).',
      registers: [registry],
      collect() {
        this.set(source.poolStats().max);
      },
    });
  }

  private registerJobs(registry: Registry): void {
    const jobs = this.jobs;
    // Read once per scrape and shared by the gauges below. The reader
    // caches for 15 s, so several gauges and several replicas do not
    // each run the query.
    let pending: Promise<Awaited<ReturnType<JobMetricsReader['read']>>> | null =
      null;
    const snapshot = () => {
      if (!pending) {
        pending = jobs.read().finally(() => {
          pending = null;
        });
      }
      return pending;
    };
    new Gauge({
      name: 'gratisgis_jobs',
      help: 'Background jobs by type and state (queued, running). Read from the database, so every replica reports the same portal-wide numbers.',
      labelNames: ['type', 'state'],
      registers: [registry],
      async collect() {
        const snap = await snapshot();
        if (!snap) return;
        for (const t of JOB_TYPES) {
          this.set({ type: t, state: 'queued' }, snap.queued[t]);
          this.set({ type: t, state: 'running' }, snap.running[t]);
        }
      },
    });
    new Gauge({
      name: 'gratisgis_jobs_oldest_queued_seconds',
      help: 'Age of the oldest queued job by type, 0 when nothing is queued.',
      labelNames: ['type'],
      registers: [registry],
      async collect() {
        const snap = await snapshot();
        if (!snap) return;
        for (const t of JOB_TYPES) {
          this.set({ type: t }, snap.oldestQueuedSeconds[t]);
        }
      },
    });
    new Gauge({
      name: 'gratisgis_jobs_failed_recent',
      help: `Jobs by type that failed in the last ${FAILED_WINDOW_SECONDS} seconds.`,
      labelNames: ['type'],
      registers: [registry],
      async collect() {
        const snap = await snapshot();
        if (!snap) return;
        for (const t of JOB_TYPES) {
          this.set({ type: t }, snap.failedRecent[t]);
        }
      },
    });
    new Gauge({
      name: 'gratisgis_jobs_query_error',
      help: '1 when the last job queue query failed (the job gauges then hold the last good values), else 0.',
      registers: [registry],
      async collect() {
        await snapshot();
        this.set(jobs.lastError ? 1 : 0);
      },
    });
  }
}
