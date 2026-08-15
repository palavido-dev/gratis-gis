// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  TileCacheService,
  tileCacheKey,
  type CacheHit,
} from '../engine/tile-cache.service.js';
import { StorageService } from '../storage/storage.service.js';
import { bboxesIntersect } from './elevation-mosaic.compositor.js';
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
      // it here, before the warp narrows the view to one tile. It is
      // approximate on purpose: computed off an overview, it costs
      // about ten milliseconds instead of a full-resolution pass.
      const stretch = needsRendering(dataType)
        ? this.statisticsRange(src)
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
   * Approximate min and max of band 1, for the grey stretch.
   *
   * Falls back to the full Byte range when statistics are
   * unavailable, which renders SOMETHING rather than failing the
   * tile: a wrong-looking layer is a report, a broken one is a
   * support call.
   */
  private statisticsRange(
    src: import('gdal-async').Dataset,
  ): { low: number; high: number } {
    try {
      const stats = src.bands.get(1).getStatistics(true, true) as {
        min: number;
        max: number;
      };
      if (Number.isFinite(stats.min) && Number.isFinite(stats.max)) {
        return { low: stats.min, high: stats.max };
      }
    } catch (err) {
      this.log.warn(
        `no statistics for the stretch: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { low: 0, high: 255 };
  }

  /** Native addon, deferred so a missing prebuild cannot crash boot
   *  (same rule as ingest and the elevation mosaic). */
  private async loadGdal(): Promise<typeof import('gdal-async')> {
    const mod = await import('gdal-async');
    return (
      (mod as unknown as { default?: typeof import('gdal-async') }).default ??
      mod
    );
  }

  private vsis3Ready = false;

  /**
   * Point GDAL's /vsis3/ at MinIO using the credentials the SDK
   * client already holds. Process-global GDAL config; idempotent,
   * and identical to the elevation mosaic's, which may have run
   * first.
   */
  private ensureVsis3(gdal: typeof import('gdal-async')): void {
    if (this.vsis3Ready) return;
    const { endpoint, accessKeyId, secretAccessKey } =
      this.storage.vsis3Config();
    let host = endpoint;
    let https = true;
    try {
      const url = new URL(endpoint);
      host = url.host;
      https = url.protocol === 'https:';
    } catch {
      // Not URL-shaped; assume host[:port] as-is.
      https = false;
    }
    gdal.config.set('AWS_S3_ENDPOINT', host);
    gdal.config.set('AWS_HTTPS', https ? 'YES' : 'NO');
    gdal.config.set('AWS_VIRTUAL_HOSTING', 'FALSE');
    gdal.config.set('AWS_ACCESS_KEY_ID', accessKeyId);
    gdal.config.set('AWS_SECRET_ACCESS_KEY', secretAccessKey);
    this.vsis3Ready = true;
  }
}

export { COG_TILE_SIZE };
