// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Standalone freehand drawing overlay for capturing an AOI geometry
 * from a Custom Web App's map (#90).  Used by the recipe-run-panel's
 * runtime-draw feature-source input as the "Draw on map" affordance.
 *
 * Mounts directly against a MapLibre instance pulled from the
 * runtime's CustomMapsContext.  Adds an internal GeoJSON source +
 * line/fill layers to render the in-progress polygon (or line, or
 * point), wires click + dblclick + mousemove + keydown handlers,
 * and tears everything down cleanly on unmount.
 *
 * Geometry types supported:
 *   - polygon: click to drop vertices; double-click (or hit Enter)
 *     to close.  Auto-closes by appending the first vertex to the
 *     ring, matching GeoJSON Polygon semantics.
 *   - line:    click to drop vertices; double-click to finish.
 *     Final shape is a LineString.
 *   - point:   first click captures the geometry; no further input
 *     needed.
 *
 * The overlay is intentionally narrow: it owns no panel chrome and
 * no buttons of its own.  The recipe panel renders a thin status
 * banner ("Click points on the map; double-click to finish")
 * around it and exposes Cancel.  Keeps the surface modular -- a
 * future "draw as part of an editor widget" path can re-use this
 * file unchanged.
 */

import { useEffect, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';

export type DrawableGeometryType = 'point' | 'line' | 'polygon';

interface Props {
  map: maplibregl.Map;
  /** Geometry type the parameter wants.  Defaults to 'polygon'
   *  because that's the Select-By-Location case and most common AOI
   *  shape; point and line are supported when the parameter declares
   *  them. */
  geometryType?: DrawableGeometryType;
  /** Called with the captured GeoJSON Geometry when the user
   *  finishes drawing.  The overlay component handles teardown
   *  before invoking this callback. */
  onComplete: (geometry: GeoJSON.Geometry) => void;
  /** Called when the user cancels (presses Escape) or the parent
   *  unmounts the overlay before drawing completes. */
  onCancel: () => void;
}

// Unique source / layer ids so a transient drawing overlay can't
// collide with a layer the host map already mounted.  Kept stable
// across drawing sessions so we can defensively remove the same
// names on cleanup even if a prior teardown was interrupted.
const SRC_ID = '__recipe-draw-source';
const LAYER_FILL = '__recipe-draw-fill';
const LAYER_LINE_COMMITTED = '__recipe-draw-line-committed';
const LAYER_LINE_PREVIEW = '__recipe-draw-line-preview';
const LAYER_POINTS = '__recipe-draw-points';

export function MapDrawingOverlay({
  map,
  geometryType = 'polygon',
  onComplete,
  onCancel,
}: Props) {
  // Vertices accumulate in [lng, lat] pairs.  We keep a ref alongside
  // the state so the event handlers (mounted once) see the latest
  // array without needing a re-binding on every state change.
  const [points, setPoints] = useState<Array<[number, number]>>([]);
  const pointsRef = useRef<Array<[number, number]>>([]);
  pointsRef.current = points;

  // Hover position for the "next segment" preview.  Drives the
  // dashed line from the last committed vertex to the cursor.
  const hoverRef = useRef<[number, number] | null>(null);

  // Keep stable refs to the callbacks so the listener teardown
  // closure can call the latest versions.  Avoids "stale onComplete"
  // bugs when the parent passes a fresh function on every render.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    // Suspend the map's stock double-click zoom while the overlay
    // owns the canvas; otherwise finishing a polygon also zooms in.
    const dblClickEnabled = map.doubleClickZoom?.isEnabled?.() ?? true;
    map.doubleClickZoom?.disable?.();

    // Crosshair cursor signals "I'm in a drawing mode" without us
    // having to render a custom DOM overlay over the canvas.
    const prevCursor = map.getCanvas().style.cursor;
    map.getCanvas().style.cursor = 'crosshair';

    // Set up the source + layers.  We render three styles in one
    // source so the polygon fill, the outline (including the
    // dashed-to-cursor preview), and the vertex dots all stay in
    // sync as the user clicks.
    if (!map.getSource(SRC_ID)) {
      map.addSource(SRC_ID, {
        type: 'geojson',
        data: emptyCollection(),
      });
    }
    if (!map.getLayer(LAYER_FILL)) {
      map.addLayer({
        id: LAYER_FILL,
        type: 'fill',
        source: SRC_ID,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': '#3b82f6',
          'fill-opacity': 0.18,
        },
      });
    }
    // Committed outline: solid stroke over the rings the user has
    // clicked.  Filtered to features whose `preview` property is
    // false (or absent).
    if (!map.getLayer(LAYER_LINE_COMMITTED)) {
      map.addLayer({
        id: LAYER_LINE_COMMITTED,
        type: 'line',
        source: SRC_ID,
        filter: [
          'all',
          ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
          ['!=', ['get', 'preview'], true],
        ],
        paint: {
          'line-color': '#3b82f6',
          'line-width': 2,
        },
      });
    }
    // Preview segment: dashed stroke from the last committed vertex
    // to the cursor (plus the closing edge for polygons).  Split
    // into its own layer because MapLibre rejects data expressions
    // on `line-dasharray`; each layer paints with a static dash
    // pattern and a filter discriminates by the `preview` property.
    if (!map.getLayer(LAYER_LINE_PREVIEW)) {
      map.addLayer({
        id: LAYER_LINE_PREVIEW,
        type: 'line',
        source: SRC_ID,
        filter: [
          'all',
          ['==', ['geometry-type'], 'LineString'],
          ['==', ['get', 'preview'], true],
        ],
        paint: {
          'line-color': '#3b82f6',
          'line-width': 2,
          'line-dasharray': [2, 2],
        },
      });
    }
    if (!map.getLayer(LAYER_POINTS)) {
      map.addLayer({
        id: LAYER_POINTS,
        type: 'circle',
        source: SRC_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-color': '#ffffff',
          'circle-stroke-color': '#3b82f6',
          'circle-stroke-width': 2,
          'circle-radius': 4,
        },
      });
    }

    function refreshSource() {
      const src = map.getSource(SRC_ID) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData(buildDisplay(pointsRef.current, hoverRef.current, geometryType));
    }
    refreshSource();

    function onClick(e: maplibregl.MapMouseEvent) {
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (geometryType === 'point') {
        // Single-click finish for point.  Avoid finishing on the
        // very first frame after mount (defensive against a stale
        // click event that pre-dates the listener attachment).
        const geom: GeoJSON.Point = {
          type: 'Point',
          coordinates: lngLat,
        };
        finish(geom);
        return;
      }
      // Polygon / line: append the click point.  pointsRef tracks
      // the source of truth so the listener doesn't capture stale
      // state when many clicks land before React re-renders.
      const next = [...pointsRef.current, lngLat];
      pointsRef.current = next;
      setPoints(next);
    }

    function onDoubleClick(e: maplibregl.MapMouseEvent) {
      // Browsers fire a click immediately before dblclick, so the
      // last point has already been appended by the click handler.
      // Drop the duplicate and finalize.
      e.preventDefault();
      const accumulated = pointsRef.current;
      if (geometryType === 'polygon') {
        // Need at least three distinct points + closure.
        if (accumulated.length < 3) return;
        const ring: Array<[number, number]> = [...accumulated, accumulated[0]!];
        const geom: GeoJSON.Polygon = {
          type: 'Polygon',
          coordinates: [ring],
        };
        finish(geom);
        return;
      }
      if (geometryType === 'line') {
        if (accumulated.length < 2) return;
        const geom: GeoJSON.LineString = {
          type: 'LineString',
          coordinates: accumulated,
        };
        finish(geom);
        return;
      }
    }

    function onMouseMove(e: maplibregl.MapMouseEvent) {
      hoverRef.current = [e.lngLat.lng, e.lngLat.lat];
      refreshSource();
    }

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        onCancelRef.current();
        return;
      }
      if (ev.key === 'Enter') {
        // Treat Enter as "finish" for polygon / line.  Same minimum-
        // point gates as double-click.
        const acc = pointsRef.current;
        if (geometryType === 'polygon' && acc.length >= 3) {
          finish({
            type: 'Polygon',
            coordinates: [[...acc, acc[0]!]],
          });
        } else if (geometryType === 'line' && acc.length >= 2) {
          finish({
            type: 'LineString',
            coordinates: acc,
          });
        }
      }
    }

    function finish(geometry: GeoJSON.Geometry) {
      onCompleteRef.current(geometry);
    }

    map.on('click', onClick);
    map.on('dblclick', onDoubleClick);
    map.on('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDoubleClick);
      map.off('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);

      // Tear down layers + source.  Wrapped in try/catch because a
      // map style swap mid-draw could have removed them already.
      for (const id of [LAYER_FILL, LAYER_LINE_COMMITTED, LAYER_LINE_PREVIEW, LAYER_POINTS]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id);
        } catch {
          /* ignore */
        }
      }
      try {
        if (map.getSource(SRC_ID)) map.removeSource(SRC_ID);
      } catch {
        /* ignore */
      }
      map.getCanvas().style.cursor = prevCursor;
      if (dblClickEnabled) map.doubleClickZoom?.enable?.();
    };
  }, [map, geometryType]);

  // The overlay renders nothing in the React tree; all visual
  // output lives on the MapLibre canvas.
  return null;
}

