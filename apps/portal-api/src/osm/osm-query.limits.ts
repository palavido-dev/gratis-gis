// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared caps for the authenticated OSM query HTTP surface
 * (POST/GET /api/osm/query) and the MCP `query_osm` facade.
 *
 * Public Overpass mirrors rate-limit and time out on continent-scale
 * or unbounded queries. These numbers refuse that class of request
 * with a plain-English error before we ever open a socket.
 */

/** Hard ceiling on returned features. OsmService defaults to 50k for
 *  recipe runners; the MCP / direct-query path stays far tighter so a
 *  single call cannot fill a model context window or hammer Overpass. */
export const OSM_QUERY_MAX_FEATURES = 5000;

/** Default feature cap when the caller omits `limit`. */
export const OSM_QUERY_DEFAULT_FEATURES = 1000;

/**
 * Maximum bbox area in square degrees ((east-west)*(north-south)).
 * ~1°×1° is a large metro / small region; country and continent
 * queries are refused. Approximate; we intentionally do not convert
 * to km² (latitude distortion is fine for an abuse guard).
 */
export const OSM_QUERY_MAX_BBOX_AREA_DEG2 = 1;

/** Cap on preset ids in a single preset-mode query. */
export const OSM_QUERY_MAX_PRESETS = 10;

/** Cap on relational near-conditions. */
export const OSM_QUERY_MAX_CONDITIONS = 5;

export type OsmQueryBbox = [west: number, south: number, east: number, north: number];

export interface OsmQueryLimitsOk {
  ok: true;
  bbox: OsmQueryBbox;
  maxFeatures: number;
  areaDeg2: number;
}

export interface OsmQueryLimitsErr {
  ok: false;
  message: string;
}

/**
 * Validate + clamp a bbox and feature limit. Returns a structured
 * result so both Nest controllers and the MCP client can surface the
 * same plain-English refusal without throwing Nest exceptions.
 */
export function validateOsmQueryBounds(input: {
  bbox: unknown;
  limit?: unknown;
}): OsmQueryLimitsOk | OsmQueryLimitsErr {
  const bbox = parseBbox(input.bbox);
  if (!bbox) {
    return {
      ok: false,
      message:
        'bbox is required as [west, south, east, north] in WGS84 degrees. Unbounded OSM queries are refused.',
    };
  }
  const [west, south, east, north] = bbox;
  if (!(west < east && south < north)) {
    return {
      ok: false,
      message:
        'bbox is degenerate (west must be < east and south < north). Crossing the antimeridian is not supported; split the query.',
    };
  }
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90
  ) {
    return {
      ok: false,
      message:
        'bbox is outside WGS84 bounds (longitude ±180, latitude ±90).',
    };
  }
  const areaDeg2 = (east - west) * (north - south);
  if (areaDeg2 > OSM_QUERY_MAX_BBOX_AREA_DEG2) {
    return {
      ok: false,
      message:
        `bbox area is ${areaDeg2.toFixed(3)} square degrees; the maximum is ${OSM_QUERY_MAX_BBOX_AREA_DEG2}. ` +
        'Tighten the area of interest (roughly a large metro or smaller) and retry.',
    };
  }

  let maxFeatures = OSM_QUERY_DEFAULT_FEATURES;
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    const n =
      typeof input.limit === 'number'
        ? input.limit
        : Number(String(input.limit));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return {
        ok: false,
        message: `limit must be an integer from 1 to ${OSM_QUERY_MAX_FEATURES}.`,
      };
    }
    if (n > OSM_QUERY_MAX_FEATURES) {
      return {
        ok: false,
        message: `limit ${n} exceeds the maximum of ${OSM_QUERY_MAX_FEATURES} features per query.`,
      };
    }
    maxFeatures = n;
  }

  return { ok: true, bbox, maxFeatures, areaDeg2 };
}

function parseBbox(raw: unknown): OsmQueryBbox | null {
  if (typeof raw === 'string') {
    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return null;
    }
    return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  }
  if (Array.isArray(raw) && raw.length === 4) {
    const nums = raw.map((v) =>
      typeof v === 'number' ? v : Number(v),
    );
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  }
  return null;
}
