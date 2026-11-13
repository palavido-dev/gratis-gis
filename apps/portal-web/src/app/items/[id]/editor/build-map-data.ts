// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *   2. Prepend one MapLayer per Editor target whose underlying v3
 *      sublayer resolved successfully. MapData.layers index 0 is the
 *      TOP of the render stack, so prepending keeps the editable
 *      layers above the reference map's layers; appending them put
 *      the purple targets UNDER any opaque reference overlay, where
 *      they were invisible and unclickable. Targets pointing at
 *      deleted / renamed layers are silently dropped here; the
 *      config page surfaces those with a warning so the author can
 *      fix it.
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
 * Why the Editor uses a per-sublayer geojson-url and not
 * kind: 'data-layer':
 *   The `data-layer` source does carry a `layerKey` for v3 items, so
 *   that is no longer the reason. The Editor's forms, inline table
 *   edits and undo read attributes from the source's own features,
 *   which only a GeoJSON source has (see map-canvas, isEditorTarget).
 *   The canvas fills that source with the rows in view (a bbox read
 *   of up to 5,000 rows per settled move), not the whole layer; the
 *   url below names the sublayer it reads. The metadata probe, the
 *   attribute table and search treat it as that v3 sublayer too
 *   (lib/server-sublayer.ts): schema-only metadata and server-paged
 *   rows, never a whole-layer download. The read-only
 *   Viewer has no such need, so its synthesized layers use the
 *   `data-layer` source and render from vector tiles with a
 *   server-paged table.
 */

/**
 * Find a referenced-map layer that already renders a target's
 * (dataLayerId, layerKey). Matches the `data-layer` source shape,
 * which carries an optional `layerKey` for v3 items, and the
 * per-sublayer `geojson-url` shape an earlier pass of this function
 * baked into saved maps.
 */
function findExistingTargetLayer(
  layers: MapLayer[] | undefined,
  dataLayerId: string,
  layerKey: string,
): MapLayer | null {
  if (!layers) return null;
  const sublayerUrl = `/api/portal/items/${dataLayerId}/layers/${layerKey}/geojson`;
  for (const l of layers) {
    const src = l.source;
    if (
      src.kind === 'data-layer' &&
      src.itemId === dataLayerId &&
      src.layerKey === layerKey
    ) {
      return l;
    }
    if (src.kind === 'geojson-url' && src.url === sublayerUrl) return l;
  }
  return null;
}

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

/** Id prefix of a read-only runtime's synthesized target layer. */
export const VIEWER_TARGET_LAYER_PREFIX = 'viewer-target:';

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
  /**
   * Read-only runtimes (the Viewer) reuse a referenced-map layer that
   * already renders a target instead of stacking a second styled copy
   * on top of it.
   *
   * The purple target style exists to mark layers as EDITABLE. In a
   * viewer nothing is editable, so a duplicate is not just redundant,
   * it silently replaces whatever the author designed. On the public
   * "Elkins in 3D" map the referenced layer is a fill-extrusion of
   * building heights and the synthesized twin is a flat 30%-opacity
   * purple fill sitting directly above it, which is what "the 3D
   * buildings are not rendering" turned out to partly mean.
   *
   * The Editor keeps the old behaviour deliberately. Its runtime
   * allowlists inline-editable layers by reconstructing the synthetic
   * id, and reference-map layers are excluded from writes on purpose
   * ("the UX gate matches the server policy"). Reusing a reference
   * layer as an editable target there would move that boundary, which
   * is a separate decision from fixing the viewer.
   */
  reuseReferencedLayers?: boolean;
}): BuiltEditorMapData {
  const { referencedMap, resolvedTargets, reuseReferencedLayers } = args;

  // The referenced map's MapData is the starting composition. Spread
  // shallow so we don't mutate the caller's reference; we only swap
  // out `layers`.
  const base: MapData = referencedMap?.data
    ? { ...referencedMap.data }
    : { ...DEFAULT_MAP };

  const newLayers: MapLayer[] = [];
  const targetLayerIds: string[] = [];
  // Reference-map layers that draw an Editor target. The Editor draws
  // its own copy of each target and refreshes only that copy after an
  // edit, so the reference copy underneath kept showing moved and
  // deleted features from its cached tiles. It is hidden, not
  // removed, so the user can still turn it on in the layer list.
  const hiddenReferenceIds = new Set<string>();

  for (const t of resolvedTargets) {
    if (!t.layer) continue;
    // Skip attribute-only related tables (geometryType === null).
    // The v3 /geojson endpoint always selects ST_AsGeoJSON(geom),
    // which crashes with 500 on related tables that have no geom
    // column. Related tables are still valid Editor targets at
    // the config level (the runtime surfaces them so users can
    // add child records via the parent feature's related-records
    // panel, slice 3b-6) but they have no map-rendering surface.
    if (t.layer.geometryType === null) continue;
    const existing = findExistingTargetLayer(
      base.layers,
      t.dataLayerId,
      t.layerKey,
    );
    if (reuseReferencedLayers) {
      if (existing) {
        // The map already draws this layer, with the author's own
        // styling. Point the target at it and synthesize nothing.
        targetLayerIds.push(existing.id);
        continue;
      }
    } else if (existing) {
      hiddenReferenceIds.add(existing.id);
    }
    // Read-only runtimes take the tiled data-layer source under an id
    // without the editor-target prefix, which is what keeps a layer
    // off the tile path. Downloading a whole large layer as one
    // GeoJSON for a viewer was slow, and failed outright where
    // unpaged reads are turned off.
    const id = reuseReferencedLayers
      ? `${VIEWER_TARGET_LAYER_PREFIX}${t.dataLayerId}:${t.layerKey}`
      : editorTargetLayerId(t.dataLayerId, t.layerKey);
    targetLayerIds.push(id);
    const url = `/api/portal/items/${t.dataLayerId}/layers/${t.layerKey}/geojson`;
    newLayers.push({
      id,
      title: `${t.dataLayerTitle} / ${t.layer.label}`,
      visible: true,
      opacity: 1,
      source: reuseReferencedLayers
        ? { kind: 'data-layer', itemId: t.dataLayerId, layerKey: t.layerKey }
        : { kind: 'geojson-url', url },
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
      // Targets first: index 0 renders on top, and the editable
      // layers must sit above the reference map's layers.
      layers: [
        ...newLayers,
        ...(base.layers ?? []).map((l) =>
          hiddenReferenceIds.has(l.id) ? { ...l, visible: false } : l,
        ),
      ],
    },
    targetLayerIds,
  };
}
