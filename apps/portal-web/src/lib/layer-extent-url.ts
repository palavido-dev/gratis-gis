// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUuid } from './api-path-guard';

/**
 * Where to ask the server for a layer's extent, or null when the
 * server cannot answer for this source.
 *
 * "Zoom to extent" used to compute the box from the layer's sampled
 * feature cache, which is never filled for v3 data layers (they draw
 * from tiles), so the action stayed greyed out for the main kind of
 * layer. The `filtered-extent` endpoint returns the bbox of the rows
 * the layer's own filter keeps, under the viewer's share limits.
 *
 * Handles a `data-layer` source with a sublayer key, and the Editor's
 * targets, which point a `geojson-url` source at the same sublayer.
 */
type ExtentSource =
  | { kind: 'data-layer'; itemId: string; layerKey?: string | undefined }
  | { kind: 'geojson-url'; url: string }
  | { kind: string };

type ExtentFilter = {
  combinator: 'all' | 'any';
  clauses: Array<{ field: string; op: string; value: string }>;
};

const SUBLAYER_GEOJSON = /^\/api\/portal\/items\/([^/?#]+)\/layers\/([^/?#]+)\/geojson(?:[?#]|$)/;

/**
 * The v3 sublayer a source reads, or null. The item id must be a UUID,
 * because callers build `/api/portal/items/<id>/...` paths from it.
 */
export function v3SublayerOf(
  source: ExtentSource,
): { itemId: string; layerKey: string } | null {
  let itemId: string | null = null;
  let layerKey: string | null = null;
  if (source.kind === 'data-layer' && 'itemId' in source) {
    itemId = source.itemId;
    layerKey = source.layerKey ?? null;
  } else if (source.kind === 'geojson-url' && 'url' in source) {
    const m = SUBLAYER_GEOJSON.exec(source.url);
    if (m) {
      itemId = m[1]!;
      try {
        layerKey = decodeURIComponent(m[2]!);
      } catch {
        layerKey = null;
      }
    }
  }
  if (!itemId || !layerKey || !isUuid(itemId)) return null;
  return { itemId, layerKey };
}

export function layerExtentUrl(
  source: ExtentSource,
  filter?: ExtentFilter | null,
): string | null {
  const sub = v3SublayerOf(source);
  if (!sub) return null;
  const base = `/api/portal/items/${sub.itemId}/layers/${encodeURIComponent(sub.layerKey)}/filtered-extent`;
  if (filter && filter.clauses.length > 0) {
    return `${base}?where=${encodeURIComponent(JSON.stringify(filter))}`;
  }
  return base;
}

/** Fetch an extent from `layerExtentUrl`; null on any failure. */
export async function fetchLayerExtent(
  url: string,
): Promise<[number, number, number, number] | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      bbox?: [number, number, number, number] | null;
    };
    return body.bbox ?? null;
  } catch {
    return null;
  }
}
