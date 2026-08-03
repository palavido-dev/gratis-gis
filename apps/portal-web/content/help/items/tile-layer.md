---
id: items-tile-layer
title: Tile layer
summary: An item that wraps a pre-rendered tile container (PMTiles) or a raw raster (GeoTIFF / COG / JP2), served by range request.
category: items
order: 120
complexity: intermediate
tags:
  - tile-layer
  - item-type
  - tiles
  - pmtiles
  - cog
  - raster
related:
  - items-basemap
  - items-data-layer
---

A **tile layer** is an item that wraps either a pre-rendered tile
container or a raw raster. Use for basemaps backed by your own
cache, big raster overlays that would be too heavy to render from
features on the fly, vector tiles from a curated dataset, or
georeferenced imagery (aerial photos, scanned maps, elevation
models).

## At-rest formats: PMTiles + COG

The portal stores tile-layer bytes in one of two formats:

- **PMTiles** is the steady-state serving format for every tile
 layer. CC0 spec, single file with an embedded directory,
 range-readable over HTTP. MinIO serves it directly with no
 per-tile compute; MapLibre's pmtiles protocol plugin reads it
 from the browser.

- **COG (Cloud-Optimized GeoTIFF)** is the bridge format for
 raster uploads. Same shape (single file, range-served), read
 by MapLibre's cog-protocol plugin. Items live in COG state
 until a background worker bakes a PMTiles raster pyramid;
 then they flip to PMTiles automatically and the COG stays
 as the archival source.

## Accepted upload formats

Pre-tiled containers (immediate PMTiles serving):

- **`.pmtiles`**: pass-through, no conversion.
- **`.mbtiles`**: converted to PMTiles via the `pmtiles` CLI on
 upload. The SQLite directory is read once and re-packed.
- **`.zip` of an XYZ tile directory** (`{z}/{x}/{y}.{ext}`).
 Unzipped, then `pmtiles convert <dir>` walks the structure
 and packs the archive.

Raw raster (immediate COG serving, then PMTiles in the background):

- **`.tif` / `.tiff` / `.geotiff`**: GDAL's `gdalwarp -t_srs
 EPSG:3857 -of COG` reprojects (if needed) and normalizes to a
 valid COG. Lossless DEFLATE compression by default.
- **`.cog`**: same path as a regular GeoTIFF; the `.cog`
 extension is a hint, not a contract, so the converter still
 normalizes the output to a guaranteed-valid COG.
- **`.jp2`**: GDAL reads JPEG 2000 via the OpenJPEG driver and
 emits the same COG output.

The portal records the original format and filename on the item
so you can see what you uploaded vs. what's stored.

## The COG-then-PMTiles bridge

When you upload a raw raster, the item is map-renderable within
seconds:

1. **Upload + COG conversion** (synchronous, seconds to minutes).
 GDAL normalizes to a COG and stores it in MinIO. The item's
 `processingState` is set to `cog-ready` and the map starts
 rendering immediately via the cog-protocol plugin.
2. **Background pyramid build** (asynchronous, minutes to
 hours). The portal-worker container picks up the item, runs
 `gdal2tiles.py` to produce a tile pyramid, packs it into
 PMTiles, and uploads. State flips to `pmtiles-ready` and the
 item's served format silently switches to PMTiles. The COG
 stays in MinIO as the archival source.
3. **On failure**, the item flips to `tiling-failed` with the
 error message surfaced on the detail page. The COG continues
 to serve. Click **Retry pyramid build** to re-queue the job.

You can see the current state on the tile layer's detail page;
a status block above the metadata card shows queued / building /
ready / failed with timestamps.

## Combining several images into one mosaic

Aerial imagery usually arrives as a grid of tiles. Pick several
raster files at once in the upload dialog (or use **Add more
images** on an existing imagery layer) and the portal combines
them server-side into one seamless mosaic, then feeds it through
the same COG-then-PMTiles bridge as a single upload. Where images
overlap, the one added last wins. The source images are kept, so
coverage can grow later without re-uploading what's already
there: adding images re-composes over the full set.

Before anything uploads, the portal estimates the build time from
the batch size and refuses a batch that cannot finish inside the
server's job window (the operator can tune the `MOSAIC_*`
settings). Mosaicking applies to plain imagery formats only; tile
packages (`.pmtiles` / `.mbtiles` / `.zip`) upload one at a time.

## TPK / TPKX / ECW / MrSID

Esri's TPK and TPKX bundles aren't accepted at upload today. They
wrap PNG/JPG tiles in a custom index format that needs its own
extraction pipeline. Documented as future scope.

ECW and MrSID aren't accepted either: their decode SDKs are
proprietary and the licenses aren't AGPL-compatible. Convert to
GeoTIFF locally with a GDAL build that includes the vendor SDK,
then upload the `.tif`. The error message in the uploader
includes the conversion recipe.

## Raster vs. vector content

PMTiles can store either; the portal reads the file header at
upload to determine which kind you have. Raster tile layers
become raster MapLibre sources; vector tile layers become vector
sources and can be styled like any other vector data.

COG items are always raster.

## Pre-upload space check

When you pick a file, the portal first asks the api how much
working space the upload + conversion pipeline needs (typically
2.5x the file size for raw rasters, 1.5x for pre-tiled inputs).
If the host doesn't have headroom, the uploader refuses up front
with a user-readable message naming the required and available
sizes. Beats discovering ENOSPC after gigabytes of bytes have
already transferred.

## Using a tile layer as a basemap

The detail page surfaces a **Use as basemap** action that
pre-fills a new basemap item with `kind: tile-url` and the
tile layer's internal URL:

- PMTiles items: `pmtiles://<api-base>/api/portal/tile-layer/<id>/file`
- COG items: `cog://<api-base>/api/portal/tile-layer/<id>/file`

Both protocols are wired into the portal's MapLibre setup;
basemap rendering picks the right one based on the URL prefix.

## What's stored on the item

- **storageKey / storageUrl** of the currently-served file (the
 PMTiles when `format` is `pmtiles`, the COG when `format` is
 `cog`).
- **cogStorageKey / cogStorageUrl / cogSizeBytes** for raster
 uploads. Stays populated even after pyramid build so you can
 re-tile later without re-upload.
- **pmtilesStorageKey / pmtilesStorageUrl / pmtilesSizeBytes**
 once the pyramid job lands.
- **processingState** (cog-ready / tiling / pmtiles-ready /
 tiling-failed) and related timestamps + error message.
- **format** (`pmtiles` or `cog`), **kind** (`raster` or
 `vector`), **bbox**, min/max zoom, suggested center.
- **tileType** (mvt / png / jpg / webp / avif) for PMTiles
 items; `png` for COG items.
- **attribution** string from the file header, when set.

## Notes

- **No re-tile on data change.** PMTiles archives are pre-
 rendered; updating the source means re-uploading. Raster
 items can be re-uploaded; the cog → pmtiles bridge runs
 again on the new bytes.
- **Bounds enforce themselves.** Tiles outside the bounding box
 in the file header simply don't exist; MapLibre stops asking
 for them.
- **Both files retained.** A raster item that's completed its
 pyramid build keeps both the COG (archival source) and the
 PMTiles (served bytes). Disk cost is ~2x the original
 upload; both are useful, so we don't auto-delete.
