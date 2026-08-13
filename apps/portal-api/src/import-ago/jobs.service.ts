// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { LeaderElectionService } from '../cron/leader-election.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  AgoImportService,
  type ImportReport,
} from './import.js';
import type { DryRunReport } from './dry-run.js';

/** How often the runner beats last_heartbeat_at while a job runs. A
 *  long single-item Feature Service copy produces no per-item progress
 *  callback, so without this timer the beat would go stale on a job
 *  that is very much alive. Comfortably under RECLAIM_AFTER_MS. */
const HEARTBEAT_MS = 30_000;

/** How often the leader replica sweeps for stale running rows. */
const RECLAIM_INTERVAL_MS = 60_000;

/** A running row whose beat is older than this is treated as abandoned.
 *  Generous next to the 30s beat: a healthy runner beats every 30s, so
 *  a five-minute silence means the process is gone or wedged. */
const RECLAIM_AFTER_MS = 5 * 60_000;

/**
 * Snapshot of an AgoImportJob row shaped for the wizard's polling
 * endpoint. We omit the verbose requestPayload here -- the client
 * already has it from the preview step -- but include the final
 * `report` once status flips to a terminal state so the wizard can
 * render the per-item results table without a second round-trip.
 */
export interface AgoImportJobDto {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  total: number;
  done: number;
  currentItem: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: ImportReport | null;
}

/**
 * Input the controller hands us when a new run is queued. Mirrors
 * the synchronous /run dto but the `report` carries any per-item
 * willImport edits the operator made in the preview (include /
 * exclude).
 */
export interface StartJobInput {
  user: AuthUser;
  portalUrl: string;
  token: string;
  report: DryRunReport;
}

/**
 * Owns the AgoImportJob row lifecycle and the background runner
 * (#55). The runner is fire-and-forget in the same node process:
 * `start()` writes the queued row, returns its id, and schedules
 * `runJob()` for the next tick. Single-replica today; if we ever
 * scale portal-api horizontally we'd swap this for a real queue
 * with a `claim` step. The row's `status` + `started_at` would
 * make the migration straightforward.
 *
 * Cancellation: a row flipped to `cancelled` by the controller is
 * observed by the runner at the per-item boundary. Mid-item work
 * (e.g. a Feature Service feature copy in flight) still completes
 * before the runner notices, but no further items are imported.
 * This is the same shape the ingest ImportJob worker uses.
 */
