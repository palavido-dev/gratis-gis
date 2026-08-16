// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared GDAL loading and /vsis3/ wiring for the raster tile services.
 *
 * Extracted because ElevationMosaicService and CogTileService each
 * carried an identical private copy, and process-global GDAL config is
 * exactly the kind of thing two copies drift on: whichever service
 * handled a request first would win, and the loser's variant would be
 * dead code that still read as authoritative.
 */
import type { StorageService } from '../storage/storage.service.js';

/**
 * The native addon, deliberately loaded on first use rather than at
 * module import so a missing prebuild cannot crash boot (same rule as
 * ingest). Callers await this per request; node caches the module, so
 * only the first call pays.
 */
export async function loadGdal(): Promise<typeof import('gdal-async')> {
  const mod = await import('gdal-async');
  return (
    (mod as unknown as { default?: typeof import('gdal-async') }).default ??
    mod
  );
}

let vsis3Ready = false;

/**
 * Point GDAL's /vsis3/ at MinIO using the credentials the SDK client
 * already holds. GDAL config is process-global, so this is module
 * state rather than per-service state: one service configuring it
 * configures it for all of them, and the flag stops repeat calls from
 * re-writing the same values on every tile.
 */
export function ensureVsis3(
  gdal: typeof import('gdal-async'),
  storage: StorageService,
): void {
  if (vsis3Ready) return;
  const { endpoint, accessKeyId, secretAccessKey } = storage.vsis3Config();
  let host = endpoint;
  let https = true;
  try {
    const url = new URL(endpoint);
    host = url.host;
    https = url.protocol === 'https:';
  } catch {
    // Not URL-shaped; assume host[:port] as-is.
    https = false;
  }
  gdal.config.set('AWS_S3_ENDPOINT', host);
  gdal.config.set('AWS_HTTPS', https ? 'YES' : 'NO');
  gdal.config.set('AWS_VIRTUAL_HOSTING', 'FALSE');
  gdal.config.set('AWS_ACCESS_KEY_ID', accessKeyId);
  gdal.config.set('AWS_SECRET_ACCESS_KEY', secretAccessKey);
  vsis3Ready = true;
}

/** Test hook: forget the configured state so a spec can observe the
 *  next ensureVsis3 call actually configuring. */
export function resetVsis3ForTests(): void {
  vsis3Ready = false;
}
