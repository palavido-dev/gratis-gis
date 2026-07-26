// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';

import type { TileLayerOriginalFormat } from '@gratis-gis/shared-types';

/**
 * Tile container conversion pipeline (#179).
 *
 * Detects the upload's container format from the file extension
 * and produces a serving-ready file for storage.  Two output
 * flavors:
 *
 *   - **PMTiles** for uploads that arrive as pre-tiled containers
 *     (pmtiles / mbtiles / xyz-zip).  No image processing; we just
 *     repack the bytes when needed.
 *   - **COG** for uploads that arrive as raw raster imagery
 *     (geotiff / cog / jp2).  GDAL warps to EPSG:3857 and writes a
 *     Cloud-Optimized GeoTIFF that the cog-protocol MapLibre
 *     plugin can range-read.  A separate background worker later
 *     builds a PMTiles pyramid from this COG; until then the COG
 *     is the served format.
 *
 *   - .pmtiles : no conversion; pass-through.
 *   - .mbtiles : `pmtiles convert in.mbtiles out.pmtiles`. The
 *     pmtiles Go CLI bundled into the api image handles the
 *     SQLite read + PMTiles directory build.
 *   - .zip (XYZ tile directory): extracted in-process (see
 *     `extractZipToDir`) into a temp dir, then
 *     `pmtiles convert <tile-dir> out.pmtiles`. The CLI walks
 *     {z}/{x}/{y}.{ext} structure and builds a PMTiles archive.
 *   - .tif / .tiff / .geotiff / .cog : `gdalwarp -t_srs EPSG:3857
 *     -of COG ...` reprojects (if needed) and emits a COG.
 *   - .jp2 : same as GeoTIFF, GDAL's JP2OpenJPEG driver reads it.
 *
 * TPK / TPKX are out of v1 ingest because Esri's bundle format
 * needs its own extraction pipeline (bundles pack multiple tiles
 * into one file with a custom index). Documented as a follow-up.
 *
 * Conversion runs in a temp dir under the system tmp; cleaned up
 * unconditionally so a failed conversion doesn't leak gigabytes
 * of intermediate files.
 */

/** Result of a successful pre-tiled (PMTiles) conversion. */
export interface PmtilesConversionResult {
  /** Output container format. */
  format: 'pmtiles';
  /** Local path to the .pmtiles file ready to upload to MinIO. */
  outputPath: string;
  /** Original format the user uploaded. */
  originalFormat: TileLayerOriginalFormat;
  /** Bytes of the resulting .pmtiles file. */
  outputBytes: number;
  /** Milliseconds elapsed for the conversion step. */
  durationMs: number;
  /** Temp directory the caller must clean up (rm -rf). */
  workDir: string;
}

/** Result of a successful raw-raster (COG) conversion. */
export interface CogConversionResult {
  /** Output container format. */
  format: 'cog';
  /** Local path to the .tif (COG) ready to upload to MinIO. */
  outputPath: string;
  /** Original format the user uploaded. */
  originalFormat: TileLayerOriginalFormat;
  /** Bytes of the resulting COG file. */
  outputBytes: number;
  /** Milliseconds elapsed for the conversion step. */
  durationMs: number;
  /** Temp directory the caller must clean up (rm -rf). */
  workDir: string;
  /** EPSG:4326 bbox of the imagery, [west, south, east, north].
   *  Computed from gdalinfo on the output COG. */
  bbox?: [number, number, number, number];
  /** Approximate max zoom level the COG's pixel size supports at
   *  EPSG:3857.  Computed from `156543.03392804062 / resolution`.
   *  Caller persists this as TileLayerData.maxZoom. */
  maxZoom?: number;
  /** Number of bands in the source (and output) raster.  1 = single-
   *  band grayscale or DEM; 3 = RGB; 4 = RGBA. */
  bandCount?: number;
}

/** Discriminated union of all converter outputs.  Caller switches
 *  on `format` to know which storage / serving path to use. */
export type ConversionResult = PmtilesConversionResult | CogConversionResult;

/** Set of original-format tokens that go through the raw-raster
 *  (COG) branch of the converter. */
const RAW_RASTER_FORMATS = new Set<TileLayerOriginalFormat>([
  'geotiff',
  'cog',
  'jp2',
]);

