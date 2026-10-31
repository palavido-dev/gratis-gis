// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Area-scale indicator math — the area sibling of MapLibre's
 * distance scale bar.
 *
 * A linear scale bar answers "how long is this edge?"; an area
 * square answers "how big is a parcel / park / block at this
 * zoom?". The control picks a decade-friendly amount in the
 * user's chosen unit (1 ac → 10 ac → 100 ac, or 1 ha → 10 ha → …)
 * so the on-screen square stays in a readable pixel range while
 * the label stays a round number people can think in.
 *
 * Ground math is planimetric (horizontal), same basis as parcel
 * acre fields and Measure → Area's geodesic readout. Pitch
 * foreshortens the map view; the indicator uses center-latitude
 * meters-per-pixel the same way the distance scale bar does.
 */

import {
  AREA_UNIT_SUFFIX,
  squareMetersPerAreaUnit,
  type AreaUnit,
} from '@/lib/measure';

/** localStorage key for the area-scale unit preference. */
export const AREA_SCALE_UNIT_KEY = 'gg-area-scale-unit';

/** Pixel side length the square aims to stay inside. */
export const AREA_SCALE_MIN_PX = 28;
export const AREA_SCALE_MAX_PX = 72;

/**
 * Cycle order for click-to-toggle. Acres first (US parcel default),
 * then metric, then the coarser / finer relatives.
 */
export const AREA_SCALE_UNIT_CYCLE: readonly AreaUnit[] = [
  'acres',
  'hectares',
  'square-meters',
  'square-kilometers',
  'square-miles',
  'square-feet',
] as const;

export type AreaScaleSelection = {
  /** Round amount in `unit` (1, 10, 100, …). */
  value: number;
  unit: AreaUnit;
  /** Ground side length of the square in meters. */
  sideMeters: number;
  /** On-screen side length in CSS pixels. */
  sidePx: number;
  /** Short label, e.g. "10 ac". */
  label: string;
};

/**
 * Web-mercator meters per pixel at a latitude + zoom. Matches the
 * GPS accuracy-ring and print scalebar formula used elsewhere in
 * the portal (equatorial circumference / 256 / 2^z * cos(lat)).
 */
export function metersPerPixel(latDeg: number, zoom: number): number {
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  // Guard poles / bad input so callers never get Infinity / NaN.
  const cos = Number.isFinite(cosLat) ? Math.max(Math.abs(cosLat), 1e-6) : 1e-6;
  const z = Number.isFinite(zoom) ? zoom : 0;
  return (40_075_016.686 * cos) / (256 * Math.pow(2, z));
}

/**
 * Decade ladder for a unit: …, 0.01, 0.1, 1, 10, 100, 1000, …
 * Bounded so extreme zooms still resolve to a finite pick.
 */
export function areaDecadeLadder(
  unit: AreaUnit,
  minValue = 1e-4,
  maxValue = 1e9,
): number[] {
  const out: number[] = [];
  // Start at the smallest power of 10 that is >= minValue.
  let v = Math.pow(10, Math.ceil(Math.log10(minValue)));
  if (!Number.isFinite(v) || v <= 0) v = minValue;
  while (v <= maxValue + Number.EPSILON) {
    out.push(Number(v.toPrecision(12)));
    v *= 10;
  }
  // Sq ft / sq m need denser small steps at city-block zooms; the
  // pure decade ladder is enough for acres/hectares/sq mi/sq km.
  void unit;
  return out;
}

/**
 * Pick the decade amount whose on-screen square fits under maxPx.
 * Same idea as MapLibre's distance scale bar: the label is always a
 * round number and the drawn size is the true ground size at this
 * zoom (never stretched to "look right" with a lying label).
 *
 * Prefers the largest decade that is still ≤ maxPx and ≥ minPx.
 * When zoomed far out (everything tiny), takes the largest decade
 * that still fits under maxPx. When zoomed far in (even 0.0001 of
 * the unit overflows), takes the smallest decade at its true size.
 */
export function pickAreaScale(
  metersPerPx: number,
  unit: AreaUnit,
  opts?: { minPx?: number; maxPx?: number },
): AreaScaleSelection | null {
  if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return null;
  const minPx = opts?.minPx ?? AREA_SCALE_MIN_PX;
  const maxPx = opts?.maxPx ?? AREA_SCALE_MAX_PX;
  const sqmPerUnit = squareMetersPerAreaUnit(unit);
  const ladder = areaDecadeLadder(unit);

  type Candidate = { value: number; sidePx: number; sideMeters: number };
  const candidates: Candidate[] = ladder.map((value) => {
    const sideMeters = Math.sqrt(value * sqmPerUnit);
    const sidePx = sideMeters / metersPerPx;
    return { value, sideMeters, sidePx };
  });

  const fits = candidates.filter((c) => c.sidePx <= maxPx);
  let best: Candidate;
  if (fits.length > 0) {
    const readable = fits.filter((c) => c.sidePx >= minPx);
    const pool = readable.length > 0 ? readable : fits;
    best = pool.reduce((a, b) => (a.sidePx >= b.sidePx ? a : b));
  } else {
    // Zoomed in past the smallest decade — still show it truthfully.
    best = candidates[0]!;
  }

  return {
    value: best.value,
    unit,
    sideMeters: best.sideMeters,
    sidePx: best.sidePx,
    label: formatAreaScaleLabel(best.value, unit),
  };
}

/** Compact label: "1 ac", "10 ha", "1000 m²". */
export function formatAreaScaleLabel(value: number, unit: AreaUnit): string {
  const suffix = AREA_UNIT_SUFFIX[unit];
  if (!Number.isFinite(value) || value <= 0) return `0 ${suffix}`;
  // Decade values are exact powers of 10; avoid "1.0000000002".
  const text =
    value >= 1 && Number.isInteger(value)
      ? String(value)
      : value.toPrecision(1).replace(/\.0$/, '');
  return `${text} ${suffix}`;
}

/** Next unit in the click cycle. */
export function nextAreaScaleUnit(current: AreaUnit): AreaUnit {
  const idx = AREA_SCALE_UNIT_CYCLE.indexOf(current);
  const next = AREA_SCALE_UNIT_CYCLE[(idx + 1) % AREA_SCALE_UNIT_CYCLE.length];
  return next ?? 'acres';
}

/**
 * Default unit from the profile metric/imperial preference.
 * Imperial (and unset) → acres; metric → hectares.
 */
export function defaultAreaScaleUnit(
  profileUnits?: string | null,
): AreaUnit {
  return profileUnits === 'metric' ? 'hectares' : 'acres';
}

/** Read the persisted unit, falling back to the profile default. */
export function readStoredAreaScaleUnit(): AreaUnit {
  if (typeof window === 'undefined') return 'acres';
  try {
    const stored = window.localStorage.getItem(AREA_SCALE_UNIT_KEY);
    if (stored && (AREA_SCALE_UNIT_CYCLE as readonly string[]).includes(stored)) {
      return stored as AreaUnit;
    }
    return defaultAreaScaleUnit(
      window.localStorage.getItem('gg-profile-units'),
    );
  } catch {
    return 'acres';
  }
}

export function writeStoredAreaScaleUnit(unit: AreaUnit): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AREA_SCALE_UNIT_KEY, unit);
  } catch {
    /* private mode */
  }
}

/**
 * Whether this area unit pairs with an imperial distance scale bar.
 * Used so clicking the area square can keep the linear scale bar in
 * the same unit family.
 */
export function areaUnitIsImperial(unit: AreaUnit): boolean {
  return (
    unit === 'acres' || unit === 'square-miles' || unit === 'square-feet'
  );
}
