// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers for the MCP `search_catalog` tool (R6-mcp-search-catalog).
 *
 * Thin client over the public OGC API Records catalog mount
 * (`GET /api/public/ogc/collections/catalog/items`). Public items
 * only — private catalogs still need `list_items` with an API key.
 * Caps stay local so portal-mcp remains a facade with no Nest import;
 * portal-api re-validates (including the 5k bbox scan ceiling).
 */

/** Matches portal-api `KNOWN_ITEM_TYPES` used by Records filters. */
export const CATALOG_ITEM_TYPES = [
  'data_layer',
  'map',
  'web_app',
  'form',
  'file',
  'dashboard',
  'report_template',
  'tool',
  'arcgis_service',
  'basemap',
  'geo_boundary',
  'pick_list',
  'layer_package',
  'service',
  'geocoding_service',
] as const;

export type CatalogItemType = (typeof CATALOG_ITEM_TYPES)[number];

export const SEARCH_CATALOG_DEFAULT_LIMIT = 25;
export const SEARCH_CATALOG_MAX_LIMIT = 100;
/** Soft client cap so a worldwide bbox is refused before the
 *  public Records in-memory bbox scan (5k rows) runs. */
export const SEARCH_CATALOG_MAX_BBOX_AREA_DEG2 = 100;

export type CatalogBbox = [west: number, south: number, east: number, north: number];

export interface SearchCatalogArgs {
  q?: string;
  type?: CatalogItemType;
  bbox?: CatalogBbox;
  limit?: number;
  offset?: number;
}

/**
 * Client-side guard. Returns an error string when the call should
 * not be sent; null when shaped well enough for the public catalog.
 */
export function clientRejectSearchCatalog(
  args: SearchCatalogArgs,
): string | null {
  if (
    args.limit !== undefined &&
    (args.limit < 1 || args.limit > SEARCH_CATALOG_MAX_LIMIT)
  ) {
    return `limit must be between 1 and ${SEARCH_CATALOG_MAX_LIMIT}.`;
  }
  if (args.offset !== undefined && args.offset < 0) {
    return 'offset must be >= 0.';
  }
  if (args.q !== undefined && args.q.length > 200) {
    return 'q must be at most 200 characters.';
  }
  if (args.bbox) {
    const [west, south, east, north] = args.bbox;
    if (!(west < east && south < north)) {
      return 'bbox is degenerate (west must be < east and south < north).';
    }
    if (
      west < -180 ||
      east > 180 ||
      south < -90 ||
      north > 90
    ) {
      return 'bbox must be WGS84 / CRS84 within [-180,180] × [-90,90].';
    }
    const area = (east - west) * (north - south);
    if (area > SEARCH_CATALOG_MAX_BBOX_AREA_DEG2) {
      return (
        `bbox area is ${area.toFixed(3)} square degrees; the maximum is ` +
        `${SEARCH_CATALOG_MAX_BBOX_AREA_DEG2}. Tighten the area of interest ` +
        'and retry, or omit bbox and filter with q / type.'
      );
    }
  }
  return null;
}

/** Build the public catalog items path from validated args. */
export function buildSearchCatalogPath(args: SearchCatalogArgs): string {
  const params = new URLSearchParams();
  params.set(
    'limit',
    String(args.limit ?? SEARCH_CATALOG_DEFAULT_LIMIT),
  );
  if (args.offset !== undefined && args.offset > 0) {
    params.set('offset', String(args.offset));
  }
  if (args.q && args.q.trim().length > 0) {
    params.set('q', args.q.trim());
  }
  if (args.type) {
    params.set('type', args.type);
  }
  if (args.bbox) {
    params.set('bbox', args.bbox.join(','));
  }
  return `/api/public/ogc/collections/catalog/items?${params.toString()}`;
}
