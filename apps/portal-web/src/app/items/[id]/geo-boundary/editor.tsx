'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  AlertTriangle,
  Clipboard,
  Info,
  Loader2,
  Save,
  Trash2,
  Upload as UploadIcon,
} from 'lucide-react';
import type {
  GeoBoundaryData,
  GeoBoundaryGeometry,
} from '@gratis-gis/shared-types';
import { importSpatialFile } from '@/lib/spatial-import';

/**
 * Minimal raster OSM style used as the preview backdrop. The geo-
 * boundary editor never depends on the org's basemap item library --
 * this page needs to work the moment a new org is created, before any
 * basemap items have been seeded, and a shape-on-a-map preview only
 * needs a neutral backdrop anyway. Inlined here because the old
 * `BASEMAPS` hardcoded record has been removed in favour of the
 * items-based library.
 */
const PREVIEW_BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    raster: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '(c) OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
};

/**
 * Editor for a `geo_boundary` item. Three ways to author the
 * geometry:
 *
 *   1. Upload a vector file (GeoJSON / KML / KMZ / Shapefile .zip).
 *      The existing spatial-import helper does the parse; we then
 *      extract every Polygon / MultiPolygon feature and merge them
 *      into a single MultiPolygon so the boundary stays a single
 *      region.
 *   2. Paste GeoJSON text (Polygon, MultiPolygon, Feature, or
 *      FeatureCollection). Same extraction path as the upload.
 *   3. Manual editing of the note + "clear geometry" — a
 *      starting-from-scratch state.
 *
 * Draw-on-map polygon authoring is a deliberate follow-up; it
 * needs a drawing library wired into MapLibre (terra-draw is
 * installed but not yet integrated) and its own focused pass.
 * For now the map below is a read-only preview that auto-fits to
 * whatever the current geometry is.
 *
 * Unit of work is the whole item.data blob. We patch /items/:id
 * with `{ data: { ...GeoBoundaryData } }` and let the server
 * snapshot the prior state the same way data_layer replaces
 * are snapshotted — so an admin can un-revert if someone pastes
 * garbage over a good boundary.
 */
interface Props {
  itemId: string;
  initial: GeoBoundaryData;
  canEdit: boolean;
}

type TabKind = 'upload' | 'paste';

