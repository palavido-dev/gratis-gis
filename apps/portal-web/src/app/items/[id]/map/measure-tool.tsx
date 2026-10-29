// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Measure tool for the map builder (#122 pattern, map-native).
 *
 * Distance (line) and area (polygon) sketches stay local — nothing
 * is written to a layer. The floating pane mirrors the editor
 * runtime's Measure UI so the two surfaces feel the same, but it
 * portals into the map container and sits clear of MapLibre's
 * top-right zoom controls.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as maplibregl from 'maplibre-gl';
import { Pentagon, Ruler, X } from 'lucide-react';

import {
  AREA_UNIT_LABELS,
  DISTANCE_UNIT_LABELS,
  formatAreaIn,
  formatLengthIn,
  lineLengthMeters,
  ringAreaSquareMeters,
  ringPerimeterMeters,
  terrainSurfaceAreaSquareMeters,
  type AreaUnit,
  type DistanceUnit,
} from '@/lib/measure';
import { useT } from '@/lib/i18n/locale-context';
import {
  setDrawMode,
  startDraw,
  useCrosshairCursor,
  useTerraDraw,
} from './use-terra-draw';

export interface MeasureToolProps {
  map: maplibregl.Map | null;
  open: boolean;
  onClose: () => void;
  /** Fired while drawing so the parent can disarm competing tools. */
  onDrawActiveChange?: (active: boolean) => void;
}

type MeasureMode = 'distance' | 'area';

