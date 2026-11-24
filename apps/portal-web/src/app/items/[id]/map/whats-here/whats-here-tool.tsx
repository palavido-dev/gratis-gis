// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * What's Here (#796): pick an area on the map and see what every layer
 * has inside it.
 *
 * One panel, top to bottom in the order a person thinks: where (draw,
 * a point, an address, or picked features), how far around it, then
 * the answer. Results come in as soon as there is an area, with no
 * setup: every visible layer reports its count, and polygon and line
 * layers report how much of them lies inside the area. Any layer can
 * be broken down by a category, which is the site-screen answer
 * ("148 acres of row crop, 27 of rural residential").
 *
 * Shared by the map builder's toolbar and the app widget, the way the
 * elevation profile is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as maplibregl from 'maplibre-gl';
import {
  BookmarkPlus,
  Circle as CircleIcon,
  Download,
  FileText,
  Hexagon,
  Link2,
  Loader2,
  MapPin,
  MousePointerClick,
  PenLine,
  RotateCcw,
  ScanSearch,
  Search,
  Square,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';

import { useLocale, useT } from '@/lib/i18n/locale-context';
import {
  appendToMarkup,
  MAX_MARKUP_VERTICES,
  vertexCount,
  type MarkupSaveContext,
} from '@/lib/markup-append';
import { importSpatialFile } from '@/lib/spatial-import';
import { clientUuid } from '@/lib/uuid';
import {
  AREA_UNIT_LABELS,
  DISTANCE_UNIT_LABELS,
  formatAreaIn,
  formatLengthIn,
  squareMetersPerAreaUnit,
  type AreaUnit,
  type DistanceUnit,
} from '@/lib/measure';
import {
  AreaExpiredError,
  DISTANCE_PRESETS,
  clearShareHash,
  decodeSharedArea,
  encodeSharedArea,
  readShareHash,
  shareUrl,
  MAX_DISTANCE_METERS,
  MAX_SUM_FIELDS,
  POINT_DEFAULT_METERS,
  initialUnits,
  profileUnitSystem,
  rememberUnits,
  percentOfArea,
  pickedAreaGeometry,
  registerArea,
  requestReport,
  screenCsv,
  screenLayer,
  snapshotMap,
  toMeters,
  type LayerScreen,
  type ResolvedArea,
  type SharedArea,
  type UnitSystem,
} from '@/lib/whats-here';
import { fetchFeatureFromServer } from '../fetch-feature';
import { geocode, type SearchResult } from '../search-sources';
import {
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useTerraDraw,
  type DrawMode,
} from '../use-terra-draw';
import { useScreenLayers, type ScreenLayerInfo } from './use-screen-layers';

// 'link' is an area that came in from outside the panel (a share link
// or an uploaded file): shown as is, not in the mode switch. Picking a
// mode starts over from there.
type AreaMode = 'draw' | 'point' | 'address' | 'features' | 'link';
type DrawShape = 'polygon' | 'rectangle' | 'circle' | 'freehand';

interface PickedFeature {
  key: string;
  layerTitle: string;
  label: string;
  geometry: GeoJSON.Geometry;
}

type LayerState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; screen: LayerScreen };

export interface WhatsHereToolProps {
  map: maplibregl.Map | null;
  open: boolean;
  onClose: () => void;
  /** The map's layers. Visible data layers are screened. */
  mapLayers: MapLayer[];
  /** Fired while the tool owns map clicks, so the host disarms others. */
  onDrawActiveChange?: (active: boolean) => void;
  /** Metric or imperial. Defaults to the user's profile setting. */
  unitSystem?: UnitSystem;
  /** Author's default units (an app widget's settings). The user can
   *  still change them, and their own last choice wins next time. */
  defaultAreaUnit?: AreaUnit;
  defaultLengthUnit?: DistanceUnit;
  /** An area from a share link (useSharedWhatsHere). Applied once,
   *  the first time the panel is open with it. */
  shared?: SharedArea | null;
  /** Lets the area be saved to the map's markup. Left out where there
   *  is no markup to save to (apps, a signed-out viewer). */
  markup?: MarkupSaveContext | undefined;
}

/**
 * The area in the page's `#wh=` share link, once decoded. A host opens
 * the panel when this turns non-null and passes it on as `shared`.
 */
export function useSharedWhatsHere(): SharedArea | null {
  const [shared, setShared] = useState<SharedArea | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => {
      const code = readShareHash();
      if (!code) return;
      void decodeSharedArea(code).then((area) => {
        if (!live) return;
        // A fresh object each time, so a link pasted into a tab that
        // already shows this map applies again.
        if (area) setShared({ ...area });
        else clearShareHash();
      });
    };
    check();
    window.addEventListener('hashchange', check);
    return () => {
      live = false;
      window.removeEventListener('hashchange', check);
    };
  }, []);
  return shared;
}

const OVERLAY_SOURCE = 'whats-here';
const OVERLAY_FILL = 'whats-here:fill';
const OVERLAY_LINE = 'whats-here:line';
const OVERLAY_POINT = 'whats-here:point';
const PICKED_SOURCE = 'whats-here:picked';
const PICKED_FILL = 'whats-here:picked-fill';
const PICKED_LINE = 'whats-here:picked-line';
const AREA_COLOR = '#0284c7';
const PICK_COLOR = '#f59e0b';
/** Maps shorter than this get the full-height panel placement. */
const COMPACT_BELOW_PX = 600;
/** Shapes one uploaded file may bring in. A site screen is a handful;
 *  a county's parcels are a data layer, not an area. */
const MAX_UPLOAD_SHAPES = 2000;
const UPLOAD_ACCEPT = '.geojson,.json,.kml,.kmz,.zip,.gpkg';

function hasArea(g: GeoJSON.Geometry): boolean {
  if (g.type === 'GeometryCollection') return g.geometries.some(hasArea);
  return g.type === 'Polygon' || g.type === 'MultiPolygon';
}
/** Wait this long after the last edit before asking the server. */
const RERUN_DELAY_MS = 350;

const DRAW_MODE: Record<DrawShape, DrawMode> = {
  polygon: 'polygon',
  rectangle: 'rectangle',
  circle: 'circle',
  freehand: 'freehand',
};

