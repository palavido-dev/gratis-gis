// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A stored length in metres, shown in another unit.
 *
 * Inputs that store metres and display feet, miles or yards convert
 * both ways on every keystroke. The round trip is not exact in binary
 * floating point (7 ft becomes 6.999999999999999), and React then
 * rewrites the field with that text while the user is typing. Twelve
 * significant digits is far more than any distance input needs and
 * drops the conversion noise.
 */
export function metersToDisplay(meters: number, metersPerUnit: number): number {
  const v = meters / metersPerUnit;
  return Number.isFinite(v) ? Number(v.toPrecision(12)) : v;
}
