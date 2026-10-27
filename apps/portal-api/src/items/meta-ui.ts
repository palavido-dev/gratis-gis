// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ItemMeta,
  MetaUi,
  MetaUiDownload,
  MetaUiLayer,
} from '@gratis-gis/shared-types';

/**
 * Build the server-computed `meta.ui` presentation block for an
 * item detail response. Pure: no Nest, no Prisma. Relative portal
 * paths only; clients that need absolute URLs (QGIS, MCP) prefix
 * with their configured portal origin.
 *
 * See docs/meta-ui.md.
 */

type MetaUiItemInput = {
  id: string;
  type: string;
  title: string;
  data: unknown;
  bbox?: unknown;
  thumbnailUrl?: string | null;
  /** When `public`, also advertise the anonymous OGC Features URL. */
  access?: string | null;
  /** Optional lite-list sublayers already attached by list endpoints. */
  _layers?: Array<{ id: string; label: string; geometryType: string | null }>;
};

export function buildMetaUi(item: MetaUiItemInput): MetaUi {
  const layers = layersFor(item);
  const downloads = downloadsFor(item);
  return {
    version: 1,
    layers,
    downloads,
    thumbnailUrl: item.thumbnailUrl ?? null,
    landingPath: `/items/${item.id}`,
  };
}

/** Stamp `meta.ui` onto an item row after thumbnail synthesis. */
export function withMetaUi<T extends MetaUiItemInput>(
  row: T,
): T & { meta: ItemMeta } {
  return {
    ...row,
    meta: { ui: buildMetaUi(row) },
  };
}

function layersFor(item: MetaUiItemInput): MetaUiLayer[] {
  switch (item.type) {
    case 'data_layer':
    case 'derived_layer':
      return dataLayerLayers(item);
    case 'tile_layer':
      return tileLayers(item);
    case 'point_cloud':
      return pointCloudLayers(item);
    case 'arcgis_service':
      return arcgisLayers(item);
    default:
      // map / web_app / form / etc. open via landingPath, not as layers.
      return [];
  }
}

function dataLayerLayers(item: MetaUiItemInput): MetaUiLayer[] {
  const subs = resolveDataSublayers(item);
  if (subs && subs.length > 0) {
    return subs
      .filter((s) => s.geometryType)
      .map((s) => ({
        title: subs.length === 1 ? item.title : s.label || s.id,
        source: {
          kind: 'data-layer' as const,
          itemId: item.id,
          layerKey: s.id,
        },
        geometryType: s.geometryType,
      }));
  }
  // v1/v2 single-table or derived_layer without explicit sublayers.
  return [
    {
      title: item.title,
      source: { kind: 'data-layer', itemId: item.id },
      geometryType: null,
    },
  ];
}

function resolveDataSublayers(item: MetaUiItemInput):
  | Array<{ id: string; label: string; geometryType: string | null }>
  | null {
  if (item._layers && item._layers.length > 0) return item._layers;
  const d = item.data as {
    version?: number;
    layers?: Array<{
      id: string;
      label?: string;
      geometryType?: string | null;
    }>;
  } | null;
  if (d?.version === 3 && Array.isArray(d.layers) && d.layers.length > 0) {
    return d.layers.map((r) => ({
      id: r.id,
      label: r.label ?? r.id,
      geometryType: r.geometryType ?? null,
    }));
  }
  return null;
}

function tileLayers(item: MetaUiItemInput): MetaUiLayer[] {
  const data = item.data as {
    tileUrl?: string;
    kind?: string;
    dem?: boolean;
    bbox?: [number, number, number, number];
    attribution?: string;
    preferredElevationItemId?: string;
  } | null;
  if (!data?.tileUrl) return [];
  if (data.kind === 'vector' || data.dem) return [];
  const pinnedUrl = data.tileUrl.replace(
    /\/file$/,
    data.tileUrl.startsWith('pmtiles://') ? '/file.pmtiles' : '/file.cog',
  );
  return [
    {
      title: item.title,
      source: {
        kind: 'tile',
        itemId: item.id,
        tileUrl: pinnedUrl,
        ...(data.bbox ? { bboxWgs84: data.bbox } : {}),
        ...(typeof data.preferredElevationItemId === 'string'
          ? { preferredElevationItemId: data.preferredElevationItemId }
          : {}),
        ...(data.attribution ? { attribution: data.attribution } : {}),
      },
    },
  ];
}

