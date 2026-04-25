import type { ItemType } from '@prisma/client';

/**
 * Compute the cached extent for an item from its data_json content.
 * Returns a 4-tuple [west, south, east, north] in EPSG:4326 when
 * the item carries a spatial footprint, or `null` when it does not
 * (empty data_layer, item type without geometry, etc.). The result
 * is persisted in `item.bbox` and drives the geographic-search
 * filter (#24).
 *
 * Per-type sources:
 *   - data_layer        item.data.bbox (set by the ingest path on every replace)
 *   - map               aggregate over the bboxes the map's layers carry inline
 *   - arcgis_service    item.data.bbox (probed at create time)
 *   - geo_boundary      item.data.bbox (recomputed when the geometry changes)
 *   - everything else   no spatial footprint
 *
 * Deliberately kept outside ItemsService so other call sites (the
 * ingest path, the v3 reconcile path) can call into it without
 * pulling Nest dependencies. Pure function, easy to unit test if
 * we add a test harness for items.
 */
export function itemBbox(
  type: ItemType,
  data: unknown,
): [number, number, number, number] | null {
  if (!data || typeof data !== 'object') return null;
  switch (type) {
    case 'data_layer':
      return readBboxField(data) ?? aggregateLayerBboxes(data);
    case 'arcgis_service':
    case 'wms_service':
    case 'wfs_service':
    case 'geo_boundary':
      return readBboxField(data);
    case 'map':
      return aggregateLayerBboxes(data);
    default:
      return null;
  }
}

function readBboxField(data: unknown): [number, number, number, number] | null {
  if (!data || typeof data !== 'object') return null;
  const b = (data as { bbox?: unknown }).bbox;
  if (Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n))) {
    return [b[0] as number, b[1] as number, b[2] as number, b[3] as number];
  }
  return null;
}

function aggregateLayerBboxes(
  data: unknown,
): [number, number, number, number] | null {
  if (!data || typeof data !== 'object') return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  let any = false;
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const layerBbox = (l as { bbox?: unknown }).bbox;
    if (
      Array.isArray(layerBbox) &&
      layerBbox.length === 4 &&
      layerBbox.every((v) => Number.isFinite(v))
    ) {
      w = Math.min(w, layerBbox[0] as number);
      s = Math.min(s, layerBbox[1] as number);
      e = Math.max(e, layerBbox[2] as number);
      n = Math.max(n, layerBbox[3] as number);
      any = true;
    }
  }
  if (!any) return null;
  return [w, s, e, n];
}
