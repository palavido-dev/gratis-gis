// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MapLibre drawings overlay shared by the map editor canvas and the
 * print-preview MapSnapshot (#154 / #159 Phase 3).
 *
 * Owns a single GeoJSON source (`drawings:overlay`) and layers:
 *   - drawings:fill / drawings:stroke: pin Points (kind=pin)
 *   - drawings:text: text annotation labels (kind=text)
 *   - drawings:line: LineString stroke (line + arrow)
 *   - drawings:arrow-head: tip marker for kind=arrow
 *   - drawings:poly-fill / drawings:poly-outline: Polygon (polygon + circle)
 *
 * Color comes from each feature's properties (`color`), stamped at
 * flatten time from the parent drawing set. Visibility on a set
 * hides its features via a filter on `setId`.
 */
import type * as maplibregl from 'maplibre-gl';
import type { DrawingSet } from '@gratis-gis/shared-types';

/**
 * Minimal projection of a DrawingSet the renderer needs. Keeps the
 * overlay insulated from panel-only fields (comments, threads).
 */
export type DrawingSetForRender = Pick<
  DrawingSet,
  'id' | 'color' | 'visible' | 'features'
>;

export const DRAWINGS_SOURCE_ID = 'drawings:overlay';
export const DRAWINGS_FILL_LAYER_ID = 'drawings:fill';
export const DRAWINGS_STROKE_LAYER_ID = 'drawings:stroke';
export const DRAWINGS_TEXT_LAYER_ID = 'drawings:text';
export const DRAWINGS_LINE_LAYER_ID = 'drawings:line';
export const DRAWINGS_ARROW_HEAD_LAYER_ID = 'drawings:arrow-head';
export const DRAWINGS_POLY_FILL_LAYER_ID = 'drawings:poly-fill';
export const DRAWINGS_POLY_OUTLINE_LAYER_ID = 'drawings:poly-outline';

/** Bottom-to-top paint order used when re-asserting z-order. */
export const DRAWINGS_LAYER_IDS = [
  DRAWINGS_POLY_FILL_LAYER_ID,
  DRAWINGS_POLY_OUTLINE_LAYER_ID,
  DRAWINGS_LINE_LAYER_ID,
  DRAWINGS_ARROW_HEAD_LAYER_ID,
  DRAWINGS_STROKE_LAYER_ID,
  DRAWINGS_FILL_LAYER_ID,
  DRAWINGS_TEXT_LAYER_ID,
] as const;

export interface FlattenedDrawings {
  featureCollection: GeoJSON.FeatureCollection;
  hiddenSetIds: string[];
}

/**
 * Flatten drawing sets into a FeatureCollection plus the list of
 * set ids that should be filtered out of the MapLibre layers.
 */
export function flattenDrawingSets(
  sets: DrawingSetForRender[],
): FlattenedDrawings {
  const features: GeoJSON.Feature[] = [];
  const hiddenSetIds: string[] = [];
  for (const set of sets) {
    if (!set.visible) hiddenSetIds.push(set.id);
    for (const f of set.features) {
      if (!f.geometry) continue;
      const color = f.style?.color ?? set.color;
      const props = {
        setId: set.id,
        color,
        kind: f.kind,
        label: f.label ?? '',
        strokeWidth: f.style?.strokeWidth ?? (f.kind === 'arrow' ? 4 : 3),
        fillOpacity: f.style?.fillOpacity ?? 0.25,
      };
      features.push({
        type: 'Feature',
        id: f.id,
        geometry: f.geometry as GeoJSON.Geometry,
        properties: props,
      });
      // Arrow tip: a Point at the last vertex so we can paint a
      // rotated chevron without a custom SDF icon.
      if (f.kind === 'arrow') {
        const tip = arrowTip(f.geometry);
        if (tip) {
          features.push({
            type: 'Feature',
            id: `${f.id}:tip`,
            geometry: { type: 'Point', coordinates: tip.coordinates },
            properties: {
              ...props,
              kind: 'arrow-head',
              bearing: tip.bearing,
            },
          });
        }
      }
    }
  }
  return {
    featureCollection: { type: 'FeatureCollection', features },
    hiddenSetIds,
  };
}

/** Last vertex + forward bearing (degrees clockwise from north). */
export function arrowTip(
  geometry: unknown,
): { coordinates: [number, number]; bearing: number } | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const coords = g.coordinates as number[][];
  if (coords.length < 2) return null;
  const a = coords[coords.length - 2]!;
  const b = coords[coords.length - 1]!;
  if (
    typeof a[0] !== 'number' ||
    typeof a[1] !== 'number' ||
    typeof b[0] !== 'number' ||
    typeof b[1] !== 'number'
  ) {
    return null;
  }
  const bearing =
    (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return { coordinates: [b[0], b[1]], bearing };
}

/**
 * Idempotent: re-runs whenever drawings change. Removes the source
 * and layers when there is no markup so the renderer does not carry
 * stale state across maps.
 */
export function syncDrawings(
  m: maplibregl.Map,
  sets: DrawingSetForRender[],
): void {
  const { featureCollection: fc, hiddenSetIds } = flattenDrawingSets(sets);
  const features = fc.features;
  const existing = m.getSource(DRAWINGS_SOURCE_ID) as
    | maplibregl.GeoJSONSource
    | undefined;
  if (features.length === 0) {
    for (const id of DRAWINGS_LAYER_IDS) {
      if (m.getLayer(id)) m.removeLayer(id);
    }
    if (m.getSource(DRAWINGS_SOURCE_ID)) m.removeSource(DRAWINGS_SOURCE_ID);
    return;
  }
  if (existing) {
    existing.setData(fc);
  } else {
    m.addSource(DRAWINGS_SOURCE_ID, {
      type: 'geojson',
      data: fc,
    });
  }

  const visibilityFilter: unknown[] =
    hiddenSetIds.length === 0
      ? ['literal', true]
      : ['!', ['in', ['get', 'setId'], ['literal', hiddenSetIds]]];

  const ensurePinCircle = (
    id: string,
    paint: Record<string, unknown>,
  ) => {
    const filter: maplibregl.FilterSpecification = [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['==', ['get', 'kind'], 'pin'],
      visibilityFilter as never,
    ];
    if (!m.getLayer(id)) {
      m.addLayer({
        id,
        type: 'circle',
        source: DRAWINGS_SOURCE_ID,
        filter,
        paint,
      } as maplibregl.CircleLayerSpecification);
    } else {
      m.setFilter(id, filter);
    }
  };

  ensurePinCircle(DRAWINGS_STROKE_LAYER_ID, {
    'circle-radius': 10,
    'circle-color': '#ffffff',
    'circle-stroke-color': '#111827',
    'circle-stroke-width': 1.5,
  });
  ensurePinCircle(DRAWINGS_FILL_LAYER_ID, {
    'circle-radius': 6,
    'circle-color': ['get', 'color'],
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
  });

  const textFilter: maplibregl.FilterSpecification = [
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['==', ['get', 'kind'], 'text'],
    visibilityFilter as never,
  ];
  if (!m.getLayer(DRAWINGS_TEXT_LAYER_ID)) {
    m.addLayer({
      id: DRAWINGS_TEXT_LAYER_ID,
      type: 'symbol',
      source: DRAWINGS_SOURCE_ID,
      filter: textFilter,
      layout: {
        'text-field': ['coalesce', ['get', 'label'], ''],
        'text-size': 14,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-anchor': 'bottom',
        'text-offset': [0, -0.4],
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  } else {
    m.setFilter(DRAWINGS_TEXT_LAYER_ID, textFilter);
  }

  const lineFilter: maplibregl.FilterSpecification = [
    'all',
    ['==', ['geometry-type'], 'LineString'],
    [
      'any',
      ['==', ['get', 'kind'], 'line'],
      ['==', ['get', 'kind'], 'arrow'],
    ],
    visibilityFilter as never,
  ];
  if (!m.getLayer(DRAWINGS_LINE_LAYER_ID)) {
    m.addLayer({
      id: DRAWINGS_LINE_LAYER_ID,
      type: 'line',
      source: DRAWINGS_SOURCE_ID,
      filter: lineFilter,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['coalesce', ['get', 'strokeWidth'], 3],
        'line-opacity': 0.95,
      },
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
    });
  } else {
    m.setFilter(DRAWINGS_LINE_LAYER_ID, lineFilter);
  }

  const arrowHeadFilter: maplibregl.FilterSpecification = [
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['==', ['get', 'kind'], 'arrow-head'],
    visibilityFilter as never,
  ];
  if (!m.getLayer(DRAWINGS_ARROW_HEAD_LAYER_ID)) {
    m.addLayer({
      id: DRAWINGS_ARROW_HEAD_LAYER_ID,
      type: 'symbol',
      source: DRAWINGS_SOURCE_ID,
      filter: arrowHeadFilter,
      layout: {
        'text-field': '▲',
        'text-size': 16,
        'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
        'text-rotate': ['get', 'bearing'],
        'text-rotation-alignment': 'map',
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1,
      },
    });
  } else {
    m.setFilter(DRAWINGS_ARROW_HEAD_LAYER_ID, arrowHeadFilter);
  }

  const polyFilter: maplibregl.FilterSpecification = [
    'all',
    ['==', ['geometry-type'], 'Polygon'],
    visibilityFilter as never,
  ];
  if (!m.getLayer(DRAWINGS_POLY_FILL_LAYER_ID)) {
    m.addLayer({
      id: DRAWINGS_POLY_FILL_LAYER_ID,
      type: 'fill',
      source: DRAWINGS_SOURCE_ID,
      filter: polyFilter,
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.25],
      },
    });
  } else {
    m.setFilter(DRAWINGS_POLY_FILL_LAYER_ID, polyFilter);
  }
  if (!m.getLayer(DRAWINGS_POLY_OUTLINE_LAYER_ID)) {
    m.addLayer({
      id: DRAWINGS_POLY_OUTLINE_LAYER_ID,
      type: 'line',
      source: DRAWINGS_SOURCE_ID,
      filter: polyFilter,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['coalesce', ['get', 'strokeWidth'], 2],
        'line-opacity': 0.95,
      },
    });
  } else {
    m.setFilter(DRAWINGS_POLY_OUTLINE_LAYER_ID, polyFilter);
  }
}

/** Raise every drawings layer above data overlays (bottom to top). */
export function raiseDrawingsLayers(m: maplibregl.Map): void {
  for (const id of DRAWINGS_LAYER_IDS) {
    if (!m.getLayer(id)) continue;
    try {
      m.moveLayer(id);
    } catch {
      // Concurrent sync may have removed it; next run re-adds on top.
    }
  }
}
