// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shape check for an inline share clip (`geoLimit` on a share row).
 *
 * The stored value is handed to PostGIS `ST_GeomFromGeoJSON` on every
 * feature read by that sharee. A value that is only `{type:'Polygon'}`,
 * has open rings, or is in projected metres either fails there (a 500
 * on every read) or silently matches nothing. The share dialog and
 * `ItemsService.share()` both check with this.
 *
 * Accepted: a Polygon, a MultiPolygon, or a GeometryCollection of those,
 * in WGS84 longitude / latitude, every ring closed with at least four
 * positions.
 */

const MAX_GEOMETRY_PARTS = 10_000;

function isPosition(p: unknown): p is [number, number] {
  if (!Array.isArray(p) || p.length < 2) return false;
  const [lng, lat] = p as unknown[];
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

function isClosedRing(ring: unknown): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  if (!ring.every(isPosition)) return false;
  const first = ring[0] as [number, number];
  const last = ring[ring.length - 1] as [number, number];
  return first[0] === last[0] && first[1] === last[1];
}

function isPolygonCoords(coords: unknown): boolean {
  return Array.isArray(coords) && coords.length > 0 && coords.every(isClosedRing);
}

export function isShareClipGeometry(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (g.type === 'Polygon') return isPolygonCoords(g.coordinates);
  if (g.type === 'MultiPolygon') {
    return (
      Array.isArray(g.coordinates) &&
      g.coordinates.length > 0 &&
      g.coordinates.length <= MAX_GEOMETRY_PARTS &&
      g.coordinates.every(isPolygonCoords)
    );
  }
  if (g.type === 'GeometryCollection' && depth === 0) {
    return (
      Array.isArray(g.geometries) &&
      g.geometries.length > 0 &&
      g.geometries.length <= MAX_GEOMETRY_PARTS &&
      g.geometries.every((x) => isShareClipGeometry(x, depth + 1))
    );
  }
  return false;
}
