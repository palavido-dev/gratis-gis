// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unified spatial-file importer. Takes any supported vector file and
 * returns a GeoJSON FeatureCollection, plus metadata the caller can
 * surface in its UI (detected format, feature count, warnings).
 *
 * Supported today (all parsed in-browser, no server round trip):
 *   - GeoJSON (.geojson, .json)
 *   - KML (.kml)
 *   - KMZ (.kmz)
 *   - Shapefile delivered as a .zip (.shp + sidecars)
 *
 * Known gaps (rejected with a clear message):
 *   - File Geodatabase (.gdb or .gdb.zip). Only robust parser is GDAL,
 *     which we haven't wired server-side yet. Users are pointed at
 *     ArcGIS Pro / QGIS to re-export.
 *   - GML, KML-in-network-link, GeoPackage, MBTiles: land later.
 *
 * Parsing libraries are dynamically imported so formats users never
 * touch don't bloat the default bundle.
 */

export type SpatialFormat =
  | 'geojson'
  | 'kml'
  | 'kmz'
  | 'shapefile-zip'
  | 'fgdb'
  | 'unknown';

export interface SpatialImportResult {
  geojson: GeoJSON.FeatureCollection;
  format: SpatialFormat;
  features: number;
  warnings: string[];
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB; keeps inline storage honest.

/** Inspect the filename to pick a parser. Content-sniffing happens inside each branch. */
export function detectFormat(filename: string): SpatialFormat {
  const n = filename.toLowerCase();
  // FGDB check first so `.gdb.zip` doesn't fall into the shapefile branch.
  if (n.endsWith('.gdb.zip') || n.endsWith('.gdb')) return 'fgdb';
  if (n.endsWith('.kmz')) return 'kmz';
  if (n.endsWith('.kml')) return 'kml';
  if (n.endsWith('.geojson')) return 'geojson';
  if (n.endsWith('.json')) return 'geojson';
  if (n.endsWith('.zip')) return 'shapefile-zip';
  return 'unknown';
}

export async function importSpatialFile(file: File): Promise<SpatialImportResult> {
  if (file.size > MAX_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the current cap is ${
        MAX_BYTES / 1024 / 1024
      } MB. Use a smaller sample or wait for server-side ingest.`,
    );
  }

  const format = detectFormat(file.name);

  if (format === 'fgdb') {
    throw new Error(
      'File Geodatabase (.gdb) import needs server-side GDAL, which is not yet wired up. For now, open the .gdb in ArcGIS Pro or QGIS and export to Shapefile or GeoJSON, then upload that.',
    );
  }

  if (format === 'geojson') {
    const text = await file.text();
    return parseGeojson(text, 'geojson');
  }

  if (format === 'kml') {
    const text = await file.text();
    const fc = await parseKml(text);
    return {
      geojson: fc,
      format: 'kml',
      features: fc.features.length,
      warnings: [],
    };
  }

  if (format === 'kmz') {
    const fc = await parseKmz(file);
    return {
      geojson: fc,
      format: 'kmz',
      features: fc.features.length,
      warnings: [],
    };
  }

  if (format === 'shapefile-zip') {
    const fc = await parseShapefileZip(file);
    return {
      geojson: fc,
      format: 'shapefile-zip',
      features: fc.features.length,
      warnings: [],
    };
  }

  throw new Error(
    'Unrecognized file type. Supported formats: GeoJSON, KML, KMZ, zipped Shapefile.',
  );
}

function parseGeojson(text: string, format: SpatialFormat): SpatialImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Top-level value must be a GeoJSON FeatureCollection.');
  }
  const obj = parsed as { type?: string; features?: unknown };
  if (obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new Error(
      'Top-level object must be `type: "FeatureCollection"` with a features array. Raw features or geometries aren\'t supported.',
    );
  }
  const fc = parsed as GeoJSON.FeatureCollection;
  return {
    geojson: fc,
    format,
    features: fc.features.length,
    warnings: [],
  };
}

async function parseKml(xml: string): Promise<GeoJSON.FeatureCollection> {
  const { kml } = await import('@tmcw/togeojson');
  // DOMParser('application/xml') yields an XMLDocument, NOT an HTML
  // document, so <script> tags don't execute and innerHTML is not
  // reinterpreted. togeojson consumes the doc via getAttribute /
  // getElementsByTagName, which never reflect the user's text back
  // into a live HTML context. Belt-and-braces: we still scrub any
  // stray <script> / event-handler attributes after parsing so the
  // returned FeatureCollection's properties can't smuggle JS into a
  // popup later (CodeQL js/xss-through-dom).
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror')[0]) {
    throw new Error('That file is not valid KML XML.');
  }
  for (const el of Array.from(doc.getElementsByTagName('script'))) {
    el.parentNode?.removeChild(el);
  }
  const fc = kml(doc);
  if (!fc || fc.type !== 'FeatureCollection') {
    throw new Error('KML converted to an unexpected shape; nothing to render.');
  }
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f): f is GeoJSON.Feature & { geometry: GeoJSON.Geometry } =>
        Boolean(f && f.geometry),
      )
      .map((f) => ({
        type: 'Feature' as const,
        geometry: f.geometry,
        properties: f.properties ?? {},
      })),
  };
}

async function parseKmz(file: File): Promise<GeoJSON.FeatureCollection> {
  // KMZ parsing moved server-side along with shapefile (#50). The
  // browser used to bundle JSZip to extract the .kml entry from
  // the KMZ archive; GDAL is already in portal-api for the
  // streaming ingest path and handles KMZ natively as an OGR
  // driver. Same /api/ingest/to-geojson endpoint as the
  // shapefile branch -- the server picks the right driver based
  // on the file's contents.
  return uploadAndParseSpatialFile(file);
}

async function parseShapefileZip(file: File): Promise<GeoJSON.FeatureCollection> {
  // Shapefile parsing moved server-side (#52). The browser used to
  // run `shpjs` (a 120+ KB shp/dbf parser); GDAL is already in
  // portal-api for the streaming ingest path and produces better
  // output (proper SRS reprojection, multi-layer flattening, real
  // field-type inference).
  return uploadAndParseSpatialFile(file);
}

/**
 * Shared helper for the formats that bounce through the server's
 * GDAL-backed parser (#50, #52). The portal-web BFF injects the
 * Keycloak access token; portal-api accepts any signed-in user here,
 * unlike /ingest/probe and /ingest/stage which need the publish
 * capability, because this helper serves the data-layer, geo-boundary
 * and map editors, and edit rights on those come from `canEdit` on
 * the item rather than from the caller's role. The
 * upstream error message is forwarded as-is so GDAL hints
 * ("missing .prj", "unknown driver", etc.) reach the user
 * instead of a generic "import failed".
 */
async function uploadAndParseSpatialFile(
  file: File,
): Promise<GeoJSON.FeatureCollection> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const resp = await fetch('/api/portal/ingest/to-geojson', {
    method: 'POST',
    body: fd,
  });
  if (!resp.ok) {
    const body = await resp.text();
    let msg = body;
    try {
      const parsed = JSON.parse(body) as { message?: string | string[] };
      msg = Array.isArray(parsed.message)
        ? parsed.message.join('; ')
        : parsed.message ?? body;
    } catch {
      /* not JSON; use raw body */
    }
    throw new Error(msg || `Server returned HTTP ${resp.status}.`);
  }
  const out = (await resp.json()) as {
    geojson: GeoJSON.FeatureCollection;
  };
  return out.geojson;
}
