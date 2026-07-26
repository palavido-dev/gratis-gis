// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ImportJob, Prisma } from '@prisma/client';

import { ImportJobsService } from './import-jobs.service.js';
import { IngestService } from '../ingest/ingest.service.js';
import { IngestStagingService } from '../ingest/ingest-staging.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { CopyWriter } from '../engine/copy-writer.js';
import { dataLayerScope } from '../engine/data-layer.js';

/**
 * In-process worker for ImportJob rows (#115).
 *
 * Why in-process: portal-api runs as a single replica today. A
 * dedicated worker container would add ops surface (separate
 * deploy, separate health check, IPC) without solving any
 * problem we have. When we scale out, this same module can be
 * extracted into a worker-only entry point (Nest supports
 * standalone application contexts) and the polling loop swaps
 * to PG NOTIFY without touching the row's contract.
 *
 * Polling cadence: 1s. Costs one cheap indexed query per second
 * even when idle (status='queued' index-only scan returning 0
 * rows). At a poll rate this gentle, NOTIFY is a fine future
 * optimization but not a correctness requirement.
 *
 * Concurrency: 1 job at a time. SELECT ... FOR UPDATE SKIP LOCKED
 * inside claimNext() makes this safe to run in N replicas later
 * without coordination, but right now the simplicity of "one
 * worker, one job" is the bigger win.
 */
@Injectable()
export class ImportJobsWorker implements OnModuleInit {
  private readonly log = new Logger(ImportJobsWorker.name);
  private readonly POLL_INTERVAL_MS = 1000;
  /**
   * Run the stale-'running' recovery sweep every this-many loop
   * iterations (roughly once a minute at the 1s poll). Boot-time
   * recovery alone cannot catch a crashed job: docker restarts the
   * worker within seconds, so at boot the dead job's heartbeat is
   * only seconds old and the 5-minute staleness threshold skips it
   * forever. The periodic sweep re-checks once the heartbeat has
   * actually gone stale. recoverStaleRunning is heartbeat-guarded
   * and uses a plain conditional updateMany, so sweeping while other
   * replicas work is safe.
   */
  private readonly RECOVERY_EVERY_TICKS = 60;
  private ticksSinceRecovery = 0;
  private running = false;

