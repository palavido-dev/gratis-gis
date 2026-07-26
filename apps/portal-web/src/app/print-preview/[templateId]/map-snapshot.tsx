// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #159 Phase 2.2 / 2.4 inline MapLibre snapshot for the print Map
 * element. Replaces the Phase 2.1 iframe so the captured PDF gets
 * a vector(-ish) map render instead of an embedded raster.
 *
 * Phase 2.4 expansions:
 *   - per-layer renderer parity (unique-values / class-breaks /
 *     time-bins / labels) via the shared snapshot-paint module
 *   - basemap fidelity: the bound map's own basemap renders
 *     instead of the OSM raster default; pmtiles + cog basemap
 *     URLs work via the same protocol registration the canvas uses
 *   - scaleOverride: the print Map element's optional scale
 *     denominator overrides the bound map's persisted zoom
 *
 * Loads MapLibre on mount, points it at the map item's data blob,
 * and signals readiness by setting `document.body.dataset.mapReady`
 * once every layer has loaded. The Puppeteer pipeline waits on this
 * flag (via `page.waitForSelector body[data-map-ready="true"]`)
 * before calling page.pdf.
 *
 * Basemap raster tiles still rasterize (PDF can't carry slippy tile
 * vector data), but vector data layers paint as path primitives.
 */
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapData } from '@gratis-gis/shared-types';
// ensureRasterProtocols registers the pmtiles:// + cog:// MapLibre
// protocols so pmtiles- or cog-backed basemaps render through the
// same handler the canvas uses. Called explicitly before the map is
// built (not relied on as a module-load side effect, which a bundler
// chunk split can leave unrun before the map loads its sources; #209).
import { basemapDataToStyle, ensureRasterProtocols } from '@/lib/custom-basemap';
import type { BasemapData } from '@gratis-gis/shared-types';

import {
  addLabelLayer,
  addPaintForLayer,
  scaleToZoom,
} from './snapshot-paint';

interface Props {
  mapData: MapData;
  /** Resolved basemap blob for `mapData.basemap` (when set). Null
   *  drops back to the OSM raster fallback. */
  basemapData: BasemapData | null;
  /** Optional scale denominator from the print Map element. When
   *  set, the snapshot computes zoom from this scale rather than
   *  reading `mapData.zoom`. */
  scaleOverride?: number;
}

export function MapSnapshot({
  mapData,
  basemapData,
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
      const tasks: Array<Promise<void>> = [];
      for (const layer of mapData.layers ?? []) {
        if (!layer.visible) continue;
        const sourceId = `pg:${layer.id}`;
        if (layer.source.kind === 'data-layer') {
          const src = layer.source;
          const base = src.layerKey
            ? `/api/portal/items/${src.itemId}/layers/${encodeURIComponent(src.layerKey)}/geojson`
            : `/api/portal/items/${src.itemId}/geojson`;
          // Scope the fetch the way the canvas does for its
          // editor-target GeoJSON reads: bbox-clip to the print
          // viewport so a county-scale layer doesn't trip the
          // server row cap with rows that aren't even on the
          // sheet, and forward the boundary clip (layer-level
          // first, then the map-wide default view scope) so the
          // print shows the same subset the bound map shows.
          const params = new URLSearchParams({ bbox: bbox.join(',') });
          const clip = layer.boundaryFilterItemId ?? mapData.clipBoundaryId;
          if (clip) params.set('clip', clip);
          tasks.push(
            fetchLayerGeoJson(`${base}?${params.toString()}`)
              .then((data) => {
                if (disposed) return;
                addGeoJsonSourceFromData(map, sourceId, data);
                addPaintForLayer(map, sourceId, layer.id, layer);
                addLabelLayer(map, sourceId, layer.id, layer);
              })
              .catch(() => {
                failures.push(layer.title);
              }),
          );
        } else if (layer.source.kind === 'arcgis-rest') {
          const src = layer.source;
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
          const queryUrl = `${baseUrl}/${src.layerId}/query?${params.toString()}`;
          tasks.push(
            fetchLayerGeoJson(queryUrl)
              .then((data) => {
                if (disposed) return;
                addGeoJsonSourceFromData(map, sourceId, data);
                addPaintForLayer(map, sourceId, layer.id, layer);
                addLabelLayer(map, sourceId, layer.id, layer);
              })
              .catch(() => {
                failures.push(layer.title);
              }),
          );
        } else if (layer.source.kind === 'postgis-live') {
          const src = layer.source;
          tasks.push(
            fetchLayerGeoJson(
              `/api/portal/postgis-live/${src.serviceItemId}/features`,
              {
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
            )
              .then((data) => {
                if (disposed) return;
                addGeoJsonSourceFromData(map, sourceId, data);
                addPaintForLayer(map, sourceId, layer.id, layer);
                addLabelLayer(map, sourceId, layer.id, layer);
              })
              .catch(() => {
                failures.push(layer.title);
              }),
          );
        }
        // geojson-url / geojson-inline / group fall through:
        //   - group is a UI-only grouping marker, not a real source
        //   - geojson-url + geojson-inline don't appear on saved maps
        //     in practice; the editor turns inline GeoJSON into a
        //     data_layer on save
      }
      await Promise.all(tasks);
      if (!disposed && failures.length > 0) {
        setFailedLayers(failures);
      }
      // Signal readiness once tiles + data sources have idled.
      // Puppeteer waitForSelector picks this up. We mark ready even
      // when layers failed: the pipeline still has to finish the
      // PDF, and the visible notice above keeps the sheet honest
      // about what is missing.
      const markReady = () => {
        document.body.dataset.mapReady = 'true';
      };
      map.once('idle', markReady);
      // Hard ceiling so a stuck source doesn't keep Puppeteer
      // waiting forever; 12 s is well within the 30 s navigation
      // timeout the render service uses.
      setTimeout(markReady, 12_000);
    });
    return () => {
      disposed = true;
      map.remove();
    };
  }, [mapData, basemapData, scaleOverride]);

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
 * Fetch one layer's GeoJSON for the snapshot, strictly. Throws on
 * non-2xx responses, non-JSON bodies (an HTML error page would
 * otherwise slip through), and the ArcGIS 200-with-error envelope,
 * so the caller can record the layer as failed instead of shipping
 * a PDF that silently omits it.
 */
async function fetchLayerGeoJson(
  url: string,
  init?: RequestInit,
): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(url, init);
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
