// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the field app's popup Edit gets the record it edits.
 *
 * The tapped feature comes from a map tile, and a tile is not the
 * record: it can be minutes old, it drops fields the layer's tile
 * settings trim, and it never carries `_observation_id`. Editing
 * from it re-sent every stale value with no base id, so the server's
 * conflict check never engaged and a colleague's newer change was
 * silently undone. Edit now reads the record first: from the server
 * when online, from the device copy when not, and only falls back to
 * the tile when neither has it.
 */
import { getCachedFeature } from './offline-store';

export interface FeatureForEdit {
  properties: Record<string, unknown>;
  geometry: GeoJSON.Geometry | null;
  source: 'server' | 'device' | 'tile';
}

export interface LoadFeatureForEditInput {
  dataCollectionId: string;
  dataLayerId: string;
  layerKey: string;
  globalId: string;
  isOnline: boolean;
  /** What the tap handler already has, used when nothing better is found. */
  tile: { properties: Record<string, unknown>; geometry: GeoJSON.Geometry | null };
  fetchImpl?: typeof fetch;
}

export async function loadFeatureForEdit(
  input: LoadFeatureForEditInput,
): Promise<FeatureForEdit> {
  const doFetch = input.fetchImpl ?? fetch;
  if (input.isOnline) {
    try {
      const url =
        `/api/portal/items/${encodeURIComponent(input.dataLayerId)}` +
        `/layers/${encodeURIComponent(input.layerKey)}` +
        `/features?entity=${encodeURIComponent(input.globalId)}`;
      const res = await doFetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as {
          features?: Array<{
            id?: unknown;
            properties?: Record<string, unknown> | null;
            geometry?: GeoJSON.Geometry | null;
          }>;
        };
        const hit = (body.features ?? []).find(
          (f) => String(f.id ?? f.properties?._global_id ?? '') === input.globalId,
        );
        if (hit) {
          return {
            properties: hit.properties ?? {},
            geometry: hit.geometry ?? null,
            source: 'server',
          };
        }
      }
    } catch {
      // Signal dropped between the tap and the read. The device copy
      // below is the next best thing.
    }
  }
  try {
    const cached = await getCachedFeature(
      input.dataCollectionId,
      input.dataLayerId,
      input.layerKey,
      input.globalId,
    );
    if (cached) {
      return {
        properties: (cached.feature.properties as Record<string, unknown> | null) ?? {},
        geometry: cached.feature.geometry ?? null,
        source: 'device',
      };
    }
  } catch {
    // No IndexedDB (private window) or a read error: use the tile.
  }
  return { ...input.tile, source: 'tile' };
}
