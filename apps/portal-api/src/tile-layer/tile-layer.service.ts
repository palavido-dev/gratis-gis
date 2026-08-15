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
import { ConfigService } from '@nestjs/config';
import { PMTiles, Source, RangeResponse, Header, TileType } from 'pmtiles';
import { Prisma } from '@prisma/client';
import type {
  TileLayerData,
  TileLayerSource,
  ISODateString,
  MergeCostCoefficients,
} from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { assertServerHeavyTier } from '../analysis/analysis-tiers.js';
import {
  estimateMosaic,
  mosaicCostModel,
  validateMosaicSources,
} from './mosaic-sources.js';
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
 * Storage-key prefix the presign path mints for tile-layer uploads
 * (StorageService composes keys as `<kind>/<uuid>` and the upload
 * kind here is `item-tile-layer`).  Every client-supplied or
 * item-data-supplied key must sit under it before we read or
 * delete through it with portal-api's credentials: the serve proxy
 * is @Public, so an unpinned key would let any MinIO object
 * (feature-attachment/..., item-file/...) be exfiltrated through a
 * tile_layer item.  Mirrors the point-cloud finalize guard.
 */
const TILE_LAYER_KEY_PREFIX = 'item-tile-layer/';

/**
 * How many open PMTiles archives the XYZ endpoint keeps around.
 *
 * The cap is the point of the structure, not an optimization: an
 * unbounded map would pin one decoded header plus root directory
 * per archive for the life of the process, and a crawler walking
 * every tile_layer in a large portal would size that map by the
 * item count. 32 is far more than the handful of archives any one
 * map or QGIS project draws at once.
 */
