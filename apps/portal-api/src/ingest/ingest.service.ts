// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  detectCsvColumnPairFromPrefix,
  detectCsvCoordinates,
} from './csv-smart-detect.js';
import {
  DuckDbUnavailableError,
  ParquetUserError,
  collectParquetFromPath,
  isParquetPath,
  probeParquetFromPath,
  streamParquetFromPath,
} from './parquet-reader.js';

/**
 * Opens an uploaded vector file with GDAL and returns a GeoJSON
 * FeatureCollection plus a simple field list.
 *
 * Why GDAL lives on the server and not the browser: File Geodatabase
 * (.gdb) has no robust in-browser parser; OGR reads a dozen more
 * formats for free (GPX, GML, MapInfo TAB, etc.); and the dataset
 * sizes that justify an "ingest this file" workflow (tens of MB,
 * hundreds of thousands of features) belong on the backend anyway.
 *
 * `gdal-async` ships prebuilt Node bindings, so there's no system
 * install step in dev. If the prebuild is missing for the current
 * platform, the import fails and callers get a friendly error.
 */
@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  /** Reasonable upload ceiling. Matches the multer config in the
   *  controller. 1 GB covers a full county-scale parcel layer
   *  (200-500 MB zipped is typical) without forcing the user to
   *  subset first. Anything bigger should go through a future
   *  direct-to-MinIO presigned-PUT path; right now everything
   *  buffers through portal-api which is RAM-bound on the host. */
  readonly maxBytes = 1024 * 1024 * 1024; // 1 GB

  async fileToGeoJson(
    buffer: Buffer,
    originalName: string,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    /** Canonical auth-name:code string for the source SRS we
     *  reprojected from (e.g. "EPSG:26911"), or null when the source
     *  file had no SRS declared (rare; we assume 4326 in that case). */
    sourceSrs: string | null;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }

    // GeoParquet routes through DuckDB, not GDAL: the bundled
    // gdal-async prebuild has no Parquet driver. The reader needs a
    // real file path, so we materialize the buffer the same way the
    // GDAL path does further down.
    if (isParquetPath(originalName)) {
      const tmp = await this.materializeBufferToTemp(buffer, originalName);
      try {
        const out = await collectParquetFromPath(tmp.filePath, undefined);
        return {
          geojson: out.geojson,
          fields: out.fields,
          driver: out.driver,
          sourceSrs: out.sourceSrs,
        };
      } catch (err) {
        throw mapParquetError(err);
      } finally {
        await tmp.cleanup();
      }
    }

    // #160 Smart upload Phase 1: when the upload is a CSV / TSV,
    // try detecting a (latitude, longitude) column pair before
    // falling back to GDAL's CSV driver. GDAL's CSV driver only
    // creates point geometry when the columns are named exactly
    // `latitude` / `longitude` (or via X_POSSIBLE_NAMES env vars
    // we don't set); a real-world CSV with "LAT" / "LNG" or
    // "y_coord" / "x_coord" silently loads as an attribute-only
    // table and produces an empty map. The smart-detect helper
    // returns a Point FeatureCollection when it can identify the
    // pair with high confidence; otherwise we fall through to
    // the original GDAL path so non-CSV formats (and CSVs that
    // are genuinely attribute-only) keep working unchanged.
    if (looksLikeTabularText(originalName)) {
      const detected = detectCsvCoordinates(buffer);
      if (detected.kind === 'detected') {
        this.log.log(
          `Smart-detect found coords in ${originalName}: ` +
            `lat="${detected.latColumn}", lng="${detected.lngColumn}", ` +
            `features=${detected.geojson.features.length}`,
        );
        return {
          geojson: detected.geojson,
          fields: detected.fields,
          driver: 'csv-smart-detect',
          sourceSrs: 'EPSG:4326',
        };
      }
    }

    const gdal = await this.loadGdal();

    // Write to a temp dir so GDAL can open it by path. Directory-based
    // formats (`.gdb`) are delivered as zips, which GDAL handles via
    // its `/vsizip/` virtual filesystem when we point at the zip.
    //
    // mkdtemp creates a uniquely-named directory atomically with
    // 0700 perms (vs `mkdir(join(tmpdir(), uuid))` which races against
    // a malicious symlink and was flagged by CodeQL js/insecure-
    // temporary-file).
    const dirPath = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;

    try {
      const ds = gdal.open(openPath);
      try {
        const layers = ds.layers;
        const layerCount = layers.count();
        if (layerCount === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        // Flatten every layer into one FeatureCollection for v1. A
        // future pass can let the user pick which layer they want.
        const combined: unknown[] = [];
        const fieldMap = new Map<
          string,
          { name: string; type: 'string' | 'number' | 'boolean' | 'date' }
        >();
        const drivers = new Set<string>();
        // Capture the first layer's SRS as the "source" SRS. In
        // practice all layers in a single file share an SRS (it's a
        // container-level property for shapefile zips and GDBs),
        // but we note the first so the provenance block has
        // something stable to record.
        let sourceSrs: string | null = null;
        const target4326 = gdal.SpatialReference.fromEPSG(4326);

        for (let i = 0; i < layerCount; i += 1) {
          const layer = layers.get(i);
          drivers.add(layer.ds.driver.description);
          if (sourceSrs === null) sourceSrs = srsAuthCode(layer.srs);
          // Build a per-layer transform from the layer's SRS to 4326.
          // If the layer has no SRS declared we can't transform: we
          // assume the coordinates are already 4326 (the OGC
          // convention for GeoJSON) and skip the transform.
          const xform = buildTransform(gdal, layer.srs, target4326);
          // Capture field definitions once per distinct name.
          const defs = layer.fields;
          const defCount = defs.count();
          for (let f = 0; f < defCount; f += 1) {
            const def = defs.get(f);
            if (!fieldMap.has(def.name)) {
              fieldMap.set(def.name, {
                name: def.name,
                type: gdalTypeToSimple(def.type),
              });
            }
          }
          // Iterate features. `layer.features.forEach` would be nicer
          // but gdal-async's iterator helpers don't always cover every
          // driver; the explicit loop is bulletproof.
          layer.features.forEach((feature) => {
            const geomJson = featureGeomJson(feature, xform);
            if (!geomJson) return;
            const props: Record<string, unknown> = feature.fields.toObject();
            combined.push({
              type: 'Feature',
              geometry: geomJson,
              properties: props,
            });
          });
        }

        return {
          geojson: { type: 'FeatureCollection', features: combined },
          fields: [...fieldMap.values()],
          driver: [...drivers].join(', '),
          sourceSrs,
        };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    } finally {
      // Clean up the scratch dir even if GDAL threw, so we don't
      // accumulate temp files under sustained failure.
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Probe an uploaded file and return per-layer metadata (name,
   * geometry type, fields, feature count) without reading geometry.
   * Lets the builder preview what's in a shapefile zip / KML / GDB
   * before the user commits to adding specific layers.
   *
   * A GDB archive typically has many layers; shapefile zips can too
   * (one per .shp inside the zip). KML/KMZ often has a single layer
   * but sometimes multiple. GeoJSON is always one layer.
   */
  async probeFile(
    buffer: Buffer,
    originalName: string,
  ): Promise<{
    driver: string;
    layers: Array<{
      name: string;
      geometryType: 'point' | 'line' | 'polygon' | null;
      fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }>;
      featureCount: number;
    }>;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    // mkdtemp: atomic + 0700, vs mkdir-after-join which races.
    const dirPath = await mkdtemp(join(tmpdir(), 'gg-probe-'));
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    try {
      return await this.probeFileFromPath(filePath);
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Path variant of probeFile. Used by the staged-upload path: the
   * file already lives on disk under /tmp/gg-staging/<id>/, so we
   * skip the buffer-write step entirely. The cleanup of the staging
   * dir is the staging service's problem, not this method's.
   */
  async probeFileFromPath(filePath: string): Promise<{
    driver: string;
    layers: Array<{
      name: string;
      geometryType: 'point' | 'line' | 'polygon' | null;
      fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }>;
      featureCount: number;
    }>;
  }> {
    // GeoParquet branch. The buffer variant (probeFile) lands here
    // too because it writes to a temp path that keeps the original
    // extension. Single layer, named after the file stem.
    if (isParquetPath(filePath)) {
      try {
        return await probeParquetFromPath(filePath);
      } catch (err) {
        throw mapParquetError(err);
      }
    }
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    try {
      const ds = await this.openVector(gdal, openPath, filePath);
      try {
        const layerCount = ds.layers.count();
        if (layerCount === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        const driver = ds.driver.description;
        const out: Array<{
          name: string;
          geometryType: 'point' | 'line' | 'polygon' | null;
          fields: Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'date';
          }>;
          featureCount: number;
        }> = [];
        // GPKG-specific: build a quick lookup of which tables the
        // file registers as feature layers vs auxiliary tables. The
        // GeoPackage spec ships an extension model (NGA style
        // extension, etc.) that stamps `nga_*` / `gpkg_*` /
        // `rtree_*` auxiliary tables alongside the actual feature
        // data. GDAL's GPKG driver exposes some of them as
        // zero-geometry layers, which would otherwise show up in
        // the data_layer wizard as anonymous "TABLE" entries
        // alongside the real layers. (Reported by user: a GPKG
        // with one rivers layer + four NGA style tables came in
        // with `rivers` shown as a non-spatial table because GDAL
        // reported its geomType as wkbUnknown.)
        //
        // The fix queries gpkg_contents through the dataset's
        // executeSQL hook (which gdal-async exposes via
        // `dataset.executeSQL`) to keep only tables registered
        // with data_type='features'. Non-GPKG drivers skip this
        // entirely and use the plain layer enumeration.
        const featureTableAllowlist =
          driver === 'GPKG' ? readGpkgFeatureTables(ds) : null;

        for (let i = 0; i < layerCount; i += 1) {
          const layer = ds.layers.get(i);
          if (
            featureTableAllowlist !== null &&
            !featureTableAllowlist.has(layer.name)
          ) {
            // Skip GPKG aux tables (NGA style, gpkg internals,
            // rtree spatial indexes, etc.) that aren't registered
            // as features in gpkg_contents. The data_layer wizard
            // is for SPATIAL data; non-feature tables belong in
            // a separate "related tables" surface that doesn't
            // exist yet.
            continue;
          }
          const fields: Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'date';
          }> = [];
          const defCount = layer.fields.count();
          for (let f = 0; f < defCount; f += 1) {
            const def = layer.fields.get(f);
            fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
          }
          // Geometry type detection. The declared geomType is
          // authoritative when it's a specific WKB type (Point,
          // LineString, Polygon, etc.). When it's wkbUnknown (0),
          // wkbGeometry (used by GPKG layers registered with the
          // generic 'GEOMETRY' type), or wkbNone (100, attribute-
          // only), the layer's declared type isn't useful and we
          // need to peek at the first feature's actual geometry
          // to decide. Without the peek, a GPKG layer with
          // geometry_type_name='GEOMETRY' shows up as a TABLE in
          // the wizard even though every row carries a real
          // LineString / MultiPolygon / etc. geometry.
          let geometryType = gdalGeomToSimple(layer.geomType);
          if (geometryType === null) {
            geometryType = peekFirstFeatureGeomType(layer);
          }
          out.push({
            name: layer.name,
            geometryType,
            fields,
            featureCount: layer.features.count(),
          });
        }
        if (out.length === 0) {
          throw new BadRequestException(
            'The file contains no spatial layers we can import. Only feature tables (with geometry) are supported.',
          );
        }
        return { driver, layers: out };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    }
  }

  /**
   * Extract features from a single named layer inside an uploaded
   * archive. If `sourceLayer` is omitted and the file has exactly one
   * layer, that single layer is used. Used by the v3 per-layer import
   * endpoint so authors can target, say, one table inside a GDB.
   */
  async fileLayerToGeoJson(
    buffer: Buffer,
    originalName: string,
    sourceLayer: string | undefined,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    /** Canonical auth-name:code string for the source SRS, if the
     *  layer declared one. See fileToGeoJson for rationale. */
    sourceSrs: string | null;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    // mkdtemp: atomic + 0700, vs mkdir-after-join which races.
    const dirPath = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    try {
      return await this.fileLayerToGeoJsonFromPath(filePath, sourceLayer);
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Path variant of fileLayerToGeoJson. Used by the staged-upload
   * path: the file is already on disk under the staging dir, so we
   * skip the buffer-write step. Cleanup of the staging dir is the
   * staging service's problem; callers must NOT delete `filePath` --
   * a single staging is consumed by N per-layer ingests.
   */
  async fileLayerToGeoJsonFromPath(
    filePath: string,
    sourceLayer: string | undefined,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    sourceSrs: string | null;
  }> {
    // GeoParquet branch: collect through the DuckDB reader. The
    // buffer variant (fileLayerToGeoJson) lands here via its temp
    // write, same as the GDAL path.
    if (isParquetPath(filePath)) {
      try {
        return await collectParquetFromPath(filePath, sourceLayer);
      } catch (err) {
        throw mapParquetError(err);
      }
    }
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    try {
      const ds = gdal.open(openPath);
      try {
        const layers = ds.layers;
        const count = layers.count();
        if (count === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        // Resolve which layer to read.
        let targetIdx = -1;
        if (sourceLayer) {
          for (let i = 0; i < count; i += 1) {
            if (layers.get(i).name === sourceLayer) {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx === -1) {
            throw new BadRequestException(
              `File has no layer named "${sourceLayer}".`,
            );
          }
        } else if (count === 1) {
          targetIdx = 0;
        } else {
          throw new BadRequestException(
            `File has ${count} layers. Specify which one via the "sourceLayer" query parameter.`,
          );
        }

        const layer = layers.get(targetIdx);
        const fields: Array<{
          name: string;
          type: 'string' | 'number' | 'boolean' | 'date';
        }> = [];
        const defCount = layer.fields.count();
        for (let f = 0; f < defCount; f += 1) {
          const def = layer.fields.get(f);
          fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
        }
        const target4326 = gdal.SpatialReference.fromEPSG(4326);
        const xform = buildTransform(gdal, layer.srs, target4326);
        const features: unknown[] = [];
        layer.features.forEach((feature) => {
          const geomJson = featureGeomJson(feature, xform);
          if (!geomJson) return;
          const props: Record<string, unknown> = feature.fields.toObject();
          features.push({
            type: 'Feature',
            geometry: geomJson,
            properties: props,
          });
        });
        return {
          geojson: { type: 'FeatureCollection', features },
          fields,
          driver: ds.driver.description,
          layerName: layer.name,
          sourceSrs: srsAuthCode(layer.srs),
        };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    }
  }

  /**
   * Write a multipart upload buffer to a fresh temp dir and return
   * the on-disk path plus a cleanup hook. Used by callers that have
   * a Buffer in hand but want to feed the streaming GDAL reader,
   * which only accepts a path. The cleanup hook should be invoked
   * in a finally block by the caller; failures are swallowed so a
   * crashed cleanup doesn't mask the real error.
   */
  async materializeBufferToTemp(
    buffer: Buffer,
    originalName: string,
  ): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    // mkdtemp: atomic + 0700, vs mkdir-after-join which races.
    const dirPath = await mkdtemp(join(tmpdir(), 'gg-ingest-'));
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    const cleanup = async () => {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    };
    return { filePath, cleanup };
  }

  /**
   * Streaming variant of fileLayerToGeoJsonFromPath. Walks features
   * in order, invoking `onBatch` every `batchSize` features so the
   * caller can insert rows incrementally instead of buffering the
   * whole layer in JS memory.
   *
   * Why this exists: a county-scale parcel layer (1.4M polygons +
   * 19 attribute fields) blew through Node's 1.5 GB heap when the
   * non-streaming variant tried to materialise the full
   * FeatureCollection. With streaming, peak memory is bounded by
   * batchSize regardless of source dataset size.
   *
   * The callback may return a Promise; we await it before resuming
   * iteration so DB back-pressure naturally throttles GDAL. GDAL's
   * own forEach is synchronous, so we use index-based access
   * (layer.features.get(i)) instead and yield control between
   * batches via `await onBatch(...)`. Features whose geometry
   * decode returns null (rare; corrupt rows in legacy shapefiles)
   * are skipped silently and counted in `processed` so the total
   * matches what GDAL reported up front.
   *
   * Returns metadata about the source after the stream finishes.
   */
  async streamLayerFromPath(
    filePath: string,
    sourceLayer: string | undefined,
    onBatch: (
      batch: Array<{ geometry: unknown; properties: Record<string, unknown> }>,
      progress: { processed: number; total: number },
    ) => Promise<void>,
    opts: {
      batchSize?: number;
      /**
       * Force table mode: emit every row with a null geometry.
       *
       * Table-ness is a property of the TARGET, not of the file. The
       * source was the only thing consulted (`layer.geomType ===
       * wkbNone`), which is right for a geodatabase table and wrong
       * for everything else: a GeoJSON or CSV of related records
       * reads back as a geometry-bearing layer whose features happen
       * to have none, so every row was skipped and the import
       * reported `inserted: 0` with no error. The caller knows the
       * target layer's geometryType; when that is null it says so
       * here and the source's opinion stops mattering.
       */
      isTable?: boolean;
    } = {},
  ): Promise<{
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    sourceSrs: string | null;
    total: number;
  }> {
    const batchSize = opts.batchSize ?? 5000;
    // GeoParquet branch: DuckDB streams vector-sized chunks, so peak
    // memory stays bounded by batchSize exactly like the GDAL cursor
    // walk below. The batch and return contracts are identical.
    if (isParquetPath(filePath)) {
      try {
        return await streamParquetFromPath(filePath, sourceLayer, onBatch, {
          batchSize,
        });
      } catch (err) {
        throw mapParquetError(err);
      }
    }
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    const ds = await this.openVector(gdal, openPath, filePath);
    try {
      const layers = ds.layers;
      const count = layers.count();
      if (count === 0) {
        throw new BadRequestException(
          'GDAL opened the file but found no vector layers inside.',
        );
      }
      let targetIdx = -1;
      if (sourceLayer) {
        for (let i = 0; i < count; i += 1) {
          if (layers.get(i).name === sourceLayer) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx === -1) {
          throw new BadRequestException(
            `File has no layer named "${sourceLayer}".`,
          );
        }
      } else if (count === 1) {
        targetIdx = 0;
      } else {
        throw new BadRequestException(
          `File has ${count} layers. Specify which one via the "sourceLayer" query parameter.`,
        );
      }

      const layer = layers.get(targetIdx);
      const fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }> = [];
      const defCount = layer.fields.count();
      for (let f = 0; f < defCount; f += 1) {
        const def = layer.fields.get(f);
        fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
      }
      const target4326 = gdal.SpatialReference.fromEPSG(4326);
      const xform = buildTransform(gdal, layer.srs, target4326);
      const total = layer.features.count();

      let batch: Array<{
        geometry: unknown;
        properties: Record<string, unknown>;
      }> = [];
      let processed = 0;
      // The caller's target wins; the source's own wkbNone is the
      // fallback for a genuine geodatabase table. See opts.isTable.
      const isTable = opts.isTable === true || layer.geomType === 100;

      // Cursor walk via first()/next(). gdal-async's
      // `layer.features.get(i)` looks up by FID, NOT by index --
      // GDB layers commonly have non-sequential FIDs (e.g. starting
      // at 1 with deletions creating gaps), so the indexed loop
      // 404s on the first iteration and tears the stream. The
      // forEach variant works because it iterates the cursor under
      // the hood; we drive the same cursor manually so we can yield
      // to the event loop with `await onBatch` between flushes
      // without buffering the whole layer in memory.
      let feature = layer.features.first();
      while (feature) {
        processed += 1;
        const geomJson = isTable ? null : featureGeomJson(feature, xform);
        // Spatial layer with an undecodable geometry: skip silently
        // (matches what the legacy non-streaming path did). For
        // table-mode layers, the absence of geometry is expected and
        // we still emit the row.
        const skip = !isTable && !geomJson;
        if (!skip) {
          const props: Record<string, unknown> = feature.fields.toObject();
          batch.push({
            geometry: isTable ? null : geomJson,
            properties: props,
          });
          if (batch.length >= batchSize) {
            await onBatch(batch, { processed, total });
            batch = [];
          }
        }
        feature = layer.features.next();
        // #115 P7: yield the event loop every ~256 features. gdal-
        // async's first()/next() and featureGeomJson are SYNCHRONOUS
        // C++ calls -- a tight while-loop over them blocks the Node
        // thread for seconds at a time on county-scale polygon
        // datasets, which starves portal-api of cycles for ANY other
        // request (item GETs, SSR fetches, the import-jobs polling
        // banner, the cancel button itself). Without this yield the
        // import is fast but the rest of the app is unusable while
        // it runs. setImmediate is enough to drain the I/O queue;
        // setTimeout(0) would over-yield. The 256 cadence keeps the
        // throughput cost in the single-digit-percent range while
        // delivering low-double-digit ms event-loop responsiveness.
        if (processed % 256 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (batch.length > 0) {
        await onBatch(batch, { processed, total });
      }

      return {
        fields,
        driver: ds.driver.description,
        layerName: layer.name,
        sourceSrs: srsAuthCode(layer.srs),
        total,
      };
    } finally {
      ds.close();
    }
  }

  /**
   * gdal-async is a native addon; loading it eagerly would crash the
   * whole portal-api on platforms whose prebuilds are missing. Defer
   * to the first ingest attempt and surface a friendly error if it
   * still fails then.
   */
  /**
   * Bytes read from the head of a delimited text file to name its
   * coordinate columns. The detector needs the header plus at most
   * SMART_DETECT_LIMITS.VALIDATION_SAMPLE_ROWS rows, so this is
   * generous even for wide files, and it is a fixed cost regardless
   * of whether the upload is 4 KB or the 1 GB ceiling.
   */
  private static readonly CSV_SNIFF_BYTES = 64 * 1024;

  /**
   * Open a vector dataset, telling GDAL where a delimited file keeps
   * its coordinates when it cannot work that out on its own.
   *
   * GDAL's CSV driver only builds point geometry when the columns are
   * literally named `latitude` / `longitude`, or when it is handed
   * X_POSSIBLE_NAMES / Y_POSSIBLE_NAMES as open options. Nothing set
   * those, so a real-world CSV with LAT / LNG or y_coord / x_coord
   * loaded as an attribute-only table and produced an empty map. The
   * smart-detect helper that solves the naming problem existed and
   * was well tested, but it was only reachable from fileToGeoJson,
   * which no UI path calls; the wizard and the detail-page import
   * both come through probeFileFromPath / streamLayerFromPath. So the
   * product shipped a help article describing a feature with no entry
   * point.
   *
   * The fix keeps the two halves apart. Detection reads a fixed
   * prefix and yields two column names; GDAL then streams the file
   * exactly as it streams every other format. Materialising the whole
   * CSV as a FeatureCollection, which is what fileToGeoJson does,
   * would not survive the 1 GB upload ceiling.
   *
   * `gdal.open()` cannot carry open options (the binding passes NULL
   * to GDALOpenEx), so this goes through the CSV driver directly,
   * which does.
   */
  private async openVector(
    gdal: typeof import('gdal-async'),
    openPath: string,
    filePath: string,
  ): Promise<import('gdal-async').Dataset> {
    // /vsizip/ paths are archives, never a bare delimited file.
    if (looksLikeTabularText(filePath) && !openPath.startsWith('/vsizip/')) {
      const pair = await this.sniffCsvColumns(filePath);
      if (pair) {
        this.log.log(
          `CSV coordinate columns in ${basename(filePath)}: ` +
            `lat="${pair.latColumn}", lng="${pair.lngColumn}"`,
        );
        // KEEP_GEOM_COLUMNS=YES leaves the source lat / lng columns in
        // the attribute table as well. They are the user's data and
        // they asked for a faithful import; dropping them would also
        // make a re-export lossy.
        return gdal.drivers.get('CSV').open(openPath, 'r', [
          `X_POSSIBLE_NAMES=${pair.lngColumn}`,
          `Y_POSSIBLE_NAMES=${pair.latColumn}`,
          'KEEP_GEOM_COLUMNS=YES',
        ]);
      }
    }
    return gdal.open(openPath);
  }

  /**
   * True when `candidate` resolves to somewhere inside a directory
   * ingest is allowed to read from.
   *
   * Two roots are legitimate. Staged uploads live under STAGING_DIR
   * when prod sets it (a named volume shared with portal-worker), and
   * everything else, including the mkdtemp `gg-ingest-` dirs the
   * buffer paths create, lives under the OS temp dir.
   *
   * Compared with path.relative rather than a string prefix, because
   * a prefix test says /tmp/gg-staging-evil is inside /tmp/gg-staging.
   */
  private isInsideIngestRoot(candidate: string): boolean {
    const target = resolve(candidate);
    const staging = process.env.STAGING_DIR?.trim();
    const roots = [resolve(tmpdir()), ...(staging ? [resolve(staging)] : [])];
    return roots.some((root) => {
      const rel = relative(root, target);
      return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
    });
  }

  /**
   * Read the head of a delimited file and name its coordinate pair.
   * Returns null when there is no confident pair, which puts the
   * caller back on the plain GDAL path: a CSV that genuinely has no
   * coordinates is a table, and importing it as one is correct.
   */
  private async sniffCsvColumns(
    filePath: string,
  ): Promise<{ latColumn: string; lngColumn: string } | null> {
    // Containment check before opening. Ingest paths are built by the
    // server (join(root, <uuid>, safeFilename(name))) and
    // safeFilename already strips traversal, so this is defence in
    // depth rather than the only guard. It is here because this is
    // the first plain fs sink on the ingest path: every other reader
    // hands the path to GDAL, which a static analyser does not model,
    // so the taint has never been visible before. An unvalidated
    // sink is worth closing even when the value reaching it happens
    // to be clean today, because the thing that changes is the
    // caller.
    if (!this.isInsideIngestRoot(filePath)) {
      this.log.warn(
        `Refusing to sniff a path outside the ingest roots: ${basename(
          filePath,
        )}`,
      );
      return null;
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(filePath, 'r');
      const buf = Buffer.alloc(IngestService.CSV_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const truncated = bytesRead === buf.length;
      const pair = detectCsvColumnPairFromPrefix(
        buf.subarray(0, bytesRead),
        truncated,
      );
      if (pair.kind !== 'detected') {
        this.log.debug?.(
          `No coordinate columns in ${basename(filePath)}: ${pair.reason}`,
        );
        return null;
      }
      return { latColumn: pair.latColumn, lngColumn: pair.lngColumn };
    } catch (err) {
      // Sniffing is an enhancement, never a reason to fail an import.
      this.log.warn(
        `CSV coordinate sniff failed for ${basename(filePath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async loadGdal(): Promise<typeof import('gdal-async')> {
    try {
      const mod = await import('gdal-async');
      return (mod as unknown as { default?: typeof import('gdal-async') }).default ?? mod;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`gdal-async failed to load: ${msg}`);
      throw new InternalServerErrorException(
        'Server-side ingest is unavailable because GDAL is not installed. Install the gdal-async native binding or use the client-side upload flow for supported formats.',
      );
    }
  }
}

/**
 * Keep tmp filenames predictable and safe for shell-adjacent tools.
 *
 * Defends against path-traversal: the user-supplied name flows into
 * join(tmpdir, ..., safeFilename(name)) so a malicious `../../etc/x`
 * could otherwise escape the temp dir. We:
 *   1. take only the basename so any path segments are stripped,
 *   2. replace every non-[A-Za-z0-9._-] character with `_`,
 *   3. strip leading dots so a literal `..` or `.hidden` can't
 *      survive (a leading dot becomes a single `_`),
 *   4. fall back to upload.bin when the result is empty.
 *
 * The dot stripping is the load-bearing step against `..`-style
 * traversal; the basename strip + char filter handle the rest.
 */
/**
 * Tabular-text recognition for the #160 smart-detect fast path.
 * Returns true for filenames whose extension reads as CSV/TSV-
 * shaped text content. Non-CSV files skip the smart-detect pass
 * and fall straight through to GDAL where they belong.
 */
function looksLikeTabularText(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.txt')
  );
}

/**
 * Translate parquet-reader errors into the HTTP vocabulary the GDAL
 * branches use. The reader is Nest-free (the Dockerfile requires it
 * standalone to bake the DuckDB spatial extension), so the mapping
 * to HttpExceptions has to happen here: ParquetUserError carries a
 * user-actionable message and surfaces verbatim as a 400, a missing
 * DuckDB binding is a 500 exactly like a missing gdal-async prebuild,
 * and anything else gets the same "could not read that file" framing
 * the GDAL catch blocks produce.
 */
function mapParquetError(err: unknown): Error {
  if (
    err instanceof BadRequestException ||
    err instanceof InternalServerErrorException
  ) {
    return err;
  }
  if (err instanceof ParquetUserError) {
    return new BadRequestException(err.message);
  }
  if (err instanceof DuckDbUnavailableError) {
    return new InternalServerErrorException(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new BadRequestException(
    `DuckDB could not read that Parquet file: ${msg}`,
  );
}

function safeFilename(name: string): string {
  const fileOnly = basename(name);
  let base = fileOnly.replace(/[^\w.-]/g, '_');
  // Replace any leading-dot run so '..' / '.hidden' cannot escape
  // the temp dir or hide as a dotfile. A single trailing dot is also
  // suspicious on Windows; flatten it.
  base = base.replace(/^\.+/, '_').replace(/\.+$/, '_');
  return base.length > 0 && base !== '_' ? base : 'upload.bin';
}

function gdalTypeToSimple(
  t: string,
): 'string' | 'number' | 'boolean' | 'date' {
  const u = t.toLowerCase();
  if (u.includes('int') || u.includes('real') || u.includes('double')) {
    return 'number';
  }
  if (u.includes('date') || u.includes('time')) return 'date';
  if (u.includes('bool')) return 'boolean';
  return 'string';
}

/**
 * Reduce a GDAL WKB geometry type (Point, MultiLineString, etc.) to the
 * tri-state we expose in the builder. Returns null when GDAL reports no
 * specific geometry (attribute-only "table" layer inside a GDB or
 * unknown / mixed geometries inside a shapefile).
 *
 * gdal-async hands us `layer.geomType` as a numeric WKB constant
 * (Point=1, LineString=2, Polygon=3, MultiPoint=4, MultiLineString=5,
 * MultiPolygon=6, plus the +1000/+2000/+3000 dimension variants for
 * Z/M/ZM). The earlier implementation only ran a string includes()
 * check, which mapped numeric values to null and surfaced every
 * shapefile in the wizard as a TABLE rather than the polygon /
 * point / line layer it actually was. Now we fold the numeric path
 * into a real switch over the WKB base type and keep the string
 * fallback for environments where gdal-async returns a name.
 */
function gdalGeomToSimple(
  geomType: number | string,
): 'point' | 'line' | 'polygon' | null {
  const n =
    typeof geomType === 'number'
      ? geomType
      : Number.parseInt(String(geomType), 10);
  if (Number.isFinite(n) && n > 0 && n !== 100) {
    // Strip the high-bit EWKB flag and the dimension offsets
    // (Z=+1000, M=+2000, ZM=+3000) so PointZ, PointM, PointZM all
    // collapse to plain Point.
    const masked = n & 0x7fffffff;
    const base = ((masked - 1) % 1000) + 1;
    switch (base) {
      case 1: // Point
      case 4: // MultiPoint
        return 'point';
      case 2: // LineString
      case 5: // MultiLineString
      case 8: // CircularString
      case 9: // CompoundCurve
      case 11: // MultiCurve
      case 13: // Curve
        return 'line';
      case 3: // Polygon
      case 6: // MultiPolygon
      case 10: // CurvePolygon
      case 12: // MultiSurface
      case 14: // Surface
      case 15: // PolyhedralSurface
      case 16: // TIN
      case 17: // Triangle
        return 'polygon';
      default:
        break;
    }
  }
  const s = String(geomType).toLowerCase();
  if (s.includes('point')) return 'point';
  if (s.includes('line') || s.includes('curve')) return 'line';
  if (s.includes('polygon') || s.includes('surface')) return 'polygon';
  return null;
}

/**
 * GPKG-specific filter: query `gpkg_contents` through gdal-async's
 * `executeSQL` hook to identify which tables are registered as
 * feature layers (data_type='features'). The data_layer wizard
 * uses this to skip auxiliary tables (NGA style extension's
 * `nga_*` tables, gpkg internals, rtree spatial-index tables,
 * tile pyramids, etc.) that GDAL otherwise exposes as
 * zero-geometry layers.
 *
 * Returns a Set of allowed table names. If anything goes wrong
 * (no gpkg_contents, executeSQL fails, etc.) we return an empty
 * set rather than failing; the caller treats null vs empty
 * differently: null skips filtering entirely (non-GPKG drivers);
 * empty set means "we tried to filter and nothing qualified."
 *
 * The any-cast is because gdal-async's TypeScript declarations
 * don't currently surface executeSQL; the method is available at
 * runtime on the Dataset object.
 */
function readGpkgFeatureTables(ds: unknown): Set<string> {
  const set = new Set<string>();
  try {
    const sql = `
      SELECT table_name FROM gpkg_contents WHERE data_type = 'features'
    `;
    // gdal-async exposes executeSQL on the Dataset; the result is a
    // virtual Layer with one row per result. Iterate it to collect
    // table names. We release the result layer immediately so the
    // virtual layer doesn't leak.
    const dataset = ds as {
      executeSQL: (sql: string) => {
        features: { forEach: (cb: (f: unknown) => void) => void };
      };
      releaseResultSet?: (layer: unknown) => void;
    };
    const result = dataset.executeSQL(sql);
    result.features.forEach((f) => {
      const feature = f as { fields: { get: (name: string) => unknown } };
      const tableName = feature.fields.get('table_name');
      if (typeof tableName === 'string' && tableName.length > 0) {
        set.add(tableName);
      }
    });
    // Best-effort cleanup; many gdal-async builds don't expose
    // releaseResultSet directly. The result layer is gc'd anyway
    // when the dataset closes.
    if (typeof dataset.releaseResultSet === 'function') {
      try {
        dataset.releaseResultSet(result);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    // No gpkg_contents (malformed GPKG?) or executeSQL not
    // available. Fall through to "everything passes" by treating
    // missing filter as null at the call site.
  }
  return set;
}

/**
 * Read the first feature's geometry from a GDAL layer and classify
 * it as point / line / polygon. Used when the layer's DECLARED
 * geometry type is unknown (wkbUnknown / wkbGeometry / 'GEOMETRY' in
 * GeoPackage parlance) but the rows themselves carry real
 * geometries. Without this, GPKG layers registered with the
 * generic 'GEOMETRY' type show up as zero-geometry tables.
 *
 * Returns null when the layer has no features or none of them have
 * geometry; in that case the layer probably IS attribute-only.
 */
function peekFirstFeatureGeomType(
  layer: unknown,
): 'point' | 'line' | 'polygon' | null {
  try {
    const l = layer as {
      features: {
        first: () => { geometry: { name: string } | null } | null;
      };
    };
    const first = l.features.first();
    if (!first || !first.geometry) return null;
    return gdalGeomToSimple(first.geometry.name);
  } catch {
    return null;
  }
}

/**
 * Pull a GeoJSON geometry object out of a gdal feature. gdal-async's
 * `geometry.toJSON()` returns a JSON string, so we parse it; falling
 * back to `toObject()` if the JSON string is ever absent.
 *
 * If a CoordinateTransformation is supplied, the geometry is
 * reprojected in-place into the target SRS before serialization.
 * That's the critical piece for #48: without this, a shapefile in
 * UTM meters (EPSG:26911) would land in PostGIS with 4326 declared
 * but coordinates like `[480000, 3750000]`: off in the Gulf of
 * Guinea when rendered.
 */
function featureGeomJson(
  feature: unknown,
  transform: unknown | null,
): unknown | null {
  // Local shape-based access to gdal-async's Feature. Typed-through
  // `unknown` at the boundary because the real `gdal.Feature` type
  // constrains `geom.transform` to `CoordinateTransformation`, and
  // we want this helper usable with the transform built by
  // `buildTransform` below which we also type as `unknown` so
  // callers aren't forced to import gdal types.
  const f = feature as {
    getGeometry: () => {
      toJSON: () => string;
      toObject?: () => unknown;
      transform?: (x: unknown) => void;
    } | null;
  };
  const geom = f.getGeometry();
  if (!geom) return null;
  if (transform && typeof geom.transform === 'function') {
    try {
      geom.transform(transform);
    } catch {
      // Reprojection can fail on malformed geometries (self-
      // intersecting polygons, empty rings). Drop silently: the
      // caller's feature count reflects what actually made it in.
      return null;
    }
  }
  try {
    return JSON.parse(geom.toJSON());
  } catch {
    return geom.toObject ? geom.toObject() : null;
  }
}

/**
 * Build a gdal CoordinateTransformation from a layer's source SRS
 * to EPSG:4326 for ingest. Returns null when:
 *   - the layer has no declared SRS (assume the caller wants no
 *     transform: e.g. already-4326 GeoJSON with no explicit SRS)
 *   - the layer's SRS already IS 4326 (transform would be a no-op)
 *   - building the transform throws (proj lookup failure, etc.)
 * A null return tells featureGeomJson to skip the transform step.
 */
function buildTransform(
  gdal: typeof import('gdal-async'),
  sourceSrs: unknown,
  target4326: unknown,
): unknown | null {
  if (!sourceSrs) return null;
  const srsWithAuth = sourceSrs as {
    getAuthorityName?: () => string | null;
    getAuthorityCode?: () => string | null;
  };
  // Skip transform if source already claims EPSG:4326: cheapest
  // correctness path, and avoids a no-op roundtrip through proj.
  try {
    if (
      srsWithAuth.getAuthorityName?.() === 'EPSG' &&
      srsWithAuth.getAuthorityCode?.() === '4326'
    ) {
      return null;
    }
  } catch {
    /* fall through to build the transform: safer than refusing */
  }
  try {
    return new (gdal as unknown as {
      CoordinateTransformation: new (a: unknown, b: unknown) => unknown;
    }).CoordinateTransformation(sourceSrs, target4326);
  } catch {
    return null;
  }
}

/**
 * Collapse a gdal SpatialReference into an "EPSG:NNNN" string for
 * the provenance block. When the SRS has no declared authority
 * (some exotic projected CRSes define only a WKT string), fall back
 * to "CRS:unknown" so the UI has something to display.
 */
function srsAuthCode(srs: unknown): string | null {
  if (!srs) return null;
  const s = srs as {
    getAuthorityName?: () => string | null;
    getAuthorityCode?: () => string | null;
  };
  try {
    const auth = s.getAuthorityName?.();
    const code = s.getAuthorityCode?.();
    if (auth && code) return `${auth}:${code}`;
  } catch {
    /* fall through */
  }
  return 'CRS:unknown';
}
