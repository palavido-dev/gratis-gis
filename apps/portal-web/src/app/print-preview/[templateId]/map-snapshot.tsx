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
import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    if (!containerRef.current) return;

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
      const tasks: Array<Promise<void>> = [];
      for (const layer of mapData.layers ?? []) {
        if (!layer.visible) continue;
        const sourceId = `pg:${layer.id}`;
        if (layer.source.kind === 'data-layer') {
          const url = layer.source.layerKey
            ? `/api/portal/items/${layer.source.itemId}/layers/${encodeURIComponent(layer.source.layerKey)}/geojson`
            : `/api/portal/items/${layer.source.itemId}/geojson`;
          addGeoJsonSourceFromUrl(map, sourceId, url);
          addPaintForLayer(map, sourceId, layer.id, layer);
          addLabelLayer(map, sourceId, layer.id, layer);
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
            fetch(queryUrl)
              .then((r) => r.json())
              .then((data) => {
                addGeoJsonSourceFromData(
                  map,
                  sourceId,
                  data as GeoJSON.FeatureCollection,
                );
                addPaintForLayer(map, sourceId, layer.id, layer);
                addLabelLayer(map, sourceId, layer.id, layer);
              })
              .catch(() => undefined),
          );
        } else if (layer.source.kind === 'postgis-live') {
          const src = layer.source;
          tasks.push(
            fetch(
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
              .then((r) => r.json())
              .then((data) => {
                addGeoJsonSourceFromData(
                  map,
                  sourceId,
                  data as GeoJSON.FeatureCollection,
                );
                addPaintForLayer(map, sourceId, layer.id, layer);
                addLabelLayer(map, sourceId, layer.id, layer);
              })
              .catch(() => undefined),
          );
        }
        // geojson-url / geojson-inline / group fall through:
        //   - group is a UI-only grouping marker, not a real source
        //   - geojson-url + geojson-inline don't appear on saved maps
        //     in practice; the editor turns inline GeoJSON into a
        //     data_layer on save
      }
      await Promise.all(tasks);
      // Signal readiness once tiles + data sources have idled.
      // Puppeteer waitForSelector picks this up.
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
      map.remove();
    };
  }, [mapData, basemapData, scaleOverride]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#f8fafc',
      }}
    />
  );
}

function addGeoJsonSourceFromUrl(
  map: maplibregl.Map,
  sourceId: string,
  url: string,
): void {
  try {
    map.addSource(sourceId, { type: 'geojson', data: url });
  } catch {
    /* HMR re-add - ignore */
  }
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
