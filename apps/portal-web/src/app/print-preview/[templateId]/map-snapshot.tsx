// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #159 Phase 2.2 / 2.4 / 3 inline MapLibre snapshot for the print
 * Map element. Replaces the Phase 2.1 iframe so the captured PDF
 * gets a vector(-ish) map render instead of an embedded raster.
 *
 * Phase 2.4 expansions:
 *   - per-layer renderer parity (unique-values / class-breaks /
 *     time-bins / labels) via the shared snapshot-paint module
 *   - basemap fidelity: the bound map's own basemap renders
 *     instead of the OSM raster default; pmtiles + cog basemap
 *     URLs work via the same protocol registration the canvas uses
 *   - scaleOverride: the print Map element's optional scale
 *     denominator overrides the bound map's persisted zoom
 * Phase 3: paints map.data.drawings via shared syncDrawings so
 * redline markup survives export (saved visibility only).
 *
 * Loads MapLibre on mount, points it at the map item's data blob,
 * and reports to PrintReadySignal once every layer has loaded. That
 * sets `body[data-map-ready]` when every map on the sheet is done,
 * which the Puppeteer pipeline waits on before calling page.pdf.
 *
 * Basemap raster tiles still rasterize (PDF can't carry slippy tile
 * vector data), but vector data layers paint as path primitives.
 */
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapData, MapLayer } from '@gratis-gis/shared-types';
import { effectiveLayerScale } from '@gratis-gis/shared-types';
// ensureRasterProtocols registers the pmtiles:// + cog:// MapLibre
// protocols so pmtiles- or cog-backed basemaps render through the
// same handler the canvas uses. Called explicitly before the map is
// built (not relied on as a module-load side effect, which a bundler
// chunk split can leave unrun before the map loads its sources; #209).
import { basemapDataToStyle, ensureRasterProtocols } from '@/lib/custom-basemap';
import { ensureMapLibreWorker } from '@/lib/maplibre-runtime';
import type { BasemapData } from '@gratis-gis/shared-types';

import { syncDrawings } from '@/lib/drawings-overlay';
import {
  addLabelLayer,
  addPaintForLayer,
  scaleToZoom,
} from './snapshot-paint';
import { reportPrintMapReady } from './print-ready-signal';

interface Props {
  mapData: MapData;
  /** Resolved basemap blob for `mapData.basemap` (when set). Null
   *  drops back to the OSM raster fallback. */
  basemapData: BasemapData | null;
  /** Per-job print read credential. Sent in a header on layer reads
   *  through /api/portal only, never to a third-party URL. */
  readCredential?: string | null;
  /** Optional scale denominator from the print Map element. When
   *  set, the snapshot computes zoom from this scale rather than
   *  reading `mapData.zoom`. */
  scaleOverride?: number;
}

