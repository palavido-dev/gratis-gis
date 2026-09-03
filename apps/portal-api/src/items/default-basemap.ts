// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which basemap a map gets when it does not name one.
 *
 * Used by ItemsService (resolving the wizard's empty-string sentinel
 * on create) and WebMapJsonService (a map whose basemap reference is
 * broken). Both used to prefer the seeded `positron` basemap, and the
 * fallback-of-the-fallback was "earliest created", which was also
 * Positron because it was seeded first. Carto now watermarks its
 * hosted raster tiles with "API KEY REQUIRED" unless a key is passed,
 * so on 2026-09-03 nine of the ten maps on the demo were rendering
 * that text across every tile. OpenStreetMap is the only seeded
 * basemap that needs no key and covers the world, so it is the
 * default; the seeded order then the earliest item are the fallbacks.
 */

export interface BasemapCandidate {
  id: string;
  data: unknown;
}

export const DEFAULT_BASEMAP_SEED_KEY = 'osm';

function seededKeyOf(c: BasemapCandidate): string | null {
  const k = (c.data as { seededKey?: unknown } | null)?.seededKey;
  return typeof k === 'string' ? k : null;
}

/**
 * `candidates` must already be ordered oldest first; the caller's
 * query does that so the "any seeded" and "anything" fallbacks are
 * deterministic.
 */
export function pickDefaultBasemap<T extends BasemapCandidate>(
  candidates: readonly T[],
): T | null {
  if (candidates.length === 0) return null;
  return (
    candidates.find((c) => seededKeyOf(c) === DEFAULT_BASEMAP_SEED_KEY) ??
    candidates.find((c) => seededKeyOf(c) !== null) ??
    candidates[0]!
  );
}