export function isRawRasterFormat(fmt: TileLayerOriginalFormat): boolean {
  return RAW_RASTER_FORMATS.has(fmt);
}

/**
 * Detect the original format from the filename. Reject any
 * unsupported extension early so the conversion doesn't fail
 * with a less helpful error from the CLI.
 *
 * `.cog` is a hint, not a contract: any GeoTIFF whose filename
 * happens to end in `.cog` is recognized as COG-class but the
 * converter still runs the same gdalwarp pass over it so
 * non-COG-compliant files get rewritten properly.  Cloud-optimized
 * structure is verified at the output, not assumed at the input.
 */
export function detectOriginalFormat(
  fileName: string,
): TileLayerOriginalFormat {
  const lower = fileName.toLowerCase();
  // Pre-tiled containers.
  if (lower.endsWith('.pmtiles')) return 'pmtiles';
  if (lower.endsWith('.mbtiles')) return 'mbtiles';
  if (lower.endsWith('.zip')) return 'xyz-zip';
  // Raw raster sources.  `.tif` and `.tiff` both produce 'geotiff'
  // because we can't distinguish a generic TIFF from a COG by
  // extension; the converter rewrites both into a guaranteed-COG
  // output regardless.
  if (lower.endsWith('.tif') || lower.endsWith('.tiff') || lower.endsWith('.geotiff')) {
    return 'geotiff';
  }
  if (lower.endsWith('.cog')) return 'cog';
  if (lower.endsWith('.jp2')) return 'jp2';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const supported =
    '.pmtiles, .mbtiles, .zip (XYZ tile directory), .tif / .tiff / .geotiff, .cog, .jp2';
  if (lower.endsWith('.tpk') || lower.endsWith('.tpkx')) {
    throw new Error(
      `TPK / TPKX ingestion is not supported yet. Convert with ArcGIS Pro's "Export Tile Cache" tool or a third-party converter, then upload the resulting .mbtiles or .pmtiles. Supported: ${supported}.`,
    );
  }
  if (lower.endsWith('.ecw') || lower.endsWith('.sid')) {
    throw new Error(
      `${lower.endsWith('.ecw') ? 'ECW' : 'MrSID'} ingestion is not supported (proprietary decoder license is not AGPL-compatible). Convert to GeoTIFF first: \`gdal_translate input.${lower.endsWith('.ecw') ? 'ecw' : 'sid'} output.tif\` with a GDAL build that includes the vendor SDK, then upload the GeoTIFF. Supported: ${supported}.`,
    );
  }
  throw new Error(
    `Unsupported tile container "${ext || lower}". Supported: ${supported}.`,
  );
}

/**
 * Run the conversion pipeline. Caller passes the source URL
 * (public MinIO URL of the just-uploaded file) + the original
 * filename. Returns a discriminated `ConversionResult` whose
 * `format` field tells the caller which output flavor came out:
 *
 *   - `'pmtiles'`: pre-tiled container (or pass-through for an
 *     already-PMTiles upload).  Caller's existing PMTiles-header
 *     parsing + storage path applies.
 *   - `'cog'`: raw raster normalized to Cloud-Optimized GeoTIFF.
 *     Caller persists the COG and kicks off the background
 *     PMTiles pyramid job.
 *
 * The caller MUST `rm -rf` the returned `workDir` once it's done
 * uploading the result, success or failure.
 *
 * For `.pmtiles` inputs the function returns immediately without
 * touching the file -- the caller's upload-to-MinIO step has
 * already put the bytes where they belong. The workDir in that
 * case is a no-op empty directory so the caller's cleanup
 * branch can call rm uniformly.
 */
/**
 * Downloader callback: write the upload's bytes to `destPath`.
 * The caller (tile-layer.service) wires this to StorageService's
 * direct S3 stream so the converter never touches a user-supplied
 * URL.  This removes the SSRF surface that the old `downloadTo`
 * helper had to defend against.
 */
export type TileSourceDownloader = (destPath: string) => Promise<void>;