export function GeoBoundaryEditor({ itemId, initial, canEdit }: Props) {
  const [draft, setDraft] = useState<GeoBoundaryData>(initial);
  const [tab, setTab] = useState<TabKind>('upload');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      // Compute area + bbox client-side so the detail header /
      // listing surfaces don't need to recompute. Source of truth
      // remains `geometry`; these are cached summary fields.
      const summary = draft.geometry ? summarize(draft.geometry) : null;
      const payload: GeoBoundaryData = {
        ...draft,
        ...(summary
          ? { areaKm2: summary.areaKm2, bbox: summary.bbox }
          : (() => {
              // Geometry got cleared — drop the stale summary.
              const { areaKm2: _a, bbox: _b, ...rest } = draft;
              return rest;
            })()),
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body as { message?: string | string[] }).message ??
          `HTTP ${res.status}`;
        setError(Array.isArray(msg) ? msg.join('; ') : msg);
        return;
      }
      setDraft(payload);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function applyGeometry(next: GeoBoundaryGeometry | null) {
    setDraft((d) => ({ ...d, geometry: next }));
    setError(null);
  }

  return (
    <section className="mb-6 space-y-4 rounded-lg border border-border bg-surface-1 p-4">
      <header>
        <h2 className="text-sm font-medium text-ink-0">Boundary geometry</h2>
        <p className="text-xs text-muted">
          Define the polygon (or multi-polygon) that represents this
          boundary. Other items — shares, maps, filters — can
          reference this boundary once saved.
        </p>
      </header>

      <BoundaryPreview geometry={draft.geometry} />

      {canEdit ? (
        <>
          <Tabs current={tab} onChange={setTab} />
          {tab === 'upload' ? (
            <UploadPanel onApply={applyGeometry} />
          ) : (
            <PastePanel onApply={applyGeometry} />
          )}

          <NoteField
            value={draft.note ?? ''}
            onChange={(note) =>
              // exactOptionalPropertyTypes: build the next object
              // without a `note` key at all when the value is empty,
              // rather than setting it to undefined. Keeps the shape
              // compatible with the `note?: string` type.
              setDraft((d) => {
                const { note: _prev, ...rest } = d;
                return note ? { ...rest, note } : rest;
              })
            }
          />

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {draft.geometry ? (
                <button
                  type="button"
                  onClick={() => applyGeometry(null)}
                  className="inline-flex items-center gap-1 rounded border border-border bg-surface-0 px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  <Trash2 className="h-3 w-3" />
                  Clear geometry
                </button>
              ) : null}
              {savedNotice ? (
                <span className="text-xs text-emerald-700">Saved</span>
              ) : dirty ? (
                <span className="text-xs text-muted">Unsaved changes</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save boundary
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted">
          You don't have edit access on this boundary; the preview
          above is read-only.
        </p>
      )}

      <p className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-2 text-[11px] text-muted">
        <Info className="mr-1 inline h-3 w-3" />
        Draw-on-map polygon authoring is a planned follow-up. For now
        you can author in ArcGIS Pro / QGIS / geojson.io and bring the
        result here via upload or paste.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------
// Map preview — read-only; auto-fits to the current geometry and
// renders a translucent fill + outline so the shape reads clearly
// on any basemap.
// ---------------------------------------------------------------

function BoundaryPreview({ geometry }: { geometry: GeoBoundaryGeometry | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // One-time map init. Inline OSM style keeps this page from
  // depending on the org's basemap item library; admins editing their
  // first boundary still see a real map even if nothing is seeded.
  useEffect(() => {
    if (!containerRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: PREVIEW_BASEMAP_STYLE,
      center: [-98, 39],
      zoom: 3,
      attributionControl: { compact: true },
    });
    mapRef.current = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));
    return () => {
      m.remove();
      mapRef.current = null;
    };
  }, []);

  // Sync the geometry into a 'boundary' source + fill/line layers
  // whenever it changes.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const apply = () => {
      const src = m.getSource('boundary') as
        | maplibregl.GeoJSONSource
        | undefined;
      // Cast through `unknown` because GeoBoundaryGeometry's union
      // type ('Polygon' | 'MultiPolygon') is structurally narrower
      // than GeoJSON.Geometry and TS can't widen implicitly.
      const feature: GeoJSON.Feature = geometry
        ? ({
            type: 'Feature',
            geometry: geometry as unknown as GeoJSON.Geometry,
            properties: {},
          } as GeoJSON.Feature)
        : (null as unknown as GeoJSON.Feature);
      const data: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: geometry ? [feature] : [],
      };
      if (!src) {
        m.addSource('boundary', { type: 'geojson', data });
        m.addLayer({
          id: 'boundary-fill',
          type: 'fill',
          source: 'boundary',
          paint: {
            'fill-color': '#2563eb',
            'fill-opacity': 0.2,
          },
        });
        m.addLayer({
          id: 'boundary-line',
          type: 'line',
          source: 'boundary',
          paint: {
            'line-color': '#1d4ed8',
            'line-width': 2,
          },
        });
      } else {
        src.setData(data);
      }
      if (geometry) {
        const b = computeBBox(geometry);
        if (b) {
          m.fitBounds(
            [
              [b[0], b[1]],
              [b[2], b[3]],
            ],
            { padding: 40, duration: 600, maxZoom: 12 },
          );
        }
      }
    };
    if (m.isStyleLoaded()) apply();
    else m.once('load', apply);
  }, [geometry]);

  return (
    <div
      ref={containerRef}
      className="h-[360px] w-full overflow-hidden rounded-md border border-border bg-surface-0"
    />
  );
}

