'use client';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Elevation profile tool: draw a line on the map, read the ground
 * elevation along it from the map's elevation layer, chart it.
 *
 * Host-agnostic on purpose: the component takes a live MapLibre
 * instance plus a resolver that turns the drawn line's bbox into an
 * elevation COG url, so the same tool serves the map builder, the
 * saved-map viewer, and the web-app runtime widget. The panel and
 * the draw hint portal into the map's own container so they overlay
 * the canvas wherever the host mounted it.
 *
 * Map furniture lives under the `gg-profile-` id prefix, which is
 * deliberately OUTSIDE the `gg:` overlay namespace so the canvas's
 * blunt teardown-and-rebuild sync never removes an in-progress
 * line. Basemap swaps do wipe every source (setStyle), so the sync
 * effect re-asserts on `styledata`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type maplibregl from 'maplibre-gl';
import { ChartSpline, Loader2, Pencil, X } from 'lucide-react';

import { formatLengthIn, type DistanceUnit } from '@/lib/measure';
import {
  sampleElevationProfile,
  type ProfileResult,
} from '@/lib/elevation-sample';

const DRAW_SOURCE = 'gg-profile-draw';
const HOVER_SOURCE = 'gg-profile-hover';
const M_TO_FT = 3.28084;

export interface ElevationProfileToolProps {
  map: maplibregl.Map | null;
  open: boolean;
  onClose: () => void;
  /**
   * Resolve the elevation COG covering the drawn line. Hosts back
   * this with the map's terrain setting, falling back to any
   * elevation layer in the org that covers the bbox. Return null
   * when nothing covers it; the tool shows a plain explanation.
   */
  resolveDemUrl: (
    bbox: [number, number, number, number],
  ) => Promise<{ url: string; title?: string } | null>;
}

type Units = 'imperial' | 'metric';

function loadUnits(): Units {
  if (typeof window === 'undefined') return 'imperial';
  return window.localStorage.getItem('gg-profile-units') === 'metric'
    ? 'metric'
    : 'imperial';
}

function lineFeature(coords: Array<[number, number]>) {
  return {
    type: 'FeatureCollection' as const,
    features:
      coords.length >= 2
        ? [
            {
              type: 'Feature' as const,
              geometry: {
                type: 'LineString' as const,
                coordinates: coords,
              },
              properties: {},
            },
          ]
        : [],
  };
}

function pointFeatures(coords: Array<[number, number]>) {
  return {
    type: 'FeatureCollection' as const,
    features: coords.map((c) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: c },
      properties: {},
    })),
  };
}

