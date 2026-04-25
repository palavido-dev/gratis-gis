'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Crosshair, MapPin, X } from 'lucide-react';

/**
 * Inset MapLibre canvas that lets the user pick an area of interest
 * for the items list. Pan / zoom to the area, then click "Use this
 * area" to fire a spatial filter against /api/portal/items?bbox=...
 *
 * Stays small intentionally (~360px tall): this is a discovery aid,
 * not a full map editor. The single OSM raster source keeps the
 * dependency footprint identical to what the geo_boundary editor and
 * map canvas already use.
 *
 * The component does not own the result list. It calls back with the
 * captured bbox + buffer; the parent fetches the items.
 */
interface Props {
  /** Initial bbox to seed the camera (skips the world view). */
  initialBbox?: [number, number, number, number];
  /** Initial buffer in km (defaults to 0). */
  initialBufferKm?: number;
  /** Currently fetching the spatial result. Used to disable the apply button. */
  busy?: boolean;
  /** User clicked "Use this area"; receives the current camera bbox. */
  onApply: (bbox: [number, number, number, number], bufferKm: number) => void;
  /** User clicked "Cancel". The parent typically just hides the panel. */
  onClose: () => void;
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

export function AreaSearchPanel({
  initialBbox,
  initialBufferKm = 0,
  busy = false,
  onApply,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [bufferKm, setBufferKm] = useState<number>(initialBufferKm);
  const [bufferText, setBufferText] = useState<string>(String(initialBufferKm));

  // Boot a single map instance for the lifetime of this panel.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    // Fit to seed bbox if we have one. Padding keeps the bbox edges
    // off the canvas border so the user sees a bit of context.
    if (initialBbox) {
      const [w, s, e, n] = initialBbox;
      map.once('load', () => {
        map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 24, animate: false },
        );
      });
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // initialBbox is captured at first mount; subsequent changes are
    // intentionally ignored so panning the map doesn't get reset by a
    // stale parent prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flyToMyLocation() {
    const map = mapRef.current;
    if (!map || typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.flyTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: 11,
          duration: 600,
        });
      },
      () => {
        /* permission denied or no fix available; silently no-op */
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 },
    );
  }

  function handleApply() {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox: [number, number, number, number] = [
      b.getWest(),
      b.getSouth(),
      b.getEast(),
      b.getNorth(),
    ];
    onApply(bbox, bufferKm);
  }

  function handleBufferChange(raw: string) {
    setBufferText(raw);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      setBufferKm(n);
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-ink-1">
          <Crosshair className="h-4 w-4 text-accent" />
          <span className="font-medium">Search by area</span>
          <span className="text-xs text-muted">
            Pan and zoom to an area, then apply.
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label="Close area search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        ref={containerRef}
        className="h-[320px] w-full"
        style={{ position: 'relative' }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-3 py-2">
        <button
          type="button"
          onClick={flyToMyLocation}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 hover:bg-surface-2"
          title="Center the map on your current location"
        >
          <MapPin className="h-3 w-3" />
          My location
        </button>
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          Pad area by
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={bufferText}
            onChange={(e) => handleBufferChange(e.target.value)}
            className="h-7 w-20 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
          km
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-1 px-2.5 text-xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={busy}
            className="inline-flex h-7 items-center rounded-md border border-accent bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Searching...' : 'Use this area'}
          </button>
        </div>
      </div>
    </div>
  );
}
