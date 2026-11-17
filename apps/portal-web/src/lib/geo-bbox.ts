// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bounding boxes of GeoJSON geometries. One implementation for the
 * map, attribute table, search and custom app runtimes: the copies had
 * drifted, and one of them skipped GeometryCollection members.
 */

export type Bbox = [number, number, number, number];

interface Accumulator {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  seen: boolean;
}

function visit(coord: unknown, acc: Accumulator): void {
  if (!Array.isArray(coord)) return;
  if (coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
    const x = coord[0];
    const y = coord[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < acc.minX) acc.minX = x;
    if (y < acc.minY) acc.minY = y;
    if (x > acc.maxX) acc.maxX = x;
    if (y > acc.maxY) acc.maxY = y;
    acc.seen = true;
    return;
  }
  for (const c of coord) visit(c, acc);
}

function visitGeometry(geom: unknown, acc: Accumulator, depth = 0): void {
  if (!geom || typeof geom !== 'object' || depth > 8) return;
  const g = geom as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
    for (const member of g.geometries) visitGeometry(member, acc, depth + 1);
    return;
  }
  visit(g.coordinates, acc);
}

function fresh(): Accumulator {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, seen: false };
}

/** [minX, minY, maxX, maxY] of one geometry, or null when it has no
 *  finite coordinate. */
export function geometryBbox(geom: unknown): Bbox | null {
  const acc = fresh();
  visitGeometry(geom, acc);
  return acc.seen ? [acc.minX, acc.minY, acc.maxX, acc.maxY] : null;
}

/** [minX, minY, maxX, maxY] across features, or null when none has a
 *  finite coordinate. */
export function featuresBbox(
  features: readonly { geometry?: unknown }[],
): Bbox | null {
  const acc = fresh();
  for (const f of features) visitGeometry(f.geometry, acc);
  return acc.seen ? [acc.minX, acc.minY, acc.maxX, acc.maxY] : null;
}
