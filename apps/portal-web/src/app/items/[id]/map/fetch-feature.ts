// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Full geometry and attributes for one data_layer feature, from the
 * server, never from the rendered tile.
 *
 * Both geometry editors (the map builder's feature tools and the
 * editor runtime) start a vertex-editing session from a map click, and
 * the natural source for the starting geometry is the feature
 * `queryRenderedFeatures` hands back. That geometry is clipped to the
 * tile the click landed in: MapLibre cuts MVT sources at tile edges and
 * tiles GeoJSON sources internally too, so a polygon spanning a tile
 * boundary comes back as the fragment under the cursor. Saving that
 * fragment overwrites the feature with a truncated shape and looks like
 * a successful edit. `/features?entity=` returns the whole thing.
 */
import { parseApiError } from '@/lib/api-error';

export interface FetchedFeature {
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
}

/**
 * Resolves to null when the server knows no such feature (or it has no
 * geometry); throws with a displayable message on a failed request.
 *
 * `failureMessage` is the sentence shown when the server sends no
 * message of its own. It is a parameter because this module has no
 * locale: the caller translates it (`featureEdit.loadFailed`). The
 * default covers the editor runtime, which is not wired to i18n yet.
 */
export async function fetchFeatureFromServer(
  itemId: string,
  layerKey: string,
  featureId: string,
  failureMessage = 'Could not load the feature',
): Promise<FetchedFeature | null> {
  const res = await fetch(
    `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerKey)}/features?entity=${encodeURIComponent(featureId)}`,
  );
  if (!res.ok) {
    throw new Error(await parseApiError(res, failureMessage));
  }
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  const f = fc.features?.[0];
  if (!f || !f.geometry) return null;
  return {
    geometry: f.geometry,
    properties: (f.properties ?? {}) as Record<string, unknown>,
  };
}
