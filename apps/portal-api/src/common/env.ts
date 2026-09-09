// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Read an integer tuning knob from the environment, falling back when
 * it is unset, empty, not a number, or below `min`. The cache bounds
 * accept zero (a zero byte cap is a legitimate "cache off"), while a
 * concurrency lane or a TTL that must stay usable passes `min: 1`.
 *
 * Lives here rather than in the tile cache, where it started, because
 * the auth and schema caches read their knobs the same way and neither
 * of them should have to import the tile cache to do it.
 */
export function parseIntEnv(
  name: string,
  fallback: number,
  { min = 0 }: { min?: number } = {},
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
