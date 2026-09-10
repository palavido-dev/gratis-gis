// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import type * as maplibregl from 'maplibre-gl';
import type { GpsPosition } from './use-geolocation';

/**
 * Manages the "you are here" blue dot + accuracy ring overlay on top of
 * the field-runtime map. Two MapLibre layers backed by one source:
 *
 *   - <id>-ring  (circle) -- translucent disc whose radius matches the
 *                            reported horizontal accuracy in meters.
 *                            Radius is computed in pixels per zoom level
 *                            because MapLibre's circle-radius doesn't
 *                            accept meter units. Recomputed on the
 *                            map's `move` / `zoom` events.
 *   - <id>-dot   (circle) -- the solid blue dot itself, fixed pixel
 *                            size with a white outline so it stays
 *                            visible against any basemap.
 *
 * Layer ids are namespaced so they can't collide with feature layers.
 * Source data is a single Point feature; we mutate setData() on each
 * GPS update rather than removing/re-adding the source.
 *
 * Source-of-truth for the source's radiusM property is the GpsPosition
 * passed in; the layer's `circle-radius` reads it via interpolate so
 * the disc resizes without our touching it on every fix.
 *
 * Keeping all of this in one helper means the runtime component just
 * has to call `attach(map)` once on map-ready and `update(position)`
 * whenever the position changes.
 */

const SOURCE_ID = 'gg-gps-source';
const RING_LAYER_ID = 'gg-gps-ring';
const DOT_LAYER_ID = 'gg-gps-dot';

/**
 * MapLibre's circle-radius is in pixels. To paint a disc that
 * represents N meters on the ground, we have to compute pixels-per-meter
 * for the current latitude + zoom and scale accordingly. This helper
 * matches MapLibre's interpolation-friendly form: we attach the meter
 * radius as a property and use a step / let expression.
 *
 * Practical formula at the equator: pixelsPerMeter = 256 *
 * 2^zoom / (40075016.686 * cos(lat)). We embed it via a runtime
 * recompute on move because expressing trig in a style expression is
 * unwieldy and the recompute is one operation per move event.
 */
export interface GpsMarkerHandle {
  /** Idempotent attach. Safe to call after a style reload. */
  attach: () => void;
  /** Push a new position into the source. Pass `null` to hide the
   *  marker (and stop reading-pixels-per-meter on move). */
  update: (pos: GpsPosition | null) => void;
  /** Detach: removes layers, source, and the move listener. */
  detach: () => void;
}

export function createGpsMarker(map: maplibregl.Map): GpsMarkerHandle {
  let lastPosition: GpsPosition | null = null;

  function recomputeRingRadiusPx(): number {
    if (!lastPosition) return 0;
    const lat = lastPosition.lat;
    const zoom = map.getZoom();
    const metersPerPixel =
      (40075016.686 * Math.cos((lat * Math.PI) / 180)) /
      (256 * Math.pow(2, zoom));
    if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
    return lastPosition.accuracyM / metersPerPixel;
  }

  function pushSourceData() {
    const source = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (!source) return;
    if (!lastPosition) {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    source.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [lastPosition.lon, lastPosition.lat],
          },
          properties: {
            ringPx: recomputeRingRadiusPx(),
            heading: lastPosition.headingDeg,
          },
        },
      ],
    });
  }

  function ensureSourceAndLayers() {
    // MapLibre throws "Style is not done loading" if addSource /
    // addLayer fires before the style is fully ready. Gate every
    // entry point through isStyleLoaded() so no caller can trip the
    // race -- the styledata listener will retry once the style
    // settles.
    if (!map.isStyleLoaded()) return;
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer(RING_LAYER_ID)) {
      map.addLayer({
        id: RING_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': [
            'max',
            // Always at least 6 px so a sub-meter accuracy fix at low
            // zoom doesn't disappear into the dot.
            6,
            ['get', 'ringPx'],
          ],
          'circle-color': '#3b82f6',
          'circle-opacity': 0.18,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#3b82f6',
          'circle-stroke-opacity': 0.45,
        },
      });
    }
    if (!map.getLayer(DOT_LAYER_ID)) {
      map.addLayer({
        id: DOT_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        paint: {
          'circle-radius': 7,
          'circle-color': '#1d4ed8',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }

  // Recompute the ring's pixel radius on every zoom because the
  // meters-to-pixels ratio changes with zoom level. This is cheap (one
  // setData call with the same coords + a different ringPx).
  const onMove = () => {
    if (lastPosition) pushSourceData();
  };

  const onStyleData = () => {
    // After a basemap swap MapLibre wipes the style; we have to
    // re-add our source + layers. Triggered for any style mutation
    // (style.load) so the guard inside ensureSourceAndLayers keeps
    // it idempotent.
    ensureSourceAndLayers();
    pushSourceData();
  };

  return {
    attach() {
      // Wire the events first so the styledata handler picks up the
      // initial style load if attach() ran before the map's style is
      // fully ready. ensureSourceAndLayers() calls addSource /
      // addLayer, which throw "Style is not done loading" if the
      // style hasn't completed loading -- iOS Safari sometimes fires
      // MapLibre's 'load' event slightly before isStyleLoaded() flips
      // true, and the styledata handler is then the path that wires
      // the layers in. Calling ensureSourceAndLayers() inline here
      // would throw on that race.
      map.on('zoom', onMove);
      map.on('styledata', onStyleData);
      if (map.isStyleLoaded()) {
        ensureSourceAndLayers();
      } else {
        map.once('load', () => {
          ensureSourceAndLayers();
          pushSourceData();
        });
      }
    },
    update(pos) {
      lastPosition = pos;
      // Style might not be loaded yet on the first call; queue until it is.
      if (!map.isStyleLoaded()) {
        map.once('load', () => {
          ensureSourceAndLayers();
          pushSourceData();
        });
        return;
      }
      ensureSourceAndLayers();
      pushSourceData();
    },
    detach() {
      map.off('zoom', onMove);
      map.off('styledata', onStyleData);
      if (map.getLayer(DOT_LAYER_ID)) map.removeLayer(DOT_LAYER_ID);
      if (map.getLayer(RING_LAYER_ID)) map.removeLayer(RING_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    },
  };
}
