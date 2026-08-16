// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  TileCacheService,
  tileCacheKey,
  type CacheHit,
} from '../engine/tile-cache.service.js';
import { StorageService } from '../storage/storage.service.js';
import { bboxesIntersect } from './elevation-mosaic.compositor.js';
import { ensureVsis3, loadGdal } from './gdal-s3.js';
import {
  COG_TILE_SIZE,
  grayscaleArgs,
  needsAlphaBand,
  needsRendering,
  tileBounds3857,
  tileBoundsWgs84,
  warpArgs,
} from './cog-tiles.js';

/** What the caller resolved for the item, ACL already applied. */
export interface CogSource {
  itemId: string;
  storageKey: string;
  bbox?: [number, number, number, number];
}

/**
 * XYZ PNG tiles warped on demand out of a COG-backed tile_layer.
 *
 * The reason this exists is a QGIS deadlock. Before it, the only way
 * a desktop GIS could draw a COG-backed layer was to open the file
 * itself over HTTP range reads through GDAL's /vsicurl. Adding such a
 * layer by hand works. Opening a saved project that CONTAINS one does
 * not: QGIS builds layer providers on a worker pool during project
 * read and blocks the GUI thread until they all finish, and a
 * /vsicurl provider never finishes. The project hangs forever and
 * QGIS has to be killed. Reproduced headless, and confirmed against a
 * native stack taken off a hung session.
 *
 * Serving tiles moves the file access to the server. The client gets
 * ordinary PNGs over its own network stack, which is the same shape
 * the PMTiles-backed layers already use, so the same authcfg carries
 * the portal key and private layers keep working.
 *
 * The COG itself stays at /tile-layer/:id/file.cog. This route is for
 * drawing; that one is for the numbers. That distinction matters for
 * elevation: a DEM served here is a grey PICTURE of the terrain, not
 * a raster anyone can run a slope calculation on.
 *
 * Reads go through GDAL's /vsis3/ against MinIO, so gdalwarp picks a
 * matching overview level and a low-zoom tile costs kilobytes rather
 * than the whole raster. Results go in the shared tile cache keyed on
 * the resolved storage key, so two viewers with different visibility
 * can never share a slot.
 */
@Injectable()
export class CogTileService {
  private readonly log = new Logger(CogTileService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly tileCache: TileCacheService,
  ) {}

  /**
   * One tile, or null when the tile lies outside the raster.
   *
   * Null rather than a transparent PNG: the controller answers it
   * with 404, which is what an XYZ client reads as "nothing here"
   * without waiting for or decoding an image.
   */
  async tile(
    source: CogSource,
    z: number,
    x: number,
    y: number,
  ): Promise<CacheHit | null> {
    // Cheap footprint test first. A county-sized image covers a
    // vanishing fraction of the world grid, so most requests can be
    // answered without touching storage at all.
    if (source.bbox && !bboxesIntersect(source.bbox, tileBoundsWgs84(z, x, y))) {
      return null;
    }
    // Keyed on the storage key, not the item id. Two viewers who can
    // both read the item read the same bytes; a viewer who cannot
    // never gets here, because resolution happens before this call.
    // A re-baked file under a new key busts the cache by itself.
    const fingerprint = createHash('sha1')
      .update(source.storageKey)
      .digest('base64url')
      .slice(0, 16);
    const hit = await this.tileCache.getOrCompute(
      tileCacheKey({ scope: 'cog-tile', z, x, y, optsFingerprint: fingerprint }),
      () => this.renderTile(source, z, x, y),
    );
    // An empty buffer is a cached "this tile is outside the raster",
    // which is worth keeping: without it, every pan past the edge
    // re-opens the COG to discover nothing is there.
    return hit.buf.length === 0 ? null : hit;
  }

