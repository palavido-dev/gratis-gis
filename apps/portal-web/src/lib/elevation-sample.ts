// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side elevation sampling along a line, straight from an
 * elevation COG over HTTP range requests (the same access pattern
 * the map's 3D terrain already uses, via geotiff which is already
 * in the bundle as the COG protocol's engine).
 *
 * Why client-side: a profile is an interactive readout, not an
 * analysis product. Round-tripping a job queue for every redrawn
 * line would feel broken; reading a few hundred kilobytes of the
 * COG directly gives instant results at the raster's native
 * accuracy, works for viewers without publish rights, and needs
 * no new server surface.
 *
 * The reader is deliberately exact about what it accepts: a COG in
 * EPSG:3857 (what the elevation job produces via the
 * GoogleMapsCompatible tiling scheme). Anything else fails with a
 * plain-language error instead of returning wrong numbers.
 */

import { lineLengthMeters } from '@/lib/measure';

export interface ProfilePoint {
  /** Cumulative ground distance from the line start, meters. */
  dist: number;
  /** Elevation in meters, or null over gaps / outside coverage. */
  elev: number | null;
  lng: number;
  lat: number;
}

export interface ProfileResult {
  points: ProfilePoint[];
  /** Ground resolution (meters per pixel) of the level actually read. */
  resolutionM: number;
  /** Total line length in meters (ground distance). */
  totalM: number;
}

const EARTH_RADIUS_M = 6_378_137;
/**
 * Pixel budget across all chunk windows. Keeps the worst case
 * (long diagonal line over a fine DEM) to a few MB of decoded
 * floats and a couple dozen tile fetches.
 */
const MAX_READ_PX = 1_500_000;
/** Chart sampling density. */
const MAX_SAMPLES = 512;
const MIN_SAMPLES = 64;

function toMercator(lng: number, lat: number): [number, number] {
  const x = (lng * Math.PI * EARTH_RADIUS_M) / 180;
  const y =
    EARTH_RADIUS_M *
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/**
 * Evenly spaced sample positions along a polyline, by cumulative
 * planar-in-mercator interpolation but with distances measured on
 * the ground (haversine). At profile scales (meters to tens of km)
 * linear interpolation between vertices is exact for our purposes.
 */
function samplePositions(
  coords: Array<[number, number]>,
  n: number,
): Array<{ lng: number; lat: number; dist: number }> {
  const segLens: number[] = [];
  for (let i = 1; i < coords.length; i += 1) {
    segLens.push(lineLengthMeters([coords[i - 1]!, coords[i]!]));
  }
  const total = segLens.reduce((a, b) => a + b, 0);
  const out: Array<{ lng: number; lat: number; dist: number }> = [];
  for (let s = 0; s < n; s += 1) {
    const target = (total * s) / (n - 1);
    // Walk to the segment containing this distance.
    let acc = 0;
    let seg = 0;
    while (seg < segLens.length - 1 && acc + segLens[seg]! < target) {
      acc += segLens[seg]!;
      seg += 1;
    }
    const segLen = segLens[seg]! || 1;
    const t = Math.min(1, Math.max(0, (target - acc) / segLen));
    const [ax, ay] = coords[seg]!;
    const [bx, by] = coords[seg + 1]!;
    out.push({
      lng: ax + (bx - ax) * t,
      lat: ay + (by - ay) * t,
      dist: target,
    });
  }
  return out;
}

interface Level {
  index: number;
  width: number;
  height: number;
  /** Meters (3857) per pixel at this level. */
  resX: number;
  resY: number;
}

/**
 * Sample elevations along `coords` (a [lng, lat] polyline) from the
 * elevation COG at `url`. Reads the finest overview level that fits
 * the pixel budget, so short lines get native resolution and long
 * ones degrade gracefully instead of downloading the county.
 */
export async function sampleElevationProfile(
  url: string,
  coords: Array<[number, number]>,
): Promise<ProfileResult> {
  if (coords.length < 2) {
    throw new Error('Draw a line with at least two points.');
  }
  const { fromUrl } = await import('geotiff');
  const tiff = await fromUrl(url);
  const full = await tiff.getImage(0);

  const geoKeys = (full as { geoKeys?: Record<string, unknown> }).geoKeys;
  const epsg = geoKeys?.ProjectedCSTypeGeoKey;
  if (epsg !== 3857) {
    throw new Error(
      'This elevation layer is stored in a projection the profile tool cannot read yet.',
    );
  }
  // Model-space extent from the full image; COG overviews share the
  // extent but usually carry no geo tags of their own, so all
  // georeferencing math anchors here.
  const [minX, minY, maxX, maxY] = full.getBoundingBox() as [
    number,
    number,
    number,
    number,
  ];
  const nodata = full.getGDALNoData();

  const count = await tiff.getImageCount();
  const levels: Level[] = [];
  for (let i = 0; i < count; i += 1) {
    const img = i === 0 ? full : await tiff.getImage(i);
    const width = img.getWidth();
    const height = img.getHeight();
    levels.push({
      index: i,
      width,
      height,
      resX: (maxX - minX) / width,
      resY: (maxY - minY) / height,
    });
  }

  const totalM = lineLengthMeters(coords);
  // One sample per DEM pixel is the information limit; cap for the
  // chart, floor so short lines still draw a smooth curve.
  const nSamples = Math.max(
    MIN_SAMPLES,
    Math.min(MAX_SAMPLES, Math.round(totalM / levels[0]!.resX) + 1),
  );
  const positions = samplePositions(coords, nSamples);
  const merc = positions.map((p) => toMercator(p.lng, p.lat));

  // Chunk the line so diagonal lines read a string of small windows
  // instead of one huge bounding rectangle.
  const CHUNKS = Math.min(8, Math.max(1, Math.floor(nSamples / 32)));
  const perChunk = Math.ceil(nSamples / CHUNKS);
  const chunks: Array<{ from: number; to: number }> = [];
  for (let c = 0; c < nSamples; c += perChunk) {
    chunks.push({ from: c, to: Math.min(nSamples - 1, c + perChunk) });
  }

  /** Pixel window (in level pixels) covering samples [from..to]. */
  function windowFor(
    level: Level,
    from: number,
    to: number,
  ): [number, number, number, number] | null {
    let wMinX = Infinity;
    let wMinY = Infinity;
    let wMaxX = -Infinity;
    let wMaxY = -Infinity;
    for (let i = from; i <= to; i += 1) {
      const [mx, my] = merc[i]!;
      const px = (mx - minX) / level.resX;
      const py = (maxY - my) / level.resY;
      wMinX = Math.min(wMinX, px);
      wMinY = Math.min(wMinY, py);
      wMaxX = Math.max(wMaxX, px);
      wMaxY = Math.max(wMaxY, py);
    }
    const x0 = Math.max(0, Math.floor(wMinX) - 1);
    const y0 = Math.max(0, Math.floor(wMinY) - 1);
    const x1 = Math.min(level.width, Math.ceil(wMaxX) + 2);
    const y1 = Math.min(level.height, Math.ceil(wMaxY) + 2);
    if (x1 <= x0 || y1 <= y0) return null; // fully outside coverage
    return [x0, y0, x1, y1];
  }

  // Finest level whose total window area fits the budget. The
  // coarsest level always "fits" as the fallback.
  let chosen = levels[levels.length - 1]!;
  for (const level of levels) {
    let px = 0;
    for (const ch of chunks) {
      const w = windowFor(level, ch.from, ch.to);
      if (w) px += (w[2] - w[0]) * (w[3] - w[1]);
    }
    if (px <= MAX_READ_PX) {
      chosen = level;
      break;
    }
  }
  const img = chosen.index === 0 ? full : await tiff.getImage(chosen.index);

  const isInvalid = (v: number): boolean =>
    Number.isNaN(v) || (nodata !== null && v === nodata);

  const elevs: Array<number | null> = new Array(nSamples).fill(null);
  for (const ch of chunks) {
    const win = windowFor(chosen, ch.from, ch.to);
    if (!win) continue;
    const [x0, y0, x1, y1] = win;
    const raster = (await img.readRasters({
      window: [x0, y0, x1, y1],
      samples: [0],
      fillValue: NaN,
    })) as unknown as Array<Float32Array | Float64Array>;
    const data = raster[0]!;
    const w = x1 - x0;
    const h = y1 - y0;
    for (let i = ch.from; i <= ch.to; i += 1) {
      const [mx, my] = merc[i]!;
      const fx = (mx - minX) / chosen.resX - x0;
      const fy = (maxY - my) / chosen.resY - y0;
      if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) continue;
      const ix = Math.min(w - 2, Math.max(0, Math.floor(fx)));
      const iy = Math.min(h - 2, Math.max(0, Math.floor(fy)));
      const tx = fx - ix;
      const ty = fy - iy;
      const v00 = data[iy * w + ix]!;
      const v10 = data[iy * w + ix + 1]!;
      const v01 = data[(iy + 1) * w + ix]!;
      const v11 = data[(iy + 1) * w + ix + 1]!;
      const corners = [v00, v10, v01, v11];
      if (corners.every((v) => !isInvalid(v))) {
        // Bilinear when the whole neighborhood is valid.
        elevs[i] =
          v00 * (1 - tx) * (1 - ty) +
          v10 * tx * (1 - ty) +
          v01 * (1 - tx) * ty +
          v11 * tx * ty;
      } else {
        // Near a nodata edge: nearest valid corner, or a gap.
        const nearest =
          corners[(ty > 0.5 ? 2 : 0) + (tx > 0.5 ? 1 : 0)]!;
        elevs[i] = !isInvalid(nearest)
          ? nearest
          : (corners.find((v) => !isInvalid(v)) ?? null);
      }
    }
  }

  return {
    points: positions.map((p, i) => ({
      dist: p.dist,
      elev: elevs[i]!,
      lng: p.lng,
      lat: p.lat,
    })),
    resolutionM: chosen.resX,
    totalM,
  };
}