@Injectable()
export class AgoImportJobsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger(AgoImportJobsService.name);
  private reclaimTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: AgoImportService,
    private readonly leader: LeaderElectionService,
  ) {}

  /**
   * Start the stale-running reclaim sweep.
   *
   * The runner is fire-and-forget in the API process, which runs at two
   * replicas in prod, so a job runs on whichever replica received the
   * request and only that replica beats its heartbeat. If that replica
   * dies, the other must be the one to notice, so the sweep gates on the
   * leader lock per tick (not once at boot: leadership can move, and
   * whichever replica currently holds the lock should own the sweep).
   *
   * A self-held timer rather than @Cron on purpose: this module does not
   * import ScheduleModule, and adding a fifth `ScheduleModule.forRoot()`
   * is what hung v0.9.10 on boot (app.module.spec pins the count at
   * four). Mirrors ScriptScheduleService, which held its own timer for
   * exactly this reason.
   */
  onApplicationBootstrap(): void {
    this.reclaimTimer = setInterval(
      () => void this.reclaimSafely(),
      RECLAIM_INTERVAL_MS,
    );
    // Never hold the process open for a housekeeping sweep.
    this.reclaimTimer.unref();
    // Opportunistic first pass so a job abandoned by a prior process is
    // caught within a beat of boot rather than a full interval later.
    // Self-gates on shouldRun(), so a boot before the lock is acquired
    // just no-ops and the timer picks it up once leadership settles.
    void this.reclaimSafely();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
  }

  private async reclaimSafely(): Promise<void> {
    if (this.stopping) return;
    // Only the leader sweeps: a non-leader replica running the same
    // updateMany would race the leader over the same rows. Harmless
    // (the update is status-guarded and idempotent) but pointless.
    if (!this.leader.shouldRun()) return;
    try {
      await this.recoverStaleRunning();
    } catch (err) {
      this.log.warn(
        `AGO stale-job recovery failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Fail any AGO import stuck at status='running' with a stale
   * heartbeat. A crashed runner cannot flip its own row, so without
   * this the wizard polls a spinner forever. Mirrors
   * ImportJobsService.recoverStaleRunning: heartbeat-based detection,
   * and a status='running' guard on the terminal update so a job that
   * finishes between the SELECT and the UPDATE is not clobbered back to
   * failed.
   */
  async recoverStaleRunning(maxAgeMs: number = RECLAIM_AFTER_MS): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.prisma.agoImportJob.findMany({
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
    const result = await this.prisma.agoImportJob.updateMany({
      where: { id: { in: stale.map((s) => s.id) }, status: 'running' },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        currentItem: null,
        errorMessage:
          'The import stopped before it finished (the server was interrupted). Start the import again to retry.',
      },
    });
    if (result.count > 0) {
      this.log.warn(
        `Recovered ${result.count} stale running AGO import job${
          result.count === 1 ? '' : 's'
        } as failed.`,
      );
    }
  }

  /**
   * Queue a new AGO migration job and kick off the background
   * runner. Returns immediately with the job id; the runner
   * writes progress + the final report back onto the same row.
   */
  async start(input: StartJobInput): Promise<{ id: string }> {
    const total = countWillImport(input.report);
    const row = await this.prisma.agoImportJob.create({
      data: {
        createdBy: input.user.id,
        orgId: input.user.orgId,
        status: 'queued',
        portalUrl: input.portalUrl,
        total,
        done: 0,
        requestPayload: input.report as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Fire-and-forget: schedule the runner for the next tick so
    // the HTTP response goes back to the caller right away. Any
    // failure inside runJob lands in the row's `errorMessage` and
    // flips status to `failed`; the .catch() here is defensive
    // and just logs (any real failure should already have been
    // captured by the runner's own try/catch).
    setImmediate(() => {
      this.runJob(row.id, input).catch((e) => {
        this.log.error(
          `AGO import job ${row.id} threw outside its handler: ${
            e instanceof Error ? e.message : e
          }`,
        );
      });
    });

    return { id: row.id };
  }

  /**
   * Fetch one job by id, scoped to the calling user's org. Throws
   * 404 when the row doesn't exist or belongs to a different org
   * (don't leak existence across org boundaries).
   */
  async get(user: AuthUser, id: string): Promise<AgoImportJobDto> {
    const row = await this.prisma.agoImportJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException(`AGO import job ${id} not found.`);
    }
    return toDto(row);
  }

  /**
   * Mark a job cancelled. The runner notices at the next per-item
   * boundary and stops. If the job is already in a terminal state
   * this is a no-op (returns the current row).
   */
  async cancel(user: AuthUser, id: string): Promise<AgoImportJobDto> {
    const row = await this.prisma.agoImportJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException(`AGO import job ${id} not found.`);
    }
    if (row.status === 'queued' || row.status === 'running') {
      const updated = await this.prisma.agoImportJob.update({
        where: { id },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      return toDto(updated);
    }
    return toDto(row);
  }

  /**
   * The background runner. Owns the full lifecycle: status to
   * `running`, write progress at every per-item boundary, write
   * the final report on completion, flip to `succeeded` /
   * `failed` / `cancelled`.
   *
   * Progress is written inline (one UPDATE per item) rather than
   * batched. AGO migrations are small enough that the extra
   * writes are noise; the smooth progress bar is worth more.
   */
  private async runJob(jobId: string, input: StartJobInput): Promise<void> {
    // Flip queued -> running. If the row was cancelled before
    // the runner started, respect that and exit.
    const queued = await this.prisma.agoImportJob.findUnique({
      where: { id: jobId },
    });
    if (!queued) return;
    if (queued.status !== 'queued') {
      this.log.warn(
        `AGO import job ${jobId} was ${queued.status} at runner start; skipping.`,
      );
      return;
    }
    await this.prisma.agoImportJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() },
    });

    // Liveness beat for the reclaim sweep. Per-item progress already
    // beats (see onProgress below), but a single large Feature Service
    // copy can run minutes with no callback, so a timer keeps the beat
    // fresh on a job that is alive but quiet. Guarded on status so a
    // late tick cannot resurrect a row the terminal update already
    // moved; unref'd so it never holds the process open; always cleared
    // in the finally.
    const heartbeat = setInterval(() => {
      void this.prisma.agoImportJob
        .updateMany({
          where: { id: jobId, status: 'running' },
          data: { lastHeartbeatAt: new Date() },
        })
        .catch(() => {
          /* a missed beat just risks an early reclaim; never fatal */
        });
    }, HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const report = await this.importer.run({
        user: input.user,
        portalUrl: input.portalUrl,
        token: input.token,
        report: input.report,
        // Per-item progress callback. The runner uses this to bump
        // done + currentItem on the row so the polling endpoint
        // can render a smooth progress bar. Cheap UPDATE; no need
        // to batch.
        onProgress: async (state) => {
          // Cancellation check piggybacks on the same UPDATE: if
          // the row is now cancelled we throw a sentinel error
          // that the outer catch will translate into the right
          // terminal state. Without this, the runner would keep
          // chewing through items even after the user clicked
          // Cancel in the UI.
          const fresh = await this.prisma.agoImportJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });
          if (fresh?.status === 'cancelled') {
            throw new JobCancelledError();
          }
          await this.prisma.agoImportJob.update({
            where: { id: jobId },
            data: {
              done: state.done,
              currentItem: state.currentItem || null,
              // Piggyback the beat on the progress write so a job
              // making steady per-item progress never trips the sweep.
              lastHeartbeatAt: new Date(),
            },
          });
        },
      });

      await this.prisma.agoImportJob.update({
        where: { id: jobId },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          done: report.total,
          report: report as unknown as Prisma.InputJsonValue,
          currentItem: null,
        },
      });
    } catch (e) {
      if (e instanceof JobCancelledError) {
        // Cancellation was already persisted by `cancel()`. Just
        // make sure finishedAt + currentItem are set so the UI
        // doesn't show "in progress" forever.
        await this.prisma.agoImportJob.update({
          where: { id: jobId },
          data: { finishedAt: new Date(), currentItem: null },
        });
        return;
      }
      this.log.error(
        `AGO import job ${jobId} failed: ${
          e instanceof Error ? e.message : e
        }`,
      );
      await this.prisma.agoImportJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage:
            e instanceof Error ? e.message : 'Unknown runner error',
        },
      });
    } finally {
      // Stop beating once the job reaches any terminal state, including
      // the cancelled early-return above.
      clearInterval(heartbeat);
    }
  }
}

class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by caller');
  }
}

function countWillImport(report: DryRunReport): number {
  let n = 0;
  for (const item of report.items) {
    if (item.willImport) n += 1;
  }
  return n;
}

function toDto(row: {
  id: string;
  status: string;
  total: number;
  done: number;
  currentItem: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  report: Prisma.JsonValue;
}): AgoImportJobDto {
  return {
    id: row.id,
    status: row.status as AgoImportJobDto['status'],
    total: row.total,
    done: row.done,
    currentItem: row.currentItem,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    report: (row.report as unknown as ImportReport | null) ?? null,
  };
}
