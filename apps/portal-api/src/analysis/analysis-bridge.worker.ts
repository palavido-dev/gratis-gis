// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { IngestStagingService } from '../ingest/ingest-staging.service.js';
import { ImportJobsService } from '../import-jobs/import-jobs.service.js';
import { stampAnalysisTargetFailed } from './analysis-target-stamp.js';

/**
 * Analysis-to-import bridge (contours and future vector analysis
 * outputs), plus the analysis-job reclaim sweep.
 *
 * The GDAL analysis worker cannot write features: engine writes
 * live in TypeScript on purpose (scoping, indexing, bbox stamping,
 * bitemporal semantics). So vector-producing jobs end their GDAL
 * half by uploading a GeoJSON artifact to MinIO and flipping the
 * analysis_job to state='ingest'. This worker claims those jobs,
 * stages the artifact, and enqueues a normal async import job into
 * the pre-created target data_layer; while the import runs the
 * analysis job sits in state='importing', and when the import
 * reaches a terminal state the bridge mirrors it back onto the
 * analysis job. Every feature therefore lands through the same
 * proven COPY pipeline user uploads use.
 *
 * The reclaim sweep rides the same tick because this is the one
 * always-deployed process that already owns analysis_job settling
 * (the python worker is the thing whose death we are detecting, so
 * it cannot police itself, and the api process has no poll loop).
 *
 * Claims are optimistic single-row UPDATEs on the state column, so
 * running several portal-worker replicas stays safe.
 */

/** A running job whose last worker beat is older than this is
 *  considered abandoned. The worker beats at least every ~10s while
 *  alive (progress writes, subprocess wait loops, S3 transfer
 *  callbacks), so ten minutes of silence means the process is gone,
 *  not slow. */
const RECLAIM_AFTER_MINUTES = 10;
/** The bridge ticks every 5s for ingest handoffs; the reclaim scan
 *  only needs minute-ish latency on a 10-minute threshold, so it is
 *  throttled to keep the steady-state query load at zero-ish. */