// ---- Helpers --------------------------------------------------------------

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Build the live display collection from the user's clicks + their
 * current hover position.  Renders:
 *   - committed vertices as Point features
 *   - a committed LineString / Polygon connecting them
 *   - a "preview" LineString from the last vertex to the cursor
 *     (and back to the first vertex when drawing a polygon) so the
 *     user can see what double-clicking right now will produce
 */
function buildDisplay(
  points: Array<[number, number]>,
  hover: [number, number] | null,
  geometryType: DrawableGeometryType,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  // Vertex dots.
  for (const p of points) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: p },
    });
  }

  if (geometryType === 'point') {
    // Nothing more to render -- point is single-click finish.
    return { type: 'FeatureCollection', features };
  }

  // Committed line (line / polygon while building).
  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { preview: false },
      geometry: { type: 'LineString', coordinates: points },
    });
  }

  // Closed polygon fill once we have three points.
  if (geometryType === 'polygon' && points.length >= 3) {
    features.push({
      type: 'Feature',
      properties: { preview: false },
      geometry: {
        type: 'Polygon',
        coordinates: [[...points, points[0]!]],
      },
    });
  }

  // Preview segment from last vertex to cursor.
  if (hover && points.length >= 1) {
    const last = points[points.length - 1]!;
    const preview: Array<[number, number]> = [last, hover];
    if (geometryType === 'polygon' && points.length >= 2) {
      // Also draw a dashed line back to the first vertex so the
      // user can see the closing segment a double-click will form.
      preview.push(points[0]!);
    }
    features.push({
      type: 'Feature',
      properties: { preview: true },
      geometry: { type: 'LineString', coordinates: preview },
    });
  }

  return { type: 'FeatureCollection', features };
}
