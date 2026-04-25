import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

  /** Reasonable upload ceiling. Matches the multer config in the controller. */
  readonly maxBytes = 100 * 1024 * 1024; // 100 MB

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

    const gdal = await this.loadGdal();

    // Write to a temp dir so GDAL can open it by path. Directory-based
    // formats (`.gdb`) are delivered as zips, which GDAL handles via
    // its `/vsizip/` virtual filesystem when we point at the zip.
    const dirPath = join(tmpdir(), `gg-ingest-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
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
    const gdal = await this.loadGdal();
    const dirPath = join(tmpdir(), `gg-probe-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;

    try {
      const ds = gdal.open(openPath);
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
        for (let i = 0; i < layerCount; i += 1) {
          const layer = ds.layers.get(i);
          const fields: Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'date';
          }> = [];
          const defCount = layer.fields.count();
          for (let f = 0; f < defCount; f += 1) {
            const def = layer.fields.get(f);
            fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
          }
          out.push({
            name: layer.name,
            geometryType: gdalGeomToSimple(layer.geomType),
            fields,
            featureCount: layer.features.count(),
          });
        }
        return { driver, layers: out };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
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
    const gdal = await this.loadGdal();
    const dirPath = join(tmpdir(), `gg-ingest-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
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
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * gdal-async is a native addon; loading it eagerly would crash the
   * whole portal-api on platforms whose prebuilds are missing. Defer
   * to the first ingest attempt and surface a friendly error if it
   * still fails then.
   */
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

/** Keep tmp filenames predictable and safe for shell-adjacent tools. */
function safeFilename(name: string): string {
  const base = name.replace(/[^\w.-]/g, '_');
  return base.length > 0 ? base : 'upload.bin';
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
 */
function gdalGeomToSimple(
  geomType: number | string,
): 'point' | 'line' | 'polygon' | null {
  const s = String(geomType).toLowerCase();
  if (s.includes('point')) return 'point';
  if (s.includes('line') || s.includes('curve')) return 'line';
  if (s.includes('polygon') || s.includes('surface')) return 'polygon';
  return null;
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
