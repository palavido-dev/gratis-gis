// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in a `web_app` Item's data when
 * `template = 'viewer'`. The Read-Only Viewer is the AGOL Map Viewer
 * stand-in: a focused app for zooming, panning, querying, toggling
 * layers, reading the legend, browsing attributes, and printing.
 *
 * Authorization is read-only by definition: this template never
 * exposes editing tools. Visibility still flows through the same
 * share + geo-limit pipeline as any other item.
 *
 * Versioned for forward-compat; the runtime should tolerate missing
 * optional fields and fall back to defaults so older Viewer items
 * keep rendering after additive shape changes.
 *
 * See docs/web-app-templates.md (and #259) for the broader template
 * registry and how new templates plug into WebAppData.
 */

export interface ViewerData {
  version: 1;
  /**
   * Optional reference to a `map` item. When set, the viewer's
   * canvas inherits that map's basemap, viewport, layer order, and
   * symbology. When unset, the viewer renders a minimal default
   * basemap and fits the camera to the union of its target layers'
   * extents (mirrors the editor's empty-map fallback).
   */
  mapId?: string;
  /**
   * Layers exposed in this viewer. Each entry references a layer
   * inside a data_layer item (by `dataLayerId` + `layerKey`). The
   * runtime uses this list to populate the layer panel + legend +
   * attribute table; the underlying layer's symbology is honored
   * directly (the viewer never overrides it).
   */
  targets: ViewerTarget[];
  /**
   * Tools available in the viewer toolbar. Always read-only; this
   * list narrows the visible affordances rather than granting any
   * write capability.
   */
  tools: ViewerTool[];
}

/**
 * One layer in the viewer. Mirrors EditorTarget's identity fields
 * but carries no editing flags or templates: every viewer target is
 * read-only.
 */
export interface ViewerTarget {
  /** Item id of the data_layer this target lives in. */
  dataLayerId: string;
  /**
   * Key identifying which layer inside the data_layer this target
   * refers to. Matches the v3 layer key in the data_layer's
   * `data.layers[].key`.
   */
  layerKey: string;
}

/**
 * Tools available in the viewer's toolbar. The runtime only renders
 * tools listed in the active `tools` array. Adding a tool here costs
 * nothing if the runtime ignores unknown values, but every option
 * introduces UI surface so we keep the list narrow and read-only.
 */
export type ViewerTool =
  | 'select'
  | 'query'
  | 'measure'
  | 'attribute-table'
  | 'legend'
  | 'print';

/**
 * Recursively Object.freeze a default so no consumer can corrupt
 * shared module state. The DEFAULT_* constants below get spread
 * into fresh objects at every use site, but a spread is shallow:
 * nested arrays / objects still alias the module-level constant,
 * and one accidental in-place mutation would silently change the
 * defaults for every later caller in the same process. Freezing
 * turns that bug into a loud TypeError at the mutation site.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_VIEWER_TOOLS: ViewerTool[] = deepFreeze([
  'select',
  'query',
  'measure',
  'attribute-table',
  'legend',
  'print',
]);

/**
 * Freshly-created Viewer with the defaults we want every new viewer
 * to carry. No targets and no map reference: the user picks those
 * on the detail page after create. The runtime renders an empty-state
 * prompt until the first target is added (mirrors the editor).
 */
export const DEFAULT_VIEWER: ViewerData = deepFreeze({
  version: 1,
  targets: [],
  tools: DEFAULT_VIEWER_TOOLS,
});
