import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_MAP,
} from '@gratis-gis/shared-types';
import type {
  DataLayerSublayer,
  EditorData,
  Item,
  MapData,
  MapLayer,
  MapLayerStyle,
} from '@gratis-gis/shared-types';

/**
 * Synthesize a MapData for the Editor runtime canvas.
 *
 * Composition rules (slice 3b-1, read-only):
 *
 *   1. Start from the referenced map's MapData. If the Editor has no
 *      mapId, start from DEFAULT_MAP (default basemap, world view, no
 *      reference layers).
 *   2. Append one MapLayer per Editor target whose underlying v3
 *      sublayer resolved successfully. Targets pointing at deleted /
 *      renamed layers are silently dropped here; the config page
 *      surfaces those with a warning so the author can fix it.
 *   3. Target layers use a distinct purple-accent style so authors
 *      can tell editable layers apart from reference layers in the
 *      canvas at a glance.
 *
 * Why we synthesize on the server:
 *   - The server already has to resolve target metadata (layer
 *     labels, geometry types, fields) for the layer panel anyway.
 *     Building the MapData in the same pass avoids a second walk on
 *     the client.
 *   - The client component stays a "render this MapData" component,
 *     no I/O on first paint.
 *
 * Why per-sublayer geojson-url instead of kind: 'data-layer':
 *   The MapLayerSource shape `kind: 'data-layer'; itemId` predates v3
 *   multi-layer items and does not carry a layerKey. The
 *   `/items/:id/geojson` endpoint only handles v1/v2 storage; v3
 *   data is exposed via `/items/:id/layers/:layerKey/geojson`. We
 *   bypass the data-layer source here and use a direct geojson-url
 *   pointing at the per-sublayer endpoint, which is what we want
 *   anyway since each Editor target is layer-key specific.
 */

export interface BuiltEditorMapData {
  /** Composed MapData ready to hand to MapCanvas. */
  mapData: MapData;
  /** Synthetic ids of the target layers, in target-list order. Used
   *  by the runtime to drive the editing layer panel and (in slice
   *  3b-2) to scope drawing tools to a chosen target. */
  targetLayerIds: string[];
}

export interface ResolvedTarget {
  dataLayerId: string;
  layerKey: string;
  /** Null when the underlying layer could not be resolved. Targets
   *  with null resolution are silently dropped from rendering. */
  layer: DataLayerSublayer | null;
  /** Title of the parent data_layer item, used in layer panel
   *  labels: "Parcels / 2026 update". */
  dataLayerTitle: string;
}

const EDITOR_TARGET_STYLE: MapLayerStyle = {
  point: {
    color: '#9333ea',
    radius: 7,
    strokeColor: '#ffffff',
    strokeWidth: 2,
    symbol: 'circle',
    iconName: '',
    iconSize: 1,
    iconTint: true,
  },
  line: {
    color: '#9333ea',
    width: 2.5,
  },
  polygon: {
    fillColor: '#9333ea',
    fillOpacity: 0.3,
    strokeColor: '#7e22ce',
    strokeWidth: 2,
  },
};

/** Stable id prefix for synthesized target layers. The runtime
 *  uses this to recognize "is this layer one I added for editing,
 *  or did it come from the referenced map?" */
export const EDITOR_TARGET_LAYER_PREFIX = 'editor-target:';

export function editorTargetLayerId(
  dataLayerId: string,
  layerKey: string,
): string {
  return `${EDITOR_TARGET_LAYER_PREFIX}${dataLayerId}:${layerKey}`;
}

export function buildEditorMapData(args: {
  editor: EditorData;
  referencedMap: Item<MapData> | null;
  resolvedTargets: ResolvedTarget[];
}): BuiltEditorMapData {
  const { referencedMap, resolvedTargets } = args;

  // The referenced map's MapData is the starting composition. Spread
  // shallow so we don't mutate the caller's reference; we only swap
  // out `layers`.
  const base: MapData = referencedMap?.data
    ? { ...referencedMap.data }
    : { ...DEFAULT_MAP };

  const newLayers: MapLayer[] = [];
  const targetLayerIds: string[] = [];

  for (const t of resolvedTargets) {
    if (!t.layer) continue;
    const id = editorTargetLayerId(t.dataLayerId, t.layerKey);
    targetLayerIds.push(id);
    const url = `/api/portal/items/${t.dataLayerId}/layers/${t.layerKey}/geojson`;
    newLayers.push({
      id,
      title: `${t.dataLayerTitle} / ${t.layer.label}`,
      visible: true,
      opacity: 1,
      source: { kind: 'geojson-url', url },
      style: EDITOR_TARGET_STYLE,
      renderer: DEFAULT_LAYER_RENDERER,
      popup: DEFAULT_LAYER_POPUP,
      interactions: DEFAULT_LAYER_INTERACTIONS,
      labels: DEFAULT_LAYER_LABELS,
      search: DEFAULT_LAYER_SEARCH,
      filter: null,
      scale: DEFAULT_LAYER_SCALE,
      access: DEFAULT_LAYER_ACCESS,
    });
  }

  return {
    mapData: {
      ...base,
      layers: [...(base.layers ?? []), ...newLayers],
    },
    targetLayerIds,
  };
}
