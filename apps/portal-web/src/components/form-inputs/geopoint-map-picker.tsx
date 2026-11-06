// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Tap-on-map location picker for the `geopoint` question.
 *
 * The schema has always offered `capture: 'map'` (and `auto`, "prefer
 * GPS, fall back to map-pick"), but the runtime only ever drew a GPS
 * button and lat/lon text boxes. A respondent standing somewhere other
 * than the point they are reporting, or indoors with no fix, had no
 * way to answer. This is that missing control: tap the map or drag the
 * pin, the same gesture ArcGIS Survey123 and Field Maps use.
 *
 * MapLibre is imported lazily inside the effect rather than at module
 * scope. The form runtime is also the public respond page, and most
 * forms have no geopoint question; a static import would put the whole
 * map engine on every one of them (and into the Jest module graph,
 * where maplibre-gl is stubbed to throw).
 *
 * The basemap is plain OpenStreetMap raster, the same fallback the
 * other small map surfaces use (item preview, bbox preview), because a
 * form has no map item of its own to borrow a basemap from.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';

export interface GeoPointValue {
  lat: number;
  lng: number;
  accuracy?: number;
}

interface Props {
  value: GeoPointValue | null;
  readOnly: boolean;
  onChange: (v: GeoPointValue) => void;
  /** Accessible name for the map region. */
  ariaLabel: string;
  /** Hint shown under the map while it is editable. */
  hint: string;
  /** The map could not be built (MapLibre failed to load, no WebGL).
   *  The picker then renders nothing; the caller offers another way
   *  to answer. */
  onFailed?: () => void;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** World view when nothing is known yet. */
const WORLD_CENTER: [number, number] = [0, 15];
const WORLD_ZOOM = 1;
/** Close enough to place a pin on a building. */
const POINT_ZOOM = 16;

function isValidPoint(p: GeoPointValue | null): p is GeoPointValue {
  return (
    p !== null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/** Six decimals is ~0.1 m, more than any tap can resolve. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function GeoPointMapPicker({
  value,
  readOnly,
  onChange,
  ariaLabel,
  hint,
  onFailed,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const libRef = useRef<typeof maplibregl | null>(null);
  const [failed, setFailed] = useState(false);

  // Latest props for handlers registered once at mount.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const valueRef = useRef(value);
  valueRef.current = value;

  function placeMarker(lng: number, lat: number) {
    const lib = libRef.current;
    const m = mapRef.current;
    if (!lib || !m) return;
    if (!markerRef.current) {
      const marker = new lib.Marker({ draggable: !readOnlyRef.current, color: '#2563eb' })
        .setLngLat([lng, lat])
        .addTo(m);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        onChangeRef.current({ lat: round6(ll.lat), lng: round6(ll.lng) });
      });
      markerRef.current = marker;
    } else {
      markerRef.current.setLngLat([lng, lat]);
    }
  }

  // Mount once.
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;
    void (async () => {
      try {
        const lib = await import('maplibre-gl');
        const { ensureMapLibreWorker } = await import('@/lib/maplibre-runtime');
        if (cancelled || !containerRef.current) return;
        ensureMapLibreWorker();
        libRef.current = lib;
        const start = valueRef.current;
        const m = new lib.Map({
          container: el,
          style: OSM_STYLE,
          center: isValidPoint(start) ? [start.lng, start.lat] : WORLD_CENTER,
          zoom: isValidPoint(start) ? POINT_ZOOM : WORLD_ZOOM,
          attributionControl: { compact: true },
          // A form scrolls; a map that swallows the wheel traps the
          // respondent inside it. Ctrl/⌘ + wheel still zooms.
          cooperativeGestures: true,
        });
        m.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        mapRef.current = m;
        if (isValidPoint(start)) placeMarker(start.lng, start.lat);
        m.on('click', (e) => {
          if (readOnlyRef.current) return;
          const lat = round6(e.lngLat.lat);
          const lng = round6(e.lngLat.lng);
          placeMarker(lng, lat);
          onChangeRef.current({ lat, lng });
        });
      } catch {
        if (!cancelled) {
          setFailed(true);
          onFailedRef.current?.();
        }
      }
    })();
    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Mount-only: later value changes are synced by the effect below.
  }, []);

  // Follow value changes made elsewhere (GPS capture, lat/lon boxes,
  // clearing the answer) without rebuilding the map.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!isValidPoint(value)) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const current = markerRef.current?.getLngLat();
    const moved =
      !current ||
      Math.abs(current.lat - value.lat) > 1e-7 ||
      Math.abs(current.lng - value.lng) > 1e-7;
    if (!moved) return;
    placeMarker(value.lng, value.lat);
    const inView = m.getBounds().contains([value.lng, value.lat]);
    if (!inView || m.getZoom() < 10) {
      m.easeTo({ center: [value.lng, value.lat], zoom: Math.max(m.getZoom(), POINT_ZOOM) });
    }
    // placeMarker reads refs only.
  }, [value?.lat, value?.lng]);

  useEffect(() => {
    markerRef.current?.setDraggable(!readOnly);
  }, [readOnly]);

  if (failed) return null;

  return (
    <div className="space-y-1">
      <div
        ref={containerRef}
        role="region"
        aria-label={ariaLabel}
        className="h-60 w-full overflow-hidden rounded-md border border-border bg-surface-2"
      />
      {!readOnly ? <p className="text-2xs text-muted">{hint}</p> : null}
    </div>
  );
}
