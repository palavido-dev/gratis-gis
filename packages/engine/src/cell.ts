// SPDX-License-Identifier: AGPL-3.0-or-later
//
// H3 cell helpers. We denormalize an H3 cell on every observation that has
// a geometry so spatially-local queries can route via the `cell` index
// without re-deriving the cell from raw geometry. Resolution 7 (~5 km
// edge length) is the locked starting choice; see the design doc for the
// rationale (uniform area, six-neighbor topology, modern open-source
// spatial stack standardized on H3).
//
// We compute the cell from the geometry's FIRST VERTEX (the point's own
// coordinates for points; the first coordinate of the first part / outer
// ring for everything else). Not a centroid: the chosen point can sit on
// the boundary of a polygon, but it is cheap, deterministic, and needs no
// geometry math. This is approximate by design: the cell is a partition /
// coarse-filter aid, not a precise containment test. The authoritative
// geometry stays in the `geom` column. Any SQL-side recomputation of the
// cell (backfills, triggers) must reproduce this function byte-for-byte,
// first vertex and all; deriving the cell from ST_Centroid or any other
// point would silently partition the same feature into a different cell
// than the write path did.

import { latLngToCell } from 'h3-js';

import type { GeoJsonGeometry } from './types.js';

/** The H3 resolution we target. Locked at 7 (~5 km edge) per the design doc. */
export const H3_RESOLUTION = 7;

/**
 * Pick a representative `[lng, lat]` point for a geometry. Used as input to
 * the H3 cell function. For Points we use the coordinates directly; for
 * everything else we take the FIRST VERTEX (first coordinate of the first
 * part / outer ring). No averaging, no centroid. This is fine for
 * partition routing; precision lives in `geom`.
 */
export function representativePoint(
  geom: GeoJsonGeometry,
): [number, number] | null {
  switch (geom.type) {
    case 'Point':
      return geom.coordinates;
    case 'MultiPoint':
    case 'LineString':
      return geom.coordinates[0] ?? null;
    case 'MultiLineString':
    case 'Polygon': {
      const ring = geom.coordinates[0];
      const first = ring && ring[0] !== undefined ? ring[0] : null;
      return first ?? null;
    }
    case 'MultiPolygon': {
      const poly = geom.coordinates[0];
      const ring = poly && poly[0] !== undefined ? poly[0] : null;
      const first = ring && ring[0] !== undefined ? ring[0] : null;
      return first ?? null;
    }
    default:
      return null;
  }
}

/**
 * Return the H3 cell (resolution 7) covering a representative point of the
 * geometry, or `null` if the geometry has no coordinates we can evaluate.
 */
export function cellForGeometry(
  geom: GeoJsonGeometry | null,
): string | null {
  if (geom === null) return null;
  const point = representativePoint(geom);
  if (point === null) return null;
  const [lng, lat] = point;
  // h3-js takes lat then lng, opposite of GeoJSON.
  return latLngToCell(lat, lng, H3_RESOLUTION);
}
