// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ground distance per screen pixel for a MapLibre map, and the scale
 * figures derived from it.
 *
 * MapLibre's zoom is defined on 512 px tiles: the whole world is
 * 512 * 2^zoom pixels wide. The common 156543 m/px and 1:591,657,550
 * constants are for 256 px raster tiles, one zoom level off, so every
 * copy that used them was out by a factor of two (the GPS accuracy
 * ring drawn at half size, print scale bars labelled twice the real
 * distance, a 1:50,000 print rendered at 1:25,000). Everything that
 * turns a MapLibre zoom into a distance goes through here.
 */

export const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** World width in pixels at MapLibre zoom 0. */
export const MAPLIBRE_TILE_SIZE = 512;
/** CSS reference pixel: 96 per inch. */
const METERS_PER_CSS_PIXEL = 0.0254 / 96;

function cosLat(latDeg: number): number {
  const c = Math.cos((latDeg * Math.PI) / 180);
  return Number.isFinite(c) ? Math.max(Math.abs(c), 1e-6) : 1e-6;
}

/** Meters of ground per CSS pixel at a latitude and MapLibre zoom. */
export function metersPerPixel(latDeg: number, zoom: number): number {
  const z = Number.isFinite(zoom) ? zoom : 0;
  return (EARTH_CIRCUMFERENCE_M * cosLat(latDeg)) / (MAPLIBRE_TILE_SIZE * Math.pow(2, z));
}

/** Scale denominator (the N in 1:N) on a 96 DPI display. */
export function scaleDenominator(latDeg: number, zoom: number): number {
  return metersPerPixel(latDeg, zoom) / METERS_PER_CSS_PIXEL;
}

/** The MapLibre zoom that shows 1:`scale` at `latDeg`. */
export function zoomForScale(scale: number, latDeg: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const mpp = scale * METERS_PER_CSS_PIXEL;
  return Math.log2((EARTH_CIRCUMFERENCE_M * cosLat(latDeg)) / (MAPLIBRE_TILE_SIZE * mpp));
}

/** Largest 1 / 2 / 5 x 10^n at or below `value`. */
export function roundNice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const mantissa = value / pow;
  const nice = mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1;
  return nice * pow;
}

export interface ScaleBar {
  /** Bar length in CSS pixels; the bar must be drawn at this width. */
  px: number;
  value: number;
  unit: 'm' | 'km' | 'ft' | 'mi';
}

/**
 * The longest round distance that fits in `maxPx`, and the pixel
 * length that distance actually takes. Drawing the bar at `px` (not
 * at the space available) is what keeps it to scale.
 */
export function scaleBar(
  mpp: number,
  maxPx: number,
  units: 'metric' | 'imperial',
): ScaleBar {
  const maxMeters = mpp * maxPx;
  let value: number;
  let unit: ScaleBar['unit'];
  let meters: number;
  if (units === 'metric') {
    if (maxMeters >= 1000) {
      value = roundNice(maxMeters / 1000);
      unit = 'km';
      meters = value * 1000;
    } else {
      value = roundNice(maxMeters);
      unit = 'm';
      meters = value;
    }
  } else {
    const feet = maxMeters / 0.3048;
    if (feet >= 1000) {
      value = roundNice(feet / 5280);
      unit = 'mi';
      meters = value * 1609.344;
    } else {
      value = roundNice(feet);
      unit = 'ft';
      meters = value * 0.3048;
    }
  }
  const px = mpp > 0 && Number.isFinite(mpp) ? meters / mpp : maxPx;
  return { px, value, unit };
}
