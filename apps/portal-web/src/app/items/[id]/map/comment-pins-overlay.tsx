// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Phase 2 comment pins. Renders a GeoJSON point per feature- or
 * drawing-anchored thread at the feature centroid, and routes pin
 * clicks back to the comments panel.
 */
import { useEffect, useMemo } from 'react';
import type * as maplibregl from 'maplibre-gl';
import type { DrawingSet } from '@gratis-gis/shared-types';
import {
  resolveCommentPin,
} from './comment-anchors';
import type { CommentThreadDTO } from './comments-panel';

const SOURCE_ID = 'comments:pins';
const LAYER_ID = 'comments:pins-circle';
const HALO_ID = 'comments:pins-halo';

interface Props {
  map: maplibregl.Map | null;
  threads: CommentThreadDTO[];
  drawings: DrawingSet[];
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null | undefined>;
  /** Hide resolved pins unless the panel is showing resolved. */
  showResolved: boolean;
  focusThreadId: string | null;
  onSelectThreadId: (threadId: string) => void;
}

export function CommentPinsOverlay({
  map,
  threads,
  drawings,
  featuresByLayer,
  showResolved,
  focusThreadId,
  onSelectThreadId,
}: Props) {
  const features = useMemo(() => {
    const out: GeoJSON.Feature[] = [];
    for (const thread of threads) {
      if (thread.resolved && !showResolved) continue;
      if (thread.parentKind !== 'feature' && thread.parentKind !== 'drawing') {
        continue;
      }
      const coord = resolveCommentPin({
        parentKind: thread.parentKind,
        parentId: thread.parentId,
        featuresByLayer,
        drawings,
      });
      if (!coord) continue;
      out.push({
        type: 'Feature',
        id: thread.id,
        geometry: { type: 'Point', coordinates: coord },
        properties: {
          threadId: thread.id,
          focused: focusThreadId === thread.id ? 1 : 0,
          resolved: thread.resolved ? 1 : 0,
        },
      });
    }
    return out;
  }, [threads, drawings, featuresByLayer, showResolved, focusThreadId]);

  useEffect(() => {
    if (!map) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features,
    };
    if (features.length === 0) {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getLayer(HALO_ID)) map.removeLayer(HALO_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      return;
    }
    const existing = map.getSource(SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) existing.setData(fc);
    addPins(map, fc);
    // A basemap switch replaces the style, which drops every source
    // and layer this overlay added. Put the pins back when the new
    // style is in. The layer-bound click handlers below are keyed by
    // layer id on the map, so they apply again once the layer exists.
    const restore = () => {
      try {
        if (map.isStyleLoaded() && !map.getSource(SOURCE_ID)) addPins(map, fc);
      } catch {
        /* style still loading; the next event retries */
      }
    };
    // styledata can arrive while sources are still loading; idle
    // always follows once the new style has settled.
    map.on('styledata', restore);
    map.on('idle', restore);
    return () => {
      map.off('styledata', restore);
      map.off('idle', restore);
    };
  }, [map, features]);

  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const threadId = f?.properties?.['threadId'];
      if (typeof threadId === 'string') onSelectThreadId(threadId);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
    };
    // Layers may not exist yet on first mount with zero pins.
    const bind = () => {
      if (!map.getLayer(LAYER_ID)) return false;
      map.on('click', LAYER_ID, onClick);
      map.on('mouseenter', LAYER_ID, onEnter);
      map.on('mouseleave', LAYER_ID, onLeave);
      return true;
    };
    if (!bind()) {
      // Retry once the effect above has added the layer.
      const t = window.setTimeout(() => {
        bind();
      }, 0);
      return () => {
        window.clearTimeout(t);
        try {
          map.off('click', LAYER_ID, onClick);
          map.off('mouseenter', LAYER_ID, onEnter);
          map.off('mouseleave', LAYER_ID, onLeave);
        } catch {
          /* layer gone */
        }
      };
    }
    return () => {
      try {
        map.off('click', LAYER_ID, onClick);
        map.off('mouseenter', LAYER_ID, onEnter);
        map.off('mouseleave', LAYER_ID, onLeave);
      } catch {
        /* layer gone */
      }
    };
  }, [map, onSelectThreadId, features.length]);

  return null;
}

/**
 * Add the pin source and its two layers when they are missing. Safe to
 * call again: anything already on the map is left alone.
 */
function addPins(map: maplibregl.Map, fc: GeoJSON.FeatureCollection): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: fc });
  }
  if (!map.getLayer(HALO_ID)) {
    map.addLayer({
      id: HALO_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-radius': 11,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#111827',
        'circle-stroke-width': 1,
      },
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-radius': [
          'case',
          ['==', ['get', 'focused'], 1],
          8,
          6,
        ],
        'circle-color': [
          'case',
          ['==', ['get', 'resolved'], 1],
          '#94a3b8',
          '#2563eb',
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  }
}
