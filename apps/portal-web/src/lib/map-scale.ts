// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tile-zoom <-> map-scale conversions.
 *
 * The web-mercator scale at zoom z and latitude lat is:
 *   scale = SCALE_AT_Z0 * cos(lat) / 2^z
 *
 * SCALE_AT_Z0 = 559_082_264.028 is the conventional value Esri /
 * MapLibre / Mapbox use: 256 px tile at 96 DPI rendering the
 * equator at z0. Apps that report "scale" in their UI all derive
 * from this baseline.
 *
 * Used by the offline-download picker (#272) so the field worker
 * sees "1:1,128" or "1"=100 ft" instead of "z19" -- the zoom
 * number is implementation detail, the scale is the GIS vocabulary
 * the user actually thinks in. Will also be reused by the print
 * template (#132) for the "Choose a scale" picker on a layout.
 *
 * cos(lat) shrinks the scale denominator at higher latitudes (a
 * z19 tile at 60deg N covers half the ground a z19 tile at the
 * equator does). For the offline-download picker we use the bbox's
 * center latitude so the scale label matches what the worker sees
 * on the map, not the equator-baseline value.
 */

import type { SupportedLocale } from '@/lib/i18n/locales';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { formatNumber } from '@/lib/i18n/format';

const SCALE_AT_Z0 = 559_082_264.028;

/**
 * Map scale (denominator of 1:N) for a given zoom and latitude.
 * Returns a positive number; the caller formats as "1:N" or
 * derives the inch-to-feet equivalent.
 */
export function zoomToScale(zoom: number, latDeg: number = 0): number {
  const latRad = (latDeg * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  return (SCALE_AT_Z0 * cosLat) / Math.pow(2, zoom);
}

/**
 * Format a 1:N denominator as a localized string. "1:1,128"
 * for normal scales, "1:1.1M" for very small scales so the
 * label doesn't bloat the picker.
 */
export function formatMapScale(
  denominator: number,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  if (denominator >= 1_000_000) {
    const m = denominator / 1_000_000;
    return `1:${m.toFixed(m < 10 ? 1 : 0)}M`;
  }
  return `1:${formatNumber(Math.round(denominator), locale)}`;
}

/**
 * Convert a 1:N scale to engineering "1 inch = N feet".
 * 1 foot = 12 inches, so 1:1200 -> 1" = 100 ft.
 * Returns null when the scale is too small for the engineering
 * vocabulary to be useful (city/regional views) -- the caller
 * shows just the 1:N label in that case.
 */
export function scaleToEngineering(denominator: number): number | null {
  if (denominator > 12_000) return null; // beyond ~1"=1000 ft, engineers stop using inch-feet
  return denominator / 12;
}

/**
 * Format engineering scale as `1"=N ft`. Rounds to a friendly
 * value (10/20/30/40/50/100/200/...) so noisy zoom-derived
 * values like 1"=94 ft show as 1"=100 ft -- which is what a
 * worker writes on the cover sheet.
 */
export function formatEngineeringScale(feetPerInch: number): string {
  // Snap to 10/20/30/40/50/60/100/200/300/400/500/1000 ladder
  const ladder = [10, 20, 30, 40, 50, 60, 100, 200, 300, 400, 500, 1000];
  let snapped = feetPerInch;
  for (let i = 0; i < ladder.length; i += 1) {
    const v = ladder[i]!;
    const next = ladder[i + 1] ?? v * 2;
    if (feetPerInch <= (v + next) / 2) {
      snapped = v;
      break;
    }
  }
  if (feetPerInch > ladder[ladder.length - 1]!) {
    snapped = Math.round(feetPerInch / 100) * 100;
  }
  return `1"=${snapped} ft`;
}

/**
 * Pretty label for a zoom level at a given latitude. Lead with
 * the user-friendly scale; show the zoom number subtly in parens
 * for the technical user.
 *
 *   z19 at lat 33° -> "1:893  ·  1"=100 ft  ·  z19"
 *   z14 at lat 33° -> "1:28,575  ·  z14"
 *   z6  at lat 0°  -> "1:8.7M  ·  z6"
 */
export function describeZoom(
  zoom: number,
  latDeg: number = 0,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const denom = zoomToScale(zoom, latDeg);
  const scaleLabel = formatMapScale(denom, locale);
  const eng = scaleToEngineering(denom);
  const engLabel = eng ? `  ·  ${formatEngineeringScale(eng)}` : '';
  return `${scaleLabel}${engLabel}  ·  z${zoom}`;
}