  /**
   * Warp the tile's ground area out of the COG and encode a PNG.
   * Returns an empty buffer when the warp produced nothing.
   */
  private async renderTile(
    source: CogSource,
    z: number,
    x: number,
    y: number,
  ): Promise<Buffer> {
    const gdal = await this.loadGdal();
    this.ensureVsis3(gdal);
    const { bucket } = this.storage.vsis3Config();

    let src: import('gdal-async').Dataset | null = null;
    let warped: import('gdal-async').Dataset | null = null;
    let rendered: import('gdal-async').Dataset | null = null;
    // Unique per call: /vsimem is process-global, and two concurrent
    // tiles sharing a path would overwrite each other's bytes.
    const token = randomUUID();
    try {
      src = await gdal.openAsync(`/vsis3/${bucket}/${source.storageKey}`);
      const bandCount = src.bands.count();
      const dataType = String(src.bands.get(1).dataType);
      const lastInterp = String(
        src.bands.get(bandCount).colorInterpretation ?? '',
      );
      const addAlpha = needsAlphaBand(lastInterp);

      // The stretch range has to come from the whole raster, so read
      // it here, before the warp narrows the view to one tile.
      const stretch = needsRendering(dataType)
        ? this.statisticsRange(source.storageKey, src)
        : null;

      warped = await gdal.warpAsync(
        `/vsimem/cog-warp-${token}`,
        null,
        [src],
        warpArgs(tileBounds3857(z, x, y), addAlpha),
      );

      let out = warped;
      if (stretch) {
        rendered = await gdal.translateAsync(
          `/vsimem/cog-render-${token}`,
          warped,
          grayscaleArgs(
            // The warp appended alpha when it was asked to, so the
            // alpha band is last either way.
            addAlpha ? bandCount + 1 : bandCount,
            stretch.low,
            stretch.high,
          ),
        );
        out = rendered;
      }

      const path = `/vsimem/cog-tile-${token}.png`;
      const png = await gdal.drivers.get('PNG').createCopyAsync(path, out);
      png.close();
      return gdal.vsimem.release(path);
    } catch (err) {
      // Thrown, not swallowed: a source that resolved but will not
      // open is a broken layer, and answering with a blank tile
      // would cache that as the truth and hide it.
      this.log.warn(
        `COG tile ${z}/${x}/${y} failed for item ${source.itemId} ` +
          `(${source.storageKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      throw err;
    } finally {
      for (const ds of [rendered, warped, src]) {
        try {
          ds?.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Cached stretch ranges, keyed by storage key. The range describes
   * the FILE, so a re-pointed key misses naturally, and a re-baked
   * file under the same key serves with the old range until the
   * process restarts, which is the same staleness the tile cache
   * already accepts. Bounded because keys accumulate for the life of
   * the process; eviction is oldest-inserted, which is fine at this
   * size.
   */
  private readonly stretchRanges = new Map<
    string,
    { low: number; high: number }
  >();
  private static readonly MAX_STRETCH_RANGES = 512;

  /**
   * Approximate min and max of band 1, for the grey stretch, cached
   * per storage key.
   *
   * Cached because this used to run on every cache-miss tile of a
   * non-Byte raster: `getStatistics` is a synchronous native call
   * that blocks the event loop while it reads (about 10 ms when the
   * file carries stats or overviews, unbounded when it has to scan),
   * and the answer is a property of the file, not of the tile. One
   * read per file per process is the honest cost.
   *
   * Falls back to the full Byte range when statistics are
   * unavailable, which renders SOMETHING rather than failing the
   * tile: a wrong-looking layer is a report, a broken one is a
   * support call. The fallback is cached too; re-paying a broken
   * statistics read on every tile would just repeat the failure.
   */
  private statisticsRange(
    storageKey: string,
    src: import('gdal-async').Dataset,
  ): { low: number; high: number } {
    const cached = this.stretchRanges.get(storageKey);
    if (cached) return cached;

    let range = { low: 0, high: 255 };
    try {
      const stats = src.bands.get(1).getStatistics(true, true) as {
        min: number;
        max: number;
      };
      if (Number.isFinite(stats.min) && Number.isFinite(stats.max)) {
        range = { low: stats.min, high: stats.max };
      }
    } catch (err) {
      this.log.warn(
        `no statistics for the stretch (${storageKey}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (this.stretchRanges.size >= CogTileService.MAX_STRETCH_RANGES) {
      const oldest = this.stretchRanges.keys().next().value;
      if (oldest !== undefined) this.stretchRanges.delete(oldest);
    }
    this.stretchRanges.set(storageKey, range);
    return range;
  }

  /** Both shared with the elevation mosaic; see gdal-s3.ts. */
  private loadGdal(): Promise<typeof import('gdal-async')> {
    return loadGdal();
  }

  private ensureVsis3(gdal: typeof import('gdal-async')): void {
    ensureVsis3(gdal, this.storage);
  }
}

export { COG_TILE_SIZE };
