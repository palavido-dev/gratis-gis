'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';

/**
 * Read-only MapLibre canvas that frames the data_layer's PostGIS bbox
 * on an OSM raster basemap. Cheap "where is this dataset?" preview;
 * does not fetch the actual features (that would mean either an
 * inline GeoJSON download or a tile pipeline we don't have yet).
 *
 * The bbox is drawn as a translucent rectangle with a solid outline
 * and the camera fits to it on first paint. Subsequent bbox changes
 * (e.g. after a successful re-import) re-fit. Pan / zoom is enabled
 * so the user can poke at surrounding context, but no editing tools.
 *
 * Used from data-layer/editor.tsx; the parent only renders this when
 * a v2/v3 layer has a non-null bbox to draw.
 */
interface Props {
  /** [west, south, east, north] in EPSG:4326. */
  bbox: [number, number, number, number];
}

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

export function DataLayerBboxPreview({ bbox }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      zoom: 1,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'top-right',
    );
    mapRef.current = map;

    map.on('load', () => {
      // Build a single-polygon source from the bbox so we can render
      // both a fill + an outline. We update the source's data on
      // subsequent prop changes rather than rebuild the layer.
      map.addSource('extent', {
        type: 'geojson',
        data: rectangleFor(bbox),
      });
      map.addLayer({
        id: 'extent-fill',
        type: 'fill',
        source: 'extent',
        paint: {
          'fill-color': '#0ea5e9',
          'fill-opacity': 0.12,
        },
      });
      map.addLayer({
        id: 'extent-line',
        type: 'line',
        source: 'extent',
        paint: {
          'line-color': '#0284c7',
          'line-width': 2,
        },
      });
      // Fit on first paint so the rectangle and a bit of context fit
      // the viewport. `animate: false` so the preview doesn't burn
      // CPU on initial render.
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 24, animate: false, maxZoom: 14 },
      );
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // bbox is intentionally read once; a follow-up effect handles
    // updates so we don't rebuild the map on every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit the camera + update the rectangle source whenever the bbox
  // changes (e.g. after a fresh import). Guard against the load
  // listener not having run yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('extent') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(rectangleFor(bbox));
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 24, animate: false, maxZoom: 14 },
      );
    };
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
  }, [bbox]);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div
        ref={containerRef}
        className="h-[220px] w-full"
        style={{ position: 'relative' }}
      />
    </div>
  );
}

/** Convert a bbox into a single-feature GeoJSON FeatureCollection. */
function rectangleFor(
  bbox: [number, number, number, number],
): GeoJSON.FeatureCollection {
  const [w, s, e, n] = bbox;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
    ],
  };
}
