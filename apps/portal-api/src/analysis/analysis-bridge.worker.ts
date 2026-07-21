// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { IngestStagingService } from '../ingest/ingest-staging.service.js';
import { ImportJobsService } from '../import-jobs/import-jobs.service.js';

/**
 * Analysis-to-import bridge (contours and future vector analysis
 * outputs).
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
 * Claims are optimistic single-row UPDATEs on the state column, so
 * running several portal-worker replicas stays safe.
 */
@Injectable()
export class AnalysisBridgeWorker implements OnModuleInit {
  private readonly log = new Logger(AnalysisBridgeWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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
        // the import worker reads from (shared volume).
        const obj = await this.storage.streamObject(params.artifactKey);
        const chunks: Buffer[] = [];
        for await (const chunk of obj.body) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
          );
        }
        const buffer = Buffer.concat(chunks);
        const staged = await this.staging.stage({
          buffer,
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
          `analysis ${job.id}: staged ${buffer.length} B, import ${importJob.id} queued`,
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
