// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  TileCacheService,
  tileCacheKey,
  type CacheHit,
} from '../engine/tile-cache.service.js';
import { StorageService } from '../storage/storage.service.js';
import { TileLayerService } from './tile-layer.service.js';
import {
  MOSAIC_TILE_SIZE,
  bboxesIntersect,
  compositeInto,
  encodeTerrarium,
  hasNodata,
  isAllNodata,
  tileBbox3857,
  tileBboxWgs84,
} from './elevation-mosaic.compositor.js';

/** One stack entry after ACL resolution. */
interface ResolvedDem {
  itemId: string;
  storageKey: string;
  bbox?: [number, number, number, number];
}

/**
 * Elevation mosaic tiles (#211). A map's terrain stack is an ordered
 * list of DEM items; this service serves terrarium-encoded raster-dem
 * PNG tiles composed per pixel across the stack (first entry with
 * data wins, nodata falls through). One MapLibre terrain mesh per map
 * is a renderer constraint; the mosaic is how several DEMs share it.
 *
 * The stack arrives as item ids (the client's stamped tileUrls are
 * never trusted); every entry is re-resolved through the same dual
 * ACL + prefix pin as the COG file proxy, so a viewer composes
 * exactly the DEMs they could already read one by one. Entries the
 * viewer cannot read are skipped rather than failing the tile: a
 * public map stacked over a private DEM degrades the same way the
 * single-source cog:// path always has (that layer contributes no
 * ground), instead of blanking terrain for everyone.
 *
 * COG reads go through GDAL's /vsis3/ against MinIO (range reads,
 * overview-aware via the gdalwarp app layer), and tiles are cached
 * in TileCacheService keyed on the RESOLVED stack fingerprint, so
 * two viewers with different visibility never share a cache slot.
 */
@Injectable()
export class ElevationMosaicService {
  private readonly log = new Logger(ElevationMosaicService.name);

  constructor(
    private readonly tileLayer: TileLayerService,
    private readonly storage: StorageService,
    private readonly tileCache: TileCacheService,
  ) {}

  /**
   * Resolve + compose one tile. Returns null when the tile is empty
   * (no resolvable source touches it); the controller turns that
   * into 204 so MapLibre treats the area as flat, same as a missing
   * single-source tile today.
   */
  async tile(
    user: AuthUser | null,
    stackItemIds: string[],
    z: number,
    x: number,
    y: number,
  ): Promise<(CacheHit & { empty: boolean }) | null> {
    const entries = await this.resolveStack(user, stackItemIds);
    if (entries.length === 0) return null;
    // Fingerprint the RESOLVED stack (ids + storage keys), not the
    // request: viewers with different visibility must never share a
    // slot, and a re-pointed storage key busts the cache naturally.
    const fingerprint = createHash('sha1')
      .update(entries.map((e) => `${e.itemId}:${e.storageKey}`).join('|'))
      .digest('base64url')
      .slice(0, 16);
    const cacheKey = tileCacheKey({
      scope: 'elev-mosaic',
      z,
      x,
      y,
      optsFingerprint: fingerprint,
    });
    const hit = await this.tileCache.getOrCompute(cacheKey, () =>
      this.computeTileBytes(entries, z, x, y),
    );
    return { ...hit, empty: hit.buf.length === 0 };
  }