  constructor(
    private readonly jobs: ImportJobsService,
    private readonly ingest: IngestService,
    private readonly staging: IngestStagingService,
    private readonly dataLayerFeatures: DataLayerFeaturesService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Recover any 'running' rows abandoned by a prior process. This
    // catches the case where portal-api was killed mid-import: the
    // row is still status='running' but no live worker is touching
    // it. Mark them failed with a clear message; the user can re-
    // upload to retry. Done before starting the loop so we don't
    // race the same recovery against an in-flight claim. This boot
    // pass only catches heartbeats that were ALREADY stale (a long
    // outage); a fast docker restart leaves the crashed job's
    // heartbeat fresh, which the periodic sweep in the loop picks
    // up once the threshold elapses.
    await this.jobs.recoverStaleRunning().catch((err) => {
      this.log.warn(
        `Stale-job recovery on boot failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
    this.running = true;
    // Detached loop: do not await. The Nest module bootstraps
    // synchronously, and the worker should keep running until the
    // process exits.
    void this.loop();
    this.log.log('Import-jobs worker started (1s poll interval).');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Periodic stale-job sweep (see RECOVERY_EVERY_TICKS). Tick
        // counting instead of wall-clock keeps this trivially free
        // of drift bugs; while this worker is busy on a long job the
        // loop is not iterating, so the sweep just runs at the next
        // boundary between jobs, which is fine: a job THIS process
        // is actively working keeps its heartbeat fresh anyway.
        this.ticksSinceRecovery += 1;
        if (this.ticksSinceRecovery >= this.RECOVERY_EVERY_TICKS) {
          this.ticksSinceRecovery = 0;
          await this.jobs.recoverStaleRunning().catch((err) => {
            this.log.warn(
              `Periodic stale-job recovery failed: ${
                err instanceof Error ? err.message : err
              }`,
            );
          });
        }
        const job = await this.jobs.claimNext();
        if (job) {
          await this.runJob(job).catch((err) => {
            // runJob has its own error handling that flips the row
            // to 'failed'. Anything that escapes here is exotic
            // (the markFailed call itself threw); log and keep the
            // loop alive so the next job isn't blocked.
            this.log.error(
              `Worker loop caught unhandled error for job ${job.id}: ${
                err instanceof Error ? err.message : err
              }`,
              err instanceof Error ? err.stack : undefined,
            );
          });
        } else {
          await sleep(this.POLL_INTERVAL_MS);
        }
      } catch (err) {
        // Database hiccup or similar transient failure on the poll
        // itself. Backoff and retry; the loop must not exit just
        // because of one bad query.
        this.log.warn(
          `Import-jobs poll errored, backing off: ${
            err instanceof Error ? err.message : err
          }`,
        );
        await sleep(5_000);
      }
    }
  }

  /**
   * Run a single import job end-to-end. Mirrors the synchronous
   * ingestV3Layer controller body but writes progress into the
   * import_job row instead of streaming NDJSON.
   *
   * Failure mode: any throw inside the try block flips the row to
   * 'failed' with the error message preserved. Cancellation mid-
   * batch flips to 'cancelled' at the next batch boundary.
   */
  async runJob(job: ImportJob): Promise<void> {
    this.log.log(
      `Running import job ${job.id}: ${job.sourceFileName} layer="${job.sourceLayerName}" mode=${job.mode}`,
    );
    try {
      // Resolve the staged file. If it has expired, fail the job
      // with an actionable message rather than throwing some
      // ENOENT diagnostic.
      let staged;
      try {
        staged = await this.staging.getStaging(job.stagingId, job.createdBy);
      } catch {
        await this.jobs.markFailed(
          job.id,
          'Source file expired before the import started. Re-upload to retry.',
        );
        return;
      }

      // Resolve the item + target layer for schema-aware filtering.
      // We bypass per-user authz here (the worker runs server-side,
      // not on behalf of a request) but we still verify the layer
      // exists in the item's data; a stale job-row referring to a
      // since-deleted layer should fail rather than 500.
      const item = await this.prisma.item.findUnique({
        where: { id: job.itemId },
        select: { data: true, ownerId: true, orgId: true },
      });
      if (!item) {
        await this.jobs.markFailed(
          job.id,
          'Item no longer exists. The job may have been queued against a deleted item.',
        );
        return;
      }
      const data = item.data as {
        version?: number;
        layers?: Array<DataLayerLayerShape>;
      } | null;
      if (data?.version !== 3) {
        await this.jobs.markFailed(
          job.id,
          'Item is not a v3 data_layer. Async import only targets v3 items.',
        );
        return;
      }
      const layer = (data.layers ?? []).find((l) => l.id === job.layerId);
      if (!layer) {
        await this.jobs.markFailed(
          job.id,
          `Layer ${job.layerId} no longer exists in this item's schema.`,
        );
        return;
      }

      // Synthesize an AuthUser the way the ingest pipeline expects.
      // This is the job's creator -- the row's eventual author_sub.
      // Since the worker runs server-side, we don't have the live
      // session's group memberships or capabilities, but the ingest
      // pipeline only reads `id` and `username` for stamping, so a
      // minimal projection suffices.
      const author: AuthUser = {
        id: job.createdBy,
        orgId: item.orgId,
        orgSlug: '',
        username: '',
        email: '',
        orgRole: 'contributor',
        groupIds: [],
        capabilities: new Set(),
      };

      // Property whitelist (sparse schemas drop unknown columns;
      // empty schema = take everything).
      const fieldNames = new Set((layer.fields ?? []).map((f) => f.name));
      const filterProps = (props: Record<string, unknown>) => {
        if (fieldNames.size === 0) return props;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(props)) {
          if (fieldNames.has(k)) out[k] = props[k];
        }
        return out;
      };

      let totalInserted = 0;
      let lastDriver = '';
      let lastLayerName = '';
      let lastSourceSrs: string | null = null;
      // Cancellation check cadence: every batch boundary. Cheaper
      // than per-row, immediate enough that a user clicking Cancel
      // sees the import stop within seconds.
      let cancelled = false;

      // Open one COPY transaction for the whole import. PostgreSQL's
      // COPY FROM STDIN is the bulk-load wire protocol -- 5-10x
      // faster than batched multi-row INSERTs because the server
      // skips per-row SQL parsing and parameter binding. We run
      // SET LOCAL synchronous_commit=off inside the transaction so
      // a re-runnable bulk import doesn't pay an fsync per batch
      // commit. The writer is closed cleanly on success and
      // aborted on any throw or cancel so a partial run never
      // stays half-written.
      //
      // Replace mode: the truncate DELETE runs on the writer's own
      // connection inside this same transaction, before COPY mode
      // starts. That makes replace atomic: commit swaps old rows
      // for new in one step, while failure or cancel rolls back
      // BOTH the delete and the partial COPY, leaving the layer
      // exactly as it was before the import. The previous shape
      // (truncateLayer committing in its own transaction up front)
      // left the layer empty whenever the COPY didn't commit.
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL is not set; COPY ingest cannot start.');
      }
      const writer = new CopyWriter(databaseUrl);
      let copyClosed = false;
      let meta: Awaited<
        ReturnType<IngestService['streamLayerFromPath']>
      >;
      try {
        await writer.begin();
        if (job.mode === 'replace') {
          await writer.deleteScope(dataLayerScope(job.itemId, job.layerId));
        }
        writer.beginCopy();
        meta = await this.ingest.streamLayerFromPath(
          staged.filePath,
          job.sourceLayerName,
          async (batch, progress) => {
            if (cancelled) return;
            if (await this.jobs.isCancelled(job.id)) {
              cancelled = true;
              return;
            }
            const filtered = batch.map((b) => ({
              geometry: b.geometry,
              properties: filterProps(b.properties),
            }));
            const { inserted } =
              await this.dataLayerFeatures.bulkInsertFeatures(
                job.itemId,
                job.layerId,
                filtered,
                author,
                writer,
              );
            totalInserted += inserted;
            await this.jobs.updateProgress(
              job.id,
              progress.processed,
              totalInserted,
            );
          },
        );
        // Important: streamLayerFromPath returns NORMALLY when we
        // cancel mid-stream (the onBatch callback noops once the
        // cancelled flag is set, but the GDAL feature pump runs to
        // completion). If we just unconditionally call writer.end()
        // here, the COPY transaction COMMITS every row that already
        // streamed before the cancel -- which was the bug behind
        // 1.3M ghost rows in observation after multiple cancelled
        // imports today. Branch on cancelled and call abort()
        // instead so the partial-load rolls back cleanly (for
        // replace mode the scoped delete rolls back with it,
        // restoring the pre-import rows).
        if (cancelled) {
          await writer.abort();
          copyClosed = true;
        } else {
          await writer.end();
          copyClosed = true;
        }
      } finally {
        if (!copyClosed) {
          // Stream-end didn't run (we threw before reaching the
          // branch above). Roll back the open transaction so the
          // connection returns to the pool clean. Best-effort;
          // abort swallows its own errors.
          await writer.abort();
        }
        await writer.close();
      }
      lastDriver = meta.driver;
      lastLayerName = meta.layerName;
      lastSourceSrs = meta.sourceSrs;