export function ElevationProfileTool({
  map,
  open,
  onClose,
  resolveDemUrl,
}: ElevationProfileToolProps) {
  // Vertices of the line being drawn (before double-click).
  const [drawing, setDrawing] = useState<Array<[number, number]>>([]);
  // The finished line the chart was computed from.
  const [line, setLine] = useState<Array<[number, number]> | null>(null);
  const [cursorPos, setCursorPos] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<ProfileResult | null>(null);
  const [demTitle, setDemTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<Units>(loadUnits);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const activeDraw = open && line === null;

  const finishLine = useCallback(
    async (coords: Array<[number, number]>) => {
      if (coords.length < 2) return;
      setLine(coords);
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const lngs = coords.map((c) => c[0]);
        const lats = coords.map((c) => c[1]);
        const bbox: [number, number, number, number] = [
          Math.min(...lngs),
          Math.min(...lats),
          Math.max(...lngs),
          Math.max(...lats),
        ];
        const dem = await resolveDemUrl(bbox);
        if (!dem) {
          setError(
            'No elevation layer covers this line. Create one from a point cloud (its page has a "Create elevation layer" button), then try again.',
          );
          return;
        }
        setDemTitle(dem.title ?? null);
        const profile = await sampleElevationProfile(dem.url, coords);
        if (profile.points.every((p) => p.elev === null)) {
          setError(
            'The elevation layer has no data along this line. Try a line inside its coverage area.',
          );
          return;
        }
        setResult(profile);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Could not read the elevation layer.',
        );
      } finally {
        setBusy(false);
      }
    },
    [resolveDemUrl],
  );

  // ---- Draw interaction ------------------------------------------
  useEffect(() => {
    if (!map || !activeDraw) return;
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    map.doubleClickZoom.disable();

    const onClick = (e: maplibregl.MapMouseEvent) => {
      setDrawing((d) => [...d, [e.lngLat.lng, e.lngLat.lat]]);
    };
    const onDblClick = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      // The preceding click already added this vertex (dblclick
      // fires after two clicks), so just close out.
      const coords = drawingRef.current;
      setDrawing([]);
      void finishLine(coords);
    };
    const onMove = (e: maplibregl.MapMouseEvent) => {
      setCursorPos([e.lngLat.lng, e.lngLat.lat]);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawingRef.current.length > 0) setDrawing([]);
        else onClose();
      } else if (e.key === 'Enter' && drawingRef.current.length >= 2) {
        const coords = drawingRef.current;
        setDrawing([]);
        void finishLine(coords);
      }
    };
    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    map.on('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
      map.off('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      canvas.style.cursor = prevCursor;
      map.doubleClickZoom.enable();
    };
  }, [map, activeDraw, finishLine, onClose]);

  // ---- Map furniture sync ----------------------------------------
  const displayCoords = useMemo(() => {
    if (line) return line;
    if (drawing.length === 0) return [];
    return cursorPos ? [...drawing, cursorPos] : drawing;
  }, [line, drawing, cursorPos]);

  const hoverCoord = useMemo(() => {
    if (!result || hoverIdx === null) return null;
    const p = result.points[hoverIdx];
    return p ? ([p.lng, p.lat] as [number, number]) : null;
  }, [result, hoverIdx]);

  useEffect(() => {
    if (!map) return;
    const ensure = () => {
      if (!open) return;
      try {
        if (!map.getSource(DRAW_SOURCE)) {
          map.addSource(DRAW_SOURCE, {
            type: 'geojson',
            data: lineFeature([]),
          });
          map.addLayer({
            id: `${DRAW_SOURCE}-line`,
            type: 'line',
            source: DRAW_SOURCE,
            paint: {
              'line-color': '#f97316',
              'line-width': 3,
              'line-dasharray': [1.5, 1],
            },
          });
        }
        if (!map.getSource(HOVER_SOURCE)) {
          map.addSource(HOVER_SOURCE, {
            type: 'geojson',
            data: pointFeatures([]),
          });
          map.addLayer({
            id: `${HOVER_SOURCE}-dot`,
            type: 'circle',
            source: HOVER_SOURCE,
            paint: {
              'circle-radius': 6,
              'circle-color': '#f97316',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          });
        }
        (map.getSource(DRAW_SOURCE) as maplibregl.GeoJSONSource).setData(
          lineFeature(displayCoords),
        );
        (map.getSource(HOVER_SOURCE) as maplibregl.GeoJSONSource).setData(
          pointFeatures(hoverCoord ? [hoverCoord] : []),
        );
      } catch {
        // Style mid-swap; the styledata listener re-runs us.
      }
    };
    ensure();
    map.on('styledata', ensure);
    return () => {
      map.off('styledata', ensure);
    };
  }, [map, open, displayCoords, hoverCoord]);

  // Teardown when the tool closes or unmounts.
  useEffect(() => {
    if (!map || open) return;
    cleanup(map);
  }, [map, open]);
  useEffect(() => {
    return () => {
      if (map) cleanup(map);
    };
  }, [map]);

  // Reset transient state whenever the tool opens fresh.
  useEffect(() => {
    if (!open) {
      setDrawing([]);
      setLine(null);
      setResult(null);
      setError(null);
      setHoverIdx(null);
      setDemTitle(null);
    }
  }, [open]);

  function setUnitsPersist(u: Units) {
    setUnits(u);
    try {
      window.localStorage.setItem('gg-profile-units', u);
    } catch {
      /* private mode */
    }
  }

  function redraw() {
    setLine(null);
    setResult(null);
    setError(null);
    setHoverIdx(null);
  }

  const container = map?.getContainer() ?? null;
  if (!open || !container) return null;

  return createPortal(
    <>
      {activeDraw ? (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-surface-0/95 px-4 py-1.5 text-xs font-medium text-ink-1 shadow-card backdrop-blur"
        >
          {drawing.length === 0
            ? 'Click the map to start a line across the ground.'
            : 'Click to add points. Double-click (or press Enter) to finish.'}
        </div>
      ) : null}
      <div className="absolute inset-x-2 bottom-2 z-20 rounded-lg border border-border bg-surface-0/95 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <ChartSpline className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-ink-0">
            Elevation profile
          </span>
          {demTitle ? (
            <span className="hidden truncate text-2xs text-muted sm:inline">
              from {demTitle}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex overflow-hidden rounded-md border border-border text-2xs">
              {(['imperial', 'metric'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnitsPersist(u)}
                  className={
                    units === u
                      ? 'bg-accent px-2 py-0.5 font-medium text-accent-foreground'
                      : 'px-2 py-0.5 text-muted hover:text-ink-1'
                  }
                >
                  {u === 'imperial' ? 'ft' : 'm'}
                </button>
              ))}
            </div>
            {line ? (
              <button
                type="button"
                onClick={redraw}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-2xs text-ink-1 hover:bg-surface-1"
              >
                <Pencil className="h-3 w-3" />
                Draw again
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close elevation profile"
              className="rounded-md p-1 text-muted hover:bg-surface-1 hover:text-ink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-3 py-2">
          {busy ? (
            <div className="flex h-36 items-center justify-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the ground elevation...
            </div>
          ) : error ? (
            <div className="flex h-36 items-center justify-center px-6 text-center text-sm text-muted">
              {error}
            </div>
          ) : result ? (
            <ProfileChart
              result={result}
              units={units}
              hoverIdx={hoverIdx}
              onHover={setHoverIdx}
            />
          ) : (
            <div className="flex h-36 items-center justify-center text-sm text-muted">
              Draw a line on the map to see the ground elevation along
              it.
            </div>
          )}
        </div>
      </div>
    </>,
    container,
  );
}

function cleanup(map: maplibregl.Map) {
  try {
    for (const id of [`${DRAW_SOURCE}-line`, `${HOVER_SOURCE}-dot`]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [DRAW_SOURCE, HOVER_SOURCE]) {
      if (map.getSource(id)) map.removeSource(id);
    }
  } catch {
    // Map torn down mid-cleanup; nothing to leak.
  }
}

// ---- Chart -------------------------------------------------------

const CHART_W = 720;
const CHART_H = 132;
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 20;

function ProfileChart({
  result,
  units,
  hoverIdx,
  onHover,
}: {
  result: ProfileResult;
  units: Units;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}) {
  const { points, totalM } = result;
  const valid = points.filter((p) => p.elev !== null);
  const elevOf = (m: number) => (units === 'imperial' ? m * M_TO_FT : m);
  const elevUnit = units === 'imperial' ? 'ft' : 'm';
  const distUnit: DistanceUnit =
    units === 'imperial'
      ? totalM > 804
        ? 'miles'
        : 'feet'
      : totalM > 1000
        ? 'kilometers'
        : 'meters';

  const minE = Math.min(...valid.map((p) => p.elev!));
  const maxE = Math.max(...valid.map((p) => p.elev!));
  const span = Math.max(maxE - minE, 1);
  const yLo = minE - span * 0.08;
  const yHi = maxE + span * 0.08;

  const x = (dist: number) =>
    PAD_L + ((CHART_W - PAD_L - PAD_R) * dist) / Math.max(totalM, 1);
  const y = (elev: number) =>
    PAD_T + (CHART_H - PAD_T - PAD_B) * (1 - (elev - yLo) / (yHi - yLo));

  // Break the line + area into contiguous valid runs so nodata gaps
  // show as gaps instead of lying with a straight bridge.
  const runs: Array<Array<{ dist: number; elev: number }>> = [];
  let cur: Array<{ dist: number; elev: number }> = [];
  for (const p of points) {
    if (p.elev === null) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    } else {
      cur.push({ dist: p.dist, elev: p.elev });
    }
  }
  if (cur.length > 1) runs.push(cur);

  const baseline = y(yLo);
  const linePaths = runs.map(
    (r) =>
      'M' +
      r.map((p) => `${x(p.dist).toFixed(1)},${y(p.elev).toFixed(1)}`).join('L'),
  );
  const areaPaths = runs.map(
    (r) =>
      `M${x(r[0]!.dist).toFixed(1)},${baseline.toFixed(1)}L` +
      r.map((p) => `${x(p.dist).toFixed(1)},${y(p.elev).toFixed(1)}`).join('L') +
      `L${x(r[r.length - 1]!.dist).toFixed(1)},${baseline.toFixed(1)}Z`,
  );

  // Total climb: positive deltas across consecutive valid samples.
  let climb = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!.elev;
    const b = points[i]!.elev;
    if (a !== null && b !== null && b > a) climb += b - a;
  }

  const yTicks = [minE, (minE + maxE) / 2, maxE];
  const xTickCount = 4;
  const xTicks = Array.from(
    { length: xTickCount + 1 },
    (_, i) => (totalM * i) / xTickCount,
  );

  const hover = hoverIdx !== null ? points[hoverIdx] : null;

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * CHART_W;
    const dist =
      ((px - PAD_L) / Math.max(CHART_W - PAD_L - PAD_R, 1)) * totalM;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const d = Math.abs(points[i]!.dist - dist);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    onHover(best);
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-32 w-full select-none"
        onMouseMove={onMouseMove}
        onMouseLeave={() => onHover(null)}
        role="img"
        aria-label="Ground elevation along the drawn line"
      >
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line
              x1={PAD_L}
              x2={CHART_W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeDasharray="2 3"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 5}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-current text-muted"
              fontSize={9}
            >
              {Math.round(elevOf(t)).toLocaleString()} {elevUnit}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={x(t)}
            y={CHART_H - 6}
            textAnchor={i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle'}
            className="fill-current text-muted"
            fontSize={9}
          >
            {formatLengthIn(t, distUnit)}
          </text>
        ))}
        {areaPaths.map((d, i) => (
          <path key={`a${i}`} d={d} className="fill-accent/15" />
        ))}
        {linePaths.map((d, i) => (
          <path
            key={`l${i}`}
            d={d}
            className="stroke-accent"
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        {hover && hover.elev !== null ? (
          <g>
            <line
              x1={x(hover.dist)}
              x2={x(hover.dist)}
              y1={PAD_T}
              y2={CHART_H - PAD_B}
              className="stroke-ink-1/40"
              strokeWidth={1}
            />
            <circle
              cx={x(hover.dist)}
              cy={y(hover.elev)}
              r={3.5}
              className="fill-accent stroke-white"
              strokeWidth={1.5}
            />
          </g>
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-2xs text-muted">
        <Stat
          label="Distance"
          value={formatLengthIn(totalM, distUnit)}
        />
        <Stat
          label="Low"
          value={`${Math.round(elevOf(minE)).toLocaleString()} ${elevUnit}`}
        />
        <Stat
          label="High"
          value={`${Math.round(elevOf(maxE)).toLocaleString()} ${elevUnit}`}
        />
        <Stat
          label="Total climb"
          value={`${Math.round(elevOf(climb)).toLocaleString()} ${elevUnit}`}
        />
        {hover && hover.elev !== null ? (
          <span className="ml-auto font-medium text-ink-1">
            {formatLengthIn(hover.dist, distUnit)} ·{' '}
            {Math.round(elevOf(hover.elev)).toLocaleString()} {elevUnit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label}:{' '}
      <span className="font-medium text-ink-1">{value}</span>
    </span>
  );
}