export function MeasureTool({
  map,
  open,
  onClose,
  onDrawActiveChange,
}: MeasureToolProps) {
  const t = useT();
  const [mode, setMode] = useState<MeasureMode>('distance');
  const [lengthMeters, setLengthMeters] = useState<number | null>(null);
  const [areaSqm, setAreaSqm] = useState<number | null>(null);
  const [surfaceSqm, setSurfaceSqm] = useState<number | null>(null);
  const [perimeterMeters, setPerimeterMeters] = useState<number | null>(null);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>('miles');
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('acres');

  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    onDrawActiveChange?.(open);
  }, [open, onDrawActiveChange]);

  // Mount terra-draw only while the tool is open so it never
  // contends with markup / feature editing for canvas clicks.
  const { draw, ready } = useTerraDraw(open ? map : null, { snapping: false });
  useCrosshairCursor(map, open);

  useEffect(() => {
    if (!draw || !ready || !open) return;
    startDraw(draw);
    setDrawMode(draw, mode === 'area' ? 'polygon' : 'linestring');
  }, [draw, ready, open, mode]);

  // Live readout while the user is sketching.
  useEffect(() => {
    if (!draw || !ready || !open) return;
    const handleChange = () => {
      const snap = draw.getSnapshot();
      const f = snap[snap.length - 1];
      if (!f || !f.geometry) return;
      const g = f.geometry;
      if (
        modeRef.current === 'distance' &&
        g.type === 'LineString' &&
        Array.isArray(g.coordinates)
      ) {
        setLengthMeters(
          lineLengthMeters(g.coordinates as Array<[number, number]>),
        );
      } else if (
        modeRef.current === 'area' &&
        g.type === 'Polygon' &&
        Array.isArray(g.coordinates) &&
        g.coordinates[0]
      ) {
        const ring = g.coordinates[0] as Array<[number, number]>;
        setAreaSqm(ringAreaSquareMeters(ring));
        setPerimeterMeters(ringPerimeterMeters(ring));
        // Terrain surface (slope) area when a DEM is active. Secondary
        // to horizontal geodesic — pitched 3D views make parcels look
        // larger than their planimetric footprint; surface area only
        // closes a few percent of that gap on WV relief, but it is the
        // honest "ground" number when users ask for it.
        if (map?.getTerrain()) {
          const surface = terrainSurfaceAreaSquareMeters(ring, (lng, lat) => {
            try {
              return map.queryTerrainElevation([lng, lat]);
            } catch {
              return null;
            }
          });
          setSurfaceSqm(surface);
        } else {
          setSurfaceSqm(null);
        }
      }
    };
    draw.on('change', handleChange);
    return () => {
      try {
        draw.off('change', handleChange);
      } catch {
        /* unmount race */
      }
    };
  }, [draw, ready, open, map]);

  function clearMeasurement() {
    try {
      draw?.clear();
    } catch {
      /* ignore */
    }
    setLengthMeters(null);
    setAreaSqm(null);
    setSurfaceSqm(null);
    setPerimeterMeters(null);
  }

  function switchMode(next: MeasureMode) {
    if (next === mode) return;
    clearMeasurement();
    setMode(next);
  }

  function handleClose() {
    clearMeasurement();
    onClose();
  }

  // Reset when the parent closes the tool.
  useEffect(() => {
    if (!open) {
      setLengthMeters(null);
      setAreaSqm(null);
      setSurfaceSqm(null);
      setPerimeterMeters(null);
      setMode('distance');
    }
  }, [open]);

  const container = map?.getContainer() ?? null;
  if (!open || !container) return null;

  // Sit above MapLibre's bottom-left ScaleControl. Covering the
  // scale bar made it impossible to sanity-check a sketch against
  // ground distance — the WV terrain report that looked like
  // "~144 acres" vs "10 ac" was consistent with the scale bar once
  // it was visible again (geodesic math was already correct).
  return createPortal(
    <div
      className="absolute bottom-12 left-3 z-30 flex w-[min(20rem,calc(100%-5.5rem))] flex-col rounded-md border border-border bg-surface-0/95 shadow-lg backdrop-blur-xs"
      role="dialog"
      aria-label={t('mapMeasure.title')}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Ruler className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium text-ink-0">
          {t('mapMeasure.title')}
        </span>
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('mapMeasure.closeAria')}
          className="ml-auto rounded-md p-1 text-muted hover:bg-surface-1 hover:text-ink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div
          role="radiogroup"
          aria-label={t('mapMeasure.modeAria')}
          className="inline-flex overflow-hidden rounded-md border border-border bg-surface-1"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'distance'}
            onClick={() => switchMode('distance')}
            className={`inline-flex items-center gap-1 px-3 py-1 text-xs ${
              mode === 'distance'
                ? 'bg-accent/15 font-medium text-ink-1'
                : 'text-muted hover:bg-surface-2'
            }`}
          >
            <Ruler className="h-3.5 w-3.5" />
            {t('mapMeasure.distance')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'area'}
            onClick={() => switchMode('area')}
            className={`inline-flex items-center gap-1 border-l border-border px-3 py-1 text-xs ${
              mode === 'area'
                ? 'bg-accent/15 font-medium text-ink-1'
                : 'text-muted hover:bg-surface-2'
            }`}
          >
            <Pentagon className="h-3.5 w-3.5" />
            {t('mapMeasure.area')}
          </button>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-ink-1">
            {t('mapMeasure.unit')}
          </label>
          {mode === 'distance' ? (
            <select
              value={distanceUnit}
              onChange={(e) =>
                setDistanceUnit(e.target.value as DistanceUnit)
              }
              className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
            >
              {(Object.keys(DISTANCE_UNIT_LABELS) as DistanceUnit[]).map(
                (u) => (
                  <option key={u} value={u}>
                    {DISTANCE_UNIT_LABELS[u]}
                  </option>
                ),
              )}
            </select>
          ) : (
            <select
              value={areaUnit}
              onChange={(e) => setAreaUnit(e.target.value as AreaUnit)}
              className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
            >
              {(Object.keys(AREA_UNIT_LABELS) as AreaUnit[]).map((u) => (
                <option key={u} value={u}>
                  {AREA_UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-ink-1">
            {mode === 'distance'
              ? t('mapMeasure.distance')
              : surfaceSqm != null
                ? t('mapMeasure.groundArea')
                : t('mapMeasure.area')}
          </p>
          <p className="font-mono text-base font-semibold text-ink-0">
            {mode === 'distance'
              ? lengthMeters !== null
                ? formatLengthIn(lengthMeters, distanceUnit)
                : '—'
              : surfaceSqm != null
                ? formatAreaIn(surfaceSqm, areaUnit)
                : areaSqm !== null
                  ? formatAreaIn(areaSqm, areaUnit)
                  : '—'}
          </p>
          {mode === 'area' && areaSqm !== null ? (
            <div className="mt-0.5 space-y-0.5 font-mono text-2xs text-muted">
              {surfaceSqm != null ? (
                <p>
                  {t('mapMeasure.horizontalLabel')}:{' '}
                  {formatAreaIn(areaSqm, areaUnit)}
                  {areaUnit !== 'square-meters'
                    ? ` (${formatAreaIn(areaSqm, 'square-meters')})`
                    : ''}
                </p>
              ) : areaUnit !== 'square-meters' ? (
                <p>{formatAreaIn(areaSqm, 'square-meters')}</p>
              ) : null}
              {perimeterMeters != null ? (
                <p>
                  {t('mapMeasure.perimeterLabel')}:{' '}
                  {formatLengthIn(perimeterMeters, distanceUnit)}
                </p>
              ) : null}
            </div>
          ) : null}
          {mode === 'distance' &&
          lengthMeters !== null &&
          distanceUnit !== 'meters' ? (
            <p className="mt-0.5 font-mono text-2xs text-muted">
              {formatLengthIn(lengthMeters, 'meters')}
            </p>
          ) : null}
          <p className="mt-1 text-2xs text-muted">
            {mode === 'area'
              ? surfaceSqm != null
                ? t('mapMeasure.hintAreaTerrain')
                : t('mapMeasure.hintArea')
              : t('mapMeasure.hintDistance')}
          </p>
        </div>

        <button
          type="button"
          onClick={clearMeasurement}
          disabled={lengthMeters === null && areaSqm === null}
          className="inline-flex h-8 w-full items-center justify-center rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('mapMeasure.newMeasurement')}
        </button>
      </div>
    </div>,
    container,
  );
}
