// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Address lookups against a self-hosted open-geocode server
 * (https://github.com/open-geocode-rs/open-geocode).
 *
 * open-geocode serves a region from one memory-mapped file, so a
 * small portal can run it next to portal-api where a Nominatim
 * database would not fit. It also has a batch endpoint, which is why
 * spreadsheet import takes far more rows with it than with Nominatim.
 *
 * Set OPEN_GEOCODE_URL to use it. When set, it replaces Nominatim for
 * spreadsheet address import. Addresses are only ever sent to that
 * configured host.
 */

const USER_AGENT = 'GratisGIS (https://github.com/palavido-dev/gratis-gis)';

export const OPEN_GEOCODE_LIMITS = {
  /** Items in one POST /geocode batch. The server's own cap is 1000. */
  BATCH_SIZE: 500,
  BATCH_TIMEOUT_MS: 60_000,
  PROBE_TIMEOUT_MS: 1_500,
};

/**
 * Answers that only place a row in an area (a town, a postcode, a
 * county) are not good enough to drop a point for a spreadsheet row.
 * Those rows stay unplaced, the same as a Nominatim miss.
 */
const AREA_LAYERS = new Set([
  'country',
  'district',
  'locality',
  'neighbourhood',
  'place',
  'postcode',
  'region',
]);

export interface OpenGeocodeHit {
  lat: number;
  lon: number;
  /** open-geocode's own precision label: rooftop, interpolated, street, ... */
  accuracy: string | null;
}

/** The configured server's base URL, or null when OPEN_GEOCODE_URL is unset or not http(s). */
export function openGeocodeBase(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.OPEN_GEOCODE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return raw.replace(/\/+$/, '');
}

/**
 * The managed geocoder's internal address (Admin -> Geocoding), from
 * MANAGED_GEOCODER_URL. Compose points it at portal-worker. Unlike
 * OPEN_GEOCODE_URL it is only used while it answers, so a portal whose
 * admin has not built a pack yet keeps its Nominatim behaviour.
 */
export function managedGeocoderBase(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return openGeocodeBase({ OPEN_GEOCODE_URL: env.MANAGED_GEOCODER_URL });
}

const MANAGED_PROBE_TTL_MS = 30_000;
let managedProbe: { base: string; at: number; ok: boolean } | null = null;

/** True when the managed geocoder answers /readyz. Cached for 30 s. */
export async function managedGeocoderReady(
  fetchImpl: typeof fetch,
  base: string,
  now = Date.now(),
): Promise<boolean> {
  if (managedProbe && managedProbe.base === base && now - managedProbe.at < MANAGED_PROBE_TTL_MS) {
    return managedProbe.ok;
  }
  const ok = await openGeocodeAnswers(fetchImpl, base);
  managedProbe = { base, at: now, ok };
  return ok;
}

/** Forget the cached probe (tests). */
export function resetManagedProbe(): void {
  managedProbe = null;
}

export async function openGeocodeAnswers(
  fetchImpl: typeof fetch,
  base: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base}/readyz`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(OPEN_GEOCODE_LIMITS.PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Read the first feature of one open-geocode response, or null for no usable answer. */
export function parseOpenGeocodeFeature(response: unknown): OpenGeocodeHit | null {
  if (!response || typeof response !== 'object') return null;
  const features = (response as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) return null;
  const feature = features[0] as {
    geometry?: { coordinates?: unknown };
    properties?: { layer?: unknown; accuracy?: unknown };
  };
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const layer = feature.properties?.layer;
  if (typeof layer === 'string' && AREA_LAYERS.has(layer)) return null;
  const accuracy = feature.properties?.accuracy;
  // "approximate" stands for a town or postcode, not the address.
  if (accuracy === 'approximate') return null;
  return { lat, lon, accuracy: typeof accuracy === 'string' ? accuracy : null };
}

/**
 * Geocode every query through POST /geocode in batches. The result is
 * parallel to `queries`; blank queries and failed batches come back
 * null.
 */
export async function openGeocodeQueries(
  fetchImpl: typeof fetch,
  base: string,
  queries: string[],
  batchSize = OPEN_GEOCODE_LIMITS.BATCH_SIZE,
): Promise<Array<OpenGeocodeHit | null>> {
  const out: Array<OpenGeocodeHit | null> = queries.map(() => null);
  const pending = queries
    .map((q, index) => ({ q: q.trim(), index }))
    .filter((item) => item.q.length > 0);
  for (let start = 0; start < pending.length; start += batchSize) {
    const chunk = pending.slice(start, start + batchSize);
    let body: unknown;
    try {
      const res = await fetchImpl(`${base}/geocode`, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          chunk.map((item) => ({ id: String(item.index), q: item.q, limit: 1 })),
        ),
        signal: AbortSignal.timeout(OPEN_GEOCODE_LIMITS.BATCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      body = await res.json();
    } catch {
      continue;
    }
    const results = (body as { results?: unknown })?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results as Array<{ id?: unknown; response?: unknown }>) {
      const index = Number(result?.id);
      if (!Number.isInteger(index) || index < 0 || index >= out.length) continue;
      out[index] = parseOpenGeocodeFeature(result.response);
    }
  }
  return out;
}
