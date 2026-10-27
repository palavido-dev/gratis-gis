// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Helpers for the MCP `query_osm` tool (R3-mcp-query-osm / #161).
 *
 * Caps mirror portal-api `osm-query.limits.ts`. Kept as literals here
 * so portal-mcp stays a thin HTTP facade with no Nest import; the
 * server re-validates on every call.
 */

export const OSM_QUERY_MAX_FEATURES = 5000;
export const OSM_QUERY_DEFAULT_FEATURES = 1000;
export const OSM_QUERY_MAX_BBOX_AREA_DEG2 = 1;
export const OSM_QUERY_MAX_PRESETS = 10;
export const OSM_QUERY_MAX_CONDITIONS = 5;

export type OsmQueryBbox = [west: number, south: number, east: number, north: number];

export interface OsmQueryArgs {
  bbox: OsmQueryBbox;
  mode?: 'presets' | 'relational';
  presetIds?: string[];
  tagFilters?: Array<{
    key: string;
    value: string;
    op?: 'equals' | 'contains' | 'regex';
  }>;
  anchorPresetId?: string;
  conditions?: Array<{
    presetId: string;
    distanceMeters: number;
    tagFilters?: Array<{
      key: string;
      value: string;
      op?: 'equals' | 'contains' | 'regex';
    }>;
  }>;
  negations?: Array<{ presetId: string; distanceMeters: number }>;
  limit?: number;
}

/**
 * Client-side bbox / limit guard. Returns an error string when the
 * call would be refused by portal-api; null when the request is
 * shaped well enough to send.
 */
export function clientRejectOsmQuery(args: OsmQueryArgs): string | null {
  const [west, south, east, north] = args.bbox;
  if (!(west < east && south < north)) {
    return 'bbox is degenerate (west must be < east and south < north).';
  }
  const area = (east - west) * (north - south);
  if (area > OSM_QUERY_MAX_BBOX_AREA_DEG2) {
    return (
      `bbox area is ${area.toFixed(3)} square degrees; the maximum is ` +
      `${OSM_QUERY_MAX_BBOX_AREA_DEG2}. Tighten the area of interest and retry.`
    );
  }
  if (
    args.limit !== undefined &&
    (args.limit < 1 || args.limit > OSM_QUERY_MAX_FEATURES)
  ) {
    return `limit must be between 1 and ${OSM_QUERY_MAX_FEATURES}.`;
  }

  const mode =
    args.mode ??
    (args.anchorPresetId ? 'relational' : 'presets');

  if (mode === 'presets') {
    const ids = args.presetIds ?? [];
    if (ids.length === 0) {
      return 'presetIds is required for mode=presets.';
    }
    if (ids.length > OSM_QUERY_MAX_PRESETS) {
      return `At most ${OSM_QUERY_MAX_PRESETS} presetIds per query.`;
    }
  } else {
    if (!args.anchorPresetId) {
      return 'anchorPresetId is required for mode=relational.';
    }
    const conditions = args.conditions ?? [];
    if (conditions.length === 0) {
      return 'conditions is required for mode=relational.';
    }
    if (conditions.length > OSM_QUERY_MAX_CONDITIONS) {
      return `At most ${OSM_QUERY_MAX_CONDITIONS} relational conditions per query.`;
    }
  }
  return null;
}

/** Build the GET /api/osm/query query string from validated args. */
export function buildOsmQueryPath(args: OsmQueryArgs): string {
  const params = new URLSearchParams();
  params.set('bbox', args.bbox.join(','));
  params.set('limit', String(args.limit ?? OSM_QUERY_DEFAULT_FEATURES));

  const mode =
    args.mode ??
    (args.anchorPresetId ? 'relational' : 'presets');
  params.set('mode', mode);

  if (mode === 'presets') {
    params.set('presetIds', (args.presetIds ?? []).join(','));
    if (args.tagFilters && args.tagFilters.length > 0) {
      params.set('tagFilters', JSON.stringify(args.tagFilters));
    }
  } else {
    params.set('anchorPresetId', args.anchorPresetId!);
    params.set('conditions', JSON.stringify(args.conditions ?? []));
    if (args.negations && args.negations.length > 0) {
      params.set('negations', JSON.stringify(args.negations));
    }
  }

  return `/api/osm/query?${params.toString()}`;
}
