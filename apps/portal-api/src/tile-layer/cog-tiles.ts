// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Argument building for the COG tile route, kept free of GDAL, Nest
 * and Prisma so the spec can cover the decisions without the native
 * addon. Same split as elevation-mosaic.compositor vs its service.
 *
 * Why the route exists at all. A COG-backed tile_layer was reachable
 * from a desktop GIS only by opening the file itself over HTTP range
 * reads (GDAL's /vsicurl). That works when a user adds the layer by
 * hand, and deadlocks QGIS when the same layer is in a project being
 * opened: QGIS builds providers on a worker pool during project read
 * and blocks the GUI thread waiting for them, and a /vsicurl provider
 * never comes back. The project never finishes loading and the
 * application has to be killed. Serving the same imagery as ordinary
 * XYZ tiles takes GDAL out of the client entirely.
 *
 * The COG stays downloadable at /tile-layer/:id/file.cog. This route
 * is for drawing; that one is for the values.
 */

/** Tiles are 256px, matching the XYZ grid every client assumes. */
export const COG_TILE_SIZE = 256;

/** Half the web-mercator world width in meters. */
const HALF_WORLD = Math.PI * 6378137;

export interface Bbox3857 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Web-mercator bounds of an XYZ tile. */
export function tileBounds3857(z: number, x: number, y: number): Bbox3857 {
  const span = (2 * HALF_WORLD) / 2 ** z;
  const minX = -HALF_WORLD + x * span;
  const maxY = HALF_WORLD - y * span;
  return { minX, minY: maxY - span, maxX: minX + span, maxY };
}

/**
 * Does this source need an alpha band added during the warp?
 *
 * gdalwarp's -dstalpha appends one, which is what makes the area
 * outside the raster's footprint transparent instead of black. Adding
 * it to a source that ALREADY carries alpha produces a 5-band result,
 * and the PNG driver refuses to write that, so the last band's colour
 * interpretation decides.
 */
export function needsAlphaBand(lastBandColorInterpretation: string): boolean {
  return lastBandColorInterpretation !== 'Alpha';
}

/**
 * gdalwarp arguments for one tile.
 *
 * -of MEM with a destination path (rather than a pre-built
 * destination dataset) lets gdalwarp size and band the output itself,
 * including the alpha band. Pre-building it means getting the band
 * count right by hand for every combination of source bands and
 * alpha, and getting it wrong is a runtime error per tile.
 *
 * -r bilinear rather than nearest because these are pictures being
 * downsampled hard at low zoom; nearest aliases badly. gdalwarp picks
 * a matching overview level for the requested output size on its own,
 * so a z8 tile over a 52k-pixel-wide image reads kilobytes, not the
 * full raster.
 */
export function warpArgs(
  bounds: Bbox3857,
  addAlpha: boolean,
  size: number = COG_TILE_SIZE,
): string[] {
  const args = [
    '-of', 'MEM',
    '-t_srs', 'EPSG:3857',
    '-te',
    String(bounds.minX),
    String(bounds.minY),
    String(bounds.maxX),
    String(bounds.maxY),
    '-ts', String(size), String(size),
    '-r', 'bilinear',
  ];
  if (addAlpha) args.push('-dstalpha');
  return args;
}

/**
 * PNG carries 8-bit and 16-bit samples only. Anything else (a
 * Float32 or Float64 elevation raster, an Int16 DEM) has to be
 * rendered to Byte first, or the driver writes whatever the cast
 * happens to produce: an elevation of 900 m clamps to 255 and the
 * whole tile comes out white.
 */
export function needsRendering(dataType: string): boolean {
  return dataType !== 'Byte';
}

/**
 * gdal_translate arguments turning a warped single-band raster into
 * a grey RGBA image, stretched over the range given.
 *
 * The range is the WHOLE raster's, taken once from the source and
 * reused for every tile. Letting -scale work out a range per tile
 * would stretch each one over its own local min and max, and
 * neighbouring tiles would then disagree about which grey a given
 * elevation is: the map draws as a patchwork with a visible seam on
 * every tile boundary.
 *
 * Band 1 is written three times to make grey, and the alpha band is
 * copied through unscaled so the footprint edge stays transparent.
 */
export function grayscaleArgs(
  alphaBandIndex: number,
  low: number,
  high: number,
): string[] {
  // A flat raster (every pixel the same) has low === high, and a
  // zero-width range makes -scale divide by zero. Widening it puts
  // the single value at the bottom of the ramp, which draws as one
  // flat tone: correct, and better than a NaN tile.
  const hi = high > low ? high : low + 1;
  const lo = String(low);
  const stretch = [lo, String(hi), '0', '255'];
  return [
    '-of', 'MEM',
    '-ot', 'Byte',
    '-b', '1', '-b', '1', '-b', '1', '-b', String(alphaBandIndex),
    '-scale_1', ...stretch,
    '-scale_2', ...stretch,
    '-scale_3', ...stretch,
    // Alpha is already 0-255 and must not be stretched: a tile whose
    // alpha happens to be all 255 would otherwise scale to 0 and the
    // tile would vanish.
    '-scale_4', '0', '255', '0', '255',
  ];
}

/**
 * Reject nonsense tile addresses before any storage work.
 *
 * z is capped at 24 because this route warps on demand: a request
 * far past the source's resolution costs the same read for a tile
 * nobody can see, and an uncapped z makes 2 ** z lose integer
 * precision.
 */
export function isValidTileAddress(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  if (z < 0 || z > 24) return false;
  const n = 2 ** z;
  return x >= 0 && y >= 0 && x < n && y < n;
}

/**
 * WGS84 [w, s, e, n] bounds of an XYZ tile, for the cheap footprint
 * test against the lon/lat bbox stamped on the item. A tile outside
 * the raster is answered without opening the raster at all, which is
 * most of them for a county-sized image on a world grid.
 */
export function tileBoundsWgs84(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const { minX, minY, maxX, maxY } = tileBounds3857(z, x, y);
  const lon = (v: number) => (v / HALF_WORLD) * 180;
  const lat = (v: number) =>
    (Math.atan(Math.sinh(v / 6378137)) * 180) / Math.PI;
  return [lon(minX), lat(minY), lon(maxX), lat(maxY)];
}
