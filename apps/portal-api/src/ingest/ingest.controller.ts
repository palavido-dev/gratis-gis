// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { FeaturesService } from '../features/features.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import { IngestService } from './ingest.service.js';
import { IngestStagingService } from './ingest-staging.service.js';
import { CopyWriter } from '../engine/copy-writer.js';

/**
 * Server-side ingest endpoint. Accepts a multipart upload of an
 * OGR-readable vector file, parses it via GDAL, and writes the
 * features into a PostGIS table (v2 storage). The item metadata is
 * updated to reflect the new storage type.
 *
 * Only data_layer items are accepted as targets. The caller must
 * have edit rights (owner or org admin, same rule as PATCH /items/:id).
 */
@ApiTags('ingest')
@ApiBearerAuth()
@Controller()
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
    private readonly dataLayerFeatures: DataLayerFeaturesService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly staging: IngestStagingService,
  ) {}

  /**
   * Probe an uploaded spatial file and return per-layer metadata
   * (name, geometry type, fields, feature count) without creating or
   * mutating any items. Backs the builder's Import tab: user picks
   * one or more layers, we seed the v3 schema with them, then the
   * user fills in details and creates the item.
   */
  @Post('ingest/probe')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async probe(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    return this.ingest.probeFile(file.buffer, file.originalname);
  }

  /**
   * Parse an uploaded spatial file and return the full GeoJSON
   * FeatureCollection (#52). Backs the in-browser unified spatial
   * importer's shapefile branch: we used to bundle `shpjs` on the
   * client to parse zipped shapefiles, but GDAL already lives on
   * the server for the regular ingest path and produces better
   * output (real SRS reprojection, multi-layer flattening, field
   * type inference). Server-side parse + return is a small
   * round-trip cost compared to shipping ~120 KB of shp + dbf
   * parsing code into every page that imports anything.
   *
   * Same auth + file-size posture as /ingest/probe (admin-or-up,
   * 1 GB cap). Driver / SRS info is returned alongside the
   * GeoJSON so the client can surface a "Reprojected from EPSG:X"
   * note when the source was anything other than WGS84.
   */
  @Post('ingest/to-geojson')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async toGeoJson(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    return this.ingest.fileToGeoJson(file.buffer, file.originalname);
  }

  /**
   * Stage an upload for later ingest AND return the schema preview.
   * Combines /ingest/probe + a server-side hold so the wizard can do
   * one upload, get the schema, let the user edit details, and then
   * fan out per-layer ingest from the stagingId without re-uploading
   * the bytes. Used by the data_layer create wizard.
   *
   * Returns the same probe shape as /ingest/probe with a stagingId
   * tacked on. Stagings expire after one hour (see
   * IngestStagingService); a wizard that idles longer than that has
   * to re-upload, which we accept as the trade for bounded disk.
   */
  @Post('ingest/stage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async stage(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    // Stage first so the file is on disk under a stable path. probe
    // can then read it from there without re-buffering. If the probe
    // fails (corrupt zip, etc.) we drop the staging to keep disk
    // tidy; the user gets an inline error and re-uploads.
    const staged = await this.staging.stage({
      buffer: file.buffer,
      originalName: file.originalname,
      ownerId: user.id,
    });
    try {
      const probe = await this.ingest.probeFileFromPath(staged.filePath);
      return {
        stagingId: staged.stagingId,
        driver: probe.driver,
        layers: probe.layers,
      };
    } catch (err) {
      // Probe rejected: don't keep a staged file we can't ingest.
      await this.staging.dropStaging(staged.stagingId).catch(() => {});
      throw err;
    }
  }

  @Post('items/:id/ingest')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // Multer enforces the same ceiling as IngestService. Defense
        // in depth is cheap and it gives users a clear 413 instead
        // of burning CPU on a 2 GB shapefile. Set to 1 GB so a
        // county-scale parcel layer (often 200-500 MB zipped) fits
        // without the user having to subset first. Anything bigger
        // should go through a future direct-to-MinIO presigned-PUT
        // path rather than buffering through portal-api.
        fileSize: 1024 * 1024 * 1024,
      },
    }),
  )
  async ingestFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded; field name must be "file".');
    }

    const item = await this.items.get(user, id);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Server-side ingest only targets data_layer items.',
      );
    }
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item.');
    }

    const { geojson, fields, driver, sourceSrs } = await this.ingest.fileToGeoJson(
      file.buffer,
      file.originalname,
    );

    // Ensure the PostGIS table exists for this item (idempotent).
    await this.features.provisionTable(id);

    // Replace all current features with the newly ingested set.
    const { inserted, expired } = await this.features.replaceAll(
      id,
      geojson.features.map((f: unknown) => {
        const feat = f as {
          geometry?: unknown;
          properties?: Record<string, unknown> | null;
        };
        return {
          geometry: feat.geometry,
          properties: feat.properties ?? {},
        };
      }),
      user,
    );

    // Compute bbox and update item metadata to v2 storage shape.
    const stats = await this.features.stats(id);
    const nextData: Record<string, unknown> = {
      version: 2,
      storageType: 'postgis',
      fields: fields.map((f) => ({
        name: f.name,
        type: f.type,
        label: f.name,
        nullable: true,
      })),
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      updatedAt: new Date().toISOString(),
      source: {
        fileName: file.originalname,
        format: driverToFormat(driver),
        sizeBytes: file.size,
        importedAt: new Date().toISOString(),
        importedBy: user.id,
        note: `driver: ${driver}`,
        sourceSrs,
      },
    };

    await this.prisma.item.update({
      where: { id },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });

    return {
      driver,
      inserted,
      expired,
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      fields: nextData.fields,
      sourceSrs,
    };
  }

  /**
   * Per-layer ingest for v3 multi-layer items.
   *
   * @deprecated #115 P6: superseded by the async import-jobs flow at
   * `POST /items/:id/layers/:layerId/import-jobs`. The wizard now
   * creates a job row and navigates immediately; the in-process
   * ImportJobsWorker drains the queue using the COPY bulk-write
   * path (5-10x faster than this endpoint) and the detail-page
   * banner reports progress.
   *
   * This endpoint stays for direct API users (curl, scripted
   * ingests) that want the synchronous NDJSON behavior. Callers
   * who don't care about the streaming progress events should
   * migrate to the import-jobs endpoint to pick up the perf
   * improvements -- this path will not get further perf work.
   *
   * Accepts a file + the optional name of a source layer inside a
   * multi-layer archive (GDB, shapefile zip with several .shp).
   * Features get bulk-inserted into the target layer's PostGIS
   * table; which must already exist (provisioned on item create
   * by ItemsService).
   */
  @Post('items/:id/layers/:layerId/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async ingestV3Layer(
    @Res() res: Response,
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('sourceLayer') sourceLayer?: string,
    // #244 replace-mode. Defaults to 'append' to preserve the existing
    // detail-page behaviour (which is what currently-bookmarked import
    // scripts assume); the UI's primary Import button passes
    // mode=replace explicitly.
    @Query('mode') mode?: 'replace' | 'append',
    // Staging integration: when stagingId is provided the file body
    // is optional, and we read the bytes from /tmp/gg-staging/<id>/
    // instead. The wizard's Create-item flow uses this so a 503 MB
    // GDB uploaded once at probe time gets re-used for N per-layer
    // ingests without N more uploads.
    @Query('stagingId') stagingId?: string,
  ) {
    // #103: response body is newline-delimited JSON. Each line is one
    // event. Shape:
    //   {"event":"start","total":1389855,"sourceLayer":"MasterSurfWV_2025"}
    //   {"event":"progress","processed":5000,"inserted":5000}
    //   {"event":"progress","processed":10000,"inserted":10000}
    //   ...
    //   {"event":"done","inserted":1389855,"sourceLayer":"MasterSurfWV_2025",
    //    "driver":"OpenFileGDB","sourceSrs":"EPSG:26917","mode":"replace",
    //    "replaced":0}
    //   {"event":"error","message":"..."}    (terminal)
    //
    // Why NDJSON instead of returning a single JSON: a county-scale
    // import takes minutes, and the user-facing wizard wants to
    // render granular progress instead of a single spinning "Loading
    // ..." state. NDJSON is supported by every modern browser via
    // the streaming fetch API and degrades gracefully if the client
    // simply waits for end-of-body and parses the last line.
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    // The NDJSON body echoes back user-supplied fields (sourceLayer,
    // filename, error.message). Browsers shouldn't sniff this as
    // HTML, but if a content-type-relaxed reverse proxy ever strips
    // the type header an attacker-controlled error message could
    // become reflected XSS. nosniff keeps that loop closed.
    res.setHeader('x-content-type-options', 'nosniff');
    res.flushHeaders?.();
    const writeEvent = (msg: Record<string, unknown>): void => {
      res.write(JSON.stringify(msg) + '\n');
    };
    // The "throw a 4xx HTTP early" pattern doesn't apply once we've
    // started streaming -- the headers are already 200. So validation
    // failures past this point go out as `{event:"error",...}` and we
    // close the body with res.end().
    const failStream = (status: number, message: string): void => {
      // For pre-stream rejections the headers haven't been flushed so
      // we can still send a real status code. Once headers are out,
      // the most we can do is emit an error event and end the body.
      if (!res.headersSent) {
        res.status(status);
      }
      writeEvent({ event: 'error', status, message });
      res.end();
    };

    try {
      if (!file && !stagingId) {
        return failStream(
          400,
          'No file uploaded; provide a multipart "file" field or a "stagingId" query parameter.',
        );
      }
      if (mode !== undefined && mode !== 'replace' && mode !== 'append') {
        return failStream(
          400,
          `Unknown mode "${mode}"; expected replace or append.`,
        );
      }
      const ingestMode: 'replace' | 'append' = mode ?? 'append';
      const item = await this.items.get(user, itemId);
      if (item.type !== 'data_layer') {
        return failStream(400, 'Ingest only targets data_layer items.');
      }
      const data = item.data as {
        version?: number;
        layers?: Array<DataLayerLayerShape>;
      } | null;
      if (data?.version !== 3) {
        return failStream(
          400,
          'Per-layer ingest is v3-only. Use /items/:id/ingest for v1/v2 items.',
        );
      }
      const layer = (data.layers ?? []).find((l) => l.id === layerId);
      if (!layer) {
        return failStream(
          404,
          `Layer ${layerId} is not part of this item's schema.`,
        );
      }
      await this.items.assertCanEdit(user, itemId);

      // #234: the replace-mode truncate moved DOWN into the streaming
      // block below, after the source file is resolved and probed.
      // It used to run here, before the file had even been opened, so
      // a corrupt upload, an empty source, or a wrong sourceLayer name
      // emptied the layer and only THEN failed. See the pre-validate
      // note at the truncate's new home.
      let truncated = 0;

      // Property whitelist (unchanged). Sparse schemas drop unknown
      // columns; an empty schema is treated as "take everything".
      const fieldNames = new Set((layer.fields ?? []).map((f) => f.name));
      const filterProps = (props: Record<string, unknown>) => {
        if (fieldNames.size === 0) return props;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(props)) {
          if (fieldNames.has(k)) out[k] = props[k];
        }
        return out;
      };

      // Resolve the source path for streaming. Two paths:
      //   1. Staging: file already on disk under /tmp/gg-staging/<id>/.
      //      We read straight off disk; the staging cleanup cron
      //      handles eviction.
      //   2. Multipart: legacy path where the caller PUTs the file in
      //      the request body. We have to write the buffer to a temp
      //      dir so the streaming reader can open it via GDAL. The
      //      old non-streaming path used the buffer-input variants
      //      that did the same write internally; we just hoist it
      //      here so the streaming variant can see a path.
      let provenanceFileName: string;
      let provenanceSizeBytes: number;
      let sourcePath: string;
      let cleanupSourceDir: (() => Promise<void>) | null = null;
      if (stagingId) {
        const staged = await this.staging.getStaging(stagingId, user.id);
        sourcePath = staged.filePath;
        provenanceFileName = staged.originalName;
        provenanceSizeBytes = staged.sizeBytes;
      } else {
        const f = file!;
        const tmp = await this.ingest.materializeBufferToTemp(
          f.buffer,
          f.originalname,
        );
        sourcePath = tmp.filePath;
        provenanceFileName = f.originalname;
        provenanceSizeBytes = f.size;
        cleanupSourceDir = tmp.cleanup;
      }

      let totalInserted = 0;
      let startedFlushed = false;
      let lastDriver = '';
      let lastLayerName = '';
      let lastSourceSrs: string | null = null;

      // Shared streaming/progress loop, parameterized by how a batch
      // is inserted. Emits the start event on the first batch (or on an
      // empty source) and a progress event per batch.
      const runStream = async (
        insertBatch: (
          filtered: Array<{
            geometry: unknown;
            properties: Record<string, unknown>;
          }>,
        ) => Promise<number>,
      ): Promise<void> => {
        const meta = await this.ingest.streamLayerFromPath(
          sourcePath,
          sourceLayer,
          async (batch, progress) => {
            if (!startedFlushed) {
              writeEvent({
                event: 'start',
                total: progress.total,
                sourceLayer: sourceLayer ?? null,
              });
              startedFlushed = true;
            }
            const filtered = batch.map((b) => ({
              geometry: b.geometry,
              properties: filterProps(b.properties),
            }));
            totalInserted += await insertBatch(filtered);
            writeEvent({
              event: 'progress',
              processed: progress.processed,
              total: progress.total,
              inserted: totalInserted,
            });
          },
        );
        lastDriver = meta.driver;
        lastLayerName = meta.layerName;
        lastSourceSrs = meta.sourceSrs;
        // Empty-source edge case: streamLayer opens fine but yields
        // zero batches. Emit the start event so the client still gets a
        // complete event sequence.
        if (!startedFlushed) {
          writeEvent({
            event: 'start',
            total: meta.total,
            sourceLayer: sourceLayer ?? null,
          });
        }
      };

      try {
        if (ingestMode === 'replace') {
          // #234 atomic replace. Route through the same COPY-transaction
          // path the async import worker uses: the scope delete and
          // every inserted row commit or roll back together. The old
          // shape truncated in a separate committed transaction before
          // the inserts, so a failed, empty, or unreadable import
          // emptied the layer and then failed. Now any throw rolls the
          // whole thing back to the exact pre-import state. (COPY is
          // also 5-10x faster than the per-batch insert.)
          const databaseUrl = process.env.DATABASE_URL;
          if (!databaseUrl) {
            throw new Error('DATABASE_URL is not set; import cannot start.');
          }
          // Count what we are about to replace for the done event,
          // before the delete runs inside the writer's transaction.
          truncated = await this.dataLayerTables.countLiveEntities(
            itemId,
            layer.id,
          );
          const writer = new CopyWriter(databaseUrl);
          let copyClosed = false;
          try {
            await writer.begin();
            await writer.deleteScope(`data_layer:${itemId}:${layerId}`);
            writer.beginCopy();
            await runStream(async (filtered) => {
              const { inserted } =
                await this.dataLayerFeatures.bulkInsertFeatures(
                  itemId,
                  layerId,
                  filtered,
                  user,
                  writer,
                );
              return inserted;
            });
            await writer.end();
            copyClosed = true;
          } finally {
            // Any throw (parse error, DB error, disconnect) rolls the
            // transaction back so the scope delete and the partial COPY
            // vanish together, leaving the pre-import rows intact.
            if (!copyClosed) await writer.abort();
            await writer.close();
          }
        } else {
          // Append: a partial result loses nothing, so the lighter
          // per-batch idempotent insert path is fine.
          await runStream(async (filtered) => {
            const { inserted } = await this.dataLayerFeatures.insertFeatures(
              itemId,
              layerId,
              filtered,
              user,
            );
            return inserted;
          });
        }
      } finally {
        if (cleanupSourceDir) {
          await cleanupSourceDir().catch(() => {});
        }
      }

      // Stamp provenance + recompute bbox the same way the legacy
      // non-streaming path did. These run once at the end, not per
      // batch, because the source-stamp captures the final state and
      // the aggregateBbox is more efficient on a fully populated
      // table than mid-stream.
      await this.stampV3LayerSource(itemId, layerId, {
        fileName: provenanceFileName,
        format: driverToFormat(lastDriver),
        sizeBytes: provenanceSizeBytes,
        importedAt: new Date().toISOString(),
        importedBy: user.id,
        note: `driver: ${lastDriver}`,
        sourceSrs: lastSourceSrs,
      });

      try {
        const fresh = await this.prisma.item.findUnique({
          where: { id: itemId },
          select: { data: true },
        });
        const layers = (
          (fresh?.data ?? null) as { layers?: DataLayerLayerShape[] } | null
        )?.layers;
        if (Array.isArray(layers)) {
          const bbox = await this.dataLayerTables.aggregateBbox(
            itemId,
            layers,
          );
          await this.prisma.item.update({
            where: { id: itemId },
            data: { bbox: bbox ?? [] },
          });
        }
      } catch (err) {
        // Pass user-controlled itemId / layerId as separate console
        // arguments rather than interpolated into the format string,
        // so the surrounding `%`-detection inside console.* can't be
        // tricked by a crafted id (CodeQL js/tainted-format-string).
        // eslint-disable-next-line no-console
        console.warn(
          '[ingestV3Layer] bbox recompute failed for %s/%s:',
          itemId,
          layerId,
          err instanceof Error ? err.message : err,
        );
      }

      writeEvent({
        event: 'done',
        driver: lastDriver,
        sourceLayer: lastLayerName,
        inserted: totalInserted,
        sourceSrs: lastSourceSrs,
        mode: ingestMode,
        ...(ingestMode === 'replace' ? { replaced: truncated } : {}),
      });
      res.end();
    } catch (err) {
      const message =
        err instanceof BadRequestException ||
        err instanceof NotFoundException ||
        err instanceof ForbiddenException
          ? err.message
          : err instanceof Error
            ? err.message || err.name || 'Ingest failed.'
            : 'Ingest failed.';
      // Log the underlying error AND the message we're about to
      // surface to the client. Earlier we logged just `err`, which
      // for some gdal-async / native errors prints as the bare
      // string "Error" with no message and no stack -- making the
      // failure mode invisible without attaching a debugger.
      // Pass user-controlled fields as separate console args so the
      // first-arg format-string detection can't be tricked by a
      // crafted id or error message (CodeQL js/tainted-format-string).
      // eslint-disable-next-line no-console
      console.error(
        '[ingestV3Layer] stream failed for %s/%s: %s',
        itemId,
        layerId,
        message,
        err instanceof Error ? err.stack : err,
      );
      writeEvent({ event: 'error', message });
      res.end();
    }
  }

  /**
   * Merge a `source` block onto the named layer inside the item's
   * v3 data blob. Read-modify-write is safe here: this endpoint is
   * the only writer of layer.source, and we guard with canEdit above.
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
  ) {
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

/**
 * Map GDAL driver strings we emit to the format enum the shared
 * DataLayerSource type exposes. Unknown drivers fall through to
 * 'api' so the shape stays strict on the client side.
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
