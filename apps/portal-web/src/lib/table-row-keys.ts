// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Selection keys shared by the attribute table and the map canvas.
 *
 * A v3 row is keyed by its `_global_id`. Every other source (GeoJSON
 * URL, inline GeoJSON, ArcGIS REST) is keyed by the feature's position
 * in the source as loaded, because that is the id MapLibre's
 * `generateId` gives it on the map. When the table filters those rows
 * itself, a row's position in the table is no longer its position in
 * the source, so the table carries the source position along with
 * each kept row and keys by that.
 */

type RowFeature = { properties?: unknown } | null | undefined;

function globalIdOf(f: RowFeature): string | null {
  const props = f && f.properties && typeof f.properties === 'object'
    ? (f.properties as Record<string, unknown>)
    : null;
  const gid = props ? props['_global_id'] : undefined;
  return typeof gid === 'string' ? gid : null;
}

/** Keep the rows that pass `keep`, remembering where each came from. */
export function filterWithSourceIndex<T>(
  items: readonly T[],
  keep: (item: T) => boolean,
): { items: T[]; srcIdx: number[] } {
  const out: T[] = [];
  const srcIdx: number[] = [];
  items.forEach((item, i) => {
    if (keep(item)) {
      out.push(item);
      srcIdx.push(i);
    }
  });
  return { items: out, srcIdx };
}

/**
 * Selection key of the row at `idx`. `srcIdx` maps table rows back to
 * source positions; null means the rows are the source, unfiltered.
 */
export function rowSelectionKey(
  features: readonly RowFeature[],
  idx: number,
  srcIdx: readonly number[] | null,
): number | string {
  const gid = globalIdOf(features[idx]);
  if (gid !== null) return gid;
  return srcIdx ? (srcIdx[idx] ?? idx) : idx;
}

/** Row index for a selection key, or -1 when no loaded row has it. */
export function rowIndexForKey(
  features: readonly RowFeature[],
  key: number | string,
  srcIdx: readonly number[] | null,
): number {
  if (typeof key === 'number') {
    if (srcIdx) return srcIdx.indexOf(key);
    return key >= 0 && key < features.length ? key : -1;
  }
  for (let i = 0; i < features.length; i += 1) {
    if (globalIdOf(features[i]) === key) return i;
  }
  return -1;
}
