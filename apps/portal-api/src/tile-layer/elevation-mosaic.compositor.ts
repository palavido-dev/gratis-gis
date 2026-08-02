// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure per-pixel math for the elevation mosaic (#211). Kept free of
 * GDAL, Nest, and Prisma so the unit spec can cover the compositing
 * rules against synthetic grids (same split as mvtTile vs
 * computeMvtTileBytes in the engine).
 *
 * The mosaic rule: the map's terrain stack is an ORDERED list of
 * DEMs. Sources are composited per PIXEL, first entry with data
 * wins, nodata (NaN) falls through to the next entry down.
 * Per-pixel rather than per-tile is what actually fixes the DEM
 * footprint cliff: boundary tiles are exactly where two sources
 * must blend.
 */

/** Mosaic tiles are 256px, matching the raster-dem tileSize the
 *  canvas registers and the GoogleMapsCompatible COG grid. */
export const MOSAIC_TILE_SIZE = 256;

const EARTH_RADIUS = 6378137;
/** Half the web-mercator world width in meters. */
const HALF_WORLD = Math.PI * EARTH_RADIUS;

export interface Bbox3857 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Web-mercator (EPSG:3857) bounds of an XYZ tile. */
export function tileBbox3857(z: number, x: number, y: number): Bbox3857 {
  const span = (2 * HALF_WORLD) / 2 ** z;
  const minX = -HALF_WORLD + x * span;
  const maxY = HALF_WORLD - y * span;
  return { minX, minY: maxY - span, maxX: minX + span, maxY };
}

/** WGS84 [w, s, e, n] bounds of an XYZ tile, for cheap intersection
 *  tests against the lon/lat bbox stamped on tile_layer items. */
export function tileBboxWgs84(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = tileBbox3857(z, x, y);
  const lon = (v: number) => (v / HALF_WORLD) * 180;
  const lat = (v: number) =>
    (Math.atan(Math.sinh(v / EARTH_RADIUS)) * 180) / Math.PI;
  return [lon(minX), lat(minY), lon(maxX), lat(maxY)];
}

/** Do two [w, s, e, n] boxes overlap? Touching edges count: a DEM
 *  whose footprint ends exactly on a tile boundary still owns the
 *  edge pixels after bilinear resampling. */
export function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * First-wins per-pixel composite: copy `src` values into the slots
 * of `dest` that are still nodata (NaN). Callers iterate the stack
 * in priority order, so a pixel keeps the value of the FIRST source
 * that had data there.
 */
export function compositeInto(dest: Float32Array, src: Float32Array): void {
  if (dest.length !== src.length) {
    throw new Error(
      `compositeInto: grid size mismatch (${dest.length} vs ${src.length})`,
    );
  }
  for (let i = 0; i < dest.length; i++) {
    if (Number.isNaN(dest[i]!) && !Number.isNaN(src[i]!)) {
      dest[i] = src[i]!;
    }
  }
}

/** True when at least one pixel is still nodata; lets the composer
 *  stop opening lower-priority sources once the tile is full. */
export function hasNodata(grid: Float32Array): boolean {
  for (let i = 0; i < grid.length; i++) {
    if (Number.isNaN(grid[i]!)) return true;
  }
  return false;
}

/** True when NO pixel has data (the tile misses every source). */
export function isAllNodata(grid: Float32Array): boolean {
  for (let i = 0; i < grid.length; i++) {
    if (!Number.isNaN(grid[i]!)) return false;
  }
  return true;
}

/**
 * Terrarium RGB encoding, MapLibre raster-dem `"encoding":
 * "terrarium"`: elevation = (R * 256 + G + B / 256) - 32768, i.e.
 * 1/256 m vertical resolution. Remaining nodata pixels encode as
 * elevation 0, which matches what a missing terrain tile renders
 * as, so uncovered ground behaves the same with and without the
 * mosaic.
 */
export function encodeTerrarium(grid: Float32Array): {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
} {
  const r = new Uint8Array(grid.length);
  const g = new Uint8Array(grid.length);
  const b = new Uint8Array(grid.length);
  const ZERO = 32768 * 256;
  const MAX = 256 * 256 * 256 - 1;
  for (let i = 0; i < grid.length; i++) {
    const e = grid[i]!;
    let total = Number.isNaN(e) ? ZERO : Math.round((e + 32768) * 256);
    if (total < 0) total = 0;
    else if (total > MAX) total = MAX;
    b[i] = total & 255;
    g[i] = (total >> 8) & 255;
    r[i] = (total >> 16) & 255;
  }
  return { r, g, b };
}

/** Decode one terrarium pixel back to meters (spec + debugging). */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Hard cap on stack length; beyond this the per-tile fan-out cost
 *  stops being reasonable and the UI has no honest use case. */
export const MOSAIC_MAX_STACK = 8;

/**
 * Controller guard for the ?stack= query: 1..MOSAIC_MAX_STACK
 * comma-separated uuid-shaped ids, order preserved, de-duped (a
 * repeated id can't change the composite but would split the
 * cache). Null means reject with 400.
 */
export function parseStackParam(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ids = raw.split(',').map((s) => s.trim());
  if (ids.length === 0 || ids.length > MOSAIC_MAX_STACK) return null;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!ids.every((id) => uuid.test(id))) return null;
  return [...new Set(ids)];
}