export async function convertUpload(
  download: TileSourceDownloader,
  fileName: string,
): Promise<ConversionResult> {
  const originalFormat = detectOriginalFormat(fileName);
  const workDir = await mkdtemp(join(tmpdir(), 'tile-conv-'));

  // Raw-raster branch.  Dispatch to the COG converter; the rest
  // of this function handles pre-tiled inputs (PMTiles / MBTiles
  // / XYZ-zip).
  if (isRawRasterFormat(originalFormat)) {
    return runCogConversion(download, fileName, originalFormat, workDir);
  }

  // Pass-through path. We don't download the file -- the bytes
  // are already in MinIO, and finalize() will read the header from
  // there with range requests. Returning a dummy output path that
  // doesn't exist would confuse the caller; signal pass-through by
  // returning `outputPath === ''` and the caller decides what to do.
  if (originalFormat === 'pmtiles') {
    return {
      format: 'pmtiles',
      outputPath: '',
      originalFormat,
      outputBytes: 0,
      durationMs: 0,
      workDir,
    };
  }

  const start = Date.now();

  // Download the upload to a local file. pmtiles CLI needs a
  // local input path; it doesn't read HTTP URLs.
  const inputPath = join(workDir, sanitizeFileName(fileName));
  await download(inputPath);

  let outputPath = join(workDir, 'out.pmtiles');
  if (originalFormat === 'xyz-zip') {
    // Extract into a tile-dir subdirectory first. The pmtiles CLI
    // walks the tree expecting {z}/{x}/{y}.{ext} layout (or
    // {z}/{x}/{y}.pbf for vector). Some zips wrap the tree in
    // an extra root directory; pmtiles handles either shape
    // because it scans for the {z} integer pattern.
    //
    // In-process extraction rather than spawning Info-ZIP: the
    // prod api image ships no unzip binary (the advertised format
    // died with ENOENT), and a walker we own is the only way to
    // refuse symlink members, traversal names, and past-the-
    // ceiling expansion before anything touches the disk.
    const tileDir = join(workDir, 'tiles');
    await mkdir(tileDir, { recursive: true });
    await extractZipToDir(inputPath, tileDir);
    // The pmtiles convert CLI for directory input requires a
    // metadata.json at the tile-dir root; if the zip doesn't
    // include one we synthesize a minimal placeholder. The
    // header bbox / center will come from the tile pyramid
    // bounds at runtime.
    //
    // Use writeFile with the 'wx' flag (O_CREAT | O_EXCL) so the
    // create-if-missing is atomic. The stat-then-write pattern
    // CodeQL flagged as js/file-system-race had a TOCTOU window
    // where another process could create the file between the
    // check and the write; the wx flag closes that window and
    // EEXIST means the zip already shipped a metadata.json (which
    // is what we wanted -- treat as success).
    const metaPath = join(tileDir, 'metadata.json');
    try {
      await writeFile(
        metaPath,
        JSON.stringify({
          name: fileName.replace(/\.zip$/i, ''),
          format: 'png',
          minzoom: 0,
          maxzoom: 22,
        }),
        { flag: 'wx' },
      );
    } catch (err) {
      // EEXIST is the expected race-free signal that the zip
      // already supplied metadata.json; anything else is real.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw err;
    }
    await runCommand('pmtiles', ['convert', tileDir, outputPath]);
  } else if (originalFormat === 'mbtiles') {
    await runCommand('pmtiles', ['convert', inputPath, outputPath]);
  } else {
    // Defensive: detectOriginalFormat already rejected
    // everything else, but make the never-happens branch
    // explicit so a future format addition doesn't silently
    // produce an empty out.pmtiles.
    throw new Error(`No converter for format ${originalFormat}`);
  }

  const outputStat = await stat(outputPath);
  return {
    format: 'pmtiles',
    outputPath,
    originalFormat,
    outputBytes: outputStat.size,
    durationMs: Date.now() - start,
    workDir,
  };
}

/**
 * Back-compat alias.  Kept so older callsites that imported the
 * pre-COG-era function name keep working through the transition;
 * new code should use `convertUpload`.
 */
export const convertToPmtiles = convertUpload;

