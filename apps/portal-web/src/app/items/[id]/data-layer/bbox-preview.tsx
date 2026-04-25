'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';

/**
 * Read-only MapLibre canvas previewing a data_layer's contents on
 * an OSM raster basemap. (#35)
 *
 * If `featureSources` is provided, the component fetches each one in
 * parallel and renders the actual feature geometries (fill + line for
 * polygons, line for lines, circle for points). Otherwise -- or if
 * every fetch fails / returns empty -- the bbox is drawn as a
 * translucent rectangle so the panel still answers "where is this
 * dataset?"
 *
 * Camera fits to the union of fetched bounds, falling back to the
 * supplied bbox when no real geometry came back. Pan / zoom is
 * enabled for context but no editing tools.
 *
 * Used from data-layer/editor.tsx; the parent renders this when a
 * v2/v3 layer has a non-null bbox to draw.
 */
interface Props {
  /** [west, south, east, north] in EPSG:4326. Used as the viewport
   *  fallback when no features come back, and as the rectangle
   *  outline when feature fetches fail. */
  bbox: [number, number, number, number];
  /** Optional GeoJSON endpoints to render as actual features. Each
   *  source carries an optional geometryType so the right paint
   *  layers are added without scanning the response. v3 items pass
   *  one source per layer; v2 items pass a single source for the
   *  whole table. Omit to fall back to the bbox-rectangle preview. */
  featureSources?: Array<{
    url: string;
    geometryType?: 'point' | 'line' | 'polygon' | null;
  }>;
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

/** Cap fetched features per source so a multi-million-row layer can
 *  still render a useful preview without OOM-ing the browser. The
 *  server already has its own LIMIT (v2 caps at 10000), so this is
 *  belt-and-braces plus a documented contract. */
const PREVIEW_FEATURE_CAP = 5000;

export function DataLayerBboxPreview({ bbox, featureSources }: Props) {
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

    let cancelled = false;
    map.on('load', async () => {
      if (cancelled) return;
      // Always seed the bbox source so the camera has something to
      // fit even if every feature fetch fails. We may overlay real
      // features on top; we may also hide the rectangle once they
      // arrive. For the moment-of-load case the rectangle paints
      // first, then the actual geometries replace it.
      map.addSource('extent', {
        type: 'geojson',
        data: rectangleFor(bbox),
      });
      map.addLayer({
        id: 'extent-fill',
        type: 'fill',
        source: 'extent',
        paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'extent-line',
        type: 'line',
        source: 'extent',
        paint: { 'line-color': '#0284c7', 'line-width': 1, 'line-dasharray': [2, 2] },
      });
      map.fitBounds(
        [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        { padding: 24, animate: false, maxZoom: 14 },
      );

      if (!featureSources || featureSources.length === 0) return;

      // Fetch every source in parallel. Promise.allSettled so one
      // failed fetch (e.g. a layer with no provisioned table yet)
      // doesn't blank out the others.
      const results = await Promise.allSettled(
        featureSources.map(async (s, i) => {
          const res = await fetch(s.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const fc = (await res.json()) as GeoJSON.FeatureCollection;
          return { idx: i, geometryType: s.geometryType ?? null, fc };
        }),
      );
      if (cancelled) return;

      const unionBounds = new maplibregl.LngLatBounds();
      let anyDrawn = false;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { idx, geometryType, fc } = r.value;
        if (!fc.features || fc.features.length === 0) continue;
        // Cap the rendered feature count per source. For very large
        // layers, the server's own LIMIT typically lands first; this
        // keeps us safe if a future endpoint relaxes that cap.
        const features = fc.features.slice(0, PREVIEW_FEATURE_CAP);
        const sourceId = `preview-src-${idx}`;
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features },
        });
        // Layer paint depends on geometry. Polygons get fill + line;
        // lines just line; points get a small circle. We add ALL
        // three layer kinds when geometryType is unknown so a mixed
        // collection still renders something visible.
        const isPoly = geometryType === 'polygon' || geometryType == null;
        const isLine = geometryType === 'line' || geometryType == null;
        const isPoint = geometryType === 'point' || geometryType == null;
        if (isPoly) {
          map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.25 },
          });
        }
        if (isLine || isPoly) {
          // Polygons get a stronger outline alongside their fill;
          // lines just paint the line. Same layer id for both since
          // MapLibre will only match the relevant geometries.
          map.addLayer({
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            paint: { 'line-color': '#0284c7', 'line-width': 1.5 },
          });
        }
        if (isPoint) {
          map.addLayer({
            id: `${sourceId}-point`,
            type: 'circle',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': 3,
              'circle-color': '#0ea5e9',
              'circle-stroke-color': '#0284c7',
              'circle-stroke-width': 1,
            },
          });
        }
        anyDrawn = true;
        // Extend the union bounds for camera fitting. Skip features
        // with null geometry (attribute-only rows leak through here).
        for (const f of features) {
          const geom = f.geometry;
          if (!geom) continue;
          extendBoundsWithGeometry(unionBounds, geom);
        }
      }

      if (anyDrawn) {
        // Hide the dashed rectangle now that real features cover the
        // viewport -- the bbox was just a placeholder until features
        // arrived. We keep the source around so the parent's bbox
        // change effect can repaint without rebuilding the layer.
        if (map.getLayer('extent-fill')) {
          map.setLayoutProperty('extent-fill', 'visibility', 'none');
        }
        if (map.getLayer('extent-line')) {
          map.setLayoutProperty('extent-line', 'visibility', 'none');
        }
        // Fit to the union of all fetched feature bounds when we
        // actually have geometry; otherwise leave the bbox-derived
        // viewport in place.
        if (!unionBounds.isEmpty()) {
          map.fitBounds(unionBounds, {
            padding: 24,
            animate: false,
            maxZoom: 16,
          });
        }
      }
    });

    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
    };
    // featureSources is captured once on mount; the effect below
    // handles bbox-only changes after the first paint without
    // rebuilding the map. A re-import that genuinely changes the
    // sources would rebuild the parent component anyway.
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
        [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
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

/** Extend a LngLatBounds with the coordinates of a GeoJSON geometry.
 *  Walks Point / LineString / Polygon and their Multi* variants and
 *  GeometryCollection. Silently skips unknown geometry shapes. */
function extendBoundsWithGeometry(
  bounds: maplibregl.LngLatBounds,
  geom: GeoJSON.Geometry,
): void {
  switch (geom.type) {
    case 'Point':
      bounds.extend(geom.coordinates as [number, number]);
      break;
    case 'MultiPoint':
    case 'LineString':
      for (const c of geom.coordinates) bounds.extend(c as [number, number]);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geom.coordinates) {
        for (const c of ring) bounds.extend(c as [number, number]);
      }
      break;
    case 'MultiPolygon':
      for (const poly of geom.coordinates) {
        for (const ring of poly) {
          for (const c of ring) bounds.extend(c as [number, number]);
        }
      }
      break;
    case 'GeometryCollection':
      for (const g of geom.geometries) extendBoundsWithGeometry(bounds, g);
      break;
  }
}
