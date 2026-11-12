// SPDX-License-Identifier: AGPL-3.0-or-later
// The part of an edited row that the user actually changed.
//
// A feature PATCH merges the body over the live row, so every key in
// the body wins. Sending the whole row as it was loaded put back any
// value another editor had changed since, with no conflict. Sending
// only the keys the user changed leaves those values alone.

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // An empty input and a missing value are the same to the user.
  if ((a === undefined || a === null) && (b === undefined || b === null)) {
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Keys of `draft` whose value differs from `original`. Keys that
 * start with an underscore are system columns and never sent.
 */
export function changedProperties(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (key.startsWith('_')) continue;
    if (!sameValue(original[key], value)) out[key] = value;
  }
  return out;
}