/**
 * Raw-raster branch of the converter.  Downloads the upload,
 * reprojects to EPSG:3857 (if needed) and writes a Cloud-
 * Optimized GeoTIFF in `workDir`.  Reads the output's bounds + pixel
 * resolution via `gdalinfo -json` so the caller can persist bbox +
 * suggested zoom range on the item without a second round-trip.
 *
 * Single GDAL command (`gdalwarp -t_srs EPSG:3857 -of COG`) covers
 * both the "raw GeoTIFF needing reprojection" and "already a COG
 * but in the wrong SRS" cases.  When the source is already a
 * compliant COG in EPSG:3857 gdalwarp emits a near-copy; we don't
 * bother short-circuiting because the runtime cost is small and
 * the explicit re-write guarantees a clean output structure.
 *
 * Output compression: DEFLATE + PREDICTOR=2 by default (lossless,
 * universal).  Users who want JPEG (lossy, smaller) for RGB
 * imagery can re-encode later; v1 picks the safe choice rather
 * than trying to guess from band structure.
 */
async function runCogConversion(
  download: TileSourceDownloader,
  fileName: string,
  originalFormat: TileLayerOriginalFormat,
  workDir: string,
): Promise<CogConversionResult> {
  const start = Date.now();

  const inputPath = join(workDir, sanitizeFileName(fileName));
  await download(inputPath);

  let outputPath = join(workDir, 'out.tif');

  // Already a web-mercator Cloud-Optimized GeoTIFF? Keep the
  // uploaded bytes exactly as they are. Re-encoding a prepared COG
  // is worse in every direction: a JPEG-compressed county ortho
  // balloons several-fold under DEFLATE, the re-encode pegs a core
  // for tens of minutes, and the output is not one pixel better.
  // GDAL stamps LAYOUT=COG in IMAGE_STRUCTURE for valid COGs, so
  // the check cannot false-positive on a plain tiled GTiff.
  let passthroughCog = false;
  try {
    const preInfo = await runCommandCapture('gdalinfo', ['-json', inputPath]);
    const pre = JSON.parse(preInfo) as GdalInfoJson;
    const wkt = pre.coordinateSystem?.wkt ?? '';
    if (
      pre.metadata?.IMAGE_STRUCTURE?.LAYOUT === 'COG' &&
      (wkt.includes('"EPSG","3857"') || wkt.includes('Pseudo-Mercator'))
    ) {
      passthroughCog = true;
      outputPath = inputPath;
    }
  } catch {
    // Unreadable header: fall through to the converter, which will
    // produce its own (better) error if the file is truly broken.
  }

  if (!passthroughCog) {
    // gdalwarp flags:
    //   -t_srs EPSG:3857        reproject for web-mercator clients
    //   -of COG                 emit a Cloud-Optimized GeoTIFF
    //   -co COMPRESS=DEFLATE    lossless, well-supported
    //   -co PREDICTOR=2         improves DEFLATE on continuous data
    //   -co BLOCKSIZE=512       reasonable tile size for HTTP range
    //   -co BIGTIFF=IF_SAFER    auto-promote to BigTIFF if >4GB
    //   -co RESAMPLING=BILINEAR pyramid overviews use bilinear
    await runCommand('gdalwarp', [
      '-t_srs', 'EPSG:3857',
      '-of', 'COG',
      '-co', 'COMPRESS=DEFLATE',
      '-co', 'PREDICTOR=2',
      '-co', 'BLOCKSIZE=512',
      '-co', 'BIGTIFF=IF_SAFER',
      '-co', 'RESAMPLING=BILINEAR',
      '-overwrite',
      inputPath,
      outputPath,
    ]);
  }

  const outputStat = await stat(outputPath);

  // gdalinfo -json gives us extent + resolution in one shot.  We
  // parse just the fields we need; failure to parse is non-fatal
  // (the COG is fine, we just lack bbox / maxZoom metadata).
  let bbox: [number, number, number, number] | undefined;
  let maxZoom: number | undefined;
  let bandCount: number | undefined;
  try {
    const info = await runCommandCapture('gdalinfo', ['-json', outputPath]);
    const parsed = JSON.parse(info) as GdalInfoJson;
    if (parsed.wgs84Extent?.coordinates?.[0]) {
      const ring = parsed.wgs84Extent.coordinates[0];
      const lons: number[] = [];
      const lats: number[] = [];
      for (const c of ring) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          lons.push(c[0]);
          lats.push(c[1]);
        }
      }
      if (lons.length > 0 && lats.length > 0) {
        bbox = [
          Math.min(...lons),
          Math.min(...lats),
          Math.max(...lons),
          Math.max(...lats),
        ];
      }
    }
    // EPSG:3857 pixel size in meters per pixel.  The web-mercator
    // resolution at zoom Z is 156543.03392804062 / 2^Z; invert to
    // get a zoom level from a resolution.
    const geo = parsed.geoTransform;
    if (geo && geo.length >= 6 && typeof geo[1] === 'number' && typeof geo[5] === 'number') {
      const pxX = Math.abs(geo[1]);
      const pxY = Math.abs(geo[5]);
      const res = Math.max(pxX, pxY);
      if (res > 0) {
        const z = Math.log2(156543.03392804062 / res);
        if (Number.isFinite(z)) {
          maxZoom = Math.min(22, Math.max(0, Math.ceil(z)));
        }
      }
    }
    if (Array.isArray(parsed.bands)) {
      bandCount = parsed.bands.length;
    }
  } catch {
    /* metadata extraction is best-effort */
  }

  const result: CogConversionResult = {
    format: 'cog',
    outputPath,
    originalFormat,
    outputBytes: outputStat.size,
    durationMs: Date.now() - start,
    workDir,
  };
  if (bbox) result.bbox = bbox;
  if (typeof maxZoom === 'number') result.maxZoom = maxZoom;
  if (typeof bandCount === 'number') result.bandCount = bandCount;
  return result;
}

