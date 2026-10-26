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
  const set = gdal.config?.set;
  if (typeof set === 'function') {
    set('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR');
    set('GDAL_HTTP_CONNECTTIMEOUT', '2');
    set('GDAL_HTTP_TIMEOUT', '5');
    set('CPL_VSIL_CURL_USE_HEAD', 'NO');
  }
}
