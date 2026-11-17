// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The extent a data layer's overview map opens on.
 *
 * Each v3 layer can carry its own bbox, and the preview unions them.
 * Layers seeded or imported before per-layer extents existed have none,
 * while the item itself still has one (`item.bbox`, kept by the
 * extent refresh). Without a fallback the preview opened on the whole
 * world with the data a dot in the middle, which is what every sample
 * layer on the demo did.
 */

export type Bbox = [number, number, number, number];

/** A usable [west, south, east, north] in degrees, or null. */
export function cleanBbox(value: unknown): Bbox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [w, s, e, n] = value as unknown[];
  if (![w, s, e, n].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const b = [w, s, e, n] as Bbox;
  if (b[0] > b[2] || b[1] > b[3]) return null;
  if (b[1] < -90 || b[3] > 90 || b[0] < -180 || b[2] > 180) return null;
  return b;
}

/** Union of the layers' own extents, else the item's extent, else null. */
export function previewExtent(
  layerBboxes: ReadonlyArray<unknown>,
  itemBbox?: unknown,
): Bbox | null {
  let out: Bbox | null = null;
  for (const raw of layerBboxes) {
    const b = cleanBbox(raw);
    if (!b) continue;
    out = out
      ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])]
      : b;
  }
  return out ?? cleanBbox(itemBbox);
}