      if (cancelled) {
        // The job row is already at status='cancelled' (the user
        // clicked Cancel). Skip the source-stamp + bbox recompute.
        // Nothing we streamed was kept: the COPY transaction rolled
        // back above, and for replace mode the scoped delete rolled
        // back with it, so the layer holds exactly its pre-import
        // rows. Zero the inserted counter so the job row (and the
        // banner reading it) does not claim rows that never
        // committed.
        await this.jobs.zeroInsertedForCancelled(job.id);
        this.log.log(
          `Job ${job.id} cancelled; rolled back ${totalInserted} streamed of ${meta.total}.`,
        );
        return;
      }

      // Stamp source provenance on the layer (the detail page
      // surfaces "Imported from X.gdb.zip on Y by Z").
      await this.stampV3LayerSource(job.itemId, job.layerId, {
        fileName: job.sourceFileName,
        format: driverToFormat(lastDriver),
        sizeBytes: staged.sizeBytes,
        importedAt: new Date().toISOString(),
        importedBy: job.createdBy,
        note: `driver: ${lastDriver}`,
        sourceSrs: lastSourceSrs,
      });

      // Recompute item-level bbox so the items list and detail page
      // map preview anchor on the fresh data.
      try {
        const fresh = await this.prisma.item.findUnique({
          where: { id: job.itemId },
          select: { data: true },
        });
        const layers = (
          (fresh?.data ?? null) as { layers?: DataLayerLayerShape[] } | null
        )?.layers;
        if (Array.isArray(layers)) {
          const bbox = await this.dataLayerTables.aggregateBbox(
            job.itemId,
            layers,
          );
          await this.prisma.item.update({
            where: { id: job.itemId },
            data: { bbox: bbox ?? [] },
          });
        }
      } catch (err) {
        this.log.warn(
          `bbox recompute failed for ${job.itemId}/${job.layerId} on job ${job.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }

      await this.jobs.markSucceeded(job.id, totalInserted);
      // Reference lastLayerName so TypeScript doesn't flag it as
      // unused. We may want to surface it in the wire response in
      // a follow-up.
      void lastLayerName;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message || err.name || 'Import failed.'
          : 'Import failed.';
      this.log.error(
        `Job ${job.id} failed: ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.jobs.markFailed(job.id, msg);
    }
  }

