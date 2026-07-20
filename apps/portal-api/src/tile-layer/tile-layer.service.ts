// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PMTiles, Source, RangeResponse, Header } from 'pmtiles';
import { Prisma } from '@prisma/client';
import type { TileLayerData, ISODateString } from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  cleanupConversion,
  convertUpload,
  detectOriginalFormat,
  isRawRasterFormat,
} from './tile-conversion.js';

/**
 * Headroom multiplier applied to an upload's claimed size before
 * the space check passes.  The full hybrid pipeline lands three
 * copies of the imagery on disk transiently (the raw upload, the
 * COG output, and during pyramid build the PMTiles + tile dir
 * scratch).  2.5x is the conservative cap: it covers the worst
 * realistic case where the COG is ~equal to the upload, the
 * PMTiles ends up ~equal to the COG, and there's a small scratch
 * dir during the gdal2tiles run.
 *
 * Pre-tiled containers (PMTiles / MBTiles / XYZ-zip) use a lower
 * multiplier (1.5x) since there's no PMTiles-build step; the
 * conversion either passes through or repacks at roughly the
 * same size.
 */
const RAW_RASTER_HEADROOM = 2.5;
const PRE_TILED_HEADROOM = 1.5;

/**
 * Service for the tile_layer item type (#179).
 *
 * Two responsibilities:
 *
 *   1. After a browser uploads a .pmtiles file directly to MinIO
 *      via the presigned PUT minted by StorageService, the client
 *      calls finalizeUpload(). We read the file header via HTTP
 *      range requests against the MinIO public URL, extract the
 *      metadata (min/max zoom, bbox, center, tile type,
 *      attribution, name, description), and persist it on the
 *      item's data_json. Subsequent renders read from item.data
 *      without re-parsing the header.
 *
 *   2. proxyTileRequest() serves the bytes for the API's pmtiles
 *      proxy endpoint. MapLibre's pmtiles plugin range-reads this
 *      URL, so we have to honor the Range header. We do that by
 *      passing it through to MinIO's presigned GET; MinIO returns
 *      a 206 with the requested byte range and we stream it back
 *      to the caller. Zero per-tile compute on our side; the cost
 *      is one S3-API hop per range request.
 *
 * Why a proxy endpoint instead of letting the browser hit MinIO
 * directly: the MinIO bucket is anonymous-read by design for
 * stable URLs, but a static URL stored on the item baked into a
 * map would leak across orgs once shared. Proxying through the
 * API lets us apply the item's read ACL (the same gate as every
 * other item endpoint), and gives us an obvious spot to add
 * caching or hot-tile prefetching later.
 */
