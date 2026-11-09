// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Background job queue numbers, read from the job tables at scrape
 * time. portal-worker and the script runner have no HTTP listener, and
 * their queues live in Postgres, so the API reads them from there
 * instead of opening a port on every worker.
 *
 * Every number is a count across the whole portal. The query groups by
 * job table and state only; no org, item, user or job id leaves it.
 */

export const JOB_TYPES = [
  'import',
  'ago_import',
  'analysis',
  'script',
  'offline_package',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface JobQueueSnapshot {
  /** Jobs waiting for a worker, per job type. */
  queued: Record<JobType, number>;
  /** Jobs a worker holds (running, building, importing, cancelling). */
  running: Record<JobType, number>;
  /** Age in seconds of the oldest queued job, 0 when none is queued. */
  oldestQueuedSeconds: Record<JobType, number>;
  /** Jobs that failed in the last FAILED_WINDOW_SECONDS. */
  failedRecent: Record<JobType, number>;
}

/** Matches the `interval '1 hour'` in JOB_QUEUE_SQL. */
export const FAILED_WINDOW_SECONDS = 3600;

/**
 * Active states per table. Anything listed that is not 'queued' counts
 * as running. Terminal states (done, succeeded, ready, failed,
 * cancelled, superseded) are not queue depth.
 *
 * The table and state names are constants in this file, never input.
 */
const JOB_QUEUE_SQL = `
WITH active AS (
  SELECT 'import'::text AS t, status::text AS s, created_at FROM import_job
   WHERE status IN ('queued', 'running')
  UNION ALL
  SELECT 'ago_import', status::text, created_at FROM ago_import_job
   WHERE status IN ('queued', 'running')
  UNION ALL
  SELECT 'analysis', state, created_at FROM analysis_job
   WHERE state IN ('queued', 'running', 'ingest', 'importing', 'cancel_requested')
  UNION ALL
  SELECT 'script', state, created_at FROM script_run
   WHERE state IN ('queued', 'running', 'cancel_requested')
  UNION ALL
  SELECT 'offline_package', status::text, created_at FROM offline_package
   WHERE status IN ('queued', 'building')
), failed AS (
  SELECT 'import'::text AS t FROM import_job
   WHERE status = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '1 hour'
  UNION ALL
  SELECT 'ago_import' FROM ago_import_job
   WHERE status = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '1 hour'
  UNION ALL
  SELECT 'analysis' FROM analysis_job
   WHERE state = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '1 hour'
  UNION ALL
  SELECT 'script' FROM script_run
   WHERE state = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '1 hour'
  UNION ALL
  SELECT 'offline_package' FROM offline_package
   WHERE status = 'failed' AND COALESCE(finished_at, created_at) > now() - interval '1 hour'
)
SELECT t, CASE WHEN s = 'queued' THEN 'queued' ELSE 'running' END AS bucket,
       count(*)::int AS n,
       COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS oldest
  FROM active GROUP BY 1, 2
UNION ALL
SELECT t, 'failed', count(*)::int, 0::float8 FROM failed GROUP BY 1
`;

interface Row {
  t: string;
  bucket: string;
  n: number;
  oldest: number;
}

function zeroes(): Record<JobType, number> {
  return Object.fromEntries(JOB_TYPES.map((t) => [t, 0])) as Record<
    JobType,
    number
  >;
}

export function emptySnapshot(): JobQueueSnapshot {
  return {
    queued: zeroes(),
    running: zeroes(),
    oldestQueuedSeconds: zeroes(),
    failedRecent: zeroes(),
  };
}

export function snapshotFromRows(rows: Row[]): JobQueueSnapshot {
  const snap = emptySnapshot();
  for (const row of rows) {
    if (!(JOB_TYPES as readonly string[]).includes(row.t)) continue;
    const t = row.t as JobType;
    const n = Number(row.n) || 0;
    if (row.bucket === 'queued') {
      snap.queued[t] += n;
      snap.oldestQueuedSeconds[t] = Math.max(0, Number(row.oldest) || 0);
    } else if (row.bucket === 'running') {
      snap.running[t] += n;
    } else if (row.bucket === 'failed') {
      snap.failedRecent[t] += n;
    }
  }
  return snap;
}

/**
 * Reads the snapshot at most once per `cacheMs`, with one query in
 * flight at a time, so a fast scrape interval or several scrapers do
 * not turn into a query storm. The query runs under a short statement
 * timeout; on failure the last good snapshot is kept and `lastError`
 * says so.
 */
export class JobMetricsReader {
  private readonly log = new Logger('JobMetrics');
  private cached: { at: number; snap: JobQueueSnapshot } | null = null;
  private inFlight: Promise<JobQueueSnapshot | null> | null = null;
  private lastErrorAt = 0;
  lastError = false;

  constructor(
    private readonly prisma: Pick<PrismaService, '$transaction' | '$executeRawUnsafe' | '$queryRawUnsafe'>,
    private readonly cacheMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<JobQueueSnapshot | null> {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) {
      return this.cached.snap;
    }
    if (!this.inFlight) {
      this.inFlight = this.query().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async query(): Promise<JobQueueSnapshot | null> {
    try {
      const [, rows] = await this.prisma.$transaction([
        this.prisma.$executeRawUnsafe('SET LOCAL statement_timeout = 2000'),
        this.prisma.$queryRawUnsafe<Row[]>(JOB_QUEUE_SQL),
      ]);
      const snap = snapshotFromRows(rows);
      this.cached = { at: this.now(), snap };
      this.lastError = false;
      return snap;
    } catch (err) {
      this.lastError = true;
      // One warning a minute at most; a scrape every 15 s would
      // otherwise fill the log while the database is down.
      if (this.now() - this.lastErrorAt > 60_000) {
        this.lastErrorAt = this.now();
        this.log.warn(
          `Job queue metrics query failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return this.cached?.snap ?? null;
    }
  }
}
