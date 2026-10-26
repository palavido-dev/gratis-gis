// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #234: GDAL/OGR open-path lockdown for user-supplied files.
 *
 * Ingest opens uploads with GDAL. A crafted VRT / GML / or zip member
 * can name `/vsicurl/http://169.254.169.254/...` (or another private
 * host) and GDAL will fetch it outside our `safeFetch` egress fence.
 * Internal raster paths legitimately use `/vsis3/` against MinIO and
 * workers build local VRTs — those stay allowed. This guard only
 * refuses the network VSI handlers and VRT/XML sidecars that point at
 * them before GDAL gets a chance to dial out.
 */

const BLOCKED_VSI = [
  '/vsicurl/',
  '/vsicurls/',
  '/vsicurl_streaming/',
  '/vsicurl_streaming_streaming/',
  '/vsicurl_streaming',
];

/** True when `pathOrUrl` names a blocked network VSI handler. */
export function hasBlockedVsi(pathOrUrl: string): boolean {
  const lower = pathOrUrl.toLowerCase();
  return BLOCKED_VSI.some((p) => lower.includes(p));
}

/**
 * Refuse open paths that would let GDAL dial out. Call before every
 * `gdal.open` / driver.open on a user-supplied file.
 *
 * `openPath` is what we hand GDAL (`/vsizip/...` or a local path).
 * `sourceName` is the original filename (for extension checks).
 * `fileBytes` is optional; when present and the name looks like VRT
 * XML, we also scan the body for blocked VSI / absolute http(s) refs.
 */
export function assertSafeGdalOpenPath(args: {
  openPath: string;
  sourceName: string;
  fileBytes?: Buffer | string | null;
}): void {
  if (hasBlockedVsi(args.openPath)) {
    throw new Error(
      'This file references a network path GDAL is not allowed to fetch.',
    );
  }
  const name = args.sourceName.toLowerCase();
  const looksVrt =
    name.endsWith('.vrt') ||
    name.endsWith('.xml') ||
    name.endsWith('.ovf');
  if (!looksVrt || args.fileBytes == null) return;
  const head =
    typeof args.fileBytes === 'string'
      ? args.fileBytes.slice(0, 256_000)
      : args.fileBytes.subarray(0, 256_000).toString('utf8');
  if (hasBlockedVsi(head)) {
    throw new Error(
      'This VRT/XML references a network path GDAL is not allowed to fetch.',
    );
  }
  // Absolute http(s) inside a VRT SourceFilename is the same class of
  // hole even without the /vsicurl/ prefix (GDAL may promote it).
  if (/SourceFilename[^>]*>\s*https?:\/\//i.test(head)) {
    throw new Error(
      'This VRT references an absolute HTTP(S) source, which is not allowed.',
    );
  }
}

/**
 * Apply process-wide GDAL config that hardens outbound HTTP without
 * breaking `/vsis3/` (MinIO) or local VRT mosaics. Safe to call more
 * than once; idempotent via env + gdal.config when available.
 */
/**
 * Default vector drivers ingest may open. VRT is excluded on purpose
 * (#234 MED-10): a crafted VRT is the usual /vsicurl/ smuggling path.
 * Override with `GDAL_ALLOWED_DRIVERS` (comma/space separated) on
 * portal-api / portal-worker. Point-cloud workers keep a broader set
 * (including VRT/GTiff) and do not call this allowlist.
 */
export const DEFAULT_GDAL_ALLOWED_DRIVERS = [
  'GeoJSON',
  'GeoJSONSeq',
  'ESRI Shapefile',
  'GPKG',
  'OpenFileGDB',
  'FileGDB',
  'CSV',
  'GPX',
  'GML',
  'KML',
  'LIBKML',
  'MapInfo File',
  'FlatGeobuf',
  'SQLite',
  'DXF',
  'OSM',
  'XLSX',
  'ODS',
] as const;

/** Resolve the active allowlist from env, falling back to defaults. */
export function resolveGdalAllowedDrivers(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = (env['GDAL_ALLOWED_DRIVERS'] ?? '').trim();
  const list = raw
    ? raw.split(/[\s,]+/).filter(Boolean)
    : [...DEFAULT_GDAL_ALLOWED_DRIVERS];
  return new Set(list.map((d) => d.toLowerCase()));
}

/**
 * Refuse a dataset whose OGR driver is outside the allowlist.
 * Call immediately after every `gdal.open` / driver.open on a
 * user-supplied file.
 */
export function assertAllowedGdalDriver(driverDescription: string): void {
  const name = driverDescription.trim();
  if (!name) {
    throw new Error('GDAL opened the file with an unknown driver.');
  }
  if (!resolveGdalAllowedDrivers().has(name.toLowerCase())) {
    throw new Error(
      `GDAL driver "${name}" is not allowed for ingest.`,
    );
  }
}

export function applyGdalNetworkHardening(
  gdal: { config?: { set?: (k: string, v: string) => void } },
): void {
  // Prefer EMPTY_DIR so a malicious sidecar cannot force GDAL to
  // readdir a remote listing as part of open.
  process.env['GDAL_DISABLE_READDIR_ON_OPEN'] ??= 'EMPTY_DIR';
  // Tight HTTP budgets: even if a /vsicurl/ path slips past the
  // open-path guard, dial attempts die quickly instead of pinning
  // the replica. /vsis3/ does not use these knobs.
  process.env['GDAL_HTTP_CONNECTTIMEOUT'] ??= '2';
  process.env['GDAL_HTTP_TIMEOUT'] ??= '5';
  process.env['CPL_VSIL_CURL_USE_HEAD'] ??= 'NO';
  // Publish the default allowlist into the process env when unset so
  // operators inspecting the container see the same set we enforce
  // in assertAllowedGdalDriver.
  process.env['GDAL_ALLOWED_DRIVERS'] ??= DEFAULT_GDAL_ALLOWED_DRIVERS.join(',');
  const set = gdal.config?.set;
  if (typeof set === 'function') {
    set('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR');
    set('GDAL_HTTP_CONNECTTIMEOUT', '2');
    set('GDAL_HTTP_TIMEOUT', '5');
    set('CPL_VSIL_CURL_USE_HEAD', 'NO');
  }
}