  /**
   * Same shape the ingest controller's stampV3LayerSource writes.
   * Duplicated here to avoid pulling the controller's private
   * helper into the public surface; a future cleanup pass could
   * extract this into a shared LayerSourceStamper.
   */
  private async stampV3LayerSource(
    itemId: string,
    layerId: string,
    source: {
      fileName: string;
      format: string;
      sizeBytes: number;
      importedAt: string;
      importedBy: string;
      note?: string;
      sourceSrs?: string | null;
    },
  ): Promise<void> {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    const data = row?.data as
      | { version?: number; layers?: Array<Record<string, unknown>> }
      | null;
    if (!data || data.version !== 3 || !Array.isArray(data.layers)) return;
    const nextLayers = data.layers.map((l) =>
      (l as { id?: string }).id === layerId ? { ...l, source } : l,
    );
    const nextData = { ...(data as object), layers: nextLayers };
    await this.prisma.item.update({
      where: { id: itemId },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors the helper in ingest.controller.ts. Same set of OGR
 * driver strings -> shared-types DataLayerSource.format enum.
 */
function driverToFormat(
  driver: string,
):
  | 'geojson'
  | 'geoparquet'
  | 'kml'
  | 'kmz'
  | 'shapefile'
  | 'gdb'
  | 'xlsx'
  | 'csv'
  | 'manual'
  | 'api' {
  const d = driver.toLowerCase();
  if (d.includes('geojson')) return 'geojson';
  if (d.includes('parquet')) return 'geoparquet';
  if (d.includes('kmz')) return 'kmz';
  if (d.includes('kml')) return 'kml';
  if (d.includes('shape') || d.includes('esri shapefile')) return 'shapefile';
  if (d.includes('filegdb') || d.includes('openfilegdb')) return 'gdb';
  if (d.includes('xlsx') || d.includes('excel')) return 'xlsx';
  if (d.includes('csv')) return 'csv';
  return 'api';
}
