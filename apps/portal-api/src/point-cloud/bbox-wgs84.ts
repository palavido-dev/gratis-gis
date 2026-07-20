// SPDX-License-Identifier: AGPL-3.0-or-later
import proj4 from 'proj4';

/**
 * Derive a WGS84 [west, south, east, north] bbox from a point
 * cloud's native-CRS bounds + its WKT (#179). Computed once at
 * finalize and stamped on the item so the viewer can start the map
 * at the data instead of at world view. That ordering matters for
 * big clouds: the streaming loader's first LOD pass is driven by
 * the viewport, and a world-spanning viewport intersects every
 * octree node, which is how a 209M-point cloud produced an
 * "Array buffer allocation failed" in the browser before any
 * points drew.
 *
 * Lidar WKT is usually a COMPD_CS (horizontal + vertical datum).
 * proj4 wants the horizontal PROJCS/GEOGCS alone, so we extract
 * the first horizontal member by balanced-bracket walk rather
 * than regex; WKT nests freely and a regex over nested brackets
 * is exactly the kind of shortcut that misparses real files.
 *
 * Returns null when the WKT is missing or the transform fails;
 * callers treat the bbox as optional metadata, never a gate.
 */
export function boundsToWgs84(
  bounds: [number, number, number, number, number, number],
  crsWkt: string | null,
): [number, number, number, number] | null {
  if (!crsWkt) return null;
  const horizontal = extractHorizontalCs(crsWkt);
  if (!horizontal) return null;
  try {
    const toWgs84 = proj4(horizontal, 'EPSG:4326');
    const [minX, minY, , maxX, maxY] = bounds;
    // Transform all four corners: projected rectangles curve in
    // geographic space, so min/min + max/max alone under-covers
    // (Albers especially, its parallels bow northward).
    const corners: Array<[number, number]> = [
      [minX, minY],
      [minX, maxY],
      [maxX, minY],
      [maxX, maxY],
    ];
    const out = corners.map((c) => toWgs84.forward(c));
    const lons = out.map((c) => c[0]!);
    const lats = out.map((c) => c[1]!);
    const west = Math.min(...lons);
    const east = Math.max(...lons);
    const south = Math.min(...lats);
    const north = Math.max(...lats);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    // Sanity gate: a wrong-CRS transform tends to produce values
    // outside the valid range; refuse to stamp garbage.
    if (west < -180 || east > 180 || south < -90 || north > 90) return null;
    return [west, south, east, north];
  } catch {
    return null;
  }
}

/**
 * Pull the first PROJCS[...] or GEOGCS[...] out of a WKT string by
 * balanced-bracket scan. For a bare PROJCS/GEOGCS input this
 * returns it unchanged.
 */
export function extractHorizontalCs(wkt: string): string | null {
  for (const keyword of ['PROJCS', 'GEOGCS']) {
    const start = wkt.indexOf(`${keyword}[`);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start + keyword.length; i < wkt.length; i++) {
      const ch = wkt[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          return wkt.slice(start, i + 1);
        }
      }
    }
    return null; // unbalanced brackets; malformed WKT
  }
  return null;
}
