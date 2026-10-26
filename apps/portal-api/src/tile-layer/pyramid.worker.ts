// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TileLayerData, ISODateString } from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * Background worker that builds a PMTiles raster pyramid from
 * the COG of a tile_layer item that landed via the raw-raster
 * upload path.  Promotes the item from the 'cog-ready' bridge
 * state to 'pmtiles-ready' once the pyramid is built, after
 * which the item serves from PMTiles (faster + universal) and
 * the COG stays as the archival source.
 *
 * The state machine on `TileLayerData.processingState`:
 *
 *   cog-ready    -> tiling           (claimNext picks the row)
 *   tiling       -> pmtiles-ready    (build succeeded)
 *   tiling       -> tiling-failed    (3 attempts exhausted)
 *
 * State transitions land via JSON patches on Item.data so we
 * don't need a separate jobs table.  claimNext uses UPDATE ...
 * WHERE state='cog-ready' FOR UPDATE SKIP LOCKED so N workers
 * are race-safe (today there's one; the pattern keeps the door
 * open for scale-out).
 *
 * Build pipeline:
 *
 *   1. Download the COG from MinIO to a local temp file.
 *   2. `gdal2tiles.py -z 0-N` writes a {z}/{x}/{y}.png tree
 *      under workDir/tiles/.
 *   3. `pmtiles convert workDir/tiles workDir/out.pmtiles` packs
 *      the tree into a PMTiles archive.
 *   4. Upload the PMTiles to MinIO under a fresh storage key.
 *   5. Patch the item: set format='pmtiles', point storageKey/
 *      storageUrl at the new PMTiles, populate pmtilesStorageKey/
 *      pmtilesStorageUrl/pmtilesSizeBytes, flip tileUrl from
 *      cog:// to pmtiles://, mark processingState='pmtiles-ready'.
 *   6. The original COG stays in MinIO (referenced by
 *      cogStorageKey/Url/SizeBytes) as the archival source.
 *
 * Failure handling: a thrown error during the build flips the
 * item to 'tiling-failed' with `tilingError` populated.  The
 * item continues to serve from its COG.  An admin can hit the
 * retry endpoint to flip back to 'cog-ready' for another pass.
 */
/**
 * How many crashed build attempts an item gets before reclaim
 * stops re-arming it and flips it to 'tiling-failed'.  Counted via
 * `tilingAttempts` in data_json: a stale 'tiling' row means the
 * previous attempt died mid-build (the worker never reached its
 * own success or markFailed patch), so each recovery increments
 * the counter.
 */
const MAX_TILING_ATTEMPTS = 3;

/**
 * #232: wall-clock ceiling for a single child process (gdalwarp /
 * gdaladdo / pmtiles). Override with PYRAMID_CMD_TIMEOUT_SEC.
 * Large county builds are legitimately multi-hour; the default is
 * generous. A hung gdal* without this wedged all pyramids forever.
 */
const DEFAULT_CMD_TIMEOUT_SEC = 4 * 60 * 60;

/**
 * #232: silence window for reclaim. If tilingHeartbeatAt (or
 * tilingStartedAt when no beat yet) is older than this, the claim
 * is treated as abandoned by a dead worker.
 */
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

