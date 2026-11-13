// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed coordinates for a geopoint question.

function parseCoord(text: string, limit: number): number | null {
  const s = text.trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

/**
 * The point two typed fields describe, or null until both are valid
 * numbers in range. The fields used to write Number(text) on every
 * keystroke, so a lone "-" became 0, a cleared field became 0, and a
 * point with only a latitude got longitude 0 and passed as a real
 * location on the prime meridian.
 */
export function parseManualPoint(
  latText: string,
  lngText: string,
): { lat: number; lng: number } | null {
  const lat = parseCoord(latText, 90);
  const lng = parseCoord(lngText, 180);
  return lat === null || lng === null ? null : { lat, lng };
}