export function MapSnapshot({
  mapData,
  basemapData,
  readCredential = null,
  scaleOverride,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Titles of layers whose data fetch failed. Rendered as a visible
  // notice ON the sheet: a PDF gets handed around detached from the
  // app, so the sheet itself has to say when it is incomplete
  // instead of silently omitting data.
  const [failedLayers, setFailedLayers] = useState<string[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Guards the async load handler against a torn-down map
    // (unmount, or a prop change re-running this effect).
    let disposed = false;
    setFailedLayers([]);

    // Resolve the map style from the basemap blob. When unset we
    // keep the OSM raster fallback so a brand-new map's preview
    // still renders.
    const customStyle = basemapData ? basemapDataToStyle(basemapData) : null;
    const styleArg: maplibregl.StyleSpecification | string = customStyle
      ? customStyle.kind === 'url'
        ? customStyle.url
        : (customStyle.style as maplibregl.StyleSpecification)
      : ({
          version: 8,
          sources: {
            raster: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '(c) OpenStreetMap contributors',
            },
          },
          layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
        } as maplibregl.StyleSpecification);

    // scaleOverride wins over the map's persisted zoom when set.
    // The conversion uses the bound map's center latitude so it's
    // accurate for the print viewport regardless of where the map
    // is centered.
    const lat = mapData.center?.[1] ?? 0;
    const zoom =
      scaleOverride && scaleOverride > 0
        ? scaleToZoom(scaleOverride, lat)
        : mapData.zoom;

    ensureRasterProtocols();
    ensureMapLibreWorker();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleArg,
      center: mapData.center,
      zoom,
      bearing: mapData.bearing ?? 0,
      pitch: mapData.pitch ?? 0,
      interactive: false,
      attributionControl: false,
      // MapLibre needs `preserveDrawingBuffer: true` so the canvas
      // content is sampled by headless capture; the option lives
      // on the canvasContextAttributes bag.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    // Tell the page this map has finished (PrintReadySignal counts
    // these). The ceiling starts at mount, not on load, so a basemap
    // style that never loads cannot hold the render to the API's own
    // timeout.
    let reported = false;
    const done = () => {
      if (reported || disposed) return;
      reported = true;
      reportPrintMapReady();
    };
    const ceiling = window.setTimeout(done, 12_000);

    map.on('load', async () => {
      // Per-source-kind handlers. Each adds a GeoJSON source and
      // the matching paint layers via the shared addPaintForLayer
      // helper. arcgis-rest + postgis-live kick off a bbox fetch
      // against the current viewport.
      const bounds = map.getBounds();
      const bbox: [number, number, number, number] = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ];
      // Every loader below records its layer here on failure. The
      // canvas can afford to shrug off a failed layer fetch (the
      // user sees the gap and reloads); a print cannot, because the
      // gap ships inside a PDF that looks complete.
      const failures: string[] = [];
      const allLayers = mapData.layers ?? [];
      const printZoom = map.getZoom();
      // Fetch every layer at once, but add them to the map only after
      // all have answered and in the map's own order (first = bottom),
      // so the stacking matches the canvas instead of whichever fetch
      // finished last.
      const loads: Array<
        Promise<{ layer: MapLayer; data: GeoJSON.FeatureCollection } | null>
      > = [];
      for (const layer of allLayers) {
        if (!layer.visible || layer.source.kind === 'group') continue;
        // A layer the canvas hides at this zoom stays off the print.
        const scale = effectiveLayerScale(layer, allLayers);
        if (scale.minZoom != null && printZoom < scale.minZoom) continue;
        if (scale.maxZoom != null && printZoom >= scale.maxZoom) continue;
        const url = layerRequest(layer, bbox, mapData);
        if (!url) {
          // Tile, point-cloud and inline / URL GeoJSON layers are not
          // drawn by the print yet. Say so on the sheet rather than
          // leave them out silently.
          failures.push(layer.title);
          continue;
        }
        loads.push(
          fetchLayerGeoJson(url.href, url.init, readCredential)
            .then((data) => {
              // ArcGIS stops at resultRecordCount and says so; a print
              // that drew only part of a layer is incomplete.
              if ((data as { exceededTransferLimit?: unknown }).exceededTransferLimit) {
                failures.push(layer.title);
              }
              return { layer, data };
            })
            .catch(() => {
              failures.push(layer.title);
              return null;
            }),
        );
      }
      const loaded = (await Promise.all(loads)).filter(
        (r): r is { layer: MapLayer; data: GeoJSON.FeatureCollection } =>
          r !== null,
      );
      if (disposed) return;
      for (const { layer, data } of loaded) {
        const sourceId = `pg:${layer.id}`;
        addGeoJsonSourceFromData(map, sourceId, data);
        if (!addPaintForLayer(map, sourceId, layer.id, layer)) {
          failures.push(layer.title);
        }
      }
      // Labels go on top of every layer's paint, as on the canvas.
      for (const { layer } of loaded) {
        const scale = effectiveLayerScale(layer, allLayers);
        if (scale.labelsMinZoom != null && printZoom < scale.labelsMinZoom) continue;
        if (scale.labelsMaxZoom != null && printZoom >= scale.labelsMaxZoom) continue;
        if (!addLabelLayer(map, `pg:${layer.id}`, layer.id, layer)) {
          failures.push(layer.title);
        }
      }
      if (failures.length > 0) {
        setFailedLayers(Array.from(new Set(failures)));
      }
      // #159 Phase 3: paint markup overlays from map.data.drawings
      // (already on the print job bundle). Honors saved per-set
      // visibility; no extra drawings API fetch.
      syncDrawings(map, mapData.drawings ?? []);
      // Report done once tiles + data sources have idled. We report
      // even when layers failed: the pipeline still has to finish the
      // PDF, and the visible notice keeps the sheet honest about what
      // is missing.
      map.once('idle', done);
    });
    return () => {
      disposed = true;
      window.clearTimeout(ceiling);
      map.remove();
    };
  }, [mapData, basemapData, scaleOverride, readCredential]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          background: '#f8fafc',
        }}
      />
      {failedLayers.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            maxWidth: '85%',
            padding: '4px 8px',
            background: 'rgba(255, 255, 255, 0.92)',
            border: '1px solid #b45309',
            borderRadius: 4,
            color: '#92400e',
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {failedLayers.length === 1
            ? '1 map layer failed to load'
            : `${failedLayers.length} map layers failed to load`}
          {': '}
          {failedLayers.join(', ')}. This map is incomplete.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The feature request for one layer, or null for a source kind the
 * print does not draw. The data-layer read is bbox-clipped to the
 * print viewport and carries the boundary clip (layer first, then the
 * map-wide default) so the print shows the subset the map shows.
 */
function layerRequest(
  layer: MapLayer,
  bbox: [number, number, number, number],
  mapData: MapData,
): { href: string; init?: RequestInit } | null {
  const src = layer.source;
  if (src.kind === 'data-layer') {
    const base = src.layerKey
      ? `/api/portal/items/${encodeURIComponent(src.itemId)}/layers/${encodeURIComponent(src.layerKey)}/geojson`
      : `/api/portal/items/${encodeURIComponent(src.itemId)}/geojson`;
    const params = new URLSearchParams({ bbox: bbox.join(',') });
    const clip = layer.boundaryFilterItemId ?? mapData.clipBoundaryId;
    if (clip) params.set('clip', clip);
    return { href: `${base}?${params.toString()}` };
  }
  if (src.kind === 'arcgis-rest') {
    const params = new URLSearchParams({
      where: '1=1',
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      outSR: '4326',
      f: 'geojson',
      resultRecordCount: '2000',
    });
    const baseUrl = src.proxyUrl ?? src.url;
    return { href: `${baseUrl}/${src.layerId}/query?${params.toString()}` };
  }
  if (src.kind === 'postgis-live') {
    return {
      href: `/api/portal/postgis-live/${encodeURIComponent(src.serviceItemId)}/features`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableName: src.tableName,
          bbox,
          ...(src.whereClause ? { whereClause: src.whereClause } : {}),
          ...(layer.filter && layer.filter.clauses.length > 0
            ? { filter: layer.filter }
            : {}),
        }),
      },
    };
  }
  return null;
}

