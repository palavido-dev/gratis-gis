// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Zoom range of a data layer's vector tiles, for the MapLibre source.
 *
 * An owner can set a layer's tile `maxZoom` (the deepest zoom tiles are
 * built for) and `minZoom`. The server answers tiles outside that range
 * empty, so the map source has to carry the same range: with source
 * `maxzoom` set, MapLibre overzooms the deepest tile past it instead of
 * requesting (empty) deeper tiles, and with `minzoom` set it does not
 * request tiles below it. The range comes from the layer's TileJSON,
 * which goes through the same access check as the tiles.
 *
 * Until the TileJSON arrives (or when it cannot be read) the source
 * uses the historical range, 0 to 22, which is what every layer without
 * tile settings advertises anyway.
 */
import { TILE_LABELS_LAYER, TILE_ZOOM_MAX, TILE_ZOOM_MIN } from '@gratis-gis/shared-types';

export interface SourceZoom {
  minzoom: number;
  maxzoom: number;
}

export const DEFAULT_SOURCE_ZOOM: SourceZoom = { minzoom: 0, maxzoom: 22 };

/**
 * A read range is kept for a minute, then read again the next time a
 * map asks: an owner who changes a layer's tile zooms and opens a map
 * by client-side navigation should not keep the old range until a hard
 * reload. A failed read is not cached as the default; it is retried
 * after a short pause, so one 429 or 502 at map load does not hide the
 * layer past its built zoom for the life of the page.
 */
const FRESH_MS = 60_000;
const RETRY_FAILED_MS = 15_000;
const cache = new Map<string, { zoom: SourceZoom; at: number }>();
const failedAt = new Map<string, number>();
const inFlight = new Set<string>();

function keyOf(itemId: string, layerKey: string): string {
  return `${itemId}/${layerKey}`;
}

/** Read min/max zoom from a TileJSON document, clamped and sane. */
export function tileJsonSourceZoom(doc: unknown): SourceZoom {
  const d = (doc ?? {}) as { minzoom?: unknown; maxzoom?: unknown };
  const clamp = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v)
      ? Math.min(TILE_ZOOM_MAX, Math.max(TILE_ZOOM_MIN, v))
      : fallback;
  const minzoom = clamp(d.minzoom, DEFAULT_SOURCE_ZOOM.minzoom);
  const maxzoom = clamp(d.maxzoom, DEFAULT_SOURCE_ZOOM.maxzoom);
  return minzoom <= maxzoom ? { minzoom, maxzoom } : DEFAULT_SOURCE_ZOOM;
}

/** The zoom range to give a data-layer vector source right now. */
export function dataLayerSourceZoom(source: {
  itemId: string;
  layerKey?: string;
}): SourceZoom {
  if (!source.layerKey) return DEFAULT_SOURCE_ZOOM;
  return cache.get(keyOf(source.itemId, source.layerKey))?.zoom ?? DEFAULT_SOURCE_ZOOM;
}

/**
 * Fetch the TileJSON of every data-layer source not yet known, and call
 * `onChange` once for each range that differs from the default, so the
 * caller can rebuild that source. Failures keep the default silently:
 * the server still answers out-of-range tiles empty, so the worst case
 * is today's behaviour.
 */
export function ensureSourceZooms(
  sources: Array<{ itemId: string; layerKey?: string }>,
  onChange: () => void,
  fetchImpl: typeof fetch = fetch,
): void {
  for (const s of sources) {
    if (!s.layerKey) continue;
    const key = keyOf(s.itemId, s.layerKey);
    const now = Date.now();
    const known = cache.get(key);
    if (inFlight.has(key)) continue;
    if (known && now - known.at < FRESH_MS) continue;
    const failed = failedAt.get(key);
    if (failed !== undefined && now - failed < RETRY_FAILED_MS) continue;
    inFlight.add(key);
    void fetchImpl(
      `/api/portal/items/${encodeURIComponent(s.itemId)}/layers/${encodeURIComponent(s.layerKey)}/tilejson.json`,
    )
      .then(async (res) => (res.ok ? tileJsonSourceZoom(await res.json()) : null))
      .catch(() => null)
      .then((zoom) => {
        inFlight.delete(key);
        if (zoom === null) {
          // Keep whatever range was known (or the default) and try
          // again later rather than remembering the failure.
          failedAt.set(key, Date.now());
          return;
        }
        failedAt.delete(key);
        const before = cache.get(key)?.zoom ?? DEFAULT_SOURCE_ZOOM;
        cache.set(key, { zoom, at: Date.now() });
        if (zoom.minzoom !== before.minzoom || zoom.maxzoom !== before.maxzoom) {
          onChange();
        }
      });
  }
}

/** Test hook: forget every cached range. */
export function resetSourceZoomCache(): void {
  cache.clear();
  failedAt.clear();
  inFlight.clear();
}

/**
 * The MapLibre vector source for a data layer. `minzoom`/`maxzoom` come
 * from the layer's tile settings, so MapLibre overzooms past the deepest
 * built zoom rather than drawing the server's empty tiles there.
 */
export function dataLayerVectorSource(
  tileUrl: string,
  zoom: SourceZoom,
): {
  type: 'vector';
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  promoteId: Record<string, string>;
} {
  return {
    type: 'vector',
    tiles: [tileUrl],
    minzoom: zoom.minzoom,
    maxzoom: zoom.maxzoom,
    // Vector-source promoteId is keyed by source-layer name. Our MVT
    // emits "features", plus "labels" when the layer's tile settings
    // turn label points on; both carry the same _global_id, so a hover
    // on a label point resolves to the same feature as its geometry.
    promoteId: { features: '_global_id', [TILE_LABELS_LAYER]: '_global_id' },
  };
}

/**
 * What the keep-alive check compares between passes: the tile URL and
 * the zoom range, so a range that arrives after the first draw rebuilds
 * the source instead of being kept with the old range.
 */
export function dataLayerKeepKey(tileUrl: string, zoom: SourceZoom): string {
  return `${tileUrl}#z=${zoom.minzoom}-${zoom.maxzoom}`;
}
