// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Request paths for the item read tools, kept apart from index.ts so
 * they can be tested against the parameter names portal-api reads.
 */

export const READ_FEATURES_DEFAULT_LIMIT = 1000;

/** GET /api/items reads the free-text search from `q`. Sending
 *  `query` was silently ignored, so a search returned any items. */
export function buildListItemsPath(args: {
  type?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
}): string {
  const params = new URLSearchParams();
  if (args.type) params.set('type', args.type);
  if (args.query) params.set('q', args.query);
  params.set('limit', String(args.limit ?? 25));
  return `/api/items?${params.toString()}`;
}

/** Per-sublayer route when `layerKey` is given (it honours `limit`);
 *  otherwise the item-level dump, which takes no limit, so callers
 *  must trim the result themselves (capFeatureCollection). */
export function buildReadLayerPath(args: {
  itemId: string;
  layerKey?: string | undefined;
  limit: number;
}): string {
  return args.layerKey
    ? `/api/items/${args.itemId}/layers/${encodeURIComponent(args.layerKey)}/geojson?limit=${args.limit}`
    : `/api/items/${args.itemId}/geojson`;
}