/**
 * Fetch one layer's GeoJSON for the snapshot, strictly. Throws on
 * non-2xx responses, non-JSON bodies (an HTML error page would
 * otherwise slip through), and the ArcGIS 200-with-error envelope,
 * so the caller can record the layer as failed instead of shipping
 * a PDF that silently omits it.
 */
async function fetchLayerGeoJson(
  url: string,
  init: RequestInit | undefined,
  readCredential: string | null,
): Promise<GeoJSON.FeatureCollection> {
  // The headless print browser has no session, so the job's read
  // credential goes along in a header. Only on same-origin portal
  // reads: an ArcGIS URL without the proxy is a third party.
  const headers = new Headers(init?.headers);
  if (readCredential && url.startsWith('/api/portal/')) {
    headers.set('x-print-read', readCredential);
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`request failed with status ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!/\bjson\b/i.test(contentType)) {
    throw new Error(
      `expected JSON, received ${contentType || 'no content type'}`,
    );
  }
  const data = (await res.json()) as
    | GeoJSON.FeatureCollection
    | { error?: unknown };
  if ('error' in data && data.error) {
    // ArcGIS servers report failures as HTTP 200 with an error body.
    throw new Error('upstream service reported an error');
  }
  return data as GeoJSON.FeatureCollection;
}

function addGeoJsonSourceFromData(
  map: maplibregl.Map,
  sourceId: string,
  data: GeoJSON.FeatureCollection,
): void {
  try {
    map.addSource(sourceId, { type: 'geojson', data });
  } catch {
    /* HMR re-add - ignore */
  }
}