function pointCloudLayers(item: MetaUiItemInput): MetaUiLayer[] {
  const data = item.data as {
    dataUrl?: string;
    bboxWgs84?: [number, number, number, number];
    pointCount?: number;
    hasRgb?: boolean;
    preferredElevationItemId?: string;
  } | null;
  if (!data?.dataUrl) return [];
  return [
    {
      title: item.title,
      source: {
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
      },
    },
  ];
}

function arcgisLayers(item: MetaUiItemInput): MetaUiLayer[] {
  const d = (item.data ?? {}) as {
    url?: string;
    defaultLayerId?: number;
    selectedLayerIds?: Array<string | number>;
    serviceType?: 'MapServer' | 'FeatureServer';
    layers?: Array<{ id: number; name?: string; geometryType?: string }>;
    layerConfig?: Record<string, { label?: string }>;
  };
  if (!d.url) return [];
  const allLayers = d.layers ?? [];
  const curated = d.selectedLayerIds
    ? allLayers.filter((l) =>
        d.selectedLayerIds!.map(String).includes(String(l.id)),
      )
    : allLayers;
  if (curated.length === 0) return [];
  const ordered = [
    ...curated.filter((l) => l.id === d.defaultLayerId),
    ...curated.filter((l) => l.id !== d.defaultLayerId),
  ];
  const proxyUrl = `/api/portal/items/${item.id}/proxy`;
  return ordered.map((l) => {
    const override = d.layerConfig?.[String(l.id)];
    const subName = l.name ?? `Layer ${l.id}`;
    const title =
      override?.label ?? (ordered.length === 1 ? item.title : subName);
    return {
      title,
      source: {
        kind: 'arcgis-rest' as const,
        url: d.url!,
        layerId: l.id,
        serviceType: d.serviceType ?? 'MapServer',
        sourceItemId: item.id,
        proxyUrl,
      },
      geometryType: l.geometryType ?? null,
    };
  });
}

function downloadsFor(item: MetaUiItemInput): MetaUiDownload[] {
  const out: MetaUiDownload[] = [];
  if (item.type === 'data_layer' || item.type === 'derived_layer') {
    // Auth-gated path first so private items never advertise a
    // public OGC URL that 404s for anonymous callers.
    out.push({
      label: 'GeoJSON',
      url: `/api/items/${item.id}/geojson`,
      format: 'GeoJSON',
    });
    if (item.access === 'public') {
      out.push({
        label: 'GeoJSON (OGC API Features)',
        url: `/api/public/ogc/collections/${item.id}/items?f=json`,
        format: 'GeoJSON',
      });
    }
  }
  if (item.type === 'tile_layer') {
    const data = item.data as { tileUrl?: string; kind?: string } | null;
    if (data?.tileUrl && data.kind !== 'vector') {
      const isPm = data.tileUrl.startsWith('pmtiles://');
      out.push({
        label: isPm ? 'PMTiles' : 'Cloud Optimized GeoTIFF',
        url: data.tileUrl.replace(
          /\/file$/,
          isPm ? '/file.pmtiles' : '/file.cog',
        ),
        format: isPm ? 'PMTiles' : 'COG',
      });
    }
  }
  if (item.type === 'point_cloud') {
    const data = item.data as { dataUrl?: string } | null;
    if (data?.dataUrl) {
      out.push({
        label: 'COPC point cloud',
        url: data.dataUrl,
        format: 'COPC',
      });
    }
  }
  return out;
}
