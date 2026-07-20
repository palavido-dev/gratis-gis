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
@Injectable()
export class TileLayerPyramidWorker implements OnModuleInit {
  private readonly log = new Logger(TileLayerPyramidWorker.name);
  // 10 s poll is fine for raster pyramids -- they're slow jobs
  // (minutes to hours) and a few seconds of pickup latency on a
  // newly-uploaded item is invisible to the user, who's still
  // looking at the immediate COG-served version anyway.
  private readonly POLL_INTERVAL_MS = 10_000;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    // Recover any 'tiling' rows abandoned by a prior worker
    // process (container killed mid-build, oom, etc).  Flip them
    // back to 'cog-ready' so the next loop tick re-claims them.
    try {
      // NOTE: Prisma maps the model + several fields + the enum
      // value to different underlying SQL identifiers:
      //   model Item            -> table "item"            (@@map)
      //   field data            -> column "data_json"      (@map)
      //   field deletedAt       -> column "deleted_at"     (@map)
      //   enum ItemType.tile_layer -> 'tile-layer'         (@map)
      // Raw SQL must reference the underlying names or Postgres
      // rejects the query (relation "Item" does not exist, or
      // invalid input value for enum "ItemType": 'tile_layer').
      // The explicit `::"ItemType"` cast mirrors items.service.ts.
      const result = await this.prisma.$executeRaw`
        UPDATE "item"
        SET "data_json" = jsonb_set("data_json", '{processingState}', '"cog-ready"')
        WHERE type = 'tile-layer'::"ItemType"
          AND "data_json"->>'processingState' = 'tiling'
      `;
      if (result > 0) {
        this.log.log(
          `Recovered ${result} stale 'tiling' row(s) back to 'cog-ready' on boot.`,
        );
      }
    } catch (err) {
      this.log.warn(
        `Stale-tiling recovery on boot failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    this.running = true;
    void this.loop();
    this.log.log(
      `Tile-layer pyramid worker started (${this.POLL_INTERVAL_MS}ms poll interval).`,
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
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
      SET "data_json" = jsonb_set(
        jsonb_set(i."data_json", '{processingState}', '"tiling"'),
        '{tilingStartedAt}',
        to_jsonb(NOW()::text)
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
    if (!data.cogStorageKey && !data.cogStorageUrl) {
      await this.markFailed(itemId, 'COG storage reference is missing on the item.');
      return;
    }
    const maxZoom = data.maxZoom ?? 18;

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
      // 1) Warp to EPSG:3857: the MBTiles driver requires
      //    web-mercator georeferencing.
      const mercPath = join(workDir, 'merc.tif');
      await this.runCommand('gdalwarp', [
        '-t_srs',
        'EPSG:3857',
        '-r',
        'bilinear',
        '-of',
        'GTiff',
        '-co',
        'COMPRESS=DEFLATE',
        // Carry nodata through as an alpha band. Without this the
        // warp's fill area and the source's nodata (e.g. the
        // rotated footprint of a hillshade) rasterize as opaque
        // black in the PNG tiles and the layer renders with a
        // black rectangle around the data.
        '-dstalpha',
        cogPath,
        mercPath,
      ]);
      // 2) Base tiles at the raster's native zoom.
      const mbtilesPath = join(workDir, 'tiles.mbtiles');
      await this.runCommand('gdal_translate', [
        '-of',
        'MBTILES',
        '-co',
        'TILE_FORMAT=PNG',
        mercPath,
        mbtilesPath,
      ]);
      // 3) Overview levels down to z0: each power-of-two factor
      //    halves the zoom, so maxZoom factors cover the range.
      const factors: string[] = [];
      for (let z = 1; z <= maxZoom; z++) {
        factors.push(String(2 ** z));
      }
      await this.runCommand('gdaladdo', [
        '-r',
        'bilinear',
        mbtilesPath,
        ...factors,
      ]);
      // 4) Pack into PMTiles.
      await this.runCommand('pmtiles', [
        'convert',
        mbtilesPath,
        pmtilesPath,
      ]);

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
      };
      // jsonb_set only patches one path per call; do them one at
      // a time so a misconfigured key doesn't blow away the
      // whole data blob.
      await this.applyPatch(itemId, patch);
      // Clear tilingError if it was set from a previous failed
      // attempt.
      await this.clearTilingError(itemId);
      this.log.log(
        `Pyramid build succeeded for item ${itemId}: ${pmtilesStat.size} bytes`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(itemId, msg).catch((patchErr) => {
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

  /** Patch one or more TileLayerData fields onto Item.data via a
   *  single jsonb operation.  Builds the patch object as JSON and
   *  merges it with the existing data so the worker doesn't have
   *  to re-read the item between fields. */
  private async applyPatch(
    itemId: string,
    patch: Partial<TileLayerData>,
  ): Promise<void> {
    // Cast through unknown to satisfy Prisma.JsonObject's index
    // signature requirement; TileLayerData is a typed interface.
    const patchJson = patch as unknown as Prisma.JsonObject;
    await this.prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = "data_json" || ${patchJson}::jsonb
      WHERE id = ${itemId}::uuid
    `;
  }

  /** Remove the tilingError key from Item.data, if present.
   *  Used after a successful build so the error from a prior
   *  failed attempt doesn't linger. */
  private async clearTilingError(itemId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "item"
      SET "data_json" = "data_json" - 'tilingError'
      WHERE id = ${itemId}::uuid
    `;
  }

  /** Flip an item to tiling-failed with the given error message.
   *  The item continues serving from its COG so the failure is
   *  recoverable -- an admin can hit the retry endpoint to flip
   *  back to cog-ready for another attempt. */
  private async markFailed(itemId: string, errorMessage: string): Promise<void> {
    const truncated = errorMessage.length > 2000
      ? errorMessage.slice(0, 2000) + '...'
      : errorMessage;
    await this.applyPatch(itemId, {
      processingState: 'tiling-failed',
      tilingError: truncated,
    });
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

  private runCommand(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 32 * 1024) {
          stderr = '...' + stderr.slice(-16 * 1024);
        }
      });
      child.on('error', (err) => {
        reject(new Error(`Failed to run ${cmd}: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${cmd} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`,
            ),
          );
        }
      });
    });
  }
}