@Injectable()
export class TileLayerPyramidWorker implements OnModuleInit {
  private readonly log = new Logger(TileLayerPyramidWorker.name);
  // 10 s poll is fine for raster pyramids -- they're slow jobs
  // (minutes to hours) and a few seconds of pickup latency on a
  // newly-uploaded item is invisible to the user, who's still
  // looking at the immediate COG-served version anyway.
  private readonly POLL_INTERVAL_MS = 10_000;
  private readonly cmdTimeoutMs: number;
  private running = false;
  private lastReclaimAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    const sec = Number(process.env['PYRAMID_CMD_TIMEOUT_SEC'] ?? '');
    this.cmdTimeoutMs =
      (Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_CMD_TIMEOUT_SEC) * 1000;
  }

  async onModuleInit() {
    // #232: reclaim is age-gated by heartbeat so a live build on
    // another replica is not stolen. Boot still runs a sweep so a
    // restart recovers abandoned claims without waiting for the
    // first loop tick.
    await this.reclaimStaleTilings('boot');
    this.running = true;
    void this.loop();
    this.log.log(
      `Tile-layer pyramid worker started (${this.POLL_INTERVAL_MS}ms poll; cmd timeout ${this.cmdTimeoutMs / 1000}s).`,
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Periodic reclaim so a hung child without a container
        // restart still gets swept (#232); boot-only was not enough.
        if (Date.now() - this.lastReclaimAt >= 60_000) {
          await this.reclaimStaleTilings('loop');
        }
        const claim = await this.claimNext();
        if (claim) {
          await this.buildPyramid(claim).catch((err) => {
            this.log.error(
              `Pyramid build failed for item ${claim.itemId}: ${err instanceof Error ? err.message : err}`,
            );
          });
        }
      } catch (err) {
        this.log.error(
          `Pyramid worker loop error: ${err instanceof Error ? err.message : err}`,
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.POLL_INTERVAL_MS),
      );
    }
  }

  /**
   * #232: fail-out / re-arm 'tiling' rows whose heartbeat went
   * silent. Bounded by MAX_TILING_ATTEMPTS so a crash-inducing
   * item cannot poison the queue forever.
   */
  private async reclaimStaleTilings(reason: 'boot' | 'loop'): Promise<void> {
    this.lastReclaimAt = Date.now();
    try {
      const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_MS);
      // Fail-out first so the re-arm pass only touches under-budget
      // rows. Heartbeat age uses COALESCE(tilingHeartbeatAt,
      // tilingStartedAt) so pre-heartbeat claims still reclaim.
      const failed = await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = ("data_json" - 'tilingAttempts' - 'tilingHeartbeatAt') || jsonb_build_object(
          'processingState', 'tiling-failed',
          'tilingError',
          'The tiling worker crashed repeatedly while building this pyramid (' || ${MAX_TILING_ATTEMPTS}::text || ' attempts). The layer still serves from its original file. Retry from the layer page, and check the worker logs if it keeps failing.'
        )
        WHERE type = 'tile-layer'::"ItemType"
          AND "data_json"->>'processingState' = 'tiling'
          AND COALESCE(
            ("data_json"->>'tilingHeartbeatAt')::timestamptz,
            ("data_json"->>'tilingStartedAt')::timestamptz
          ) < ${staleBefore}
          AND COALESCE(("data_json"->>'tilingAttempts')::int, 0) >= ${MAX_TILING_ATTEMPTS - 1}
      `;
      const rearmed = await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = ("data_json" - 'tilingHeartbeatAt') || jsonb_build_object(
          'processingState', 'cog-ready',
          'tilingAttempts', COALESCE(("data_json"->>'tilingAttempts')::int, 0) + 1
        )
        WHERE type = 'tile-layer'::"ItemType"
          AND "data_json"->>'processingState' = 'tiling'
          AND COALESCE(
            ("data_json"->>'tilingHeartbeatAt')::timestamptz,
            ("data_json"->>'tilingStartedAt')::timestamptz
          ) < ${staleBefore}
      `;
      if (failed > 0 || rearmed > 0) {
        this.log.log(
          `Stale 'tiling' recovery (${reason}): re-armed ${rearmed} row(s) to 'cog-ready', failed out ${failed} row(s) after ${MAX_TILING_ATTEMPTS} crashed attempts.`,
        );
      }
    } catch (err) {
      this.log.warn(
        `Stale-tiling recovery (${reason}) failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Atomically pick one cog-ready item and flip it to 'tiling'.
   * Returns null when there's nothing to do.  Uses FOR UPDATE
   * SKIP LOCKED so N workers race-safely; today N=1 but the
   * pattern keeps the door open for horizontal scale.
   */
  private async claimNext(): Promise<{
    itemId: string;
    data: TileLayerData;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; data: Prisma.JsonValue }>
    >`
      WITH picked AS (
        SELECT id
        FROM "item"
        WHERE type = 'tile-layer'::"ItemType"
          AND "data_json"->>'processingState' = 'cog-ready'
          AND ("deleted_at" IS NULL)
        ORDER BY ("data_json"->>'uploadedAt') ASC NULLS LAST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "item" i
      SET "data_json" = i."data_json" || jsonb_build_object(
        'processingState', 'tiling',
        'tilingStartedAt', NOW()::text,
        'tilingHeartbeatAt', NOW()::text
      )
      FROM picked
      WHERE i.id = picked.id
      RETURNING i.id, i."data_json" AS data
    `;
    const row = rows[0];
    if (!row) return null;
    if (!isTileLayerData(row.data)) {
      this.log.warn(`Claimed item ${row.id} has invalid TileLayerData; skipping`);
      return null;
    }
    return { itemId: row.id, data: row.data };
  }

  /** Stamp tilingHeartbeatAt so reclaim does not steal a live claim. */
  private async beatHeartbeat(itemId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = "data_json" || jsonb_build_object(
          'tilingHeartbeatAt', NOW()::text
        )
        WHERE id = ${itemId}::uuid
          AND "data_json"->>'processingState' = 'tiling'
      `;
    } catch (err) {
      this.log.warn(
        `tiling heartbeat failed for ${itemId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Run the full build pipeline for one claimed item.  On
   * success patches the item to 'pmtiles-ready'; on failure
   * patches to 'tiling-failed' with a human-readable error
   * message.
   */
  private async buildPyramid(claim: {
    itemId: string;
    data: TileLayerData;
  }): Promise<void> {
    const { itemId, data } = claim;
    // Ownership token for terminal stamps (#232 race with mosaic
    // rebuild): only patch if the item is still 'tiling' with the
    // same COG key we claimed.
    const claimedCogKey = data.cogStorageKey ?? null;
    if (!data.cogStorageKey && !data.cogStorageUrl) {
      await this.markFailed(
        itemId,
        'COG storage reference is missing on the item.',
        claimedCogKey,
      );
      return;
    }
    const maxZoom = data.maxZoom ?? 18;
    const onBeat = () => this.beatHeartbeat(itemId);

    const workDir = await mkdtemp(join(tmpdir(), 'tile-pyramid-'));
    const cogPath = join(workDir, 'source.tif');
    const pmtilesPath = join(workDir, 'out.pmtiles');

    try {
      this.log.log(
        `Building pyramid for item ${itemId} (zoom 0-${maxZoom})`,
      );

      // Download the COG to local scratch.  gdal2tiles needs a
      // local input path.  Prefer the storage KEY through the S3
      // SDK: since item-tile-layer became a private kind, the
      // persisted cogStorageUrl is an API-relative path
      // (/api/portal/storage/private/...) that a bare fetch()
      // cannot parse, which silently broke every pyramid build on
      // private COGs.  The URL fetch stays as a fallback for
      // legacy rows that predate the key fields and still carry
      // an absolute MinIO URL.
      if (data.cogStorageKey) {
        await this.storage.streamObjectToDisk(data.cogStorageKey, cogPath);
      } else {
        await this.downloadTo(data.cogStorageUrl!, cogPath);
      }
      await onBeat();

      // #186: elevation (DEM) layers never get a PNG pyramid; the
      // re-encode would destroy the float elevation values. Their
      // web-tiled COG serves directly through /file.cog. Guard here
      // so a stray retry-pyramid on a dem item is a no-op instead
      // of a corruption.
      if ((data as { dem?: boolean }).dem) {
        return;
      }
      // COG -> web-mercator MBTiles -> PMTiles. The previous
      // gdal2tiles + `pmtiles convert <dir>` sequence silently
      // stopped working when the pmtiles binary moved to
      // go-pmtiles (the Trivy hardening rebuild): go-pmtiles only
      // converts MBTiles archives, not xyz tile directories. The
      // MBTiles route is also strictly better: one SQLite file
      // instead of a million tiny PNGs, and gdaladdo builds the
      // overview levels in place.
      //
      // Tile format is chosen from what the source actually is:
      // photographic imagery (3 opaque bands, no nodata) gets
      // JPEG tiles at a third of the bytes; anything with alpha
      // or nodata (hillshade footprints, viewshed overlays) keeps
      // PNG so transparency survives. A county ortho in PNG tiles
      // is 3x the storage and bandwidth for zero visible gain.
      const info = await this.runCommandJson<{
        bands?: Array<{
          colorInterpretation?: string;
          noDataValue?: number | string;
        }>;
        coordinateSystem?: { wkt?: string };
        metadata?: { IMAGE_STRUCTURE?: { LAYOUT?: string } };
      }>('gdalinfo', ['-json', cogPath], onBeat);
      const bands = info.bands ?? [];
      const isPhoto =
        bands.length === 3 &&
        !bands.some(
          (b) =>
            b.colorInterpretation === 'Alpha' ||
            b.noDataValue !== undefined,
        );
      const wkt = info.coordinateSystem?.wkt ?? '';
      const isWebMercator =
        wkt.includes('"EPSG","3857"') || wkt.includes('Pseudo-Mercator');

      // Photographic imagery that is ALREADY a web-tiled COG needs
      // no pyramid at all: the COG's internal JPEG overviews are
      // the pyramid, and the browser's COG protocol renders
      // nothing outside the image footprint. Baking it into
      // JPEG tiles actively made it worse: JPEG has no alpha, so
      // every tile that only partially overlaps the image pads the
      // rest with opaque black, drawing a black apron over the
      // basemap at every zoom (the county ortho regression). Same
      // serve-the-COG precedent as dem layers.
      if (
        isPhoto &&
        isWebMercator &&
        info.metadata?.IMAGE_STRUCTURE?.LAYOUT === 'COG'
      ) {
        const applied = await this.applyPatch(
          itemId,
          {
            processingState: 'ready',
            tileType: 'jpg',
            tileUrl: `cog:///api/portal/tile-layer/${itemId}/file.cog`,
          } as Partial<TileLayerData>,
          claimedCogKey,
        );
        if (applied) await this.clearTilingError(itemId, claimedCogKey);
        this.log.log(
          `Item ${itemId} is a web-tiled photo COG; serving it directly (no pyramid).`,
        );
        return;
      }

      // 1) Web-mercator GTiff: the MBTiles driver requires 3857.
      //    Skipped when the source already is (our own analysis
      //    outputs and imagery extracts), which also avoids a
      //    multi-GB DEFLATE intermediate on small disks. The
      //    -dstalpha flag carries nodata through as alpha for the
      //    PNG path; without it the warp fill rasterizes as
      //    opaque black around rotated footprints.
      const mbtilesInput = (() => {
        if (isWebMercator) return cogPath;
        return join(workDir, 'merc.tif');
      })();
      if (!isWebMercator) {
        await this.runCommand(
          'gdalwarp',
          [
            '-t_srs',
            'EPSG:3857',
            '-r',
            'bilinear',
            '-of',
            'GTiff',
            '-co',
            'COMPRESS=DEFLATE',
            ...(isPhoto ? [] : ['-dstalpha']),
            cogPath,
            mbtilesInput,
          ],
          onBeat,
        );
      }
      // 2) Base tiles at the raster's native zoom.
      const mbtilesPath = join(workDir, 'tiles.mbtiles');
      await this.runCommand(
        'gdal_translate',
        [
          '-of',
          'MBTILES',
          '-co',
          `TILE_FORMAT=${isPhoto ? 'JPEG' : 'PNG'}`,
          ...(isPhoto ? ['-co', 'QUALITY=85'] : []),
          mbtilesInput,
          mbtilesPath,
        ],
        onBeat,
      );
      // 3) Overview levels down to z0: each power-of-two factor
      //    halves the zoom, so maxZoom factors cover the range.
      const factors: string[] = [];
      for (let z = 1; z <= maxZoom; z++) {
        factors.push(String(2 ** z));
      }
      await this.runCommand(
        'gdaladdo',
        ['-r', 'bilinear', mbtilesPath, ...factors],
        onBeat,
      );
      // 4) Pack into PMTiles.
      await this.runCommand(
        'pmtiles',
        ['convert', mbtilesPath, pmtilesPath],
        onBeat,
      );

      const pmtilesStat = await stat(pmtilesPath);

      // Upload the PMTiles to MinIO under a fresh storage key.
      // We don't delete the COG -- it stays as the archival
      // source per the design.
      const uploaded = await this.storage.uploadLocalFile(
        'item-tile-layer',
        pmtilesPath,
        'application/octet-stream',
      );

      // Patch the item.  storageKey + storageUrl flip to the new
      // PMTiles so consumers transparently start serving from it
      // on the next request.  tileUrl flips from cog:// to
      // pmtiles:// so cached map views re-resolve to the better
      // path on next render.
      const patch: Partial<TileLayerData> = {
        format: 'pmtiles',
        storageKey: uploaded.key,
        storageUrl: uploaded.publicUrl,
        sizeBytes: pmtilesStat.size,
        pmtilesStorageKey: uploaded.key,
        pmtilesStorageUrl: uploaded.publicUrl,
        pmtilesSizeBytes: pmtilesStat.size,
        processingState: 'pmtiles-ready',
        tilingCompletedAt: new Date().toISOString() as ISODateString,
        tileUrl: `pmtiles:///api/portal/tile-layer/${itemId}/file`,
        tileType: isPhoto ? 'jpg' : 'png',
      };
      const applied = await this.applyPatch(itemId, patch, claimedCogKey);
      if (applied) {
        await this.clearTilingError(itemId, claimedCogKey);
        this.log.log(
          `Pyramid build succeeded for item ${itemId}: ${pmtilesStat.size} bytes`,
        );
      } else {
        this.log.warn(
          `Pyramid build for ${itemId} finished but ownership moved (mosaic/reclaim); dropping success stamp.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(itemId, msg, claimedCogKey).catch((patchErr) => {
        this.log.error(
          `Failed to mark item ${itemId} as tiling-failed: ${patchErr instanceof Error ? patchErr.message : patchErr}`,
        );
      });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }

  /**
   * Patch TileLayerData fields onto Item.data. When `claimedCogKey`
   * is passed (#232), only applies if the row is still `'tiling'`
   * with that COG key — otherwise a concurrent mosaic rebuild would
   * be clobbered by a finishing pyramid. Returns whether the patch
   * landed.
   */
  private async applyPatch(
    itemId: string,
    patch: Partial<TileLayerData>,
    claimedCogKey?: string | null,
  ): Promise<boolean> {
    const patchJson = patch as unknown as Prisma.JsonObject;
    if (claimedCogKey === undefined) {
      const n = await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = "data_json" || ${patchJson}::jsonb
        WHERE id = ${itemId}::uuid
      `;
      return n > 0;
    }
    const n = await this.prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = ("data_json" - 'tilingHeartbeatAt') || ${patchJson}::jsonb
      WHERE id = ${itemId}::uuid
        AND "data_json"->>'processingState' = 'tiling'
        AND "data_json"->>'cogStorageKey' IS NOT DISTINCT FROM ${claimedCogKey}
    `;
    return n > 0;
  }

  /** Remove tilingError / tilingAttempts / heartbeat after success. */
  private async clearTilingError(
    itemId: string,
    claimedCogKey?: string | null,
  ): Promise<void> {
    if (claimedCogKey === undefined) {
      await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = "data_json" - 'tilingError' - 'tilingAttempts' - 'tilingHeartbeatAt'
        WHERE id = ${itemId}::uuid
      `;
      return;
    }
    await this.prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = "data_json" - 'tilingError' - 'tilingAttempts' - 'tilingHeartbeatAt'
      WHERE id = ${itemId}::uuid
        AND "data_json"->>'cogStorageKey' IS NOT DISTINCT FROM ${claimedCogKey}
    `;
  }

  /** Flip an item to tiling-failed with the given error message. */
  private async markFailed(
    itemId: string,
    errorMessage: string,
    claimedCogKey?: string | null,
  ): Promise<void> {
    const truncated =
      errorMessage.length > 2000
        ? errorMessage.slice(0, 2000) + '...'
        : errorMessage;
    const applied = await this.applyPatch(
      itemId,
      {
        processingState: 'tiling-failed',
        tilingError: truncated,
      },
      claimedCogKey,
    );
    if (!applied) {
      this.log.warn(
        `markFailed for ${itemId} skipped: ownership moved (mosaic/reclaim).`,
      );
      return;
    }
    // A clean failure ends any crash streak so an admin retry gets
    // a fresh MAX_TILING_ATTEMPTS budget.
    await this.prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = "data_json" - 'tilingAttempts' - 'tilingHeartbeatAt'
      WHERE id = ${itemId}::uuid
    `;
  }

  // -----------------------------------------------------------
  // Helpers (duplicated from tile-conversion.ts: keeping the
  // pyramid worker free of cross-module imports beyond Prisma +
  // Storage means it can ship to the worker container without
  // pulling in the api's HTTP / auth modules.)
  // -----------------------------------------------------------

  private async downloadTo(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Download failed (HTTP ${res.status}) from ${url}`);
    }
    if (!res.body) {
      throw new Error(`Download returned no body from ${url}`);
    }
    await pipeline(
      Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream),
      createWriteStream(dest),
    );
  }

  /**
   * #232: spawn with wall-clock timeout and optional heartbeat.
   * Polls every 10s; on deadline SIGKILL so a hung gdal* cannot
   * wedge the whole pyramid queue.
   */
  private runCommand(
    cmd: string,
    args: string[],
    onBeat?: () => Promise<void>,
  ): Promise<void> {
    return this.spawnWithTimeout(cmd, args, {
      captureStdout: false,
      ...(onBeat ? { onBeat } : {}),
    }).then(() => undefined);
  }

  /** Run a command and JSON-parse its stdout (gdalinfo -json). */
  private runCommandJson<T>(
    cmd: string,
    args: string[],
    onBeat?: () => Promise<void>,
  ): Promise<T> {
    return this.spawnWithTimeout(cmd, args, {
      captureStdout: true,
      ...(onBeat ? { onBeat } : {}),
    }).then((stdout) => {
      try {
        return JSON.parse(stdout) as T;
      } catch {
        throw new Error(`${cmd} produced unparseable JSON output`);
      }
    });
  }

  private spawnWithTimeout(
    cmd: string,
    args: string[],
    opts: {
      onBeat?: () => Promise<void>;
      captureStdout: boolean;
    },
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const started = Date.now();
      const pollMs = 10_000;

      if (opts.captureStdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
      } else {
        child.stdout.resume();
      }
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 32 * 1024) {
          stderr = '...' + stderr.slice(-16 * 1024);
        }
      });

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (err) reject(err);
        else resolve(stdout);
      };

      const timer = setInterval(() => {
        if (settled) return;
        if (Date.now() - started >= this.cmdTimeoutMs) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish(
            new Error(
              `${cmd} exceeded ${this.cmdTimeoutMs / 1000}s wall-clock limit and was killed`,
            ),
          );
          return;
        }
        if (opts.onBeat) {
          void opts.onBeat().catch(() => {
            /* heartbeat is best-effort */
          });
        }
      }, pollMs);

      child.on('error', (err) => {
        finish(new Error(`Failed to run ${cmd}: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) {
          finish(null);
        } else {
          finish(
            new Error(
              `${cmd} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`,
            ),
          );
        }
      });
    });
  }
}
