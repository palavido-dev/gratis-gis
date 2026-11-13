// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The id a comment pin uses to find its feature again.
 *
 * Pins are resolved by the feature's own id (`id`, then `_global_id`,
 * then `properties.id`). A selection key is not always that: for
 * GeoJSON, inline and ArcGIS REST layers it is the feature's position
 * in the loaded source (MapLibre's generateId). Storing the position
 * put the pin on whichever feature happened to have that number as
 * its id, and on nothing when features carried no id.
 */
type IdFeature = {
  id?: string | number | undefined;
  properties?: Record<string, unknown> | null;
};

/** The feature's own stable id, or null when it has none. */
export function stableFeatureId(f: IdFeature | null | undefined): string | null {
  if (!f) return null;
  const raw = f.id ?? f.properties?.['_global_id'] ?? f.properties?.['id'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * Feature id to anchor a comment on, from a selection key. String
 * keys are already `_global_id`s. Numeric keys are positions and are
 * translated through the loaded features; null when that feature is
 * not loaded or has no id of its own, so no anchor is made that would
 * point at the wrong feature.
 */
export function commentFeatureIdForKey(
  key: string | number,
  features: ReadonlyArray<IdFeature> | null | undefined,
): string | null {
  if (typeof key === 'string') return key;
  if (!features || !Number.isInteger(key) || key < 0) return null;
  return stableFeatureId(features[key]);
}