@Injectable()
export class TileLayerService {
  private readonly log = new Logger(TileLayerService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Called by the frontend after it has PUT the bytes to MinIO
   * via the presigned URL. We read the PMTiles header to extract
   * metadata, compose the tile-URL the basemap editor will
   * surface, and persist everything into item.data.
   */
  async finalizeUpload(
    user: AuthUser,
    itemId: string,
    input: {
      storageKey: string;
      storageUrl: string;
      fileName: string;
      sizeBytes: number;
    },
  ): Promise<TileLayerData> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can attach a tile file to this item.',
      );
    }
    if (typeof input.storageKey !== 'string' || input.storageKey.length === 0) {
      throw new BadRequestException('storageKey is required');
    }
    if (typeof input.storageUrl !== 'string' || input.storageUrl.length === 0) {
      throw new BadRequestException('storageUrl is required');
    }
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw new BadRequestException('fileName is required');
    }
    if (
      typeof input.sizeBytes !== 'number' ||
      !Number.isFinite(input.sizeBytes) ||
      input.sizeBytes <= 0
    ) {
      throw new BadRequestException('sizeBytes must be a positive number');
    }
    // Detect upload format. detectOriginalFormat throws a
    // BadRequest-readable error for TPK / unknown extensions; we
    // re-wrap it as a Nest exception so the response shape stays
    // consistent.
    let originalFormat;
    try {
      originalFormat = detectOriginalFormat(input.fileName);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Unsupported file type',
      );
    }

    // Run the converter.  Returns a discriminated union: either a
    // PMTiles result (pre-tiled inputs) or a COG result (raw
    // raster inputs).  Pass-through inputs (already-PMTiles
    // uploads) come back with format='pmtiles' and outputPath=''.
    let conversion: Awaited<ReturnType<typeof convertUpload>> | null = null;
    try {
      conversion = await convertUpload(
        // Stream the source straight from MinIO via the S3 client.
        // Avoids fetching a user-supplied URL (the prior storageUrl
        // input was an SSRF surface) and side-steps the unnecessary
        // round-trip through the public-base hostname when MINIO_
        // PUBLIC_BASE is a CDN-fronted URL.
        (destPath) =>
          this.storage.streamObjectToDisk(input.storageKey, destPath),
        input.fileName,
      );
    } catch (err) {
      // convertUpload owns its own temp-dir lifecycle: any workdir
      // it created before throwing is its own to clean up. We don't
      // have a handle to it from out here. The original upload
      // stays in MinIO so the user can retry without re-uploading.
      throw new BadRequestException(
        `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // After this block `effectiveStorageKey` / `effectiveStorageUrl`
    // point at the served file, regardless of which branch ran.
    let effectiveStorageKey = input.storageKey;
    let effectiveStorageUrl = input.storageUrl;
    let effectiveSizeBytes = input.sizeBytes;
    const conversionMs = conversion.durationMs;
    try {
      if (conversion.outputPath) {
        // Upload the converted file back to MinIO under a fresh
        // key.  Content-type matters: PMTiles is application/
        // octet-stream (no registered mime), COG is image/tiff so
        // MinIO sets a sensible response header for clients that
        // sniff it.
        const contentType =
          conversion.format === 'cog' ? 'image/tiff' : 'application/octet-stream';
        const uploaded = await this.storage.uploadLocalFile(
          'item-tile-layer',
          conversion.outputPath,
          contentType,
        );
        effectiveStorageKey = uploaded.key;
        effectiveStorageUrl = uploaded.publicUrl;
        effectiveSizeBytes = conversion.outputBytes;
        // Best-effort delete of the original upload.  PMTiles
        // pass-through uploads skip this (outputPath was '' so we
        // never reached here); raw-raster uploads delete the
        // source TIFF / JP2 once the COG has landed.  A failed
        // delete leaks bytes but doesn't break the item.
        try {
          await this.storage.deleteObject(input.storageKey);
        } catch (err) {
          this.log.warn(
            `Failed to delete original upload ${input.storageKey}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } finally {
      // Clean up the converter's temp workdir regardless of upload
      // outcome. conversion is non-null here (we returned early via
      // the catch block above if convertUpload threw), so reading
      // .workDir directly is safe.
      if (conversion.workDir) await cleanupConversion(conversion.workDir);
    }

    // Branch on output format.  PMTiles serves via the existing
    // header-parsing path; COG goes through a separate metadata
    // capture (gdalinfo) and persists the bridge-state fields.
    if (conversion.format === 'cog') {
      const fileNameOut = input.fileName.replace(
        /\.(tif|tiff|geotiff|cog|jp2)$/i,
        '.tif',
      );
      const data: TileLayerData = {
        version: 1,
        format: 'cog',
        kind: 'raster',
        storageKey: effectiveStorageKey,
        storageUrl: effectiveStorageUrl,
        fileName: fileNameOut,
        sizeBytes: effectiveSizeBytes,
        uploadedAt: new Date().toISOString() as ISODateString,
        originalFormat,
        originalFileName: input.fileName,
        originalSizeBytes: input.sizeBytes,
        conversionMs,
        cogStorageKey: effectiveStorageKey,
        cogStorageUrl: effectiveStorageUrl,
        cogSizeBytes: effectiveSizeBytes,
        processingState: 'cog-ready',
        tileType: 'png',
      };
      if (conversion.bbox) data.bbox = conversion.bbox;
      if (typeof conversion.maxZoom === 'number') {
        data.maxZoom = conversion.maxZoom;
        data.minZoom = 0;
      }
      if (conversion.bbox) {
        const [w, s, e, n] = conversion.bbox;
        data.centerLng = (w + e) / 2;
        data.centerLat = (s + n) / 2;
        if (typeof conversion.maxZoom === 'number') {
          // Suggested center zoom is one step below the native
          // max so the initial view shows some context rather
          // than fully zoomed in.
          data.centerZoom = Math.max(0, conversion.maxZoom - 1);
        }
      }
      // cog-protocol URL.  Mirrors the pmtiles convention --
      // MapLibre's cog-protocol plugin keys off the `cog://`
      // prefix and treats the rest as the HTTP URL to range-read.
      data.tileUrl = `cog:///api/portal/tile-layer/${itemId}/file`;
      await this.items.update(user, itemId, {
        data: data as unknown as Prisma.JsonObject,
      });
      return data;
    }

    // PMTiles branch.  Read the PMTiles header via HTTP range
    // requests against the MinIO public URL. The pmtiles library
    // handles directory walking and metadata parsing; we only
    // need to provide a Source that fetches byte ranges.
    let header: Header | null = null;
    let metadata: Record<string, unknown> = {};
    try {
      const source = new FetchRangeSource(effectiveStorageUrl);
      const pmt = new PMTiles(source);
      header = await pmt.getHeader();
      metadata = (await pmt.getMetadata()) as Record<string, unknown>;
    } catch (err) {
      this.log.warn(
        `Failed to parse PMTiles header at ${effectiveStorageUrl}: ${err instanceof Error ? err.message : err}`,
      );
      // Best-effort: keep the upload but persist with empty
      // metadata so the user can still try (the file might be
      // malformed or have an unusual variant). The detail page
      // surfaces this by showing "(metadata could not be read)".
    }

    const tileType = header ? tileTypeToken(header.tileType) : 'unknown';
    const data: TileLayerData = {
      version: 1,
      format: 'pmtiles',
      kind: tileType === 'mvt' ? 'vector' : 'raster',
      storageKey: effectiveStorageKey,
      storageUrl: effectiveStorageUrl,
      // Display name strips the original extension and replaces
      // with .pmtiles to reflect what's actually stored, but we
      // also keep the original filename below for provenance.
      fileName:
        originalFormat === 'pmtiles'
          ? input.fileName
          : input.fileName.replace(/\.(mbtiles|zip)$/i, '.pmtiles'),
      sizeBytes: effectiveSizeBytes,
      uploadedAt: new Date().toISOString() as ISODateString,
      originalFormat,
    };
    if (originalFormat !== 'pmtiles') {
      data.originalFileName = input.fileName;
      data.originalSizeBytes = input.sizeBytes;
      data.conversionMs = conversionMs;
    }
    // Only persist metadata fields that came back populated;
    // exactOptionalPropertyTypes refuses undefined assignments to
    // optional string/number fields, so we omit instead.
    if (header) {
      if (Number.isFinite(header.minZoom)) data.minZoom = header.minZoom;
      if (Number.isFinite(header.maxZoom)) data.maxZoom = header.maxZoom;
      if (
        Number.isFinite(header.minLon) &&
        Number.isFinite(header.minLat) &&
        Number.isFinite(header.maxLon) &&
        Number.isFinite(header.maxLat)
      ) {
        data.bbox = [
          header.minLon,
          header.minLat,
          header.maxLon,
          header.maxLat,
        ];
      }
      if (Number.isFinite(header.centerLon)) data.centerLng = header.centerLon;
      if (Number.isFinite(header.centerLat)) data.centerLat = header.centerLat;
      if (Number.isFinite(header.centerZoom))
        data.centerZoom = header.centerZoom;
      if (tileType !== 'unknown') data.tileType = tileType;
    }
    const attribution = pickString(metadata, 'attribution');
    if (attribution) data.attribution = attribution;
    const name = pickString(metadata, 'name');
    if (name) data.name = name;
    const description = pickString(metadata, 'description');
    if (description) data.description = description;

    // Compose the runtime URL the basemap editor will display.
    // MapLibre's pmtiles plugin keys off the `pmtiles://` prefix
    // and treats the rest as the HTTP URL to range-read from.
    // We use a relative path so the URL stays valid regardless of
    // which hostname the portal is served from (gratisgis.org vs
    // a custom domain a fork uses).
    data.tileUrl = `pmtiles:///api/portal/tile-layer/${itemId}/file`;

    // PATCH item.data through the normal items pipeline so any
    // downstream hooks (dependency extractor, bbox cache, etc.)
    // see the new state.
    // The shared-types TileLayerData interface doesn't have a
    // string index signature; Prisma's InputJsonValue wants one
    // for plain object types. Cast through Prisma.JsonObject to
    // match the pattern other services use when persisting typed
    // shapes into the polymorphic data_json column.
    await this.items.update(user, itemId, {
      data: data as unknown as Prisma.JsonObject,
    });
    return data;
  }

  /**
   * Resolve the storageUrl for a tile_layer item the caller has
   * read access to. Used by the proxy endpoint to know where to
   * forward range requests. NotFound when the caller can't read
   * the item; that's the ACL gate.
   */
  async resolveStorageUrl(user: AuthUser, itemId: string): Promise<string> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    const data: unknown = item.data;
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    if (!data.storageUrl) {
      throw new NotFoundException('Tile layer file URL is missing.');
    }
    return data.storageUrl;
  }

  /**
   * Resolve the MinIO storage KEY for the active tile-layer file.
   * Used by the range-proxy controller after the bucket policy was
   * tightened to deny anonymous GET on `item-tile-layer/*`: the
   * controller uses the key to fetch via the SDK with portal-api's
   * credentials instead of hitting the public URL.  Performs the
   * same ACL check as resolveStorageUrl.
   */
  async resolveStorageKey(
    user: AuthUser | null,
    itemId: string,
  ): Promise<string> {
    // #185: `user` is null for anonymous requests, which resolve
    // only when the item is shared publicly (the public-mirror
    // rule). This is what lets a public map with a tile overlay
    // layer render for signed-out visitors, same dual path as the
    // point-cloud serve endpoint.
    let data: unknown;
    if (user) {
      const item = await this.items.get(user, itemId);
      if (item.type !== 'tile_layer') {
        throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
      }
      data = item.data;
    } else {
      const item = await this.prisma.item.findFirst({
        where: {
          id: itemId,
          type: 'tile_layer',
          access: 'public',
          deletedAt: null,
        },
        select: { data: true },
      });
      if (!item) {
        throw new NotFoundException('Tile layer not found.');
      }
      data = item.data;
    }
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    // Prefer the active PMTiles key (set after the background pyramid
    // build finishes); fall back to the COG key (used during the
    // pre-pyramid window), and to the legacy `storageKey` for older
    // rows that predate the hybrid serving model.
    const d = data as unknown as Record<string, unknown>;
    const key =
      (typeof d.pmtilesStorageKey === 'string' && d.pmtilesStorageKey) ||
      (typeof d.cogStorageKey === 'string' && d.cogStorageKey) ||
      (typeof d.storageKey === 'string' && d.storageKey) ||
      null;
    if (!key) {
      throw new NotFoundException('Tile layer storage key is missing.');
    }
    return key;
  }

  /**
   * Pre-upload space check.  The frontend calls this when the
   * user picks a file but before requesting a presigned URL.
   * Returns whether the upload + conversion + serving pipeline
   * fits in the host's remaining disk, applying a multiplier
   * keyed off the file's expected format (raw rasters need more
   * headroom because they pass through both COG and PMTiles).
   *
   * The host-disk check uses `statfs` on the api container's
   * `/tmp`, which lives on the same underlying volume as MinIO's
   * bucket in the standard single-host deployment.  Multi-host
   * deployments would need a different check; that's a follow-up.
   *
   * No auth gate beyond the route's JwtAuthGuard: knowing the
   * portal's free disk space isn't sensitive (a user with edit
   * access to an item would learn it anyway during a real
   * upload).
   */
  async checkUploadSpace(input: {
    fileName: string;
    sizeBytes: number;
  }): Promise<{
    ok: boolean;
    reason?: string;
    requiredBytes: number;
    hostFreeBytes: number;
    hostTotalBytes: number;
  }> {
    if (
      typeof input.sizeBytes !== 'number' ||
      !Number.isFinite(input.sizeBytes) ||
      input.sizeBytes <= 0
    ) {
      throw new BadRequestException('sizeBytes must be a positive number');
    }
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw new BadRequestException('fileName is required');
    }

    // Multiplier picked from the format detection.  Unknown
    // extensions fall through detectOriginalFormat's reject path;
    // surface the same error to the user up front so they don't
    // wait through the upload to find out their file isn't
    // accepted.
    let multiplier: number;
    try {
      const fmt = detectOriginalFormat(input.fileName);
      multiplier = isRawRasterFormat(fmt) ? RAW_RASTER_HEADROOM : PRE_TILED_HEADROOM;
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Unsupported file type',
      );
    }

    const requiredBytes = Math.ceil(input.sizeBytes * multiplier);

    // Probe the host disk.  bavail (blocks available to non-root)
    // is the relevant figure since the api container runs as the
    // unprivileged `app` user.  statfs returns `bigint` for size
    // fields in modern Node; coerce to number after the math.
    let hostFreeBytes = 0;
    let hostTotalBytes = 0;
    try {
      const st = await statfs(tmpdir());
      const bsize = Number(st.bsize);
      hostFreeBytes = Number(st.bavail) * bsize;
      hostTotalBytes = Number(st.blocks) * bsize;
    } catch (err) {
      this.log.warn(
        `statfs(${tmpdir()}) failed: ${err instanceof Error ? err.message : err}`,
      );
      // If we can't read the disk, fail-open: don't block the
      // upload purely because the probe broke.  The real upload
      // will surface any actual ENOSPC at the storage layer.
      return {
        ok: true,
        requiredBytes,
        hostFreeBytes: -1,
        hostTotalBytes: -1,
      };
    }

    if (requiredBytes > hostFreeBytes) {
      return {
        ok: false,
        reason: `This upload would need about ${formatBytes(requiredBytes)} of working space (${multiplier.toFixed(1)}x the file size for the upload + conversion pipeline). The host has ${formatBytes(hostFreeBytes)} free. Pick a smaller file or contact the admin to free space.`,
        requiredBytes,
        hostFreeBytes,
        hostTotalBytes,
      };
    }
    return {
      ok: true,
      requiredBytes,
      hostFreeBytes,
      hostTotalBytes,
    };
  }

  /**
   * Retry a failed pyramid build.  Flips a tile_layer item from
   * processingState='tiling-failed' back to 'cog-ready' so the
   * pyramid worker re-claims it on the next poll tick.  Clears
   * the previous tilingError.  Only the owner or an org admin
   * can retry.
   *
   * No-op (but not an error) when the item is in any other
   * state -- a UI that races a successful build against a retry
   * click shouldn't crash.
   */
  async retryPyramid(user: AuthUser, itemId: string): Promise<TileLayerData> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can retry the pyramid build.',
      );
    }
    const data: unknown = item.data;
    if (!isTileLayerData(data)) {
      throw new BadRequestException('Tile layer has no upload yet.');
    }
    if (data.processingState !== 'tiling-failed') {
      // Idempotent: just return the current state.
      return data;
    }
    const patch: Partial<TileLayerData> = {
      processingState: 'cog-ready',
    };
    await this.items.update(user, itemId, {
      data: {
        ...(data as unknown as Prisma.JsonObject),
        ...(patch as unknown as Prisma.JsonObject),
        // Explicit null so jsonb merge drops the previous error
        // string (Prisma's update treats undefined as "skip"; the
        // worker's clearTilingError path uses jsonb's '-' operator
        // which we don't have here without a raw query).
        tilingError: null,
      } as Prisma.JsonObject,
    });
    // Strip tilingError from the returned shape too -- the field
    // is optional on TileLayerData (exactOptionalPropertyTypes
    // refuses an explicit undefined assignment).
    const { tilingError: _stripped, ...rest } = data;
    return { ...rest, ...patch };
  }

  /**
   * Drop the MinIO object backing this tile layer. Called by the
   * items service during purge. Best-effort: a missing key is
   * fine (the item may have been created without the upload ever
   * completing).
   */
  async tearDownStorage(itemId: string, data: unknown): Promise<void> {
    if (!isTileLayerData(data)) return;
    const tl: TileLayerData = data;
    if (!tl.storageKey) return;
    try {
      await this.storage.deleteObject(tl.storageKey);
    } catch (err) {
      this.log.warn(
        `Failed to delete tile_layer storage object for item ${itemId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Translate the PMTiles header's `tileType` integer to the token
 * we persist on TileLayerData.tileType. Spec values:
 *   0 unknown, 1 mvt, 2 png, 3 jpeg, 4 webp, 5 avif.
 */
/**
 * Format a byte count for the space-check user-facing message.
 * Mirrors the front-end's humanSize() in tile-layer/editor.tsx
 * but lives here too so the api can produce a coherent error
 * string without having to round-trip the raw number.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function tileTypeToken(
  t: number,
): 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'unknown' {
  switch (t) {
    case 1:
      return 'mvt';
    case 2:
      return 'png';
    case 3:
      return 'jpg';
    case 4:
      return 'webp';
    case 5:
      return 'avif';
    default:
      return 'unknown';
  }
}

function pickString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = metadata[key];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return undefined;
}

/**
 * pmtiles.Source adapter that range-reads a public HTTP URL with
 * the global fetch() (Node 20+). The pmtiles package ships a
 * built-in FetchSource but only for the browser; on the server
 * we need to provide our own minimal implementation.
 *
 * Caches the etag so re-reads of the same file across calls
 * benefit from PMTiles's own directory cache. We deliberately
 * don't add a higher-level cache here; the package caches
 * decoded directories internally and the header itself is small.
 */
class FetchRangeSource implements Source {
  private etag?: string;

  constructor(private readonly url: string) {}

  getKey(): string {
    return this.url;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<RangeResponse> {
    const headers: Record<string, string> = {
      Range: `bytes=${offset}-${offset + length - 1}`,
    };
    if (this.etag) headers['If-Match'] = this.etag;
    const init: RequestInit = { headers };
    if (signal) init.signal = signal;
    const res = await fetch(this.url, init);
    if (res.status === 416) {
      throw new Error(
        `PMTiles source replied 416 for range ${offset}-${offset + length - 1}; file may be smaller than the directory claims`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `PMTiles source HTTP ${res.status} for range ${offset}-${offset + length - 1}`,
      );
    }
    const etag = res.headers.get('etag') ?? undefined;
    if (etag && !this.etag) this.etag = etag;
    const buf = await res.arrayBuffer();
    const result: RangeResponse = { data: buf };
    if (etag) result.etag = etag;
    const cc = res.headers.get('cache-control');
    if (cc) result.cacheControl = cc;
    const expires = res.headers.get('expires');
    if (expires) result.expires = expires;
    return result;
  }
}
