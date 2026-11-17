// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keep renderer classes in a shape MapLibre accepts.
 *
 * A `step` expression needs strictly ascending stops and a `match`
 * expression needs unique labels. Either mistake makes MapLibre reject
 * the paint property, so the layer stops following its renderer, and
 * once saved it draws wrong for every viewer. The renderer editor
 * produced both: raising the class count padded the stops with copies
 * of the last one, and two clicks on "Add category" made two empty
 * labels.
 */

/**
 * Stops for `n` classes. Growing adds stops above the last one, one
 * step apart (the last gap, or 1), so the list stays strictly
 * ascending. Shrinking keeps the first `n`.
 */
export function resizeStops(stops: readonly number[], n: number): number[] {
  if (n <= stops.length) return stops.slice(0, n);
  const out = [...stops];
  const last = out.at(-1);
  const prev = out.at(-2);
  const gap = last !== undefined && prev !== undefined && last > prev ? last - prev : 1;
  let next = last === undefined ? 1 : last + gap;
  while (out.length < n) {
    out.push(next);
    next += gap;
  }
  return out;
}

/**
 * Sort class breaks ascending and drop repeated stops, keeping each
 * stop's colour with it. `colors` has one more entry than `stops`
 * (the colour below the first stop comes first). Null when the shape
 * is wrong, so the caller can fall back to the plain colour.
 */
export function normalizeClassBreaks(
  stops: readonly number[],
  colors: readonly string[],
): { stops: number[]; colors: string[] } | null {
  if (stops.length === 0 || colors.length !== stops.length + 1) return null;
  const pairs = stops
    .map((stop, i) => ({ stop, color: colors[i + 1]!, i }))
    .filter((p) => Number.isFinite(p.stop))
    .sort((a, b) => a.stop - b.stop || a.i - b.i);
  const outStops: number[] = [];
  const outColors: string[] = [colors[0]!];
  for (const p of pairs) {
    if (outStops.length > 0 && outStops[outStops.length - 1] === p.stop) continue;
    outStops.push(p.stop);
    outColors.push(p.color);
  }
  if (outStops.length === 0) return null;
  return { stops: outStops, colors: outColors };
}

/** Categories with each value once; the first one wins. */
export function uniqueCategories<T extends { value: string }>(
  categories: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of categories) {
    if (seen.has(c.value)) continue;
    seen.add(c.value);
    out.push(c);
  }
  return out;
}

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Stretch a colour list to `n` entries by linear interpolation, so a
 * hand-picked or custom ramp survives a change in the class count
 * instead of being replaced by the default ramp. Colours that are not
 * #rrggbb are kept by nearest position.
 */
export function resampleColors(colors: readonly string[], n: number): string[] {
  if (n <= 0 || colors.length === 0) return [];
  if (colors.length === 1 || n === 1) return Array.from({ length: n }, () => colors[0]!);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1)) * (colors.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, colors.length - 1);
    const a = parseHex(colors[lo]!);
    const b = parseHex(colors[hi]!);
    if (!a || !b) {
      out.push(colors[Math.round(t)]!);
      continue;
    }
    const f = t - lo;
    const mix = a.map((x, k) => Math.round(x + (b[k]! - x) * f));
    out.push(`#${mix.map((x) => x.toString(16).padStart(2, '0')).join('')}`);
  }
  return out;
}