// ---------------------------------------------------------------
// Authoring tabs
// ---------------------------------------------------------------

function Tabs({
  current,
  onChange,
}: {
  current: TabKind;
  onChange: (next: TabKind) => void;
}) {
  const tabs: Array<{ kind: TabKind; label: string; icon: typeof UploadIcon }> =
    [
      { kind: 'upload', label: 'Upload file', icon: UploadIcon },
      { kind: 'paste', label: 'Paste GeoJSON', icon: Clipboard },
    ];
  return (
    <div className="flex gap-1 border-b border-border text-xs">
      {tabs.map(({ kind, label, icon: Icon }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onChange(kind)}
          className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 ${
            kind === current
              ? 'border-accent text-accent'
              : 'border-transparent text-muted hover:text-ink-1'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

function UploadPanel({
  onApply,
}: {
  onApply: (geom: GeoBoundaryGeometry | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(f: File) {
    setBusy(true);
    setErr(null);
    try {
      const res = await importSpatialFile(f);
      const g = extractPolygonGeometry(res.geojson);
      if (!g) {
        setErr(
          `No Polygon / MultiPolygon features in this file (read ${res.features} features). Boundaries need at least one polygon.`,
        );
        return;
      }
      onApply(g);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read that file.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="rounded border border-dashed border-border bg-surface-0 p-3">
      <p className="mb-2 text-xs text-ink-1">
        Drop or pick a <code>.geojson</code>, <code>.kml</code>,{' '}
        <code>.kmz</code>, or zipped shapefile. We read it in the browser
        (no upload to the server) and pull out every Polygon /
        MultiPolygon feature, merging them into a single boundary.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".geojson,.json,.kml,.kmz,.zip"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
        className="block w-full text-xs file:mr-3 file:rounded file:border file:border-border file:bg-surface-1 file:px-2 file:py-1 file:text-xs file:text-ink-1 hover:file:bg-surface-2"
      />
      {busy ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Parsing…
        </p>
      ) : null}
      {err ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-danger">
          <AlertTriangle className="h-3 w-3" />
          {err}
        </p>
      ) : null}
    </div>
  );
}

function PastePanel({
  onApply,
}: {
  onApply: (geom: GeoBoundaryGeometry | null) => void;
}) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function handleApply() {
    setErr(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setErr('Paste a GeoJSON Polygon, MultiPolygon, Feature, or FeatureCollection.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      setErr('That text is not valid JSON.');
      return;
    }
    const g = extractPolygonGeometryFromAny(parsed);
    if (!g) {
      setErr(
        'No Polygon / MultiPolygon found. Expected Polygon, MultiPolygon, a Feature wrapping one of those, or a FeatureCollection containing at least one polygon feature.',
      );
      return;
    }
    onApply(g);
    setText('');
  }

  return (
    <div className="rounded border border-dashed border-border bg-surface-0 p-3">
      <p className="mb-2 text-xs text-ink-1">
        Paste raw GeoJSON. Polygon, MultiPolygon, Feature, and
        FeatureCollection all work; non-polygon features in a collection
        are ignored.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder='{"type":"Polygon","coordinates":[[[-122.5,37.6],…]]}'
        className="block w-full rounded border border-border bg-surface-0 p-2 font-mono text-[11px]"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleApply}
          className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1 hover:bg-surface-2"
        >
          Apply to preview
        </button>
      </div>
      {err ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-danger">
          <AlertTriangle className="h-3 w-3" />
          {err}
        </p>
      ) : null}
    </div>
  );
}

function NoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">
        Author note (optional)
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="What is this boundary for, and who maintains it?"
        className="block w-full rounded border border-border bg-surface-0 p-2 text-xs"
      />
    </label>
  );
}

// ---------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------

/**
 * Walk a FeatureCollection, extract every Polygon + MultiPolygon,
 * and return them as a single MultiPolygon (or a Polygon if there's
 * only one). Returns null when no polygons are present.
 */
function extractPolygonGeometry(
  fc: GeoJSON.FeatureCollection,
): GeoBoundaryGeometry | null {
  const polys: GeoJSON.Position[][][] = [];
  for (const feat of fc.features) {
    const g = feat.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
  }
  if (polys.length === 0) return null;
  if (polys.length === 1) {
    return { type: 'Polygon', coordinates: polys[0] };
  }
  return { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Accepts Polygon / MultiPolygon geometry, a Feature wrapping one, or a
 * FeatureCollection. Returns the same "one boundary as Polygon or
 * MultiPolygon" normalisation as the uploader.
 */
function extractPolygonGeometryFromAny(
  raw: unknown,
): GeoBoundaryGeometry | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as { type?: unknown };
  if (v.type === 'Polygon' || v.type === 'MultiPolygon') {
    return raw as GeoBoundaryGeometry;
  }
  if (v.type === 'Feature') {
    const geom = (raw as { geometry?: unknown }).geometry;
    if (!geom) return null;
    return extractPolygonGeometryFromAny(geom);
  }
  if (v.type === 'FeatureCollection') {
    return extractPolygonGeometry(raw as GeoJSON.FeatureCollection);
  }
  return null;
}

/**
 * Minimum / maximum longitude + latitude of a polygon geometry.
 * Walks every coord exactly once; no external dep.
 */
function computeBBox(
  g: GeoBoundaryGeometry,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coord: GeoJSON.Position) => {
    // Positions are [lon, lat, (elev)]; we only care about the first
    // two. Under noUncheckedIndexedAccess the 0 / 1 reads are typed
    // `number | undefined`, so we guard before comparing.
    const x = coord[0];
    const y = coord[1];
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const rings =
    g.type === 'Polygon'
      ? [g.coordinates as GeoJSON.Position[][]]
      : (g.coordinates as GeoJSON.Position[][][]);
  for (const poly of rings) {
    for (const ring of poly) {
      for (const pt of ring) visit(pt);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

/**
 * Rough spherical-polygon area in kmAï¿½, adequate for operator-facing
 * "this boundary covers N kmAï¿½" summaries. Not a replacement for
 * PostGIS on the server — the API still computes its own answer for
 * anywhere that needs precision.
 */
function polygonAreaKm2(rings: GeoJSON.Position[][]): number {
  const R = 6371; // Earth radius in km.
  if (rings.length === 0) return 0;
  const areaRing = (ring: GeoJSON.Position[]): number => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!a || !b) continue;
      const x1 = a[0];
      const y1 = a[1];
      const x2 = b[0];
      const y2 = b[1];
      if (
        typeof x1 !== 'number' ||
        typeof y1 !== 'number' ||
        typeof x2 !== 'number' ||
        typeof y2 !== 'number'
      ) {
        continue;
      }
      sum +=
        ((toRad(x2) - toRad(x1)) *
          (2 + Math.sin(toRad(y1)) + Math.sin(toRad(y2)))) /
        2;
    }
    return Math.abs(sum) * R * R;
  };
  // Outer ring positive, holes subtract. Guard the outer ring too —
  // noUncheckedIndexedAccess treats `rings[0]` as possibly undefined.
  const outer = rings[0];
  if (!outer) return 0;
  let area = areaRing(outer);
  for (let i = 1; i < rings.length; i += 1) {
    const hole = rings[i];
    if (hole) area -= areaRing(hole);
  }
  return area;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function summarize(
  g: GeoBoundaryGeometry,
): { areaKm2: number; bbox: [number, number, number, number] } | null {
  const bbox = computeBBox(g);
  if (!bbox) return null;
  const polys =
    g.type === 'Polygon'
      ? [g.coordinates as GeoJSON.Position[][]]
      : (g.coordinates as GeoJSON.Position[][][]);
  let total = 0;
  for (const poly of polys) total += polygonAreaKm2(poly);
  return { areaKm2: Math.round(total * 100) / 100, bbox };
}
