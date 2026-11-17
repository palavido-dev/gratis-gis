// SPDX-License-Identifier: AGPL-3.0-or-later

/** One sublayer of a v3 data layer, as the Add Layer picker needs it. */
export interface DataLayerSublayer {
  id: string;
  label: string;
  geometryType: string | null;
}

/**
 * The sublayers of a data layer row. The lite items list attaches them
 * as `_layers`; other endpoints (folder contents) return the plain row
 * with its `data`. Reading only `_layers` added a v3 layer from the
 * Folders view with no sublayer key, so the map pointed it at the
 * legacy item-level endpoint and it drew nothing. Falls back to
 * `data.layers` of a version 3 blob, and returns [] for anything else
 * (v1/v2 single-table layers).
 */
export function dataLayerSublayers(item: {
  _layers?: DataLayerSublayer[];
  data?: unknown;
}): DataLayerSublayer[] {
  if (Array.isArray(item._layers) && item._layers.length > 0) {
    return item._layers;
  }
  const d = item.data as { version?: unknown; layers?: unknown } | null | undefined;
  if (!d || d.version !== 3 || !Array.isArray(d.layers)) return [];
  const out: DataLayerSublayer[] = [];
  for (const raw of d.layers) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as { id?: unknown; label?: unknown; geometryType?: unknown };
    if (typeof l.id !== 'string' || l.id.length === 0) continue;
    out.push({
      id: l.id,
      label: typeof l.label === 'string' && l.label.length > 0 ? l.label : l.id,
      geometryType: typeof l.geometryType === 'string' ? l.geometryType : null,
    });
  }
  return out;
}
