// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's data_json when
 * `type = 'tile_layer'` (#179).
 *
 * A tile_layer item wraps a single pre-rendered tile container
 * (currently PMTiles only; MBTiles + TPK/TPKX are documented as
 * follow-ups). The uploaded bytes live in MinIO; the item carries
 * the storage key + metadata lifted from the file header at
 * upload time so render-time consumers don't have to re-parse
 * the header per request.
 *
 * Why PMTiles as the only v1 format:
 *
 *   - Open spec (CC0), single file, HTTP-range-request friendly.
 *     MinIO range-serves the file directly; no per-tile compute
 *     on our side. MapLibre's pmtiles protocol plugin reads the
 *     file with range requests from the client.
 *   - MBTiles requires SQLite open + per-tile query for every
 *     tile served. Order-of-magnitude more compute and a
 *     dedicated server process. We can ingest MBTiles by
 *     converting to PMTiles at upload, but that conversion is
 *     follow-up scope; for v1 we accept PMTiles directly.
 *   - TPK / TPKX are Esri-proprietary zip-with-metadata. Their
 *     internal format wraps PNG / JPG tiles and an Esri-shaped
 *     JSON conf file. Worth supporting but needs its own
 *     extraction pipeline.
 *   - COG (Cloud-Optimized GeoTIFF) is the right answer for
 *     RAW imagery input that we'd tile on-the-fly. Not a tile
 *     container; lives in the separate "generate tile cache
 *     from imagery" surface (also follow-up).
 *
 * Once uploaded, the tile_layer is consumable as a basemap by
 * creating a basemap item with `kind: 'tile-url'` and the
 * tile_layer's `tileUrl` value (which the API exposes as a
 * pmtiles:// URL pointing at the API's proxy endpoint).
 */
import type { ISODateString } from './ids';

/**
 * Container formats served AT REST in MinIO.  Two flavors today:
 *
 *   - **pmtiles** is the universal serving format: range-served
 *     directly by MinIO, MapLibre reads with the pmtiles protocol
 *     plugin, no per-tile compute.  This is what we eventually
 *     converge on for every tile_layer item.
 *   - **cog** (Cloud-Optimized GeoTIFF) is the bridge format used
 *     for raw raster uploads.  GDAL normalizes a `.tif` / `.tiff`
 *     / `.geotiff` / `.jp2` to COG at upload, MinIO range-serves
 *     the COG, and MapLibre reads it with the cog-protocol
 *     plugin.  A background worker then bakes the same data into
 *     a PMTiles raster pyramid; once the PMTiles is ready, the
 *     item's served format flips from `cog` to `pmtiles`.  The
 *     COG is preserved as the archival source.
 */
export type TileLayerFormat = 'pmtiles' | 'cog';

/**
 * Container formats accepted at upload.  Pre-tiled containers
 * (pmtiles / mbtiles / xyz-zip) feed the PMTiles path directly.
 * Raw raster formats (geotiff / cog / jp2) feed the COG-first
 * hybrid path: convert to COG, serve immediately, build PMTiles
 * pyramid in the background.  TPK / TPKX remain out of v1
 * ingest -- Esri's bundle format needs its own extractor.
 */
export type TileLayerOriginalFormat =
  | 'pmtiles'
  | 'mbtiles'
  | 'xyz-zip'
  | 'geotiff'
  | 'cog'
  | 'jp2';

/**
 * State of the background pyramid-build job for raster-uploaded
 * items.  Items that started life as pre-tiled containers never
 * enter this state machine (their `format` is `pmtiles` at upload
 * and stays there).
 *
 *   - **null / undefined**: item didn't come from a raw raster
 *     upload, so there's no pyramid job.
 *   - **cog-ready**: COG is in MinIO and being served.  Pyramid
 *     job is queued or about to start.
 *   - **tiling**: pyramid job is running.  `tilingProgress`
 *     between 0 and 100 reflects how far along.
 *   - **pmtiles-ready**: pyramid build succeeded; the item is now
 *     served from PMTiles.  COG kept as archival source.
 *   - **tiling-failed**: pyramid build hit an unrecoverable error
 *     after retries.  Item continues serving from COG;
 *     `tilingError` carries the error string.  Admin can retry
 *     from the detail page.
 */
export type TileLayerProcessingState =
  | 'cog-ready'
  | 'tiling'
  | 'pmtiles-ready'
  | 'tiling-failed'
  /** #186: terminal state for layers that serve their COG as-is
   *  with no pyramid step (elevation/DEM layers). */
  | 'ready'
  /** #199: the imagery-mosaic worker is composing this item's
   *  sources into one COG. The currently-served file (if any)
   *  stays live until the swap. Also the state analysis jobs use
   *  while deriving into a fresh target item. */
  | 'building'
  /** #199: a build/derive failed; `processingError` carries the
   *  plain-language reason. The previously-served file (if any)
   *  keeps serving. Distinct from 'tiling-failed', which is
   *  specifically the background pyramid step. */
  | 'failed';

/** Raster vs vector tile content. Lifted from the PMTiles header
 *  at upload time; consumers read this to decide whether to
 *  treat the source as a `raster` or `vector` MapLibre source. */
export type TileLayerKind = 'raster' | 'vector';

/**
 * #199: one retained source raster of an imagery mosaic. The
 * uploaded object is kept in MinIO after the mosaic bakes so
 * "add more images later" re-composes over the full set instead
 * of resampling the baked output. Mirrors PointCloudSource.
 */
export interface TileLayerSource {
  /** MinIO object key under item-tile-layer/. */
  storageKey: string;
  /** Original filename, for the sources list on the detail page. */
  fileName: string;
  /** Uploaded size in bytes. */
  sizeBytes: number;
  /** When this source joined the mosaic. */
  addedAt: ISODateString;
}

export type TileLayerDataVersion = 1;

export interface TileLayerData {
  version: TileLayerDataVersion;
  /** Container format CURRENTLY served from MinIO.  Either
   *  'pmtiles' (the steady state) or 'cog' (the bridge state for
   *  raster items whose pyramid job hasn't finished yet).  See
   *  the TileLayerFormat docstring for the lifecycle. */
  format: TileLayerFormat;
  /**
   * Container format the user originally uploaded. Surfaced on
   * the detail page so the author can see whether a conversion
   * ran. Missing on items that pre-date this field; treat
   * absence as 'pmtiles' for backward compat.
   */
  originalFormat?: TileLayerOriginalFormat;
  /** Original upload filename before conversion (e.g.
   *  "wv-parcels.mbtiles"). Useful for re-download / debugging. */
  originalFileName?: string;
  /** Size of the original upload in bytes. May differ from
   *  sizeBytes when the conversion shrinks/grows the file. */
  originalSizeBytes?: number;
  /** Milliseconds spent in the conversion step. Surfaced on the
   *  detail page so authors can see the one-time conversion cost
   *  separately from the upload time. */
  conversionMs?: number;
  /** Raster vs vector content. Lifted from the PMTiles header. */
  kind: TileLayerKind;
  /**
   * #186: this layer is a ground-elevation surface (single-band
   * DEM COG on the web tile grid) usable as 3D terrain in maps.
   * Set by the analysis worker's elevation job. DEM layers never
   * get a tile pyramid (PNG re-encoding would destroy the float
   * elevation values); the COG serves directly via /file.cog.
   */
  dem?: boolean;
  /**
   * #211: item id of the elevation layer (a `dem: true` tile_layer)
   * that is this layer's ground truth, e.g. the DEM a hillshade or
   * steepness overlay was derived from. Stamped by the analysis
   * pipeline; the map builder uses it to offer "bring this layer's
   * elevation along" when the layer joins a map.
   */
  preferredElevationItemId?: string;
  /** MinIO object key of the CURRENTLY-served file (matches
   *  `format`).  For COG-state items this points at the COG; once
   *  the pyramid job lands, storageKey is updated to point at the
   *  new PMTiles object.  Used for delete cleanup. */
  storageKey: string;
  /** Public MinIO URL for the currently-served file.  MapLibre's
   *  pmtiles / cog protocol plugin (per `format`) range-reads
   *  this URL directly; no per-tile API hop. */
  storageUrl: string;
  /** Original upload filename for display + Content-Disposition
   *  on the download affordance. */
  fileName: string;
  /** Total uploaded size in bytes. Drives the file-size readout
   *  on the detail page and the housekeeping storage card. */
  sizeBytes: number;
  /** When the upload completed. Distinct from item.updatedAt
   *  because a re-upload action would keep updatedAt aligned but
   *  we want to know the bytes' age separately. */
  uploadedAt: ISODateString;

  // -------------- hybrid (cog -> pmtiles) bridge state -------------

  /**
   * MinIO object key of the source COG, preserved as the archival
   * master for raster items.  Set on raw-raster uploads; unset on
   * pre-tiled uploads.  Stays set even after `format` flips to
   * 'pmtiles' so we can re-tile later without re-upload.
   */
  cogStorageKey?: string;
  /** Public MinIO URL of the source COG.  Surfaced as a separate
   *  download affordance on the detail page after pyramid build. */
  cogStorageUrl?: string;
  /** Size of the stored COG in bytes.  May differ from
   *  `originalSizeBytes` when the source was JPEG2000 or a non-
   *  COG GeoTIFF that was normalized at ingest. */
  cogSizeBytes?: number;
  /**
   * MinIO object key of the derived PMTiles pyramid, set once the
   * worker job lands.  Unset before then.  Stays set even though
   * `storageKey` redundantly points at the same value once
   * `format` flips to 'pmtiles' -- carrying both lets the detail
   * page surface "both files available" without inferring it.
   */
  pmtilesStorageKey?: string;
  /** Public MinIO URL of the PMTiles pyramid, set with
   *  `pmtilesStorageKey`. */
  pmtilesStorageUrl?: string;
  /** Size of the derived PMTiles pyramid in bytes.  Surfaced
   *  alongside `cogSizeBytes` so admins can see the storage cost
   *  of keeping both. */
  pmtilesSizeBytes?: number;
  /**
   * Where the background pyramid job is in its lifecycle.  Unset
   * for non-raster items.  See TileLayerProcessingState for the
   * state machine.
   */
  processingState?: TileLayerProcessingState;
  /** Pyramid build progress 0..100 while `processingState ===
   *  'tiling'`.  Unset otherwise. */
  tilingProgress?: number;
  /** Human-readable error message from the most recent pyramid
   *  build failure.  Set when `processingState ===
   *  'tiling-failed'`, cleared on next successful run. */
  tilingError?: string;
  /** When the most recent pyramid build attempt started.  Used
   *  for the "stuck job" detector and the progress card timer. */
  tilingStartedAt?: ISODateString;
  /** When the most recent successful pyramid build completed.
   *  Set together with `processingState = 'pmtiles-ready'`. */
  tilingCompletedAt?: ISODateString;
  /** Plain-language reason when `processingState === 'failed'`
   *  (#199 mosaic builds; also stamped by failed analysis derives,
   *  which predate this field being typed). */
  processingError?: string;

  // ---------------------- imagery mosaic (#199) ----------------------

  /**
   * Retained source rasters when this layer is a mosaic built from
   * several images. Kept so more images can be added later and the
   * mosaic rebuilt over the full set (the VRT re-composition is
   * cheap; only overview/COG encoding pays by extent). Absent for
   * single-file uploads. Mirrors PointCloudSource (#200).
   */
  sources?: TileLayerSource[];

  // -------------------- metadata from the PMTiles header --------------------

  /** Minimum zoom level present in the cache. */
  minZoom?: number;
  /** Maximum zoom level present in the cache. */
  maxZoom?: number;
  /** EPSG:4326 bbox of the cached coverage [west, south, east, north]. */
  bbox?: [number, number, number, number];
  /** Suggested map center longitude. */
  centerLng?: number;
  /** Suggested map center latitude. */
  centerLat?: number;
  /** Suggested initial zoom. */
  centerZoom?: number;
  /**
   * Tile content type. PMTiles internal type ints map to the
   * tokens we store: 'mvt' (vector), 'png', 'jpg', 'webp', 'avif'.
   * Used by the runtime to pick the right MapLibre source +
   * layer types.
   */
  tileType?: 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'unknown';
  /** Attribution string from the PMTiles header, when set by
   *  whoever built the cache. Surfaced as the basemap
   *  attribution when the layer is used as a basemap. */
  attribution?: string;
  /** Human-readable name from the PMTiles header. */
  name?: string;
  /** Description string from the PMTiles header. */
  description?: string;

  // ----------------------------- runtime URL --------------------------------

  /**
   * The pmtiles:// URL the basemap editor / map renderer uses to
   * consume this tile layer. Server fills this in after upload:
   * `pmtiles://<api-base>/api/portal/tile-layer/<itemId>/file`.
   *
   * Stored on the item so the basemap editor's "Use as basemap"
   * affordance can hand it straight to the user as a copyable
   * URL without an extra api round-trip.
   */
  tileUrl?: string;
}

export const DEFAULT_TILE_LAYER: TileLayerData = {
  version: 1,
  format: 'pmtiles',
  kind: 'raster',
  storageKey: '',
  storageUrl: '',
  fileName: '',
  sizeBytes: 0,
  uploadedAt: new Date(0).toISOString() as ISODateString,
};

export function isTileLayerData(value: unknown): value is TileLayerData {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    version?: unknown;
    format?: unknown;
    storageKey?: unknown;
  };
  if (v.version !== 1) return false;
  // Accept both legacy items (format = 'pmtiles' always) and new
  // hybrid items in the cog-bridge state (format = 'cog' until
  // the pyramid job lands).  Anything outside the union is a
  // schema violation.
  if (v.format !== 'pmtiles' && v.format !== 'cog') return false;
  if (typeof v.storageKey !== 'string') return false;
  return true;
}