/** Minimal shape of `gdalinfo -json` we read.  GDAL ships many
 *  more keys; we leave them untyped via passthrough. */
interface GdalInfoJson {
  geoTransform?: number[];
  wgs84Extent?: {
    type?: string;
    coordinates?: number[][][];
  };
  bands?: Array<unknown>;
  metadata?: {
    IMAGE_STRUCTURE?: {
      LAYOUT?: string;
    };
  };
  coordinateSystem?: {
    wkt?: string;
  };
}

/**
 * Always-run cleanup after the caller uploads the converted
 * PMTiles back to MinIO. Failed conversions also call this so
 * temp space is reclaimed regardless of outcome.
 */
export async function cleanupConversion(workDir: string): Promise<void> {
  if (!workDir) return;
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ----------------------------------------------------------------
// In-process zip extraction (XYZ tile-dir uploads)
// ----------------------------------------------------------------

/**
 * Ceilings for zip extraction.  A tile pyramid is many small
 * images; anything past these bounds is a mistake or a zip bomb.
 * The byte ceiling sits an order of magnitude above the largest
 * pre-tiled uploads the disk-headroom check waves through (the
 * upload size times PRE_TILED_HEADROOM), and the entry ceiling
 * covers a deep regional pyramid without letting one crafted
 * archive allocate millions of inodes.  Extraction aborts (and
 * the caller's workDir cleanup reclaims the partial output) the
 * moment either would be crossed.
 */
export const MAX_ZIP_ENTRIES = 100_000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Central-directory size ceiling.  100k entries of tile-path-
 * length names fit in a few MB; refusing anything bigger keeps a
 * lying header from making us allocate gigabytes before the entry
 * walk even starts.
 */
const MAX_ZIP_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;

// Zip on-disk record signatures (little-endian, per APPNOTE.TXT).
const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
}

/**
 * Extract a zip archive into `destDir` using node's own zlib, no
 * external binary.  Exists because spawning Info-ZIP was wrong
 * three ways at once: the binary isn't in the prod runtime image
 * (ENOENT for the advertised format), it enforces no expansion
 * ceiling (zip bomb), and it materializes symlink members, which
 * lets a crafted archive write outside the extraction dir.
 *
 * Guarantees:
 *   - every entry path resolves inside `destDir` (no `..`, no
 *     absolute paths, backslash separators normalized first)
 *   - symlink and encrypted members are refused outright
 *   - total decompressed output and entry count are capped, with
 *     the byte cap enforced while inflating so a deflate stream
 *     lying about its size still cannot run past it
 *   - per-entry CRC32 is verified, matching what unzip did, so
 *     corruption fails loudly instead of producing broken tiles
 *
 * Sizes, CRCs, and offsets come from the central directory (the
 * authoritative copy); only name/extra lengths are re-read from
 * each local header, because writers legitimately differ there
 * and the data offset depends on them.
 */
