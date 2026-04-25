/**
 * Shared geographic boundary: a named, authoritative polygon (or
 * multipolygon) that other items can reference as a geographic
 * filter, default extent, region tag, etc. Mirrors the pick_list
 * pattern: define the geometry once, reference it from many shares,
 * maps, dashboards, and so on.
 *
 * Storage is EPSG:4326 (WGS 84), matching the portal-wide policy
 * for spatial reference. Ingest reprojects on the way in; consumers
 * can trust that boundary.geometry is 4326 when they read it.
 *
 * Design notes:
 *  - `geometry` is a GeoJSON Polygon or MultiPolygon. Bare geometry
 *    (not a Feature / FeatureCollection) so consumers don't need to
 *    unwrap. Imports that come in as Feature / FeatureCollection get
 *    unwrapped + merged at save time.
 *  - `note` is optional author-facing context (what this boundary
 *    is for, who maintains it, source citation). Not shown to the
 *    end user consuming the boundary through a share or map.
 *  - Version is pinned so future shape changes (e.g. adding named
 *    sub-regions) can be rolled in without breaking consumers.
 */
export type GeoBoundaryDataVersion = 1;

export interface GeoBoundaryData {
  version: GeoBoundaryDataVersion;
  /**
   * GeoJSON Polygon or MultiPolygon in EPSG:4326. Null means the
   * item exists but has no geometry yet (brand-new item waiting for
   * an upload or draw). Consumers must handle null by treating the
   * boundary as 'matches everything' or by blocking use until the
   * author populates it.
   */
  geometry: GeoBoundaryGeometry | null;
  /** Optional author-facing note. Not shown to end users. */
  note?: string;
  /**
   * Service-level summary: area in km² plus the geometry's bbox
   * populated on save so the detail page doesn't have to recompute
   * from every consumer's perspective. Both are optional: absent
   * when geometry is null.
   */
  areaKm2?: number;
  bbox?: [number, number, number, number];
}

/**
 * The geometry subset we allow as a boundary payload. Polygon for
 * simple regions; MultiPolygon for islands / disjoint areas.
 * GeometryCollection is deliberately not supported: a collection
 * of heterogeneous geometries doesn't cleanly answer 'is point X
 * inside this boundary?', which is the core consumer question.
 */
export interface GeoBoundaryGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

export const DEFAULT_GEO_BOUNDARY: GeoBoundaryData = {
  version: 1,
  geometry: null,
};

/**
 * Lenient runtime check: accepts any object that looks roughly
 * right. The caller is responsible for validating coordinates if
 * they need precision (PostGIS will reject truly malformed geoms
 * on any downstream ST_Intersects call anyway).
 */
export function isGeoBoundaryData(value: unknown): value is GeoBoundaryData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; geometry?: unknown };
  if (v.version !== 1) return false;
  if (v.geometry === null || v.geometry === undefined) return true;
  if (typeof v.geometry !== 'object') return false;
  const g = v.geometry as { type?: unknown };
  return g.type === 'Polygon' || g.type === 'MultiPolygon';
}
