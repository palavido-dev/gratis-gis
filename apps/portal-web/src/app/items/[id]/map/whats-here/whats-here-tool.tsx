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
  Circle as CircleIcon,
  Download,
  Hexagon,
  Loader2,
  MapPin,
  MousePointerClick,
  PenLine,
  RotateCcw,
  ScanSearch,
  Search,
  Square,
  X,
  ZoomIn,
} from 'lucide-react';
import type { MapLayer } from '@gratis-gis/shared-types';

import { useT } from '@/lib/i18n/locale-context';
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
  MAX_DISTANCE_METERS,
  POINT_DEFAULT_METERS,
  initialUnits,
  profileUnitSystem,
  rememberUnits,
  percentOfArea,
  pickedAreaGeometry,
  registerArea,
  screenCsv,
  screenLayer,
  toMeters,
  type LayerScreen,
  type ResolvedArea,
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

type AreaMode = 'draw' | 'point' | 'address' | 'features';
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
}: WhatsHereToolProps) {
  const t = useT();
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

  function choosePlace(p: SearchResult) {
    if (!p.center) return;
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
  }, [open, source, distanceMeters, layers, screenAll, t]);

  // Changing one layer's breakdown reruns that layer only.
  const setBreakdown = useCallback(
    (layer: ScreenLayerInfo, field: string) => {
      setBreakdowns((cur) => {
        const next = { ...cur };
        if (field) next[layer.mapLayerId] = field;
        else delete next[layer.mapLayerId];
        return next;
      });
      const resolved = areaRef.current;
      if (!resolved) return;
      const run = runRef.current;
      setResults((cur) => ({ ...cur, [layer.mapLayerId]: { status: 'loading' } }));
      screenLayer({ layer, areaId: resolved.id, breakdownField: field || null })
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
    if (mode === 'address' && source?.type === 'Point') {
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
      className="absolute bottom-28 left-3 z-30 flex max-h-[calc(100%-14rem)] w-[min(24rem,calc(100%-5.5rem))] flex-col rounded-md border border-border bg-surface-0/95 shadow-lg backdrop-blur-xs"
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
              </div>
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
          onClick={zoomToArea}
          disabled={!area}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          <ZoomIn className="h-3.5 w-3.5" />
          {t('whatsHere.zoomTo')}
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
}: {
  layer: ScreenLayerInfo;
  screen: LayerScreen;
  areaSqm: number;
  areaUnit: AreaUnit;
  lengthUnit: DistanceUnit;
  breakdown: string;
  onBreakdown: (field: string) => void;
}) {
  const t = useT();
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