export async function extractZipToDir(
  zipPath: string,
  destDir: string,
): Promise<void> {
  const fh = await open(zipPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const entries = await readCentralDirectory(fh, fileSize);

    // Pre-flight on the declared sizes so an honestly-labeled bomb
    // is refused before a single byte lands on disk.  The inflate
    // counter below re-enforces the same ceiling against liars.
    let declaredTotal = 0;
    for (const e of entries) declaredTotal += e.uncompressedSize;
    if (declaredTotal > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Zip expands to ${declaredTotal} bytes, past the ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}-byte extraction ceiling`,
      );
    }

    const destRoot = resolve(destDir);
    let budget = MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES;
    for (const entry of entries) {
      budget -= await extractEntry(fh, fileSize, entry, destRoot, budget);
    }
  } finally {
    await fh.close();
  }
}

/** Locate + parse the central directory. Handles the ZIP64 record
 *  chain, since a >65535-entry pyramid is well within our entry
 *  ceiling and 4GB+ archives are realistic for imagery. */
async function readCentralDirectory(
  fh: FileHandle,
  fileSize: number,
): Promise<ZipEntry[]> {
  if (fileSize < 22) throw new Error('Not a zip file (too small)');
  // The EOCD sits in the last 22 + 65535 bytes (fixed record plus
  // maximum comment). Scan backwards for a signature whose comment
  // length lines up with the end of file, so a signature byte
  // pattern inside the comment cannot decoy us.
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = await readExact(fh, fileSize - tailLen, tailLen);
  let eocdPos = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen === tailLen) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) {
    throw new Error('Not a zip file (no end-of-central-directory record)');
  }
  let diskNumber: number = tail.readUInt16LE(eocdPos + 4);
  let cdStartDisk: number = tail.readUInt16LE(eocdPos + 6);
  let totalEntries: number = tail.readUInt16LE(eocdPos + 10);
  let cdSize: number = tail.readUInt32LE(eocdPos + 12);
  let cdOffset: number = tail.readUInt32LE(eocdPos + 16);

  // Sentinel values redirect through the ZIP64 locator to the
  // 64-bit record.
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    const locOffset = fileSize - tailLen + eocdPos - 20;
    if (locOffset >= 0) {
      const loc = await readExact(fh, locOffset, 20);
      if (loc.readUInt32LE(0) === EOCD64_LOCATOR_SIG) {
        const eocd64Offset = toSafeNumber(
          loc.readBigUInt64LE(8),
          'zip64 record offset',
        );
        if (eocd64Offset + 56 > fileSize) {
          throw new Error('Corrupt zip: zip64 record extends past end of file');
        }
        const rec = await readExact(fh, eocd64Offset, 56);
        if (rec.readUInt32LE(0) !== EOCD64_SIG) {
          throw new Error(
            'Corrupt zip: bad zip64 end-of-central-directory record',
          );
        }
        diskNumber = rec.readUInt32LE(16);
        cdStartDisk = rec.readUInt32LE(20);
        totalEntries = toSafeNumber(rec.readBigUInt64LE(32), 'entry count');
        cdSize = toSafeNumber(rec.readBigUInt64LE(40), 'central directory size');
        cdOffset = toSafeNumber(
          rec.readBigUInt64LE(48),
          'central directory offset',
        );
      }
    }
  }
  if (diskNumber !== 0 || cdStartDisk !== 0) {
    throw new Error('Multi-disk zip archives are not supported');
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(
      `Zip has ${totalEntries} entries, past the ${MAX_ZIP_ENTRIES}-entry ceiling`,
    );
  }
  if (cdSize > MAX_ZIP_CENTRAL_DIR_BYTES) {
    throw new Error('Corrupt zip: central directory is implausibly large');
  }
  if (cdOffset + cdSize > fileSize) {
    throw new Error('Corrupt zip: central directory extends past end of file');
  }

  const cd = await readExact(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('Corrupt zip: bad central directory entry');
    }
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize: number = cd.readUInt32LE(p + 20);
    let uncompressedSize: number = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    let localHeaderOffset: number = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
      throw new Error('Corrupt zip: central directory entry overruns');
    }
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // ZIP64 extended-information extra field: whichever of the
    // three fixed fields overflowed appears here, 64-bit, in this
    // exact order.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extra = cd.subarray(
        p + 46 + nameLen,
        p + 46 + nameLen + extraLen,
      );
      let q = 0;
      while (q + 4 <= extra.length) {
        const fieldId = extra.readUInt16LE(q);
        const fieldLen = extra.readUInt16LE(q + 2);
        if (q + 4 + fieldLen > extra.length) break;
        if (fieldId === 0x0001) {
          let r = q + 4;
          const fieldEnd = q + 4 + fieldLen;
          if (uncompressedSize === 0xffffffff && r + 8 <= fieldEnd) {
            uncompressedSize = toSafeNumber(
              extra.readBigUInt64LE(r),
              `uncompressed size of ${name}`,
            );
            r += 8;
          }
          if (compressedSize === 0xffffffff && r + 8 <= fieldEnd) {
            compressedSize = toSafeNumber(
              extra.readBigUInt64LE(r),
              `compressed size of ${name}`,
            );
            r += 8;
          }
          if (localHeaderOffset === 0xffffffff && r + 8 <= fieldEnd) {
            localHeaderOffset = toSafeNumber(
              extra.readBigUInt64LE(r),
              `local header offset of ${name}`,
            );
          }
          break;
        }
        q += 4 + fieldLen;
      }
    }
    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttrs,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Validate an entry name and resolve its destination.  Rejection,
 * not sanitization: a zip that ships `../` or absolute paths is
 * hostile or broken, and silently rewriting its layout would feed
 * the pmtiles CLI a tree the author never built.
 */
function safeEntryDestination(
  destRoot: string,
  rawName: string,
): { dest: string; isDir: boolean } {
  // Zip mandates '/' separators but Windows-built archives show
  // up with '\'; normalize first so the traversal checks see real
  // segments either way.
  const name = rawName.replace(/\\/g, '/');
  if (name.length === 0 || name.includes('\0')) {
    throw new Error(`Unsafe zip entry name: ${JSON.stringify(rawName)}`);
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`Zip entry has an absolute path: ${rawName}`);
  }
  const isDir = name.endsWith('/');
  const segments = name.split('/').filter((s) => s.length > 0 && s !== '.');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`Zip entry escapes the extraction directory: ${rawName}`);
    }
  }
  if (segments.length === 0 && !isDir) {
    throw new Error(`Unsafe zip entry name: ${JSON.stringify(rawName)}`);
  }
  const dest = resolve(destRoot, segments.join('/'));
  // Belt and braces after the segment check: confirm containment
  // on the resolved path so no path trick survives.
  if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
    throw new Error(`Zip entry escapes the extraction directory: ${rawName}`);
  }
  return { dest, isDir };
}

/** Extract one entry. Returns the number of bytes written so the
 *  caller can charge them against the archive-wide budget. */
async function extractEntry(
  fh: FileHandle,
  fileSize: number,
  entry: ZipEntry,
  destRoot: string,
  budget: number,
): Promise<number> {
  const { dest, isDir } = safeEntryDestination(destRoot, entry.name);

  // Unix mode travels in the high 16 bits of the external
  // attributes.  Symlink members are how zip extractors get talked
  // into writing outside the target dir (drop a link, then write
  // "through" it on a later entry), and a tile pyramid has no
  // business shipping links.  Refuse rather than skip so the
  // uploader learns why their archive was rejected.
  if (((entry.externalAttrs >>> 16) & 0xf000) === 0xa000) {
    throw new Error(`Zip entry is a symlink, refusing to extract: ${entry.name}`);
  }
  if ((entry.flags & 0x0001) !== 0) {
    throw new Error(`Zip entry is encrypted: ${entry.name}`);
  }

  if (isDir) {
    await mkdir(dest, { recursive: true });
    return 0;
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(
      `Unsupported zip compression method ${entry.method} for ${entry.name}`,
    );
  }
  if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw new Error(`Corrupt zip: stored entry size mismatch on ${entry.name}`);
  }

  await mkdir(dirname(dest), { recursive: true });

  if (entry.compressedSize === 0) {
    // Zero-byte member (an empty tile, or a dir recorded without
    // the trailing slash by an odd writer). Nothing to stream.
    if (entry.uncompressedSize !== 0 || entry.crc !== 0) {
      throw new Error(`Corrupt zip: empty entry with nonzero size on ${entry.name}`);
    }
    await writeFile(dest, Buffer.alloc(0));
    return 0;
  }

  // The local header's name/extra lengths can legitimately differ
  // from the central directory's, and the data offset depends on
  // them, so re-read those two fields from the local copy.
  if (entry.localHeaderOffset + 30 > fileSize) {
    throw new Error(`Corrupt zip: local header out of range for ${entry.name}`);
  }
  const loc = await readExact(fh, entry.localHeaderOffset, 30);
  if (loc.readUInt32LE(0) !== LOC_SIG) {
    throw new Error(`Corrupt zip: bad local header for ${entry.name}`);
  }
  const dataStart =
    entry.localHeaderOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
  if (dataStart + entry.compressedSize > fileSize) {
    throw new Error(
      `Corrupt zip: entry data extends past end of file for ${entry.name}`,
    );
  }

  let written = 0;
  let crc = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      // A deflate stream inflating past its declared size is a zip
      // bomb (or corruption); either way, stop it, not the disk.
      if (written > entry.uncompressedSize) {
        cb(new Error(`Zip entry inflated past its declared size: ${entry.name}`));
        return;
      }
      if (written > budget) {
        cb(
          new Error(
            `Zip expands past the ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}-byte extraction ceiling`,
          ),
        );
        return;
      }
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
  });

  const source = fh.createReadStream({
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
    autoClose: false,
  });
  const sink = createWriteStream(dest);
  if (entry.method === 8) {
    await pipeline(source, createInflateRaw(), counter, sink);
  } else {
    await pipeline(source, counter, sink);
  }
  if (written !== entry.uncompressedSize) {
    throw new Error(
      `Corrupt zip: ${entry.name} inflated to ${written} bytes, expected ${entry.uncompressedSize}`,
    );
  }
  // Matching what Info-ZIP verified: silent corruption here would
  // surface later as broken tiles with no cause attached.
  if ((crc >>> 0) !== entry.crc) {
    throw new Error(`Corrupt zip: CRC mismatch on ${entry.name}`);
  }
  return written;
}

/** Positioned read of exactly `length` bytes, or throw. */
async function readExact(
  fh: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead <= 0) {
      throw new Error('Corrupt zip: unexpected end of file');
    }
    done += bytesRead;
  }
  return buf;
}

/** Narrow a zip64 bigint field to a JS number, refusing values a
 *  double cannot represent exactly (they would silently corrupt
 *  offset math). */
function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Corrupt zip: ${what} out of range`);
  }
  return Number(value);
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Strip path separators + control characters from the upload
 * filename so we can use it as a temp-file name without worrying
 * about directory traversal in the workDir.
 *
 * Defends against `..` traversal: the bare char filter would let
 * a literal `..` through (both chars are in the allowed set). We
 * basename() first to drop any path segments, then run the filter,
 * then collapse leading / trailing dot runs so `..` and `.hidden`
 * cannot escape the workDir or hide as dotfiles.
 */
function sanitizeFileName(name: string): string {
  const fileOnly = basename(name);
  let base = fileOnly.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  base = base.replace(/^\.+/, '_').replace(/\.+$/, '_');
  return base.length > 0 && base !== '_' ? base : 'upload.bin';
}

/**
 * Spawn an external command and resolve when it exits 0. stderr
 * is buffered and surfaced on non-zero exits so the error
 * message in the API response reflects what the tool actually
 * said. stdout is discarded (the CLIs we run produce progress on
 * stderr and silence on stdout, or write to disk directly).
 */
function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      // Cap the buffer so a chatty tool doesn't pin memory.
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

/**
 * Variant of `runCommand` that buffers stdout and resolves with
 * the captured string.  Used for `gdalinfo -json`, where we need
 * the tool's output rather than a side effect.  stderr is still
 * surfaced on non-zero exits the same way.
 */
function runCommandCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      // Cap stdout too -- gdalinfo -json on a hyperspectral image
      // can be megabytes of band statistics.  We only need the
      // first chunk to parse geoTransform / wgs84Extent / bands.
      if (stdout.length > 4 * 1024 * 1024) {
        stdout = stdout.slice(0, 4 * 1024 * 1024);
      }
    });
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
        resolve(stdout);
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