const PMTILES_ARCHIVE_CACHE_SIZE = 32;

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

  /**
   * Open archives for the XYZ tile endpoint. Not a general cache:
   * only getPmtilesTile reads it, and it holds no tile bytes.
   * Staleness is a non-issue because a re-baked pyramid lands under
   * a fresh storage key, so the key it is entered under changes
   * with the bytes.
   */
  private readonly archives = new PmtilesArchiveCache(
    PMTILES_ARCHIVE_CACHE_SIZE,
  );

  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
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
    // Only accept keys under our own prefix: the finalize body is
    // client-supplied, and a key pointing into another prefix
    // (attachments, file items) must not become readable through
    // the public tile-layer proxy.
    if (!input.storageKey.startsWith(TILE_LAYER_KEY_PREFIX)) {
      throw new BadRequestException('storageKey is not a tile-layer upload');
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

    // PMTiles branch.  Read the PMTiles header via ranged reads
    // through the S3 SDK against the (prefix-validated) storage
    // key. The pmtiles library handles directory walking and
    // metadata parsing; we only need to provide a Source that
    // fetches byte ranges.  Reading by key rather than fetching
    // the client-supplied storageUrl closes the SSRF that URL
    // opened (finalize would range-read any URL the client put in
    // the body), and it also works for private-kind objects, whose
    // publicUrl is a relative api path plain fetch cannot resolve.
    let header: Header | null = null;
    let metadata: Record<string, unknown> = {};
    try {
      const source = new StorageRangeSource(this.storage, effectiveStorageKey);
      const pmt = new PMTiles(source);
      header = await pmt.getHeader();
      metadata = (await pmt.getMetadata()) as Record<string, unknown>;
    } catch (err) {
      this.log.warn(
        `Failed to parse PMTiles header for ${effectiveStorageKey}: ${err instanceof Error ? err.message : err}`,
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
    format?: 'pmtiles' | 'cog',
  ): Promise<string> {
    const data = await this.readTileLayerDataDualAcl(user, itemId);
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    const d = data as unknown as Record<string, unknown>;
    // Serve-time prefix pin, same rule as finalize: item.data is
    // owner-writable through the generic items PATCH, so a key
    // that escaped the finalize check (or was edited in later)
    // must still never make this @Public proxy stream another
    // prefix's objects with portal-api's credentials.  A
    // non-conforming key is treated as absent.
    const tileKey = (v: unknown): string | null =>
      typeof v === 'string' && v.startsWith(TILE_LAYER_KEY_PREFIX) ? v : null;
    // #185: an explicit format pins the bytes a client gets. Map
    // layers stamp a format-suffixed URL at add time; without the
    // pin, a layer stamped cog:// during the pre-pyramid window
    // would silently start receiving PMTiles bytes once the
    // background build finishes and the bare endpoint switches to
    // preferring the pyramid.
    if (format === 'pmtiles') {
      const pmtilesKey = tileKey(d.pmtilesStorageKey);
      if (pmtilesKey) return pmtilesKey;
      // Pass-through uploads (a .pmtiles the user handed us, or an
      // .mbtiles / XYZ zip the converter repacked) never run the
      // pyramid worker, so nothing ever sets pmtilesStorageKey on
      // them: their archive IS the item's storageKey. Gating on the
      // stored format keeps the #185 pin intact, because a
      // COG-backed item still refuses here rather than answering a
      // pmtiles client with GeoTIFF bytes.
      if (d.format === 'pmtiles') {
        const passthroughKey = tileKey(d.storageKey);
        if (passthroughKey) return passthroughKey;
      }
      throw new NotFoundException(
        'This layer has no optimized tile file yet.',
      );
    }
    if (format === 'cog') {
      const cogKey = tileKey(d.cogStorageKey) ?? tileKey(d.storageKey);
      if (cogKey) return cogKey;
      throw new NotFoundException('This layer has no image file.');
    }
    // Bare endpoint: prefer the active PMTiles key (set after the
    // background pyramid build finishes); fall back to the COG key
    // (used during the pre-pyramid window), and to the legacy
    // `storageKey` for older rows that predate the hybrid serving
    // model.
    const key =
      tileKey(d.pmtilesStorageKey) ??
      tileKey(d.cogStorageKey) ??
      tileKey(d.storageKey);
    if (!key) {
      throw new NotFoundException('Tile layer storage key is missing.');
    }
    return key;
  }

  /**
   * What the XYZ tile route should read for this item, in one ACL'd
   * pass: which kind of file backs it, where that file is, and the
   * footprint if the item carries one.
   *
   * The tile route serves both kinds and the caller cannot tell them
   * apart from the URL, by design. A client that stamped a tile URL
   * while an upload was still a COG keeps working after the pyramid
   * build turns it into PMTiles, and vice versa; the item decides,
   * per request. Deciding in the controller instead would mean two
   * ACL reads for the COG branch.
   *
   * PMTiles wins when both keys are present. That is the same
   * preference the bare file endpoint uses, and it is the cheaper
   * read: a pyramid tile is a byte-range fetch, a COG tile is a warp.
   */
  async resolveTileSource(
    user: AuthUser | null,
    itemId: string,
  ): Promise<{
    kind: 'pmtiles' | 'cog';
    storageKey: string;
    bbox?: [number, number, number, number];
  }> {
    const data = await this.readTileLayerDataDualAcl(user, itemId);
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    const d = data as unknown as Record<string, unknown>;
    // Same serve-time prefix pin as resolveStorageKey: item.data is
    // owner-writable through the generic items PATCH, so a key that
    // escaped the finalize check must never make this @Public route
    // read another prefix with portal-api's credentials.
    const tileKey = (v: unknown): string | null =>
      typeof v === 'string' && v.startsWith(TILE_LAYER_KEY_PREFIX) ? v : null;
    const bbox =
      Array.isArray(d.bbox) &&
      d.bbox.length === 4 &&
      d.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? ([...d.bbox] as [number, number, number, number])
        : undefined;

    const pmtiles = tileKey(d.pmtilesStorageKey);
    if (pmtiles) {
      return { kind: 'pmtiles', storageKey: pmtiles, ...(bbox ? { bbox } : {}) };
    }
    // A pass-through upload (a .pmtiles the user handed us, or an
    // .mbtiles the converter repacked) never runs the pyramid
    // worker, so nothing sets pmtilesStorageKey: its archive IS the
    // item's storageKey, and only the stored format says so.
    if (d.format === 'pmtiles') {
      const passthrough = tileKey(d.storageKey);
      if (passthrough) {
        return {
          kind: 'pmtiles',
          storageKey: passthrough,
          ...(bbox ? { bbox } : {}),
        };
      }
    }
    const cog = tileKey(d.cogStorageKey) ?? tileKey(d.storageKey);
    if (cog) {
      return { kind: 'cog', storageKey: cog, ...(bbox ? { bbox } : {}) };
    }
    throw new NotFoundException('Tile layer storage key is missing.');
  }

  /**
   * #185 / #211: the shared dual-ACL read behind every serve-time
   * resolver. `user` is null for anonymous requests, which resolve
   * only when the item is shared publicly (the public-mirror rule).
   */
  private async readTileLayerDataDualAcl(
    user: AuthUser | null,
    itemId: string,
  ): Promise<unknown> {
    if (user) {
      const item = await this.items.get(user, itemId);
      if (item.type !== 'tile_layer') {
        throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
      }
      return item.data;
    }
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
    return item.data;
  }

  /**
   * Read one tile out of the item's PMTiles archive, addressed the
   * XYZ way. Returns null when the archive holds no tile there,
   * which is the ordinary case outside a sparse pyramid's coverage.
   *
   * Reading a tile rather than proxying the archive is what lets a
   * desktop GIS draw a raster PMTiles at all: GDAL's PMTiles driver
   * handles vector archives only and rejects a PNG one outright, so
   * the archive itself is unopenable there.
   *
   * The archive instance is pooled per storage key because the
   * pmtiles library keeps the decoded header and root directory on
   * the instance. Discarding it would turn every tile into three
   * ranged reads against MinIO instead of one.
   */
  async getPmtilesTile(
    user: AuthUser | null,
    itemId: string,
    z: number,
    x: number,
    y: number,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const storageKey = await this.resolveStorageKey(user, itemId, 'pmtiles');
    return this.getPmtilesTileByKey(storageKey, z, x, y);
  }

  /**
   * The same read with the ACL already done, for a caller that
   * resolved the item once and then branched on what backs it (see
   * resolveTileSource). Taking a raw storage key here is safe only
   * because every caller got it from a resolver that applied the
   * dual ACL and the prefix pin; nothing may pass a key straight off
   * a request.
   */
  async getPmtilesTileByKey(
    storageKey: string,
    z: number,
    x: number,
    y: number,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const archive = this.archives.get(
      storageKey,
      (key) => new PMTiles(new StorageRangeSource(this.storage, key)),
    );
    const tile = await archive.getZxy(z, x, y);
    if (!tile) return null;
    // Free after getZxy: the same instance already resolved and
    // cached the header to find the tile.
    const header = await archive.getHeader();
    return {
      data: Buffer.from(tile.data),
      contentType: tileTypeContentType(header.tileType),
    };
  }

  /**
   * #211: resolve one elevation-mosaic stack entry. Same dual ACL
   * and serve-time prefix pin as resolveStorageKey, plus the `dem`
   * flag gate: only elevation-flagged layers may be composed, so
   * the mosaic endpoint can't be pointed at arbitrary rasters. The
   * WGS84 bbox rides along so the composer can skip sources that
   * don't touch a tile without opening them.
   */
  async resolveDemSource(
    user: AuthUser | null,
    itemId: string,
  ): Promise<{
    storageKey: string;
    bbox?: [number, number, number, number];
  }> {
    const data = await this.readTileLayerDataDualAcl(user, itemId);
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    const d = data as unknown as Record<string, unknown>;
    if (d.dem !== true) {
      throw new NotFoundException('Not an elevation layer.');
    }
    const tileKey = (v: unknown): string | null =>
      typeof v === 'string' && v.startsWith(TILE_LAYER_KEY_PREFIX) ? v : null;
    const storageKey = tileKey(d.cogStorageKey) ?? tileKey(d.storageKey);
    if (!storageKey) {
      throw new NotFoundException('This layer has no elevation file.');
    }
    const bbox =
      Array.isArray(d.bbox) &&
      d.bbox.length === 4 &&
      d.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? ([...d.bbox] as [number, number, number, number])
        : undefined;
    return { storageKey, ...(bbox ? { bbox } : {}) };
  }

  // ---------------------- imagery mosaic (#199) ----------------------

  /** Deployment-wide mosaic cost model, for the client's pre-upload
   *  estimate. Same contract as the point-cloud merge-limits. */
  mosaicLimits(): MergeCostCoefficients {
    return mosaicCostModel();
  }

  /**
   * Queue a mosaic build over the given source images (#199).
   * Records the sources on the item, flips it to 'building', and
   * enqueues an imagery-mosaic job the worker runs with
   * gdalbuildvrt + a COG translate. The item's currently-served
   * file (if any) stays in place so a rebuild never blanks a live
   * layer. Mirrors the point-cloud buildFromSources contract.
   */
  async mosaicBuild(
    user: AuthUser,
    itemId: string,
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ): Promise<{ jobId: string; itemId: string; estimatedSec: number; humanEstimate: string }> {
    const item = await this.assertMosaicTarget(user, itemId, 'build');
    const sources = validateMosaicSources(body.sources);
    // A rebuild over already-registered sources (the failed-build
    // retry path) keeps each source's original addedAt instead of
    // restamping history.
    const prev = isTileLayerData(item.data) ? item.data : null;
    const prevAdded = new Map(
      (prev?.sources ?? []).map((s) => [s.storageKey, s.addedAt]),
    );
    for (const s of sources) {
      const kept = prevAdded.get(s.storageKey);
      if (kept) s.addedAt = kept;
    }
    return this.enqueueMosaic(user, item, sources);
  }

  /**
   * Append more source images to an existing mosaic and rebuild
   * over the full set (#199). The VRT re-composition is cheap; the
   * COG encode pays by total extent, which is exactly what the
   * estimate models.
   */
  async mosaicAddSources(
    user: AuthUser,
    itemId: string,
    body: {
      sources: Array<{ storageKey: string; fileName: string; sizeBytes: number }>;
    },
  ): Promise<{ jobId: string; itemId: string; estimatedSec: number; humanEstimate: string }> {
    const item = await this.assertMosaicTarget(user, itemId, 'add');
    const added = validateMosaicSources(body.sources);
    const prev = isTileLayerData(item.data) ? item.data : null;
    const existingSources = [...(prev?.sources ?? [])];
    // Adding images to a layer that was a single-file upload: fold
    // the original raster in as the first source. The archival COG
    // is the master (the raw upload is deleted after conversion);
    // a pre-tiled package (PMTiles with no COG) has no raster to
    // fold in, so extending it is refused with guidance.
    if (existingSources.length === 0 && prev?.storageKey) {
      const originalKey =
        typeof prev.cogStorageKey === 'string' &&
        prev.cogStorageKey.startsWith(TILE_LAYER_KEY_PREFIX)
          ? prev.cogStorageKey
          : prev.storageKey.startsWith(TILE_LAYER_KEY_PREFIX) &&
              prev.format === 'cog'
            ? prev.storageKey
            : null;
      if (!originalKey) {
        throw new BadRequestException(
          'This layer was uploaded as a pre-tiled package, which cannot ' +
            'be extended with more images. Create a new imagery layer ' +
            'from the source images instead.',
        );
      }
      existingSources.push({
        storageKey: originalKey,
        fileName: prev.fileName || 'original.tif',
        sizeBytes: prev.cogSizeBytes ?? prev.sizeBytes ?? 0,
        addedAt: prev.uploadedAt ?? (new Date().toISOString() as ISODateString),
      });
    }
    const existingKeys = new Set(existingSources.map((s) => s.storageKey));
    for (const s of added) {
      if (existingKeys.has(s.storageKey)) {
        throw new BadRequestException(
          'One of those images is already part of this mosaic.',
        );
      }
    }
    return this.enqueueMosaic(user, item, [...existingSources, ...added]);
  }

  /** Shared guards for both mosaic entry points. */
  private async assertMosaicTarget(
    user: AuthUser,
    itemId: string,
    verb: 'build' | 'add',
  ): Promise<{ id: string; data: unknown }> {
    assertServerHeavyTier(this.cfg, 'Building imagery mosaics');
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        verb === 'build'
          ? 'Only the owner or an org admin can build this mosaic.'
          : 'Only the owner or an org admin can add images to this mosaic.',
      );
    }
    const data = isTileLayerData(item.data) ? item.data : null;
    if (data?.kind === 'vector') {
      throw new BadRequestException(
        'This layer holds street-map style vector tiles; mosaics are for imagery.',
      );
    }
    if (data?.dem) {
      throw new BadRequestException(
        'This is an elevation layer. Elevation is composed per map ' +
          "through the terrain stack, not by rebuilding the layer's file.",
      );
    }
    return item;
  }

  /**
   * Shared tail of build + add: refuse what cannot finish inside
   * the worker's wall (#205 rule), write the source list and
   * 'building' state onto the item, then create the imagery-mosaic
   * job. The served file and metadata stay untouched so the layer
   * stays live until the worker swaps in the fresh mosaic.
   */
  private async enqueueMosaic(
    user: AuthUser,
    item: { id: string; data: unknown },
    sources: TileLayerSource[],
  ): Promise<{ jobId: string; itemId: string; estimatedSec: number; humanEstimate: string }> {
    const totalBytes = sources.reduce((n, s) => n + s.sizeBytes, 0);
    const estimate = estimateMosaic(totalBytes, sources.length);
    if (estimate.overCeiling) {
      throw new BadRequestException(
        `This mosaic is very large: ${sources.length} images, ` +
          `${(totalBytes / 1024 ** 3).toFixed(1)} GB. Building it would take ` +
          `${estimate.humanEstimate}, beyond what this server allows in one ` +
          'job. Split it into smaller mosaics, or raise ' +
          'MOSAIC_TIME_CEILING_SEC if this server can genuinely afford ' +
          'longer builds.',
      );
    }
    const prev = isTileLayerData(item.data) ? item.data : null;
    const data: TileLayerData = {
      // Preserve the currently-served file + metadata during a
      // rebuild; a fresh build starts from an empty served file in
      // the cog-bridge shape the worker will fill in.
      ...(prev ?? {
        version: 1,
        format: 'cog',
        kind: 'raster',
        storageKey: '',
        storageUrl: '',
        fileName: '',
        sizeBytes: 0,
        uploadedAt: new Date(0).toISOString() as ISODateString,
      }),
      version: 1,
      sources,
      processingState: 'building',
    };
    delete data.processingError;

    await this.items.update(user, item.id, {
      data: data as unknown as Prisma.JsonObject,
    });

    const job = await this.prisma.analysisJob.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        kind: 'imagery-mosaic',
        params: { sourceKeys: sources.map((s) => s.storageKey) },
        sourceItemId: item.id,
        targetItemId: item.id,
      },
    });
    this.log.log(
      `tile_layer ${item.id}: queued imagery-mosaic over ` +
        `${sources.length} image(s), estimated ${estimate.estimatedSec}s ` +
        `(job ${job.id})`,
    );
    return {
      jobId: job.id,
      itemId: item.id,
      estimatedSec: estimate.estimatedSec,
      humanEstimate: estimate.humanEstimate,
    };
  }

  /**
   * Friendly filename for the ?download=1 disposition. Prefers the
   * stored upload filename, normalized to an extension matching the
   * served format so QGIS / desktop GIS recognize the file type.
   */
  async downloadFileName(
    user: AuthUser | null,
    itemId: string,
    format?: 'pmtiles' | 'cog',
  ): Promise<string> {
    let data: unknown;
    if (user) {
      const item = await this.items.get(user, itemId);
      data = item.data;
    } else {
      const item = await this.prisma.item.findFirst({
        where: { id: itemId, type: 'tile_layer', access: 'public', deletedAt: null },
        select: { data: true },
      });
      data = item?.data ?? null;
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const rawName =
      (typeof d.fileName === 'string' && d.fileName) ||
      (typeof d.originalFileName === 'string' && d.originalFileName) ||
      'tile-layer';
    const stem = rawName.replace(/\.[A-Za-z0-9]+$/, '') || 'tile-layer';
    const servedFormat =
      format ??
      ((typeof d.pmtilesStorageKey === 'string' && d.pmtilesStorageKey
        ? 'pmtiles'
        : 'cog') as 'pmtiles' | 'cog');
    return servedFormat === 'pmtiles' ? `${stem}.pmtiles` : `${stem}.tif`;
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
    // Re-check the prefix before deleting: item.data is owner-
    // writable, so a key edited to point at another prefix would
    // otherwise turn purge into an arbitrary-object delete.
    if (!tl.storageKey.startsWith(TILE_LAYER_KEY_PREFIX)) {
      this.log.warn(
        `Refusing to delete non-tile-layer key ${tl.storageKey} while purging item ${itemId}`,
      );
      return;
    }
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

/**
 * MIME type for the individual tiles inside a PMTiles archive,
 * read off the archive header's tileType.
 *
 * The XYZ endpoint needs this and the archive proxy does not: an
 * XYZ client picks its decoder from Content-Type alone, while the
 * archive object is served as one opaque application/octet-stream
 * and the client parses the header itself.
 */
export function tileTypeContentType(tileType: number): string {
  switch (tileType) {
    case TileType.Mvt:
      return 'application/vnd.mapbox-vector-tile';
    case TileType.Png:
      return 'image/png';
    case TileType.Jpeg:
      return 'image/jpeg';
    case TileType.Webp:
      return 'image/webp';
    case TileType.Avif:
      return 'image/avif';
    default:
      // TileType.Unknown, plus whatever a later spec revision adds.
      // Handing back octet-stream lets the caller decide rather than
      // asserting a decoder we have no evidence for.
      return 'application/octet-stream';
  }
}

/**
 * Bounded pool of open PMTiles archives, keyed by storage key.
 *
 * Eviction is insertion order, deliberately not least-recently-used:
 * a miss costs one ranged read of the header plus root directory,
 * which is not worth per-hit bookkeeping at this size.
 *
 * Tile bytes are not held here. Bounding by archive count keeps the
 * memory ceiling predictable; bounding by tile count would tie it to
 * whatever imagery someone uploaded. HTTP caching covers the bytes.
 */
export class PmtilesArchiveCache {
  private readonly open = new Map<string, PMTiles>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.open.size;
  }

  /** Cached archive for `key`, opening one through `openArchive` on a miss. */
  get(key: string, openArchive: (key: string) => PMTiles): PMTiles {
    const existing = this.open.get(key);
    if (existing) return existing;
    const archive = openArchive(key);
    this.open.set(key, archive);
    while (this.open.size > this.capacity) {
      const oldest = this.open.keys().next();
      if (oldest.done) break;
      this.open.delete(oldest.value);
    }
    return archive;
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
 * pmtiles.Source adapter that range-reads a MinIO object through
 * the S3 SDK with portal-api's credentials.  The pmtiles package
 * ships a built-in FetchSource but only for the browser; on the
 * server we read by storage KEY so no user-supplied URL is ever
 * fetched (the previous fetch-based source took the finalize
 * body's storageUrl verbatim, which was an SSRF surface) and so
 * private-prefix objects stay readable after the bucket policy
 * denied anonymous GET on them.
 *
 * No higher-level caching here: the package caches decoded
 * directories internally and the header itself is small.
 */
class StorageRangeSource implements Source {
  constructor(
    private readonly storage: StorageService,
    private readonly key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const upstream = await this.storage.streamObject(
      this.key,
      `bytes=${offset}-${offset + length - 1}`,
    );
    const buf = await collectStream(upstream.body, length);
    // Copy into a fresh ArrayBuffer: Buffer views a pooled slab
    // whose .buffer is wider than the payload (and typed
    // ArrayBufferLike), while pmtiles wants exactly-sized plain
    // ArrayBuffer data.
    const data = new ArrayBuffer(buf.byteLength);
    new Uint8Array(data).set(buf);
    const result: RangeResponse = { data };
    if (upstream.etag) result.etag = upstream.etag;
    return result;
  }
}

/**
 * Collect a readable stream into a Buffer, hard-capped.  The cap
 * is belt and braces: the Range header already bounds the
 * response, but a misbehaving upstream must not buffer unbounded
 * bytes into the api heap.  Mirrors the point-cloud service's
 * helper.
 */
function collectStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Ranged read returned more bytes than requested'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