export function WhatsHereTool({
  map,
  open,
  onClose,
  mapLayers,
  onDrawActiveChange,
  unitSystem,
  defaultAreaUnit,
  defaultLengthUnit,
  shared,
  markup,
}: WhatsHereToolProps) {
  const t = useT();
  const locale = useLocale();
  const [system] = useState<UnitSystem>(() => unitSystem ?? profileUnitSystem());
  const [mode, setMode] = useState<AreaMode>('draw');
  const [shape, setShape] = useState<DrawShape>('polygon');
  // The shape as the user made it, before the distance.
  const [source, setSource] = useState<GeoJSON.Geometry | null>(null);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [customUnit, setCustomUnit] = useState<DistanceUnit>(
    system === 'metric' ? 'meters' : 'feet',
  );
  const [area, setArea] = useState<ResolvedArea | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [results, setResults] = useState<Record<string, LayerState>>({});
  const [breakdowns, setBreakdowns] = useState<Record<string, string>>({});
  // Map layer id to the number fields its results add up.
  const [sums, setSums] = useState<Record<string, string[]>>({});
  const [units, setUnits] = useState(() =>
    initialUnits({
      system,
      author: { areaUnit: defaultAreaUnit, lengthUnit: defaultLengthUnit },
    }),
  );
  const { areaUnit, lengthUnit } = units;
  const changeUnits = (patch: Partial<typeof units>) => {
    const next = { ...units, ...patch };
    setUnits(next);
    rememberUnits(next);
  };
  const [picked, setPicked] = useState<PickedFeature[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [linkFallback, setLinkFallback] = useState<string | null>(null);
  // What the 'link' mode says about where its area came from.
  const [givenNote, setGivenNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [markupNote, setMarkupNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { layers, loading: layersLoading } = useScreenLayers(mapLayers, open);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  useEffect(() => {
    onDrawActiveChange?.(open);
  }, [open, onDrawActiveChange]);

  // ---- Drawing --------------------------------------------------------

  const drawing = open && (mode === 'draw' || mode === 'point');
  const { draw, ready } = useTerraDraw(drawing ? map : null, { snapping: false });
  const [finished, setFinished] = useState(false);
  useCrosshairCursor(map, open && ((drawing && !finished) || mode === 'features'));

  // Freehand is press and drag, so a drag must draw, not pan. Turn the
  // map's drag panning off until the shape is finished.
  const freehandDrawing = open && mode === 'draw' && shape === 'freehand' && !finished;
  useEffect(() => {
    if (!map || !freehandDrawing) return;
    const wasOn = map.dragPan.isEnabled();
    map.dragPan.disable();
    return () => {
      if (wasOn) map.dragPan.enable();
    };
  }, [map, freehandDrawing]);

  useEffect(() => {
    if (!draw || !ready || !drawing) return;
    startDraw(draw);
    setDrawMode(draw, mode === 'point' ? 'point' : DRAW_MODE[shape]);
  }, [draw, ready, drawing, mode, shape]);

  // A finished shape stays selected so it can be dragged and reshaped;
  // every change after that reruns the screen.
  useEffect(() => {
    if (!draw || !ready || !drawing) return;
    const readShape = () => {
      const snap = draw.getSnapshot();
      for (let i = snap.length - 1; i >= 0; i--) {
        const f = snap[i]!;
        const m = f.properties?.mode;
        if (m === 'select' || !f.geometry) continue;
        const g = f.geometry as GeoJSON.Geometry;
        if (g.type === 'Point' || g.type === 'Polygon') return g;
      }
      return null;
    };
    const onFinish = (id: string | number, context?: { action?: string }) => {
      if (context?.action && context.action !== 'draw') return;
      window.setTimeout(() => {
        try {
          if (!draw.hasFeature(id)) return;
          // One shape at a time: drop any earlier one.
          for (const f of draw.getSnapshot()) {
            if (f.id !== id && f.properties?.mode !== 'select') draw.removeFeatures([f.id!]);
          }
          setDrawMode(draw, 'select');
          draw.selectFeature(id);
          setFinished(true);
          setSource(readShape());
        } catch {
          /* tool closed in the meantime */
        }
      }, 0);
    };
    const onChange = (_ids: Array<string | number>, type: string) => {
      if (type === 'delete') return;
      if (!finished) return;
      const g = readShape();
      if (g) setSource(g);
    };
    draw.on('finish', onFinish);
    draw.on('change', onChange);
    return () => {
      try {
        draw.off('finish', onFinish);
        draw.off('change', onChange);
      } catch {
        /* unmount race */
      }
    };
  }, [draw, ready, drawing, finished]);

  const clearDrawing = useCallback(() => {
    try {
      draw?.clear();
    } catch {
      /* not started */
    }
    setFinished(false);
    if (draw && drawing) setDrawMode(draw, mode === 'point' ? 'point' : DRAW_MODE[shape]);
  }, [draw, drawing, mode, shape]);

  // ---- Picking features ----------------------------------------------

  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  useEffect(() => {
    if (!open || !map || mode !== 'features') return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const byId = new Map(layersRef.current.map((l) => [`gg:${l.mapLayerId}`, l]));
      const hits = map.queryRenderedFeatures(e.point).filter((h) => byId.has(h.source));
      const hit = hits[0];
      if (!hit) return;
      const layer = byId.get(hit.source)!;
      const id = String(hit.properties?._global_id ?? hit.id ?? '');
      if (!id) return;
      const key = `${layer.mapLayerId}:${id}`;
      if (pickedRef.current.some((p) => p.key === key)) {
        setPicked((cur) => cur.filter((p) => p.key !== key));
        return;
      }
      setPickError(null);
      // The tile copy of a shape is cut at tile edges and simplified,
      // so the screen asks for the stored geometry.
      void fetchFeatureFromServer(layer.itemId, layer.layerKey, id, t('whatsHere.pickFailed'))
        .then((f) => {
          if (!f) return;
          const raw = layer.labelField ? f.properties[layer.labelField] : null;
          const label =
            raw !== null && raw !== undefined && String(raw).trim() !== ''
              ? String(raw)
              : t('whatsHere.unnamedFeature');
          setPicked((cur) =>
            cur.some((p) => p.key === key)
              ? cur
              : [...cur, { key, layerTitle: layer.title, label, geometry: f.geometry }],
          );
        })
        .catch((err: unknown) =>
          setPickError(err instanceof Error ? err.message : t('whatsHere.pickFailed')),
        );
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [open, map, mode, t]);

  useEffect(() => {
    if (mode !== 'features') return;
    setSource(pickedAreaGeometry(picked.map((p) => p.geometry)));
  }, [mode, picked]);

  // ---- Address --------------------------------------------------------

  useEffect(() => {
    if (mode !== 'address') return;
    const q = query.trim();
    if (q.length < 3) {
      setPlaces([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      geocode(q, controller.signal)
        .then((rows) => setPlaces(rows.filter((r) => r.center !== null).slice(0, 6)))
        .catch(() => setPlaces([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [mode, query]);

  // An address is usually somewhere off screen; show it once its area
  // has resolved. Drawn and picked areas are already in view.
  const flyOnResolveRef = useRef(false);

  function choosePlace(p: SearchResult) {
    if (!p.center) return;
    flyOnResolveRef.current = true;
    setPlaceLabel(p.label);
    setPlaces([]);
    setQuery(p.label);
    // An address is a spot; without a distance it finds only what is
    // under that spot. Offer a sensible radius the first time.
    if (distanceMeters === 0) setDistanceMeters(POINT_DEFAULT_METERS[system]);
    setSource({ type: 'Point', coordinates: p.center });
  }

  // A tapped point with no distance only finds what lies under it,
  // which is rarely the question. Default it once.
  useEffect(() => {
    if (mode === 'point' && source?.type === 'Point' && distanceMeters === 0) {
      setDistanceMeters(POINT_DEFAULT_METERS[system]);
    }
    // Only when a point first appears.
  }, [mode, source?.type]);

  // ---- Screening ------------------------------------------------------

  const runRef = useRef(0);
  const areaRef = useRef<ResolvedArea | null>(null);
  const breakdownsRef = useRef(breakdowns);
  breakdownsRef.current = breakdowns;
  const sumsRef = useRef(sums);
  sumsRef.current = sums;

  const screenAll = useCallback(
    async (resolved: ResolvedArea, run: number, signal: AbortSignal) => {
      const current = layersRef.current;
      // Keep the last answer on screen while the new one comes in, so
      // dragging a vertex does not blank every card on each step.
      setResults((cur) =>
        Object.fromEntries(
          current.map((l): [string, LayerState] => {
            const prev = cur[l.mapLayerId];
            return [l.mapLayerId, prev?.status === 'done' ? prev : { status: 'loading' }];
          }),
        ),
      );
      await Promise.all(
        current.map(async (layer) => {
          let state: LayerState;
          try {
            const screen = await screenLayer({
              layer,
              areaId: resolved.id,
              breakdownField: breakdownsRef.current[layer.mapLayerId] ?? null,
              sumFields: sumsRef.current[layer.mapLayerId] ?? [],
              signal,
            });
            state = { status: 'done', screen };
          } catch (err) {
            if (signal.aborted) return;
            if (err instanceof AreaExpiredError) throw err;
            state = {
              status: 'error',
              message: err instanceof Error ? err.message : t('whatsHere.layerFailed'),
            };
          }
          if (runRef.current !== run) return;
          setResults((cur) => ({ ...cur, [layer.mapLayerId]: state }));
        }),
      );
    },
    [t],
  );

  useEffect(() => {
    if (!open) return;
    if (!source) {
      areaRef.current = null;
      setArea(null);
      setResults({});
      return;
    }
    if (layers.length === 0) return;
    const run = ++runRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setResolving(true);
        setAreaError(null);
        try {
          let resolved = await registerArea(
            source,
            distanceMeters,
            t('whatsHere.areaFailed'),
            controller.signal,
          );
          if (runRef.current !== run) return;
          areaRef.current = resolved;
          setArea(resolved);
          if (flyOnResolveRef.current && map) {
            flyOnResolveRef.current = false;
            const [w, s, e, n] = resolved.bbox;
            map.fitBounds(
              [
                [w, s],
                [e, n],
              ],
              { padding: 80, maxZoom: 17, duration: 800 },
            );
          }
          try {
            await screenAll(resolved, run, controller.signal);
          } catch (err) {
            if (!(err instanceof AreaExpiredError)) throw err;
            // Pruned between register and read: register once more.
            resolved = await registerArea(source, distanceMeters, t('whatsHere.areaFailed'), controller.signal);
            areaRef.current = resolved;
            setArea(resolved);
            await screenAll(resolved, run, controller.signal);
          }
        } catch (err) {
          if (controller.signal.aborted || runRef.current !== run) return;
          setAreaError(err instanceof Error ? err.message : t('whatsHere.areaFailed'));
        } finally {
          if (runRef.current === run) setResolving(false);
        }
      })();
    }, RERUN_DELAY_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, map, source, distanceMeters, layers, screenAll, t]);

  // Changing one layer's breakdown reruns that layer only.
  // Rerun one layer after its breakdown or its added-up fields change.
  const rescreenLayer = useCallback(
    (layer: ScreenLayerInfo, breakdownField: string | null, sumFields: string[]) => {
      const resolved = areaRef.current;
      if (!resolved) return;
      const run = runRef.current;
      setResults((cur) => ({ ...cur, [layer.mapLayerId]: { status: 'loading' } }));
      screenLayer({ layer, areaId: resolved.id, breakdownField, sumFields })
        .then((screen) => {
          if (runRef.current === run) {
            setResults((cur) => ({ ...cur, [layer.mapLayerId]: { status: 'done', screen } }));
          }
        })
        .catch((err: unknown) => {
          if (runRef.current !== run) return;
          if (err instanceof AreaExpiredError) {
            // Nudge the main effect to register again.
            setSource((s) => (s ? structuredClone(s) : s));
            return;
          }
          setResults((cur) => ({
            ...cur,
            [layer.mapLayerId]: {
              status: 'error',
              message: err instanceof Error ? err.message : t('whatsHere.layerFailed'),
            },
          }));
        });
    },
    [t],
  );

  const setBreakdown = useCallback(
    (layer: ScreenLayerInfo, field: string) => {
      setBreakdowns((cur) => {
        const next = { ...cur };
        if (field) next[layer.mapLayerId] = field;
        else delete next[layer.mapLayerId];
        return next;
      });
      rescreenLayer(layer, field || null, sumsRef.current[layer.mapLayerId] ?? []);
    },
    [rescreenLayer],
  );

  const setSumFields = useCallback(
    (layer: ScreenLayerInfo, fields: string[]) => {
      setSums((cur) => {
        const next = { ...cur };
        if (fields.length > 0) next[layer.mapLayerId] = fields;
        else delete next[layer.mapLayerId];
        return next;
      });
      rescreenLayer(layer, breakdownsRef.current[layer.mapLayerId] ?? null, fields);
    },
    [rescreenLayer],
  );

  // ---- Map overlay ----------------------------------------------------

  // What the overlay should show right now. The effect that adds the
  // sources reads this, so a source created after the area resolved
  // still starts with the area in it.
  const overlayRef = useRef<{
    area: GeoJSON.FeatureCollection;
    picked: GeoJSON.FeatureCollection;
  }>({
    area: { type: 'FeatureCollection', features: [] },
    picked: { type: 'FeatureCollection', features: [] },
  });

  useEffect(() => {
    if (!map || !open) return;
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    const add = () => {
      // Before the first style has loaded there is nowhere to add to;
      // the 'styledata' and 'idle' listeners below come back here.
      if (!map.style) return;
      if (!map.getSource(OVERLAY_SOURCE)) {
        map.addSource(OVERLAY_SOURCE, { type: 'geojson', data: empty });
        map.addLayer({
          id: OVERLAY_FILL,
          type: 'fill',
          source: OVERLAY_SOURCE,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': AREA_COLOR, 'fill-opacity': 0.12 },
        });
        map.addLayer({
          id: OVERLAY_LINE,
          type: 'line',
          source: OVERLAY_SOURCE,
          paint: { 'line-color': AREA_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        });
        map.addLayer({
          id: OVERLAY_POINT,
          type: 'circle',
          source: OVERLAY_SOURCE,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 6,
            'circle-color': AREA_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
      }
      if (!map.getSource(PICKED_SOURCE)) {
        map.addSource(PICKED_SOURCE, { type: 'geojson', data: empty });
        map.addLayer({
          id: PICKED_FILL,
          type: 'fill',
          source: PICKED_SOURCE,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': PICK_COLOR, 'fill-opacity': 0.3 },
        });
        map.addLayer({
          id: PICKED_LINE,
          type: 'line',
          source: PICKED_SOURCE,
          paint: { 'line-color': PICK_COLOR, 'line-width': 2 },
        });
      }
      (map.getSource(OVERLAY_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
        overlayRef.current.area,
      );
      (map.getSource(PICKED_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
        overlayRef.current.picked,
      );
    };
    // Not gated on isStyleLoaded(): that stays false while any tile is
    // still loading, and waiting for a 'load' that already fired left
    // the area outline off the map. Adding needs only the style.
    try {
      add();
    } catch {
      /* style mid-swap; a listener below retries */
    }
    // A basemap switch replaces the style and drops these; put them back.
    const retry = () => {
      try {
        add();
      } catch {
        /* next event */
      }
    };
    map.on('styledata', retry);
    map.once('idle', retry);
    return () => {
      map.off('styledata', retry);
      map.off('idle', retry);
      for (const id of [OVERLAY_POINT, OVERLAY_LINE, OVERLAY_FILL, PICKED_LINE, PICKED_FILL]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [OVERLAY_SOURCE, PICKED_SOURCE]) {
        if (map.getSource(id)) map.removeSource(id);
      }
    };
  }, [map, open]);

  useEffect(() => {
    if (!map || !open) return;
    const features: GeoJSON.Feature[] = [];
    // The resolved area is what was screened, so that is the outline.
    // An address point stays visible as the spot it was measured from.
    if (area) features.push({ type: 'Feature', geometry: area.geometry, properties: {} });
    if ((mode === 'address' || mode === 'link') && source?.type === 'Point') {
      features.push({ type: 'Feature', geometry: source, properties: {} });
    }
    overlayRef.current = {
      area: { type: 'FeatureCollection', features },
      picked: {
        type: 'FeatureCollection',
        features:
          mode === 'features'
            ? picked.map((p) => ({ type: 'Feature', geometry: p.geometry, properties: {} }))
            : [],
      },
    };
    (map.getSource(OVERLAY_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      overlayRef.current.area,
    );
    (map.getSource(PICKED_SOURCE) as maplibregl.GeoJSONSource | undefined)?.setData(
      overlayRef.current.picked,
    );
  }, [map, open, area, picked, mode, source]);

  // ---- Reset ------------------------------------------------------------

  const startOver = useCallback(() => {
    runRef.current++;
    clearDrawing();
    setSource(null);
    setPicked([]);
    setPickError(null);
    setQuery('');
    setPlaces([]);
    setPlaceLabel(null);
    setArea(null);
    setAreaError(null);
    setResults({});
    setLinkNote(null);
    setLinkFallback(null);
    setGivenNote(null);
    setUploadError(null);
    setMarkupNote(null);
  }, [clearDrawing]);

  function switchMode(next: AreaMode) {
    if (next === mode) return;
    startOver();
    setMode(next);
  }

  function switchShape(next: DrawShape) {
    if (next === shape) return;
    clearDrawing();
    setSource(null);
    setShape(next);
  }

  useEffect(() => {
    if (!open) {
      startOver();
      setMode('draw');
      setDistanceMeters(0);
      setCustomOpen(false);
    }
    // startOver is stable enough; this is the close transition only.
  }, [open]);

  // ---- Share links ----------------------------------------------------

  const appliedShareRef = useRef<SharedArea | null>(null);
  useEffect(() => {
    if (!open || !shared || appliedShareRef.current === shared) return;
    appliedShareRef.current = shared;
    startOver();
    setMode('link');
    setDistanceMeters(shared.distanceMeters);
    setPlaceLabel(shared.place ?? null);
    setGivenNote(t('whatsHere.linkArea'));
    setBreakdowns(shared.breakdowns ?? {});
    setSums(shared.sums ?? {});
    // The receiver's map opens wherever it was saved: show the area.
    flyOnResolveRef.current = true;
    setSource(shared.geometry);
    clearShareHash();
  }, [open, shared, startOver, t]);

  async function uploadShape(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const { geojson } = await importSpatialFile(file);
      const shapes = geojson.features
        .map((f) => f.geometry)
        .filter((g): g is GeoJSON.Geometry => !!g);
      if (shapes.length === 0) throw new Error(t('whatsHere.uploadEmpty'));
      if (shapes.length > MAX_UPLOAD_SHAPES) {
        throw new Error(t('whatsHere.uploadTooMany', { max: MAX_UPLOAD_SHAPES }));
      }
      const geometry = pickedAreaGeometry(shapes)!;
      startOver();
      setMode('link');
      setGivenNote(t('whatsHere.uploadedFrom', { name: file.name }));
      // Points and lines cover no ground on their own: give them the
      // same first distance a tapped point gets.
      if (!hasArea(geometry) && distanceMeters === 0) {
        setDistanceMeters(POINT_DEFAULT_METERS[system]);
      }
      flyOnResolveRef.current = true;
      setSource(geometry);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('whatsHere.uploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  async function copyLink() {
    if (!source) return;
    setLinkFallback(null);
    const code = await encodeSharedArea({
      geometry: source,
      distanceMeters,
      ...((mode === 'address' || mode === 'link') && placeLabel ? { place: placeLabel } : {}),
      breakdowns,
      sums,
    });
    if (!code) {
      setLinkNote(t('whatsHere.linkTooBig'));
      return;
    }
    const url = shareUrl(code);
    try {
      await navigator.clipboard.writeText(url);
      setLinkNote(t('whatsHere.linkCopied'));
      window.setTimeout(() => setLinkNote(null), 3000);
    } catch {
      // No clipboard (an insecure origin, or permission refused): show
      // the link so it can be copied by hand.
      setLinkNote(t('whatsHere.linkCopyByHand'));
      setLinkFallback(url);
    }
  }

  // ---- Panel placement ------------------------------------------------

  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!map || !open) return;
    const el = map.getContainer();
    const measure = () => setCompact(el.clientHeight < COMPACT_BELOW_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [map, open]);

  // ---- Derived ----------------------------------------------------------

  const areaPerUnit = squareMetersPerAreaUnit(areaUnit);
  const settled = layers.filter((l) => results[l.mapLayerId]?.status === 'done');
  const found = settled.filter((l) => {
    const r = results[l.mapLayerId];
    return r?.status === 'done' && r.screen.total.count > 0;
  });
  const empty = settled.filter((l) => {
    const r = results[l.mapLayerId];
    return r?.status === 'done' && r.screen.total.count === 0;
  });
  const pending = layers.filter((l) => results[l.mapLayerId]?.status === 'loading');
  const failed = layers.filter((l) => results[l.mapLayerId]?.status === 'error');

  const presets = DISTANCE_PRESETS[system];
  const presetKey = useMemo(() => {
    const p = presets.find((d) => Math.abs(d.meters - distanceMeters) < 0.001);
    return p ? p.key : 'custom';
  }, [distanceMeters, presets]);

  function applyCustom() {
    const n = Number(customValue.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    setDistanceMeters(Math.min(MAX_DISTANCE_METERS, toMeters(n, customUnit)));
  }

  function exportCsv() {
    if (!area) return;
    const csv = screenCsv({
      area: { squareMeters: area.squareMeters, distanceMeters },
      layers: layers.flatMap((layer) => {
        const r = results[layer.mapLayerId];
        return r?.status === 'done' ? [{ layer, screen: withLabels(r.screen, layer) }] : [];
      }),
      areaUnit,
      lengthUnit,
      areaPerUnit,
      headers: {
        layer: t('whatsHere.csvLayer'),
        category: t('whatsHere.csvCategory'),
        count: t('whatsHere.csvCount'),
        area: t('whatsHere.csvArea'),
        length: t('whatsHere.csvLength'),
        percent: t('whatsHere.csvPercent'),
        sum: (label) => t('whatsHere.csvSum', { label }),
      },
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('whatsHere.fileName')}.csv`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function makeReport() {
    if (!map || !area || !source) return;
    setReporting(true);
    setReportError(null);
    try {
      const mapImage = await snapshotMap(map, area.bbox);
      const body = (areaId: string) => ({
        areaId,
        distanceMeters,
        layers: layers.slice(0, 30).map((l) => {
          const field = breakdowns[l.mapLayerId];
          const added = sums[l.mapLayerId] ?? [];
          return {
            itemId: l.itemId,
            layerKey: l.layerKey,
            title: l.title,
            ...(field ? { breakdownField: field } : {}),
            ...(added.length > 0 ? { sumFields: added } : {}),
          };
        }),
        areaUnit,
        lengthUnit,
        // Letter where people print on it, A4 everywhere else.
        paper: locale === 'en' ? ('letter' as const) : ('a4' as const),
        locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        labels: {
          title: t('whatsHere.report.title'),
          generated: t('whatsHere.report.generated'),
          area: t('whatsHere.areaLabel'),
          distance: t('whatsHere.distanceHeading'),
          onlyInside: t('whatsHere.distance.none'),
          place: t('whatsHere.report.place'),
          picked: t('whatsHere.report.picked'),
          layer: t('whatsHere.csvLayer'),
          count: t('whatsHere.csvCount'),
          areaCol: t('whatsHere.csvArea'),
          lengthCol: t('whatsHere.csvLength'),
          percentCol: t('whatsHere.csvPercent'),
          nothingIn: t('whatsHere.report.nothingIn'),
          breakdownBy: t('whatsHere.report.by'),
          noValue: t('whatsHere.noValue'),
          unavailable: t('whatsHere.report.unavailable'),
          truncated: t('whatsHere.breakdownTruncated'),
          totalOf: t('whatsHere.report.totalOf'),
          sumNote: t('whatsHere.report.sumNote'),
        },
        ...((mode === 'address' || mode === 'link') && placeLabel ? { place: placeLabel } : {}),
        picked: mode === 'features' ? picked.slice(0, 200).map((p) => `${p.label} (${p.layerTitle})`) : [],
        ...(mapImage ? { mapImage } : {}),
      });
      let blob: Blob;
      try {
        blob = await requestReport(body(area.id), t('whatsHere.report.failed'));
      } catch (err) {
        if (!(err instanceof AreaExpiredError)) throw err;
        const again = await registerArea(source, distanceMeters, t('whatsHere.areaFailed'));
        areaRef.current = again;
        setArea(again);
        blob = await requestReport(body(again.id), t('whatsHere.report.failed'));
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${t('whatsHere.fileName')}.pdf`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : t('whatsHere.report.failed'));
    } finally {
      setReporting(false);
    }
  }

  /** The area as checked (distance included) as a markup shape, with
   *  its size shown in the middle in the panel's area unit. */
  async function saveToMarkup() {
    if (!markup || !area) return;
    if (vertexCount(area.geometry) > MAX_MARKUP_VERTICES) {
      setMarkupNote({ tone: 'error', text: t('whatsHere.markupTooDetailed') });
      return;
    }
    setSavingMarkup(true);
    setMarkupNote(null);
    try {
      const now = new Date().toISOString();
      const label = (mode === 'address' || mode === 'link') && placeLabel ? placeLabel : undefined;
      const set = await appendToMarkup(markup, {
        id: clientUuid(),
        kind: 'polygon',
        geometry: area.geometry,
        ...(label ? { label: label.slice(0, 200) } : {}),
        dimensions: { area: true, areaUnit },
        createdAt: now,
        updatedAt: now,
      });
      setMarkupNote({ tone: 'ok', text: t('whatsHere.markupSaved', { title: set.title }) });
    } catch {
      setMarkupNote({ tone: 'error', text: t('whatsHere.markupFailed') });
    } finally {
      setSavingMarkup(false);
    }
  }

  /** The area as screened (distance included), as GeoJSON to keep, to
   *  open in desktop GIS, or to upload here again later. */
  function downloadArea() {
    if (!area) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: area.geometry,
          properties: {
            distance_m: distanceMeters,
            area_m2: Math.round(area.squareMeters * 100) / 100,
            ...((mode === 'address' || mode === 'link') && placeLabel ? { place: placeLabel } : {}),
          },
        },
      ],
    };
    const blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('whatsHere.fileName')}-area.geojson`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function zoomToArea() {
    if (!map || !area) return;
    const [w, s, e, n] = area.bbox;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 60, maxZoom: 18, duration: 600 },
    );
  }

  const container = map?.getContainer() ?? null;
  if (!open || !container) return null;

  // A map in an app can be a short strip. There the panel takes the
  // map's full height from the top; on a tall map it sits low, clear
  // of the search bar and select toolbar.
  const placement = compact
    ? 'left-2 top-2 bottom-2'
    : 'bottom-28 left-3 max-h-[calc(100%-14rem)]';

  const modeButton = (m: AreaMode, Icon: typeof PenLine, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => switchMode(m)}
      className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-xs ${
        mode === m ? 'bg-accent/15 font-medium text-ink-0' : 'text-muted hover:bg-surface-2'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );

  const shapeButton = (s: DrawShape, Icon: typeof PenLine, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={shape === s}
      onClick={() => switchShape(s)}
      title={label}
      className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded text-xs ${
        shape === s ? 'bg-accent/15 font-medium text-ink-0' : 'text-muted hover:bg-surface-2'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );

  return createPortal(
    <div
      className={`absolute ${placement} z-30 flex w-[min(24rem,calc(100%-5.5rem))] flex-col rounded-md border border-border bg-surface-0/95 shadow-lg backdrop-blur-xs`}
      role="dialog"
      aria-label={t('whatsHere.title')}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <ScanSearch className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium text-ink-0">{t('whatsHere.title')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('whatsHere.close')}
          className="ml-auto rounded-md p-1 text-muted hover:bg-surface-1 hover:text-ink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {/* 1. Where */}
        <section>
          <p className="mb-1 text-xs font-medium text-ink-1">{t('whatsHere.whereHeading')}</p>
          <div
            role="radiogroup"
            aria-label={t('whatsHere.whereHeading')}
            className="flex gap-1 rounded-md border border-border bg-surface-1 p-1"
          >
            {modeButton('draw', PenLine, t('whatsHere.modeDraw'))}
            {modeButton('point', MapPin, t('whatsHere.modePoint'))}
            {modeButton('address', Search, t('whatsHere.modeAddress'))}
            {modeButton('features', MousePointerClick, t('whatsHere.modeFeatures'))}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              disabled={uploading}
              title={t('whatsHere.uploadHint')}
              className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs text-accent hover:bg-surface-2 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {t('whatsHere.upload')}
            </button>
            <input
              ref={uploadRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void uploadShape(file);
              }}
            />
          </div>
          {uploadError ? (
            <p role="alert" className="text-2xs text-danger">
              {uploadError}
            </p>
          ) : null}

          {mode === 'draw' ? (
            <div className="mt-2 space-y-1">
              <div role="radiogroup" aria-label={t('whatsHere.shapeAria')} className="flex gap-1">
                {shapeButton('polygon', Hexagon, t('whatsHere.shapePolygon'))}
                {shapeButton('rectangle', Square, t('whatsHere.shapeRectangle'))}
                {shapeButton('circle', CircleIcon, t('whatsHere.shapeCircle'))}
                {shapeButton('freehand', PenLine, t('whatsHere.shapeFreehand'))}
              </div>
              <p className="text-2xs text-muted">
                {finished ? t('whatsHere.hintEditShape') : t(`whatsHere.hintDraw.${shape}`)}
              </p>
            </div>
          ) : null}

          {mode === 'point' ? (
            <p className="mt-2 text-2xs text-muted">
              {finished ? t('whatsHere.hintMovePoint') : t('whatsHere.hintPoint')}
            </p>
          ) : null}

          {mode === 'address' ? (
            <div className="relative mt-2">
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPlaceLabel(null);
                }}
                placeholder={t('whatsHere.addressPlaceholder')}
                aria-label={t('whatsHere.addressPlaceholder')}
                className="h-9 w-full rounded border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
              />
              {searching ? (
                <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-muted" />
              ) : null}
              {places.length > 0 && placeLabel === null ? (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-border bg-surface-1 text-sm">
                  {places.map((p) => (
                    <li key={`${p.label}-${p.center?.join(',')}`}>
                      <button
                        type="button"
                        onClick={() => choosePlace(p)}
                        className="block w-full px-2 py-1.5 text-left hover:bg-surface-2"
                      >
                        <span className="block truncate text-ink-0">{p.label}</span>
                        {p.subtitle ? (
                          <span className="block truncate text-2xs text-muted">{p.subtitle}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {mode === 'link' ? (
            <p className="mt-2 text-xs text-muted">
              {placeLabel ? `${placeLabel}. ` : ''}
              {givenNote}
            </p>
          ) : null}

          {mode === 'features' ? (
            <div className="mt-2 space-y-1">
              <p className="text-2xs text-muted">{t('whatsHere.hintFeatures')}</p>
              {picked.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {picked.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setPicked((cur) => cur.filter((x) => x.key !== p.key))}
                      title={t('whatsHere.removePicked', { name: p.label })}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-2xs text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
                    >
                      <span className="truncate">{p.label}</span>
                      <X className="h-3 w-3 shrink-0" />
                    </button>
                  ))}
                </div>
              ) : null}
              {pickError ? <p className="text-2xs text-danger">{pickError}</p> : null}
            </div>
          ) : null}
        </section>

        {/* 2. How far around it */}
        <section>
          <p className="mb-1 text-xs font-medium text-ink-1">{t('whatsHere.distanceHeading')}</p>
          <div className="flex flex-wrap gap-1">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={presetKey === p.key}
                onClick={() => {
                  setCustomOpen(false);
                  setDistanceMeters(p.meters);
                }}
                className={`h-8 rounded-full border px-3 text-xs ${
                  presetKey === p.key
                    ? 'border-accent bg-accent/15 font-medium text-ink-0'
                    : 'border-border text-ink-1 hover:bg-surface-2'
                }`}
              >
                {t(`whatsHere.distance.${p.key}`)}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={presetKey === 'custom' || customOpen}
              onClick={() => setCustomOpen((v) => !v)}
              className={`h-8 rounded-full border px-3 text-xs ${
                presetKey === 'custom'
                  ? 'border-accent bg-accent/15 font-medium text-ink-0'
                  : 'border-border text-ink-1 hover:bg-surface-2'
              }`}
            >
              {presetKey === 'custom'
                ? formatLengthIn(distanceMeters, customUnit)
                : t('whatsHere.distance.custom')}
            </button>
          </div>
          {customOpen ? (
            <form
              className="mt-2 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                applyCustom();
              }}
            >
              <input
                type="text"
                inputMode="decimal"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                aria-label={t('whatsHere.customDistanceAria')}
                className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs"
              />
              <select
                value={customUnit}
                onChange={(e) => setCustomUnit(e.target.value as DistanceUnit)}
                aria-label={t('whatsHere.customUnitAria')}
                className="h-8 rounded border border-border bg-surface-1 px-1 text-xs"
              >
                {(Object.keys(DISTANCE_UNIT_LABELS) as DistanceUnit[]).map((u) => (
                  <option key={u} value={u}>
                    {DISTANCE_UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
              >
                {t('whatsHere.apply')}
              </button>
            </form>
          ) : null}
        </section>

        {/* 3. The answer */}
        <section aria-live="polite">
          {!source ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
              {t('whatsHere.emptyState')}
            </p>
          ) : areaError ? (
            <p role="alert" className="text-xs text-danger">
              {areaError}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-md bg-surface-1 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-2xs uppercase tracking-wide text-muted">
                    {t('whatsHere.areaLabel')}
                  </p>
                  <p className="font-mono text-sm font-semibold text-ink-0">
                    {area ? formatAreaIn(area.squareMeters, areaUnit) : '…'}
                  </p>
                </div>
                {resolving ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : null}
                {markup ? (
                  <button
                    type="button"
                    onClick={() => void saveToMarkup()}
                    disabled={!area || savingMarkup}
                    aria-label={t('whatsHere.saveToMarkup')}
                    title={t('whatsHere.saveToMarkup')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    {savingMarkup ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <BookmarkPlus className="h-3.5 w-3.5" />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={downloadArea}
                  disabled={!area}
                  aria-label={t('whatsHere.downloadArea')}
                  title={t('whatsHere.downloadArea')}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </div>
              {markupNote ? (
                <p
                  role={markupNote.tone === 'error' ? 'alert' : 'status'}
                  className={`mt-1 text-2xs ${markupNote.tone === 'error' ? 'text-danger' : 'text-success'}`}
                >
                  {markupNote.text}
                </p>
              ) : null}
              {/* Both units in one place: they apply to every card and to
                  the spreadsheet, and each user's choice is remembered. */}
              <div className="mt-1 flex gap-1">
                <label className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-muted">
                  {t('whatsHere.areaUnitLabel')}
                  <select
                    value={areaUnit}
                    onChange={(e) => changeUnits({ areaUnit: e.target.value as AreaUnit })}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-0 px-1 text-xs text-ink-1"
                  >
                    {(Object.keys(AREA_UNIT_LABELS) as AreaUnit[]).map((u) => (
                      <option key={u} value={u}>
                        {AREA_UNIT_LABELS[u]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-muted">
                  {t('whatsHere.lengthUnitLabel')}
                  <select
                    value={lengthUnit}
                    onChange={(e) => changeUnits({ lengthUnit: e.target.value as DistanceUnit })}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-0 px-1 text-xs text-ink-1"
                  >
                    {(Object.keys(DISTANCE_UNIT_LABELS) as DistanceUnit[]).map((u) => (
                      <option key={u} value={u}>
                        {DISTANCE_UNIT_LABELS[u]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {layersLoading ? (
                <p className="mt-2 text-xs text-muted">{t('whatsHere.loadingLayers')}</p>
              ) : layers.length === 0 ? (
                <p className="mt-2 text-xs text-muted">{t('whatsHere.noLayers')}</p>
              ) : null}

              <ul className="mt-2 space-y-2">
                {found.map((layer) => (
                  <LayerCard
                    key={layer.mapLayerId}
                    layer={layer}
                    screen={withLabels(
                      (results[layer.mapLayerId] as { status: 'done'; screen: LayerScreen })
                        .screen,
                      layer,
                    )}
                    areaSqm={area?.squareMeters ?? 0}
                    areaUnit={areaUnit}
                    lengthUnit={lengthUnit}
                    breakdown={breakdowns[layer.mapLayerId] ?? ''}
                    onBreakdown={(f) => setBreakdown(layer, f)}
                    sumFields={sums[layer.mapLayerId] ?? []}
                    onSumFields={(f) => setSumFields(layer, f)}
                  />
                ))}
                {pending.map((layer) => (
                  <li
                    key={layer.mapLayerId}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-2 text-xs text-muted"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {layer.title}
                  </li>
                ))}
                {failed.map((layer) => (
                  <li
                    key={layer.mapLayerId}
                    className="rounded-md border border-border px-2 py-2 text-xs"
                  >
                    <span className="font-medium text-ink-0">{layer.title}</span>
                    <span className="block text-danger">
                      {(results[layer.mapLayerId] as { status: 'error'; message: string }).message}
                    </span>
                  </li>
                ))}
              </ul>

              {empty.length > 0 ? (
                <p className="mt-2 text-xs text-muted">
                  {t('whatsHere.nothingIn', { layers: empty.map((l) => l.title).join(', ') })}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>

      {linkNote ? (
        <div role="status" className="border-t border-border px-3 py-1.5 text-xs text-ink-1">
          {linkNote}
          {linkFallback ? (
            <input
              readOnly
              value={linkFallback}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t('whatsHere.copyLink')}
              className="mt-1 block w-full rounded border border-border bg-surface-1 px-1.5 py-1 text-2xs"
            />
          ) : null}
        </div>
      ) : null}
      {reportError ? (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-danger">
          {reportError}
        </p>
      ) : null}
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={exportCsv}
          disabled={!area || settled.length === 0}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {t('whatsHere.exportCsv')}
        </button>
        <button
          type="button"
          onClick={() => void makeReport()}
          disabled={!area || settled.length === 0 || reporting}
          aria-busy={reporting}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {reporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="h-3.5 w-3.5" />
          )}
          {t('whatsHere.report.button')}
        </button>
        <button
          type="button"
          onClick={() => void copyLink()}
          disabled={!source}
          title={t('whatsHere.copyLinkHint')}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          <Link2 className="h-3.5 w-3.5" />
          {t('whatsHere.copyLink')}
        </button>
        <button
          type="button"
          onClick={zoomToArea}
          disabled={!area}
          aria-label={t('whatsHere.zoomTo')}
          title={t('whatsHere.zoomTo')}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={startOver}
          disabled={!source}
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('whatsHere.startOver')}
        </button>
      </div>
    </div>,
    container,
  );
}

/** Swap stored codes for their pick-list labels. */
function withLabels(screen: LayerScreen, layer: ScreenLayerInfo): LayerScreen {
  if (!screen.breakdown) return screen;
  const labels = layer.codeLabels[screen.breakdown.field];
  if (!labels) return screen;
  return {
    ...screen,
    breakdown: {
      ...screen.breakdown,
      rows: screen.breakdown.rows.map((r) => ({
        ...r,
        value: r.value !== null ? (labels[r.value] ?? r.value) : null,
      })),
    },
  };
}

function LayerCard({
  layer,
  screen,
  areaSqm,
  areaUnit,
  lengthUnit,
  breakdown,
  onBreakdown,
  sumFields,
  onSumFields,
}: {
  layer: ScreenLayerInfo;
  screen: LayerScreen;
  areaSqm: number;
  areaUnit: AreaUnit;
  lengthUnit: DistanceUnit;
  breakdown: string;
  onBreakdown: (field: string) => void;
  sumFields: string[];
  onSumFields: (fields: string[]) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const amount = (v: number | null | undefined) =>
    v === null || v === undefined
      ? '–'
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  // Shown sums follow the last answer, not the checkboxes, so a
  // number never sits beside a field it was not computed for.
  const shownSums = (screen.sumFields ?? []).map((name) => ({
    name,
    label: layer.numberFields.find((f) => f.name === name)?.label ?? name,
  }));
  const toggleSum = (name: string, on: boolean) => {
    const next = on
      ? [...sumFields.filter((f) => f !== name), name].slice(0, MAX_SUM_FIELDS)
      : sumFields.filter((f) => f !== name);
    onSumFields(next);
  };
  const measure = (m: number | null) =>
    m === null
      ? null
      : layer.geometry === 'polygon'
        ? formatAreaIn(m, areaUnit)
        : formatLengthIn(m, lengthUnit);
  const pct = (m: number | null) => {
    const p = percentOfArea(m, areaSqm, layer.geometry);
    return p === null ? null : `${p < 0.1 && p > 0 ? '<0.1' : p.toFixed(p < 10 ? 1 : 0)}%`;
  };
  const total = screen.total;
  return (
    <li className="rounded-md border border-border bg-surface-1 px-2 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-0">
          {layer.title}
        </span>
        <span className="shrink-0 rounded-full bg-accent/15 px-2 text-2xs font-medium text-ink-0">
          {t('whatsHere.count', { count: total.count })}
        </span>
      </div>
      {total.measure !== null ? (
        <p className="mt-0.5 font-mono text-xs text-ink-1">
          {measure(total.measure)}
          {pct(total.measure) ? (
            <span className="text-muted"> · {t('whatsHere.ofArea', { pct: pct(total.measure)! })}</span>
          ) : null}
        </p>
      ) : null}
      {shownSums.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5 text-xs text-ink-1">
          {shownSums.map((f) => (
            <li key={f.name}>
              {t('whatsHere.totalOf', { label: f.label })}{' '}
              <span className="font-mono">{amount(total.sums?.[f.name])}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {layer.categoryFields.length > 0 ? (
        <label className="mt-1.5 flex items-center gap-1 text-2xs text-muted">
          {t('whatsHere.breakDownBy')}
          <select
            value={breakdown}
            onChange={(e) => onBreakdown(e.target.value)}
            className="h-6 min-w-0 flex-1 rounded border border-border bg-surface-0 px-1 text-2xs text-ink-1"
          >
            <option value="">{t('whatsHere.noBreakdown')}</option>
            {layer.categoryFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {layer.numberFields.length > 0 ? (
        <details className="mt-1.5 text-2xs text-muted">
          <summary className="cursor-pointer select-none">
            {t('whatsHere.addUp')}
            {sumFields.length > 0 ? ` (${sumFields.length})` : ''}
          </summary>
          <p className="mt-1 leading-snug">{t('whatsHere.addUpHint')}</p>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
            {layer.numberFields.map((f) => (
              <label key={f.name} className="flex min-w-0 items-center gap-1 text-ink-1">
                <input
                  type="checkbox"
                  checked={sumFields.includes(f.name)}
                  disabled={!sumFields.includes(f.name) && sumFields.length >= MAX_SUM_FIELDS}
                  onChange={(e) => toggleSum(f.name, e.target.checked)}
                />
                <span className="truncate">{f.label}</span>
              </label>
            ))}
          </div>
        </details>
      ) : null}

      {screen.breakdown && screen.breakdown.rows.length > 0 ? (
        <table className="mt-1.5 w-full text-2xs">
          <tbody>
            {screen.breakdown.rows.map((r) => (
              <tr key={r.value ?? '\u0000'} className="border-t border-border/60">
                <td className="py-0.5 pr-2 text-ink-1">
                  {r.value ?? <span className="italic text-muted">{t('whatsHere.noValue')}</span>}
                </td>
                <td className="py-0.5 pr-2 text-right font-mono text-muted">{r.count}</td>
                {r.measure !== null ? (
                  <td className="py-0.5 text-right font-mono text-ink-1">
                    {measure(r.measure)}
                    {pct(r.measure) ? <span className="text-muted"> · {pct(r.measure)}</span> : null}
                  </td>
                ) : null}
                {shownSums.map((f) => (
                  <td key={f.name} className="py-0.5 pl-2 text-right font-mono text-ink-1" title={f.label}>
                    {amount(r.sums?.[f.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {screen.breakdown?.truncated ? (
        <p className="mt-1 text-2xs text-muted">{t('whatsHere.breakdownTruncated')}</p>
      ) : null}
    </li>
  );
}
