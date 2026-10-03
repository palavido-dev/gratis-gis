// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Look up addresses against the portal's own Nominatim.
 *
 * Spreadsheet import can send a few hundred addresses. That is bulk
 * geocoding, which the public Nominatim usage policy forbids, and it
 * would also ship a customer's addresses off the host. Search in the
 * browser may fall back to the public service for a single typed
 * query. This module never does.
 */

const USER_AGENT = 'GratisGIS/0.1 (https://github.com/palavido-dev/gratis-gis)';
const PUBLIC_HOST = 'nominatim.openstreetmap.org';

export const NOMINATIM_LIMITS = {
  CONCURRENCY: 2,
  SEARCH_TIMEOUT_MS: 8_000,
  PROBE_TIMEOUT_MS: 1_500,
};

export function localNominatimBase(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.NOMINATIM_URL?.trim();
  const base = (raw && raw.length > 0 ? raw : 'http://localhost:8081').replace(
    /\/$/,
    '',
  );
  let host = '';
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === PUBLIC_HOST || host.endsWith(`.${PUBLIC_HOST}`)) return null;
  return base;
}

export function parseNominatimHit(
  body: unknown,
): { lat: number; lon: number } | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const hit = body[0];
  if (!hit || typeof hit !== 'object') return null;
  const lat = Number((hit as { lat?: unknown }).lat);
  const lon = Number((hit as { lon?: unknown }).lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export async function nominatimAnswers(
  fetchImpl: typeof fetch,
  base: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base}/status`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
      signal: AbortSignal.timeout(NOMINATIM_LIMITS.PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function geocodeOne(
  fetchImpl: typeof fetch,
  base: string,
  query: string,
): Promise<{ lat: number; lon: number } | null> {
  const url = `${base}/search?${new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    q: query,
  })}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(NOMINATIM_LIMITS.SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return parseNominatimHit(await res.json());
}

export async function geocodeQueries(
  queries: string[],
  lookup: (query: string) => Promise<{ lat: number; lon: number } | null>,
  concurrency = NOMINATIM_LIMITS.CONCURRENCY,
): Promise<Array<{ lat: number; lon: number } | null>> {
  const out: Array<{ lat: number; lon: number } | null> = queries.map(() => null);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, queries.length || 1));
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= queries.length) return;
      const query = queries[index]!;
      if (query.trim().length === 0) continue;
      try {
        out[index] = await lookup(query);
      } catch {
        out[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