const RECLAIM_SWEEP_MS = 60_000;
@Injectable()
export class AnalysisBridgeWorker implements OnModuleInit {
  private readonly log = new Logger(AnalysisBridgeWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastReclaimAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly staging: IngestStagingService,
    private readonly importJobs: ImportJobsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    // Allow the process to exit even with the interval scheduled.
    this.timer.unref?.();
    this.log.log('Analysis bridge polling every 5s');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // no overlapping ticks
    this.running = true;
    try {
      await this.reclaimStaleJobs();
      await this.claimIngestJobs();
      await this.settleImportingJobs();
    } catch (err) {
      this.log.error(
        `bridge tick failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Reclaim sweep: terminal-ize jobs whose worker died mid-run.
   * The python worker beats heartbeat_at on claim, on every
   * progress write, and every ~10s during long silent stretches; a
   * running row whose beat is stale therefore has no living worker
   * behind it (SIGKILL, OOM, node poweroff) and nothing else will
   * ever move it, which left the UI spinning forever.
   *
   * running -> failed with the plain 'worker stopped responding';
   * cancel_requested -> cancelled (the user asked for the stop and
   * the stop happened, just unconfirmed). The COALESCE covers rows
   * claimed before heartbeat_at existed; during a mixed-version
   * deploy an old worker's healthy long job could be swept 10
   * minutes in, accepted because worker and bridge ship together.
   *
   * Default (not private) visibility so the lifecycle spec can
   * drive it directly without poking through `any`.
   */
  async reclaimStaleJobs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReclaimAt < RECLAIM_SWEEP_MS) return;
    this.lastReclaimAt = now;
    // Single conditional UPDATE keeps the sweep idempotent across
    // bridge replicas: whichever replica gets there first moves the
    // row, the others match nothing.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        kind: string;
        state: string;
        target_item_id: string | null;
        source_item_id: string;
      }>
    >`
      UPDATE analysis_job
      SET state = CASE WHEN state = 'cancel_requested'
                       THEN 'cancelled' ELSE 'failed' END,
          error = CASE WHEN state = 'cancel_requested'
                       THEN error ELSE 'worker stopped responding' END,
          finished_at = now()
      WHERE state IN ('running', 'cancel_requested')
        AND COALESCE(heartbeat_at, started_at, created_at)
            < now() - make_interval(mins => ${RECLAIM_AFTER_MINUTES})
      RETURNING id, kind, state, target_item_id, source_item_id
    `;
    for (const row of rows) {
      this.log.warn(
        `analysis ${row.id} (${row.kind}): reclaimed as ${row.state}; worker heartbeat went stale`,
      );
      // Same husk stamp the worker's own failure path writes; see
      // analysis-target-stamp.ts for the kind coverage rationale.
      await stampAnalysisTargetFailed(
        this.prisma,
        {
          kind: row.kind,
          targetItemId: row.target_item_id,
          sourceItemId: row.source_item_id,
        },
        row.state === 'cancelled'
          ? 'This analysis was cancelled before it finished.'
          : row.kind === 'copc-build'
            ? 'The analysis worker stopped responding during the merge. The source tiles are kept; run the merge again.'
            : 'The analysis worker stopped responding, so this layer could not be created. Try running the analysis again.',
      );
    }
  }

  /** state='ingest' -> stage artifact + enqueue import -> 'importing'. */
  private async claimIngestJobs(): Promise<void> {
    const candidates = await this.prisma.analysisJob.findMany({
      where: { state: 'ingest' },
      orderBy: { createdAt: 'asc' },
      take: 3,
    });
    for (const job of candidates) {
      const claimed = await this.prisma.analysisJob.updateMany({
        where: { id: job.id, state: 'ingest' },
        data: { state: 'importing', progress: 82 },
      });
      if (claimed.count === 0) continue; // another replica took it
      try {
        const params = (job.params ?? {}) as {
          artifactKey?: string;
          layerId?: string;
          featureCount?: number;
        };
        if (!params.artifactKey || !params.layerId || !job.targetItemId) {
          throw new Error(
            'The analysis result is missing its file reference.',
          );
        }
        // Pull the artifact out of MinIO and into the staging area
        // the import worker reads from (shared volume). Piped, not
        // buffered: a large contour set is hundreds of MB, and the
        // old collect-into-one-Buffer approach held all of it in
        // this process's heap for no benefit (the import worker
        // reads the staged FILE, never the bytes in memory).
        const obj = await this.storage.streamObject(params.artifactKey);
        const staged = await this.staging.stageStream({
          stream: obj.body,
          originalName: 'contours.geojson',
          ownerId: job.userId,
        });
        const importJob = await this.importJobs.enqueue({
          itemId: job.targetItemId,
          layerId: params.layerId,
          stagingId: staged.stagingId,
          sourceFileName: staged.originalName,
          // Empty layer name = "use the file's only layer". A
          // GeoJSON file always has exactly one, and this avoids
          // guessing what OGR will call it.
          sourceLayerName: '',
          mode: 'replace',
          totalFeatures: params.featureCount ?? null,
          userId: job.userId,
          orgId: job.orgId,
        });
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            params: { ...params, importJobId: importJob.id },
            progress: 85,
          },
        });
        // The artifact has served its purpose; the staged copy is
        // what the import reads. Best-effort cleanup.
        try {
          await this.storage.deleteObject(params.artifactKey);
        } catch {
          /* orphaned artifacts are harmless and tiny */
        }
        this.log.log(
          `analysis ${job.id}: staged ${staged.sizeBytes} B, import ${importJob.id} queued`,
        );
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'The analysis result could not be imported.';
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            error: msg.slice(0, 2000),
            finishedAt: new Date(),
          },
        });
        this.log.error(`analysis ${job.id}: bridge failed: ${msg}`);
      }
    }
  }

  /** Mirror terminal import states back onto 'importing' jobs. */
  private async settleImportingJobs(): Promise<void> {
    const importing = await this.prisma.analysisJob.findMany({
      where: { state: 'importing' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    for (const job of importing) {
      const params = (job.params ?? {}) as { importJobId?: string };
      if (!params.importJobId) continue; // claim step still writing
      const imp = await this.prisma.importJob.findUnique({
        where: { id: params.importJobId },
      });
      if (!imp) {
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            error: 'The import step went missing.',
            finishedAt: new Date(),
          },
        });
        continue;
      }
      if (imp.status === 'succeeded') {
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            state: 'done',
            progress: 100,
            finishedAt: new Date(),
          },
        });
        this.log.log(`analysis ${job.id}: done (import ${imp.id})`);
      } else if (imp.status === 'failed' || imp.status === 'cancelled') {
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            error:
              imp.status === 'cancelled'
                ? 'The import step was cancelled.'
                : imp.errorMessage || 'The import step failed.',
            finishedAt: new Date(),
          },
        });
      } else {
        // Still running; nudge progress so the UI shows life.
        await this.prisma.analysisJob.update({
          where: { id: job.id },
          data: { progress: 90 },
        });
      }
    }
  }
}
