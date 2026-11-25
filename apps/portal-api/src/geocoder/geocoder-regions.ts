// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regions an admin can pick for the managed geocoder: Geofabrik's
 * OpenStreetMap extracts, read from their public index.
 */
import { isGeofabrikPbfUrl } from './geocoder-settings.js';

export const GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1-nogeom.json';
/** The same index with each extract's outline, for the map picker. */
export const GEOFABRIK_INDEX_GEOM_URL = 'https://download.geofabrik.de/index-v1.json';

const USER_AGENT = 'GratisGIS (https://github.com/palavido-dev/gratis-gis)';
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

export interface RegionOption {
  id: string;
  name: string;
  /** Parent region id, or null for a continent. */
  parent: string | null;
  /** Names from the continent down, for the picker's second line. */
  path: string[];
  pbfUrl: string;
  /** ISO 3166-1 / 3166-2 codes Geofabrik lists. */
  iso: string[];
}

interface IndexFeature {
  properties?: {
    id?: unknown;
    parent?: unknown;
    name?: unknown;
    urls?: { pbf?: unknown };
    'iso3166-1:alpha2'?: unknown;
    'iso3166-2'?: unknown;
  };
}

/** Flatten Geofabrik's index into picker rows, sorted by path then name. */
export function parseGeofabrikIndex(body: unknown): RegionOption[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const raw = new Map<string, { name: string; parent: string | null; pbfUrl: string; iso: string[] }>();
  for (const f of features as IndexFeature[]) {
    const p = f?.properties;
    const id = typeof p?.id === 'string' ? p.id : null;
    const name = typeof p?.name === 'string' ? p.name : null;
    const pbf = typeof p?.urls?.pbf === 'string' ? p.urls.pbf : null;
    if (!id || !name || !pbf || !isGeofabrikPbfUrl(pbf)) continue;
    const iso = [p?.['iso3166-1:alpha2'], p?.['iso3166-2']]
      .flatMap((v) => (Array.isArray(v) ? v : []))
      .filter((v): v is string => typeof v === 'string');
    raw.set(id, {
      name,
      parent: typeof p?.parent === 'string' ? p.parent : null,
      pbfUrl: pbf,
      iso,
    });
  }
  const pathOf = (id: string): string[] => {
    const names: string[] = [];
    let cursor = raw.get(id)?.parent ?? null;
    let guard = 0;
    while (cursor && guard < 10) {
      const node = raw.get(cursor);
      if (!node) break;
      names.unshift(node.name);
      cursor = node.parent;
      guard += 1;
    }
    return names;
  };
  const out: RegionOption[] = [];
  for (const [id, r] of raw) {
    out.push({ id, name: r.name, parent: r.parent, path: pathOf(id), pbfUrl: r.pbfUrl, iso: r.iso });
  }
  out.sort((a, b) => {
    const pa = a.path.join(' / ');
    const pb = b.path.join(' / ');
    return pa === pb ? a.name.localeCompare(b.name) : pa.localeCompare(pb);
  });
  return out;
}

let cache: { at: number; regions: RegionOption[] } | null = null;

/** Geofabrik's regions, cached for a day. Throws when the index cannot be read. */
export async function geofabrikRegions(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<RegionOption[]> {
  if (cache && now - cache.at < INDEX_TTL_MS) return cache.regions;
  const res = await fetchImpl(GEOFABRIK_INDEX_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Geofabrik index answered HTTP ${res.status}`);
  const regions = parseGeofabrikIndex(await res.json());
  if (regions.length === 0) throw new Error('Geofabrik index had no regions');
  cache = { at: now, regions };
  return regions;
}

/** Forget the cached index (tests). */
export function resetRegionCache(): void {
  cache = null;
}

/** Download size of an extract in bytes, or null when the server does not say. */
export async function extractBytes(
  pbfUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!isGeofabrikPbfUrl(pbfUrl)) return null;
  try {
    const res = await fetchImpl(pbfUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

/** True when any picked region is in the United States, where TIGER applies. */
export function coversUnitedStates(regions: Array<{ id: string }>, all: RegionOption[]): boolean {
  const byId = new Map(all.map((r) => [r.id, r]));
  return regions.some((r) => {
    const opt = byId.get(r.id);
    if (!opt) return r.id === 'us' || r.id.startsWith('us/');
    return (
      opt.iso.some((c) => c === 'US' || c.startsWith('US-')) ||
      opt.id === 'us' ||
      opt.id.startsWith('us/')
    );
  });
}
