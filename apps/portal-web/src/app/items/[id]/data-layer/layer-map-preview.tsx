// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { Map as MapIcon } from 'lucide-react';
import { ensureMapLibreWorker } from '@/lib/maplibre-runtime';
import type { LayerGeometryType } from '@gratis-gis/shared-types';

/**
 * In-card MapLibre preview for one data_layer sublayer (#223).
 *
 * Sibling of `ItemMapPreview` (hero on the item detail page) but
 * sized for the layer-data card and pointed at a single layer. Uses
 * the same MVT tile URL the map page uses, so row scoping and geo
 * limits apply without a second access path.
 *
 * Deliberate choices from the issue:
 * - Grey/minimal basemap (Carto light_nolabels), not the org default —
 *   a busy backdrop competes with the geometry at this size.
 * - Generic paint, not the layer's saved style — the tab answers
 *   "did the geometry land in the right place?", not finished look.
 * - Empty layers get an empty state, not a world-view fallback that
 *   would read as "your import went somewhere very wrong".
 */

/** Muted grey basemap; labels omitted so they don't fight the overlay. */
const GREY_BASEMAP: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '(c) OpenStreetMap contributors (c) Carto',
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
};

/** ST_AsMVT names every layer 'features' (engine/data-layer.ts). */
const MVT_SOURCE_LAYER = 'features';

const ACCENT = '#2563eb';

interface Props {
  itemId: string;
  layerId: string;
  geometryType: Exclude<LayerGeometryType, null>;
  /** [west, south, east, north] in EPSG:4326. Null/missing when the
   *  layer has no features (or none with geometry). */
  bbox: [number, number, number, number] | null | undefined;
  featureCount: number | undefined;
}

function isValidBbox(
  b: [number, number, number, number] | null | undefined,
): b is [number, number, number, number] {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export function LayerMapPreview({
  itemId,
  layerId,
  geometryType,
  bbox,
  featureCount,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  const empty =
    (typeof featureCount === 'number' && featureCount === 0) ||
    !isValidBbox(bbox);
  // Primitive stand-in so a fresh bbox array from RSC refresh does
  // not tear the map down mid-pan (same pattern as ItemMapPreview).
  const bboxKey = isValidBbox(bbox) ? bbox.join(',') : '';

  useEffect(() => {
    const container = containerRef.current;
    if (!container || empty || !isValidBbox(bbox)) return;
    const extent = bbox;
    ensureMapLibreWorker();
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: GREY_BASEMAP,
        center: [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2],
        zoom: 4,
        attributionControl: { compact: true },
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right',
    );
    map.on('error', (e) => {
      // Tile 404s on sparse tiles are normal; only style/source
      // failures blank the preview.
      if ((e as { sourceId?: string }).sourceId) return;
      setFailed(true);
    });

    map.on('load', () => {
      const sourceId = 'layer-preview';
      map.addSource(sourceId, {
        type: 'vector',
        tiles: [
          `${window.location.origin}/api/portal/items/${itemId}` +
            `/layers/${encodeURIComponent(layerId)}/tile/{z}/{x}/{y}.mvt`,
        ],
        minzoom: 0,
        maxzoom: 22,
      });
      const common = {
        source: sourceId,
        'source-layer': MVT_SOURCE_LAYER,
      } as const;
      if (geometryType === 'polygon') {
        map.addLayer({
          ...common,
          id: `${sourceId}-fill`,
          type: 'fill',
          paint: { 'fill-color': ACCENT, 'fill-opacity': 0.25 },
        });
        map.addLayer({
          ...common,
          id: `${sourceId}-outline`,
          type: 'line',
          paint: { 'line-color': ACCENT, 'line-width': 1 },
        });
      } else if (geometryType === 'line') {
        map.addLayer({
          ...common,
          id: `${sourceId}-line`,
          type: 'line',
          paint: { 'line-color': ACCENT, 'line-width': 1.5 },
        });
      } else {
        map.addLayer({
          ...common,
          id: `${sourceId}-circle`,
          type: 'circle',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              4,
              2,
              14,
              5,
            ],
            'circle-color': ACCENT,
            'circle-opacity': 0.75,
            'circle-stroke-width': 0.5,
            'circle-stroke-color': '#ffffff',
          },
        });
      }
      map.fitBounds(
        [
          [extent[0], extent[1]],
          [extent[2], extent[3]],
        ],
        { padding: 24, duration: 0, maxZoom: 14 },
      );
    });

    // Card width can change without a window resize (sidebar, panel
    // reveal). MapLibre only listens for window resize.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, layerId, geometryType, empty, bboxKey]);

  if (empty) {
    return (
      <div className="mt-2 flex h-[240px] flex-col items-center justify-center gap-1 rounded-md border border-border bg-surface-2 px-4 text-center">
        <MapIcon className="mb-1 h-5 w-5 text-muted" aria-hidden />
        <p className="text-sm font-medium text-ink-1">No features to show</p>
        <p className="max-w-sm text-xs text-muted">
          This layer has no geometry yet. Import features to see them on
          the map.
        </p>
      </div>
    );
  }

  return (
    <div className="relative mt-2 overflow-hidden rounded-md border border-border">
      <div
        ref={containerRef}
        role="img"
        aria-label="Layer geometry preview"
        className="h-[240px] w-full"
      />
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2/90 text-xs text-muted">
          Map preview failed to load
        </div>
      ) : null}
    </div>
  );
}