  /**
   * Per-viewer ACL pass over the requested stack, preserving order.
   * NotFound / Forbidden entries drop out (see class doc); anything
   * else (DB down, malformed data) propagates.
   */
  private async resolveStack(
    user: AuthUser | null,
    stackItemIds: string[],
  ): Promise<ResolvedDem[]> {
    const out: ResolvedDem[] = [];
    for (const itemId of stackItemIds) {
      try {
        const dem = await this.tileLayer.resolveDemSource(user, itemId);
        out.push({ itemId, ...dem });
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 403 || status === 404) continue;
        throw err;
      }
    }
    return out;
  }

  /**
   * The actual composition, run under the tile cache's concurrency
   * cap. IO failures here THROW rather than skipping the source: a
   * DEM that resolved but won't open would otherwise render as a
   * silent hole and get cached as truth.
   */
  private async computeTileBytes(
    entries: ResolvedDem[],
    z: number,
    x: number,
    y: number,
  ): Promise<Buffer> {
    const size = MOSAIC_TILE_SIZE;
    const tileWgs84 = tileBboxWgs84(z, x, y);
    const candidates = entries.filter(
      (e) => !e.bbox || bboxesIntersect(e.bbox, tileWgs84),
    );
    if (candidates.length === 0) return Buffer.alloc(0);

    const gdal = await this.loadGdal();
    this.ensureVsis3(gdal);
    const { bucket } = this.storage.vsis3Config();
    const bb = tileBbox3857(z, x, y);
    const pixel = (bb.maxX - bb.minX) / size;
    const dest = new Float32Array(size * size).fill(NaN);

    for (const entry of candidates) {
      // Stop opening lower-priority sources once every pixel has
      // ground; the common single-coverage tile costs one source.
      if (!hasNodata(dest)) break;
      let src: import('gdal-async').Dataset | null = null;
      let warped: import('gdal-async').Dataset | null = null;
      try {
        src = await gdal.openAsync(`/vsis3/${bucket}/${entry.storageKey}`);
        warped = await gdal.drivers
          .get('MEM')
          .createAsync('', size, size, 1, 'Float32');
        warped.geoTransform = [bb.minX, pixel, 0, bb.maxY, 0, -pixel];
        warped.srs = gdal.SpatialReference.fromEPSG(3857);
        const band = await warped.bands.getAsync(1);
        band.noDataValue = NaN;
        await band.fillAsync(NaN);
        // The gdalwarp app layer (not plain GDALReprojectImage):
        // it picks matching overviews, so low-zoom tiles over a
        // large DEM read a few kilobytes instead of the full-res
        // raster. With an existing destination it warps into our
        // grid and leaves un-covered pixels at their NaN init.
        await gdal.warpAsync(null, warped, [src], [
          '-r',
          'bilinear',
          '-dstnodata',
          'nan',
        ]);
        const grid = new Float32Array(size * size);
        await band.pixels.readAsync(0, 0, size, size, grid);
        compositeInto(dest, grid);
      } catch (err) {
        this.log.warn(
          `elevation mosaic read failed for item ${entry.itemId} ` +
            `(${entry.storageKey}) at ${z}/${x}/${y}: ${
              err instanceof Error ? err.message : err
            }`,
        );
        throw err;
      } finally {
        try {
          warped?.close();
        } catch {
          /* already closed */
        }
        try {
          src?.close();
        } catch {
          /* already closed */
        }
      }
    }

    if (isAllNodata(dest)) return Buffer.alloc(0);
    return this.encodePng(gdal, dest, size);
  }

  /** Terrarium-encode the grid and PNG it via the in-memory driver. */
  private async encodePng(
    gdal: typeof import('gdal-async'),
    grid: Float32Array,
    size: number,
  ): Promise<Buffer> {
    const { r, g, b } = encodeTerrarium(grid);
    const rgb = await gdal.drivers
      .get('MEM')
      .createAsync('', size, size, 3, 'Byte');
    const path = `/vsimem/elev-mosaic-${randomUUID()}.png`;
    try {
      await (await rgb.bands.getAsync(1)).pixels.writeAsync(0, 0, size, size, r);
      await (await rgb.bands.getAsync(2)).pixels.writeAsync(0, 0, size, size, g);
      await (await rgb.bands.getAsync(3)).pixels.writeAsync(0, 0, size, size, b);
      const png = await gdal.drivers.get('PNG').createCopyAsync(path, rgb);
      png.close();
      return gdal.vsimem.release(path);
    } finally {
      try {
        rgb.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Native addon, deliberately deferred so a missing prebuild can't
   * crash boot (same rule as ingest).
   */
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
   * client already holds. Process-global GDAL config; idempotent.
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

