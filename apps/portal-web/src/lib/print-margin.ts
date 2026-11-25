// SPDX-License-Identifier: AGPL-3.0-or-later

/** The widest margin a sheet allows: a quarter of its shorter side. */
export function maxPrintMarginIn(inches: { w: number; h: number }): number {
  return Math.min(inches.w, inches.h) / 4;
}

/**
 * A margin the sheet can use, from what was typed in the designer:
 * from zero to a quarter of the shorter side. Empty or not a number
 * gives zero, as the field always did; out of range gives the nearest
 * end. The API applies the same range when it prints.
 */
export function clampPrintMarginIn(value: number, inches: { w: number; h: number }): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), maxPrintMarginIn(inches));
}
