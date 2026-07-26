// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ImportJob, ImportJobStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Persistence + lifecycle helpers for ImportJob rows (#115).
 *
 * Two clienteles use this service:
 *
 * 1. The HTTP controller, which speaks to humans / wizard. Creates
 *    queued rows, lists active rows for a detail-page banner, and
 *    accepts cancel requests.
 *
 * 2. The in-process worker, which drains queued rows in a loop.
 *    Calls claimNext() to atomically transition queued -> running
 *    (using SELECT ... FOR UPDATE SKIP LOCKED), then bumps progress
 *    counters and the heartbeat as it works, then markSucceeded /
 *    markFailed at the end.
 *
 * The split is enforced by convention rather than separate
 * interfaces: any caller can use any method, but in practice the
 * controller doesn't claim or finish jobs, and the worker doesn't
 * care about org-scoped visibility.
 */
@Injectable()
export class ImportJobsService {
  private readonly log = new Logger(ImportJobsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Enqueue a new ingest job. Worker will pick it up on the next poll. */
  async enqueue(input: {
    itemId: string;
    layerId: string;
    stagingId: string;
    sourceFileName: string;
    sourceLayerName: string;
    mode: 'replace' | 'append';
    totalFeatures: number | null;
    userId: string;
    orgId: string;
  }): Promise<ImportJob> {
    return this.prisma.importJob.create({
      data: {
        itemId: input.itemId,
        layerId: input.layerId,
        stagingId: input.stagingId,
        sourceFileName: input.sourceFileName,
        sourceLayerName: input.sourceLayerName,
        mode: input.mode,
        createdBy: input.userId,
        orgId: input.orgId,
        totalFeatures: input.totalFeatures,
        status: 'queued',
      },
    });
  }

  /**
   * The detail-page banner reads from here. Returns running + queued
   * jobs the user is allowed to see (their org). Excludes terminal
   * states: a finished job no longer earns a banner. Caller is
   * responsible for deciding which to surface (a queued job behind
   * a running one is interesting; a queued job alone might be
   * shown as "queued").
   */
  async listActiveForItem(
    user: AuthUser,
    itemId: string,
  ): Promise<ImportJob[]> {
    return this.prisma.importJob.findMany({
      where: {
        orgId: user.orgId,
        itemId,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Single-job lookup. Org-scoped so a leaked id in the URL bar
   *  can't leak data across orgs. */
  async get(user: AuthUser, jobId: string): Promise<ImportJob> {
    const row = await this.prisma.importJob.findUnique({
      where: { id: jobId },
    });
    if (!row) throw new NotFoundException(`Import job ${jobId} not found.`);
    if (row.orgId !== user.orgId) {
      throw new ForbiddenException('Job not in your organization.');
    }
    return row;
  }

  /**
   * Caller-initiated cancel. Only meaningful while the job is queued;
   * a running job's cancel is a flag the worker checks at each batch
   * boundary (we don't kill mid-COPY because that leaves the row
   * counters out of sync with reality). Already-terminal jobs no-op.
   */
  async cancel(user: AuthUser, jobId: string): Promise<ImportJob> {
    const row = await this.get(user, jobId);
    if (row.status === 'queued' || row.status === 'running') {
      return this.prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: 'cancelled',
          finishedAt: new Date(),
        },
      });
    }
    return row;
  }

  /**
   * Atomic claim-and-mark-running. Uses SELECT ... FOR UPDATE SKIP
   * LOCKED so two workers (future scale-out) can drain the queue
   * without claiming the same row. Single-replica today: still correct.
   * Returns null when the queue is empty -- the worker's poll loop
   * sleeps and retries.
   */
  async claimNext(): Promise<ImportJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id
          FROM import_job
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );
      if (rows.length === 0) return null;
      const id = rows[0]!.id;
      return tx.importJob.update({
        where: { id },
        data: {
          status: 'running',
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
        },
      });
    });
  }

  /**
   * Worker progress beat. Updates the row counters and lastHeartbeatAt
   * so the UI banner shows live progress and an external observer can
   * detect a hung worker (heartbeat older than e.g. 30s while status
   * is still 'running' is suspect).
   */
  async updateProgress(
    jobId: string,
    processed: number,
    inserted: number,
  ): Promise<void> {
    // Skip the update when the job has been cancelled in flight; the
    // worker's next batch boundary will read the cancelled status
    // and stop. Avoiding the write here means a cancel that races a
    // batch flush doesn't accidentally bring the status back to
    // running.
    await this.prisma.importJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: {
        processedFeatures: processed,
        insertedFeatures: inserted,
        lastHeartbeatAt: new Date(),
      },
    });
  }

  /** Final status flip + final counts. */
  async markSucceeded(
    jobId: string,
    insertedFeatures: number,
  ): Promise<void> {
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        insertedFeatures,
      },
    });
    this.log.log(
      `Import job ${jobId} succeeded with ${insertedFeatures} features.`,
    );
  }

  /** Failure path. Stores the diagnostic message on the row so the
   *  detail-page banner can show it; the worker has already logged
   *  the full stack. */
  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage,
      },
    });
    this.log.warn(`Import job ${jobId} failed: ${errorMessage}`);
  }

  /**
   * After a cancelled import's COPY transaction rolls back, none of
   * the streamed rows exist anymore (and for replace mode the old
   * rows are back untouched). The progress beats that ran while the
   * import was live left a nonzero insertedFeatures on the row,
   * which the UI would read as "N rows were kept". Zero it so the
   * job row tells the truth. Guarded on status='cancelled' so a
   * racing state change can't be clobbered.
   */
  async zeroInsertedForCancelled(jobId: string): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: { id: jobId, status: 'cancelled' },
      data: { insertedFeatures: 0 },
    });
  }

  /**
   * Failure-path twin of zeroInsertedForCancelled. The whole import
   * runs inside one COPY transaction, so when the worker fails a
   * job before that transaction committed, every streamed row was
   * rolled back and the insertedFeatures the progress beats left on
   * the row describes rows that do not exist. The worker calls this
   * after markFailed, but ONLY when it knows the transaction never
   * committed: a failure in the post-commit bookkeeping (source
   * stamp, bbox refresh) leaves the rows in place, and zeroing the
   * counter there would lie in the opposite direction. Guarded on
   * status='failed' so a racing state change can't be clobbered.
   */
  async zeroInsertedForFailed(jobId: string): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: { id: jobId, status: 'failed' },
      data: { insertedFeatures: 0 },
    });
  }

  /** Test the running-job's row to see whether the user clicked
   *  cancel. Worker calls between batches. */
  async isCancelled(jobId: string): Promise<boolean> {
    const row = await this.prisma.importJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return row?.status === 'cancelled';
  }

  /**
   * Stale-'running' recovery: a worker that crashed mid-import
   * leaves a 'running' row with no live process behind it. We
   * surface those rows as failed with a clear message so the user
   * sees what happened and can retry. Detected by status='running'
   * with a stale heartbeat (older than the threshold).
   *
   * Called at worker boot AND periodically from the poll loop. The
   * periodic call matters: docker restarts a crashed worker within
   * seconds, so at boot the dead job's heartbeat is still fresher
   * than the threshold and the boot pass alone would skip it
   * forever, stranding the job as 'running'.
   *
   * Threshold default 5 minutes is generous; a healthy worker beats
   * every batch (~10s). If the heartbeat is older than that, the
   * worker is gone or wedged and the job is effectively dead. The
   * heartbeat guard also makes concurrent sweeps safe: a job a live
   * worker is actively processing keeps beating and never matches.
   */
  async recoverStaleRunning(maxAgeMs: number = 5 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.prisma.importJob.findMany({
      where: {
        status: 'running',
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          { lastHeartbeatAt: null, startedAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
    });
    if (stale.length === 0) return;
    await this.prisma.importJob.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        // The crashed worker's COPY transaction died with its
        // connection, so Postgres rolled back every streamed row;
        // the insertedFeatures left behind by the progress beats
        // counts rows that no longer exist. Zero it in the same
        // update so the recovered row doesn't claim phantom rows.
        // (A crash inside the tiny window between COMMIT and
        // markSucceeded would make 0 an undercount, but "re-upload
        // to retry" is the honest instruction either way; the
        // pre-crash counter was wrong in the common case.)
        insertedFeatures: 0,
        errorMessage:
          'Worker crashed before completing this import. Re-upload to retry.',
      },
    });
    this.log.warn(
      `Recovered ${stale.length} stale running import job${
        stale.length === 1 ? '' : 's'
      } as failed.`,
    );
  }

  /** Map a Prisma row to the wire shape the controller returns. */
  toWire(row: ImportJob) {
    return {
      id: row.id,
      itemId: row.itemId,
      layerId: row.layerId,
      sourceFileName: row.sourceFileName,
      sourceLayerName: row.sourceLayerName,
      mode: row.mode,
      status: row.status,
      totalFeatures: row.totalFeatures,
      processedFeatures: row.processedFeatures,
      insertedFeatures: row.insertedFeatures,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    };
  }
}

export type ImportJobWire = ReturnType<ImportJobsService['toWire']>;
export type { ImportJobStatus };
