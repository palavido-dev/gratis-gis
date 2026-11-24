// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prisma } from '@prisma/client';

import { isMultiTenant } from './tenancy.js';

/**
 * Which queued job a worker claims next.
 *
 * One organization: the oldest queued job, exactly the statement each
 * queue has always run.
 *
 * Many organizations: the organizations take turns. The next job comes
 * from the organization whose last job started longest ago (one that
 * has not started any in the last day goes first), and within it the
 * oldest. One organization that queues a hundred jobs then waits its
 * turn after each, instead of making everyone else wait for all of
 * them. Only jobs started in the last day are looked at, so the turn
 * order costs one pass over recent rows.
 *
 * Each statement selects the claimed row's `id` with
 * `FOR UPDATE SKIP LOCKED`, so it can stand alone in a transaction or
 * sit inside `UPDATE ... WHERE id = (...)`. The table names are fixed
 * here, never taken from input.
 */
export type JobQueue = 'import_job' | 'offline_package' | 'script_run' | 'search_index_build';

const ONE_ORG: Record<JobQueue, Prisma.Sql> = {
  import_job: Prisma.sql`
          SELECT id
          FROM import_job
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
  offline_package: Prisma.sql`
          SELECT id
          FROM offline_package
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
  script_run: Prisma.sql`
        SELECT id FROM script_run
        WHERE state = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
  search_index_build: Prisma.sql`
        SELECT id FROM search_index_build
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
};

const TAKING_TURNS: Record<JobQueue, Prisma.Sql> = {
  import_job: Prisma.sql`
    WITH last_start AS (
      SELECT org_id, max(started_at) AS at FROM import_job
      WHERE started_at > now() - interval '1 day'
      GROUP BY org_id
    )
    SELECT q.id FROM import_job q
    LEFT JOIN last_start l ON l.org_id = q.org_id
    WHERE q.status = 'queued'
    ORDER BY l.at ASC NULLS FIRST, q.created_at ASC
    LIMIT 1
    FOR UPDATE OF q SKIP LOCKED`,
  offline_package: Prisma.sql`
    WITH last_start AS (
      SELECT org_id, max(started_at) AS at FROM offline_package
      WHERE started_at > now() - interval '1 day'
      GROUP BY org_id
    )
    SELECT q.id FROM offline_package q
    LEFT JOIN last_start l ON l.org_id = q.org_id
    WHERE q.status = 'queued'
    ORDER BY l.at ASC NULLS FIRST, q.created_at ASC
    LIMIT 1
    FOR UPDATE OF q SKIP LOCKED`,
  script_run: Prisma.sql`
    WITH last_start AS (
      SELECT org_id, max(started_at) AS at FROM script_run
      WHERE started_at > now() - interval '1 day'
      GROUP BY org_id
    )
    SELECT q.id FROM script_run q
    LEFT JOIN last_start l ON l.org_id = q.org_id
    WHERE q.state = 'queued'
    ORDER BY l.at ASC NULLS FIRST, q.created_at ASC
    LIMIT 1
    FOR UPDATE OF q SKIP LOCKED`,
  search_index_build: Prisma.sql`
    WITH last_start AS (
      SELECT org_id, max(started_at) AS at FROM search_index_build
      WHERE started_at > now() - interval '1 day'
      GROUP BY org_id
    )
    SELECT q.id FROM search_index_build q
    LEFT JOIN last_start l ON l.org_id = q.org_id
    WHERE q.status = 'queued'
    ORDER BY l.at ASC NULLS FIRST, q.created_at ASC
    LIMIT 1
    FOR UPDATE OF q SKIP LOCKED`,
};

/** The statement that picks the next job of `queue` (see above). */
export function nextQueuedJobSql(queue: JobQueue): Prisma.Sql {
  return isMultiTenant() ? TAKING_TURNS[queue] : ONE_ORG[queue];
}
