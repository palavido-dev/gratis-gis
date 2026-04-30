/**
 * Length units shared across UI surfaces and SQL emission. Used by
 * tools that take a distance parameter (currently `buffer`; future
 * `simplify`, `distance-to-nearest`).
 *
 * The canonical internal unit is meters: PostGIS `geography` distance
 * is in meters, the bbox-padding helper expects meters, and the cap
 * constant `MAX_BUFFER_DISTANCE_METERS` is meters. UI surfaces preserve
 * the user's chosen unit so a recipe authored in "5 km" round-trips
 * through save / reload as "5 km" rather than "5000 m". Converting to
 * meters happens at SQL emission time using `metersFor(value, unit)`.
 *
 * The factors are international definitions (1 ft = 0.3048 m exactly,
 * 1 mi = 1609.344 m). Survey-foot variants are 6 ppm different, which
 * is irrelevant for buffer-distance use cases.
 */

export type LengthUnit =
  | 'meters'
  | 'kilometers'
  | 'feet'
  | 'yards'
  | 'miles';

/**
 * Meters in one unit of `LengthUnit`. Multiply by a value in that unit
 * to get meters; divide a meters value to get the unit value.
 */
export const METERS_PER_UNIT: Record<LengthUnit, number> = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  yards: 0.9144,
  miles: 1609.344,
};

/**
 * Short, human-friendly labels for each unit. Used by the recipe
 * detail panel and any other UI that summarizes a stored distance
 * without re-reading the unit name verbatim.
 */
export const UNIT_LABELS: Record<LengthUnit, string> = {
  meters: 'm',
  kilometers: 'km',
  feet: 'ft',
  yards: 'yd',
  miles: 'mi',
};

/**
 * Convert a value in `unit` to meters. Pure; no rounding. Returns the
 * input when `unit === 'meters'` so the common case is a no-op rather
 * than a multiplication by 1.
 */
export function metersFor(value: number, unit: LengthUnit): number {
  if (unit === 'meters') return value;
  return value * METERS_PER_UNIT[unit];
}

/**
 * Type guard for incoming JSON: narrows an unknown string to a
 * `LengthUnit`. Used by validators to reject unknown unit names with
 * a useful message.
 */
export function isLengthUnit(value: unknown): value is LengthUnit {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(METERS_PER_UNIT, value)
  );
}

/**
 * Ordered list of all units, useful for building a `<select>` so the
 * UI doesn't drift away from the type definition. Order is
 * meters -> kilometers -> feet -> yards -> miles, biggest-metric to
 * biggest-imperial, which matches what GIS users expect.
 */
export const LENGTH_UNITS: ReadonlyArray<LengthUnit> = [
  'meters',
  'kilometers',
  'feet',
  'yards',
  'miles',
];

/**
 * Area units used by the calculate-geometry tool's area mode. Square
 * versions of the length units, plus hectares and acres which are the
 * conventional "land parcel" units in metric and imperial respectively.
 */
export type AreaUnit =
  | 'square-meters'
  | 'square-kilometers'
  | 'hectares'
  | 'square-feet'
  | 'square-yards'
  | 'acres'
  | 'square-miles';

/**
 * Square meters in one unit of `AreaUnit`. Multiply by a value in
 * that unit to get square meters; divide a square-meters value to
 * convert into that unit.
 *
 * Constants chosen to match international definitions: 1 ha = 10_000
 * square meters, 1 acre = 4046.8564224 square meters (exactly), 1
 * square mile = 1609.344 squared. Square versions of the LengthUnit
 * factors are exact under `Math.pow(metersPerUnit, 2)` so we keep
 * them factored that way for the linear units; ha and acres are
 * spelled out.
 */
export const SQ_METERS_PER_AREA_UNIT: Record<AreaUnit, number> = {
  'square-meters': 1,
  'square-kilometers': 1_000_000,
  hectares: 10_000,
  'square-feet': 0.3048 * 0.3048,
  'square-yards': 0.9144 * 0.9144,
  acres: 4046.8564224,
  'square-miles': 1609.344 * 1609.344,
};

export const AREA_UNIT_LABELS: Record<AreaUnit, string> = {
  'square-meters': 'm2',
  'square-kilometers': 'km2',
  hectares: 'ha',
  'square-feet': 'ft2',
  'square-yards': 'yd2',
  acres: 'ac',
  'square-miles': 'mi2',
};

export const AREA_UNITS: ReadonlyArray<AreaUnit> = [
  'square-meters',
  'square-kilometers',
  'hectares',
  'square-feet',
  'square-yards',
  'acres',
  'square-miles',
];

export function isAreaUnit(value: unknown): value is AreaUnit {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SQ_METERS_PER_AREA_UNIT, value)
  );
}

/**
 * Convert a square-meters value into `unit`. Used by tools that
 * compute on geography (which returns square meters) and want to
 * surface a user-friendly unit. Divide-by-the-factor; pure.
 */
export function areaInUnit(squareMeters: number, unit: AreaUnit): number {
  if (unit === 'square-meters') return squareMeters;
  return squareMeters / SQ_METERS_PER_AREA_UNIT[unit];
}
