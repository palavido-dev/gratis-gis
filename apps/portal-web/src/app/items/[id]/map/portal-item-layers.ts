// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Shared "portal item -> MapLayer(s)" construction logic (#185/#187).
 *
 * The Add Layer dialog historically owned all of this inline. The
 * "Add to map" button on item pages and the scratch-map ?add= flow
 * need the same construction WITHOUT the dialog's interactive
 * sublayer-choice step, so the builders live here and both callers
 * consume them:
 *
 *   - The dialog keeps its interactive flow (sublayer subset,
 *     group-vs-flat) and calls the build* functions at commit time.
 *   - layersForPortalItem() is the non-interactive composition used
 *     by auto-add: every sublayer, group mode, stamped metadata.
 *
 * Everything here is pure or fetch-only; no React state. Errors
 * come back as plain-language strings for the caller to surface.
 */
import type { Item, MapLayer, MapLayerSource } from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_RENDERER,
} from '@gratis-gis/shared-types';

export function makeLayer(title: string, source: MapLayerSource): MapLayer {
  return {
    id: crypto.randomUUID(),
    title,
    visible: true,
    opacity: 1,
    source,
    style: structuredClone(DEFAULT_LAYER_STYLE),
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup: structuredClone(DEFAULT_LAYER_POPUP),
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
}

/** Lite-mode list rows attach `_layers` for v3 data layers. */
export type PortalItemWithSublayers = Item & {
  _layers?: Array<{ id: string; label: string; geometryType: string | null }>;
};

/**
 * Fetch full item data when the caller only has a lite row.
 * Returns the item unchanged when data is already present.
 */
export async function fetchHydratedItem(
  item: Item,
): Promise<{ item?: Item; error?: string }> {
  if (item.data && Object.keys(item.data as object).length > 0) {
    return { item };
  }
  try {
    const res = await fetch(`/api/portal/items/${item.id}`);
    if (!res.ok) {
      return { error: `Could not load ${item.title} (HTTP ${res.status}).` };
    }
    return { item: (await res.json()) as Item };
  } catch (err) {
    return {
      error:
        err instanceof Error ? err.message : `Could not load ${item.title}.`,
    };
  }
}

/**
 * Curated, ordered sublayer list from an arcgis_service item's data
 * blob: default layer first, then the rest of the curated set.
 */
export function arcgisSublayers(item: Item):
  | {
      ordered: Array<{ id: number; name?: string; geometryType?: string }>;
      error?: undefined;
    }
  | { ordered?: undefined; error: string } {
  const d = (item.data ?? {}) as {
    url?: string;
    defaultLayerId?: number;
    selectedLayerIds?: Array<string | number>;
    layers?: Array<{ id: number; name?: string; geometryType?: string }>;
  };
  if (!d.url) {
    return {
      error: `${item.title} has no service URL yet. Open it and paste one.`,
    };
  }
  const allLayers = d.layers ?? [];
  const curated = d.selectedLayerIds
    ? allLayers.filter((l) =>
        d.selectedLayerIds!.map(String).includes(String(l.id)),
      )
    : allLayers;
  if (curated.length === 0) {
    return {
      error: `${item.title} has no layers selected for web-map use. Open the item and pick at least one layer.`,
    };
  }
  return {
    ordered: [
      ...curated.filter((l) => l.id === d.defaultLayerId),
      ...curated.filter((l) => l.id !== d.defaultLayerId),
    ],
  };
}

/**
 * Layers for an arcgis_service item given the caller's chosen mode
 * and sublayer subset. Pure: returns the layers (group header first
 * in group mode); empty array when nothing selected.
 */
export function buildArcgisLayers(
  item: Item,
  ordered: Array<{ id: number; name?: string; geometryType?: string }>,
  mode: 'group' | 'flat',
  selectedIds: Set<number>,
): MapLayer[] {
  const d = (item.data ?? {}) as {
    url?: string;
    serviceType?: 'MapServer' | 'FeatureServer';
    layerConfig?: Record<string, { label?: string; visible?: boolean }>;
  };
  // Every arcgis-rest layer goes through the portal-api proxy, not
  // just secured ones (#96): usage tracking, CORS coverage, and one
  // consistent path.
  const proxyUrl = `/api/portal/items/${item.id}/proxy`;
  const picked = ordered.filter((l) => selectedIds.has(l.id));
  if (picked.length === 0) return [];
  const out: MapLayer[] = [];
  let groupId: string | undefined;
  if (mode === 'group' && picked.length > 1) {
    const header = makeLayer(item.title, { kind: 'group' });
    groupId = header.id;
    out.push(header);
  }
  for (const l of picked) {
    const override = d.layerConfig?.[String(l.id)];
    const subName = l.name ?? `Layer ${l.id}`;
    const title =
      override?.label ?? (picked.length === 1 ? item.title : subName);
    const layer = makeLayer(title, {
      kind: 'arcgis-rest',
      url: d.url!,
      layerId: l.id,
      serviceType: d.serviceType ?? 'MapServer',
      sourceItemId: item.id,
      proxyUrl,
    });
    if (groupId) layer.groupId = groupId;
    out.push(layer);
  }
  return out;
}

/**
 * Layers for a v3 data_layer given mode + sublayer subset (#189
 * counterpart of buildArcgisLayers). Empty array when nothing
 * selected.
 */
export function buildDataLayerLayers(
  item: PortalItemWithSublayers,
  mode: 'group' | 'flat',
  selectedIds: Set<string>,
): MapLayer[] {
  const all = item._layers ?? [];
  const picked = all.filter((l) => selectedIds.has(l.id));
  if (picked.length === 0) return [];
  const out: MapLayer[] = [];
  let groupId: string | undefined;
  if (mode === 'group' && picked.length > 1) {
    const header = makeLayer(item.title, { kind: 'group' });
    groupId = header.id;
    out.push(header);
  }
  for (const sub of picked) {
    const title = picked.length === 1 ? item.title : sub.label || sub.id;
    const layer = makeLayer(title, {
      kind: 'data-layer',
      itemId: item.id,
      layerKey: sub.id,
    });
    if (groupId) layer.groupId = groupId;
    out.push(layer);
  }
  return out;
}

/** Point cloud item -> 3D layer with stamped streaming metadata. */
export function buildPointCloudLayer(
  item: Item,
): { layer: MapLayer; error?: undefined } | { layer?: undefined; error: string } {
  const data = item.data as {
    dataUrl?: string;
    bboxWgs84?: [number, number, number, number];
    pointCount?: number;
    hasRgb?: boolean;
    preferredElevationItemId?: string;
  } | null;
  if (!data?.dataUrl) {
    return {
      error: `${item.title} has no uploaded point cloud file yet. Upload a COPC file on the item page first.`,
    };
  }
  return {
    layer: makeLayer(item.title, {
      kind: 'point-cloud',
      itemId: item.id,
      dataUrl: data.dataUrl,
      ...(data.bboxWgs84 ? { bboxWgs84: data.bboxWgs84 } : {}),
      ...(typeof data.preferredElevationItemId === 'string'
        ? { preferredElevationItemId: data.preferredElevationItemId }
        : {}),
      ...(typeof data.pointCount === 'number'
        ? { pointCount: data.pointCount }
        : {}),
      ...(typeof data.hasRgb === 'boolean' ? { hasRgb: data.hasRgb } : {}),
      colorScheme: data.hasRgb ? 'rgb' : 'elevation',
      pointSize: 2,
    }),
  };
}

/** Tile layer item -> raster overlay with a format-pinned URL. */
export function buildTileLayer(
  item: Item,
): { layer: MapLayer; error?: undefined } | { layer?: undefined; error: string } {
  const data = item.data as {
    tileUrl?: string;
    kind?: string;
    dem?: boolean;
    bbox?: [number, number, number, number];
    attribution?: string;
    preferredElevationItemId?: string;
  } | null;
  if (!data?.tileUrl) {
    return {
      error: `${item.title} has no uploaded file yet. Upload an image or tile file on the item page first.`,
    };
  }
  if (data.kind === 'vector') {
    return {
      error: `${item.title} is a street-map style tile package. It can be used as a basemap (see the item page) but can't be added as a layer yet.`,
    };
  }
  if (data.dem) {
    return {
      error: `${item.title} is an elevation layer. To use it, add it in the "3D terrain" section at the bottom of a map's layers panel.`,
    };
  }
  // Pin the format with a suffixed URL: the bare /file endpoint
  // flips from the source image to the tile pyramid when the
  // background build finishes, which would change the bytes
  // underneath a stamped URL.
  const pinnedUrl = data.tileUrl.replace(
    /\/file$/,
    data.tileUrl.startsWith('pmtiles://') ? '/file.pmtiles' : '/file.cog',
  );
  return {
    layer: makeLayer(item.title, {
      kind: 'tile',
      itemId: item.id,
      tileUrl: pinnedUrl,
      ...(data.bbox ? { bboxWgs84: data.bbox } : {}),
      ...(typeof data.preferredElevationItemId === 'string'
        ? { preferredElevationItemId: data.preferredElevationItemId }
        : {}),
      ...(data.attribution ? { attribution: data.attribution } : {}),
    }),
  };
}

/**
 * Non-interactive composition for auto-add flows ("Add to map"
 * buttons, scratch-map ?add=). Uses the defaults a user would get
 * by accepting the dialog's suggestions: every curated sublayer,
 * group mode. Connected Service items (WMS/WFS/WMTS) are declined
 * with a pointer at the dialog, which knows how to explain their
 * rendering status.
 */
export async function layersForPortalItem(
  input: Item,
): Promise<{ layers?: MapLayer[]; error?: string }> {
  if (
    input.type === 'service' ||
    input.type === 'wms_service' ||
    input.type === 'wfs_service'
  ) {
    return {
      error:
        'Connected services are added from inside a map: open the map, choose Add layer, and pick it from the Portal tab.',
    };
  }
  if (input.type === 'point_cloud') {
    const { item, error } = await fetchHydratedItem(input);
    if (!item) return { error: error ?? `Could not load ${input.title}.` };
    const built = buildPointCloudLayer(item);
    return built.layer ? { layers: [built.layer] } : { error: built.error };
  }
  if (input.type === 'tile_layer') {
    const { item, error } = await fetchHydratedItem(input);
    if (!item) return { error: error ?? `Could not load ${input.title}.` };
    const built = buildTileLayer(item);
    return built.layer ? { layers: [built.layer] } : { error: built.error };
  }
  if (input.type === 'arcgis_service') {
    const { item, error } = await fetchHydratedItem(input);
    if (!item) return { error: error ?? `Could not load ${input.title}.` };
    const subs = arcgisSublayers(item);
    if (!subs.ordered) return { error: subs.error };
    const layers = buildArcgisLayers(
      item,
      subs.ordered,
      'group',
      new Set(subs.ordered.map((l) => l.id)),
    );
    return { layers };
  }
  // data_layer / derived_layer. The lite list attaches `_layers` for
  // v3 items; a bare item (from a detail page or an id-only ?add=)
  // carries the same information in its own data blob
  // (DataLayerDataV3.layers), so hydrate and read it from there.
  // Every rendered sublayer MUST carry a layerKey: the MVT tile
  // endpoint only exists per sublayer, so a v3 layer without one
  // silently draws nothing (the original auto-add bug).
  const lite = input as PortalItemWithSublayers;
  if (input.type === 'data_layer') {
    let sublayers = lite._layers;
    if (!sublayers) {
      const { item, error } = await fetchHydratedItem(input);
      if (!item) return { error: error ?? `Could not load ${input.title}.` };
      const d = item.data as {
        version?: number;
        layers?: Array<{
          id: string;
          label?: string;
          geometryType?: string | null;
        }>;
      } | null;
      if (d?.version === 3 && Array.isArray(d.layers)) {
        sublayers = d.layers.map((r) => ({
          id: r.id,
          label: r.label ?? r.id,
          geometryType: r.geometryType ?? null,
        }));
      }
    }
    if (sublayers && sublayers.length > 0) {
      const layers = buildDataLayerLayers(
        { ...lite, _layers: sublayers },
        'group',
        new Set(sublayers.map((s) => s.id)),
      );
      if (layers.length > 0) return { layers };
    }
  }
  // v1/v2 single-table data_layer and derived_layer: single layer
  // against the item-level geojson endpoint.
  return {
    layers: [makeLayer(input.title, { kind: 'data-layer', itemId: input.id })],
  };
}
