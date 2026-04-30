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
