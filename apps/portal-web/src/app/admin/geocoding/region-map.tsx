// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { ChevronRight, Loader2, Plus } from 'lucide-react';

import { ensureMapLibreWorker } from '@/lib/maplibre-runtime';
import { useT } from '@/lib/i18n/locale-context';

const API = '/api/portal/admin/geocoder/regions/outlines';

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

interface OutlineProps {
  id: string;
  name: string;
  hasChildren: boolean;
}

type Outlines = GeoJSON.FeatureCollection<GeoJSON.Geometry, OutlineProps>;

const EMPTY: Outlines = { type: 'FeatureCollection', features: [] };

/** [west, south, east, north] of every coordinate in the collection. */
function boundsOf(fc: Outlines): maplibregl.LngLatBoundsLike | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      w = Math.min(w, c[0]);
      e = Math.max(e, c[0]);
      s = Math.min(s, c[1]);
      n = Math.max(n, c[1]);
      return;
    }
    for (const inner of c) visit(inner);
  };
  for (const f of fc.features) visit((f.geometry as { coordinates?: unknown }).coordinates);
  if (!Number.isFinite(w)) return null;
  return [
    [Math.max(-180, w), Math.max(-85, s)],
    [Math.min(180, e), Math.min(85, n)],
  ];
}

/**
 * Pick geocoder regions on a map. Starts at the continents; click a
 * region to add it, or open it to see the regions inside. Picked
 * regions are filled.
 */
export function RegionMap({
  pickedIds,
  onAdd,
}: {
  pickedIds: string[];
  onAdd: (region: { id: string; name: string }) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const [outlines, setOutlines] = useState<Outlines>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OutlineProps | null>(null);
  const parent = trail.length > 0 ? trail[trail.length - 1]!.id : null;

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    ensureMapLibreWorker();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [0, 20],
      zoom: 0.5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('regions', { type: 'geojson', data: EMPTY, promoteId: 'id' });
      map.addLayer({
        id: 'regions-fill',
        type: 'fill',
        source: 'regions',
        paint: {
          'fill-color': '#0ea5e9',
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'picked'], false],
            0.45,
            ['boolean', ['feature-state', 'hover'], false],
            0.25,
            0.08,
          ],
        },
      });
      map.addLayer({
        id: 'regions-line',
        type: 'line',
        source: 'regions',
        paint: { 'line-color': '#0369a1', 'line-width': 1 },
      });
      let hovered: string | null = null;
      map.on('mousemove', 'regions-fill', (e) => {
        const id = e.features?.[0]?.id;
        if (typeof id !== 'string' || id === hovered) return;
        if (hovered) map.setFeatureState({ source: 'regions', id: hovered }, { hover: false });
        hovered = id;
        map.setFeatureState({ source: 'regions', id }, { hover: true });
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'regions-fill', () => {
        if (hovered) map.setFeatureState({ source: 'regions', id: hovered }, { hover: false });
        hovered = null;
        map.getCanvas().style.cursor = '';
      });
      map.on('click', 'regions-fill', (e) => {
        const p = e.features?.[0]?.properties as
          | { id?: string; name?: string; hasChildren?: boolean | string }
          | undefined;
        if (!p?.id || !p.name) return;
        setSelected({
          id: p.id,
          name: p.name,
          hasChildren: p.hasChildren === true || p.hasChildren === 'true',
        });
      });
      setReady(true);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Load the outlines for the current level.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    fetch(parent ? `${API}?parent=${encodeURIComponent(parent)}` : API)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Outlines;
      })
      .then((fc) => {
        if (!cancelled) setOutlines(fc);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parent]);

  // Draw them and fit the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('regions') as maplibregl.GeoJSONSource | undefined)?.setData(outlines);
    const b = boundsOf(outlines);
    if (b && outlines.features.length > 0) map.fitBounds(b, { padding: 20, duration: 400 });
  }, [ready, outlines]);

  // Fill the picked ones.
  const pickedKey = pickedIds.join(',');
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const picked = new Set(pickedKey ? pickedKey.split(',') : []);
    for (const f of outlines.features) {
      map.setFeatureState(
        { source: 'regions', id: f.properties.id },
        { picked: picked.has(f.properties.id) },
      );
    }
  }, [ready, outlines, pickedKey]);

  const alreadyPicked = selected ? pickedIds.includes(selected.id) : false;

  return (
    <div className="mt-3 space-y-2">
      <nav aria-label={t('adminGeocoding.mapTrail')} className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          className={`rounded px-1 ${trail.length === 0 ? 'font-medium' : 'text-accent hover:underline'}`}
          onClick={() => setTrail([])}
          disabled={trail.length === 0}
        >
          {t('adminGeocoding.mapWorld')}
        </button>
        {trail.map((step, i) => (
          <span key={step.id} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted" />
            <button
              type="button"
              className={`rounded px-1 ${i === trail.length - 1 ? 'font-medium' : 'text-accent hover:underline'}`}
              onClick={() => setTrail((prev) => prev.slice(0, i + 1))}
              disabled={i === trail.length - 1}
            >
              {step.name}
            </button>
          </span>
        ))}
        {loading ? <Loader2 className="ml-1 h-3 w-3 animate-spin text-muted" /> : null}
      </nav>
      <div
        ref={containerRef}
        className="h-80 w-full overflow-hidden rounded-md border border-border"
        role="application"
        aria-label={t('adminGeocoding.mapLabel')}
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          <span className="font-medium">{selected.name}</span>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs disabled:opacity-50"
            disabled={alreadyPicked}
            onClick={() => onAdd({ id: selected.id, name: selected.name })}
          >
            <Plus className="h-3.5 w-3.5" />
            {alreadyPicked ? t('adminGeocoding.mapAdded') : t('adminGeocoding.mapAdd')}
          </button>
          {selected.hasChildren ? (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs"
              onClick={() => setTrail((prev) => [...prev, { id: selected.id, name: selected.name }])}
            >
              <ChevronRight className="h-3.5 w-3.5" />
              {t('adminGeocoding.mapOpen')}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">{t('adminGeocoding.mapHelp')}</p>
      )}
    </div>
  );
}
