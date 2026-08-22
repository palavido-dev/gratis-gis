// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { LayerGeometryType } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Live, pannable preview of a v3 data_layer, as the hero of the item
 * detail page instead of a static thumbnail. (#52)
 *
 * Draws the real tiles the rest of the portal draws, from
 * `/layers/:layerId/tile/{z}/{x}/{y}.mvt`, so it inherits the server's
 * row scoping and geo limits for free: a restricted viewer previews
 * exactly the rows they are allowed, with no separate access path to
 * keep in step.
 *
 * MVT rather than the GeoJSON that `DataLayerBboxPreview` fetches.
 * That one caps at 5,000 features, which silently draws a partial
 * dataset on anything larger, and the demo's water quality layer is
 * 285,788 rows. Tiles have no such ceiling.
 *
 * Deliberately not built on `layersForPortalItem` / `MapCanvas`: the
 * canvas takes ~25 props and owns selection, drawing and editing
 * state. A read-only preview needs a basemap, some tiles and a camera.
 */

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '(c) OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** ST_AsMVT names every layer 'features' (engine/data-layer.ts). A
 *  vector paint layer with the wrong source-layer renders nothing at
 *  all, silently, so this is pinned to one place. */
const MVT_SOURCE_LAYER = 'features';

const ACCENT = '#2563eb';

export interface PreviewLayer {
  id: string;
  label: string;
  geometryType: LayerGeometryType;
  bbox?: [number, number, number, number] | null;
}

interface Props {
  itemId: string;
  layers: PreviewLayer[];
  className?: string;
}

function unionBbox(
  layers: PreviewLayer[],
): [number, number, number, number] | null {
  let out: [number, number, number, number] | null = null;
  for (const layer of layers) {
    const b = layer.bbox;
    if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
    out = out
      ? [
          Math.min(out[0], b[0]),
          Math.min(out[1], b[1]),
          Math.max(out[2], b[2]),
          Math.max(out[3], b[3]),
        ]
      : [b[0], b[1], b[2], b[3]];
  }
  return out;
}

export function ItemMapPreview({ itemId, layers, className }: Props) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  // Attribute-only layers have no geometry and nothing to draw.
  const spatial = layers.filter((l) => Boolean(l.geometryType));
  const bbox = unionBbox(spatial);

  // What the map is actually built from, as a primitive. `layers`
  // arrives from a server component, so it is a fresh array on every
  // RSC payload even when nothing about it changed, and
  // ImportJobsBanner calls router.refresh() on this same page while
  // an import runs. Depending on the array identity would therefore
  // tear the map down and rebuild it every few seconds mid-import,
  // throwing away wherever the reader had panned to.
  const layerKey = spatial
    .map((l) => `${l.id}:${l.geometryType}`)
    .join('|');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || spatial.length === 0) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: OSM_STYLE,
        center: bbox
          ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
          : [-98, 39],
        zoom: bbox ? 4 : 2,
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
      // Tile 404s on an empty layer are normal and must not blank the
      // whole preview; only a style/source failure is worth reporting.
      if ((e as { sourceId?: string }).sourceId) return;
      setFailed(true);
    });

    map.on('load', () => {
      for (const layer of spatial) {
        const sourceId = `layer-${layer.id}`;
        map.addSource(sourceId, {
          type: 'vector',
          tiles: [
            `${window.location.origin}/api/portal/items/${itemId}` +
              `/layers/${encodeURIComponent(layer.id)}/tile/{z}/{x}/{y}.mvt`,
          ],
          minzoom: 0,
          maxzoom: 22,
        });
        const common = {
          source: sourceId,
          'source-layer': MVT_SOURCE_LAYER,
        } as const;
        if (layer.geometryType === 'polygon') {
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
        } else if (layer.geometryType === 'line') {
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
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 14, 5],
              'circle-color': ACCENT,
              'circle-opacity': 0.75,
              'circle-stroke-width': 0.5,
              'circle-stroke-color': '#ffffff',
            },
          });
        }
      }
      if (bbox) {
        map.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: 24, duration: 0, maxZoom: 14 },
        );
      }
    });

    // The container is `w-full` inside a collapsible shell, so it can
    // change width without the window doing so. MapLibre only listens
    // for window resize, and would otherwise keep a stale canvas size.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      map.remove();
    };
    // `spatial` and `bbox` are derived from `layers` on every render;
    // `layerKey` is the stable primitive that stands in for both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, layerKey]);

  if (spatial.length === 0) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-surface-2 p-6 text-center ${className ?? ''}`}
      >
        <p className="text-sm font-medium text-ink-1">
          {t('itemDetail.previewEmpty')}
        </p>
        <p className="max-w-md text-xs text-muted">
          {t('itemDetail.previewEmptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-md border border-border ${className ?? ''}`}
    >
      <div
        ref={containerRef}
        role="img"
        aria-label={t('itemDetail.previewTitle')}
        className="h-[320px] w-full"
      />
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-2/90 text-xs text-muted">
          {t('itemDetail.previewFailed')}
        </div>
      ) : null}
    </div>
  );
}
