// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Measure tool for the map builder (#122 pattern, map-native).
 *
 * Distance (line) and area (polygon) sketches stay local unless the
 * user saves one to markup. The floating pane mirrors the editor
 * runtime's Measure UI so the two surfaces feel the same, but it
 * portals into the map container and sits clear of MapLibre's
 * top-right zoom controls.
 *
 * A finished sketch stays selected: drag it to move it, drag a corner
 * to reshape it. Side lengths and the area are drawn on the map and
 * follow every drag. "Set area" scales a polygon to an exact size.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as maplibregl from 'maplibre-gl';
import { Pentagon, Ruler, X } from 'lucide-react';
import type { DrawingFeature } from '@gratis-gis/shared-types';

import {
  AREA_UNIT_LABELS,
  AREA_UNIT_SUFFIX,
  DISTANCE_UNIT_LABELS,
  formatAreaIn,
  formatLengthIn,
  lineLengthMeters,
  ringAreaSquareMeters,
  ringPerimeterMeters,
  squareMetersPerAreaUnit,
  terrainSurfaceAreaSquareMeters,
  type AreaUnit,
  type DistanceUnit,
} from '@/lib/measure';
import { flattenPitchForMeasure } from '@/lib/measure-camera';
import { dimensionLabelFeatures, scaleRingToArea } from '@/lib/measure-labels';
import { dimensionLabelLayout, dimensionLabelPaint } from '@/lib/drawings-overlay';
import { appendToMarkup, type MarkupSaveContext } from '@/lib/markup-append';
import { clientUuid } from '@/lib/uuid';
import { useT } from '@/lib/i18n/locale-context';
import {
  roundCoordsToPrecision,
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
  /**
   * Saving a measurement to markup. Leave out (scratch maps, signed
   * out visitors) and the Save button is not shown.
   */
  save?: MeasureSaveContext | undefined;
}

export type MeasureSaveContext = MarkupSaveContext;

type MeasureMode = 'distance' | 'area';
type MeasuredGeometry =
  | { type: 'LineString'; coordinates: Array<[number, number]> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> };

const LABEL_SOURCE_ID = 'measure:labels';
const LABEL_LAYER_ID = 'measure:labels';

export function MeasureTool({
  map,
  open,
  onClose,
  onDrawActiveChange,
  save,
}: MeasureToolProps) {
  const t = useT();
  const [mode, setMode] = useState<MeasureMode>('distance');
  const [lengthMeters, setLengthMeters] = useState<number | null>(null);
  const [areaSqm, setAreaSqm] = useState<number | null>(null);
  const [surfaceSqm, setSurfaceSqm] = useState<number | null>(null);
  const [perimeterMeters, setPerimeterMeters] = useState<number | null>(null);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>('miles');
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('acres');
  // The sketch as it stands, and the id it has in terra-draw once it
  // is finished (null while still being drawn).
  const [geometry, setGeometry] = useState<MeasuredGeometry | null>(null);
  const [finishedId, setFinishedId] = useState<string | number | null>(null);
  const [showLengths, setShowLengths] = useState(true);
  const [showArea, setShowArea] = useState(true);
  const [targetInput, setTargetInput] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    onDrawActiveChange?.(open);
  }, [open, onDrawActiveChange]);

  // Pitched 3D foreshortens the view: a sketch that looks like it
  // covers a ~144 ac parcel can honestly be ~58 ac planimetric.
  // Jump to top-down + lock maxPitch while open so every vertex
  // lands under a flat camera; restore pitch on close.
  useEffect(() => {
    if (!open || !map) return;
    return flattenPitchForMeasure(map);
  }, [open, map]);

  // Mount terra-draw only while the tool is open so it never
  // contends with markup / feature editing for canvas clicks.
  const { draw, ready } = useTerraDraw(open ? map : null, { snapping: false });
  // Crosshair while placing points; the normal cursor once the sketch
  // is finished and can be dragged.
  useCrosshairCursor(map, open && finishedId === null);

  useEffect(() => {
    if (!draw || !ready || !open) return;
    startDraw(draw);
    setDrawMode(draw, mode === 'area' ? 'polygon' : 'linestring');
  }, [draw, ready, open, mode]);

  // A finished sketch switches to select mode and stays selected, so
  // it can be dragged and reshaped. Deferred a tick: terra-draw is
  // still inside its own finish handling when this fires.
  useEffect(() => {
    if (!draw || !ready || !open) return;
    const handleFinish = (id: string | number, context?: { action?: string }) => {
      if (context?.action && context.action !== 'draw') return;
      window.setTimeout(() => {
        try {
          if (!draw.hasFeature(id)) return;
          setDrawMode(draw, 'select');
          draw.selectFeature(id);
          setFinishedId(id);
        } catch {
          /* tool closed in the meantime */
        }
      }, 0);
    };
    draw.on('finish', handleFinish);
    return () => {
      try {
        draw.off('finish', handleFinish);
      } catch {
        /* unmount race */
      }
    };
  }, [draw, ready, open]);

  // Live readout while the user is sketching.
  useEffect(() => {
    if (!draw || !ready || !open) return;
    const handleChange = () => {
      // In select mode the snapshot also holds terra-draw's own
      // handles (corner and midpoint markers). Take the sketch itself.
      const wanted = modeRef.current === 'area' ? 'polygon' : 'linestring';
      const snap = draw.getSnapshot();
      let f: (typeof snap)[number] | undefined;
      for (let i = snap.length - 1; i >= 0; i--) {
        if (snap[i]!.properties?.mode === wanted) {
          f = snap[i];
          break;
        }
      }
      if (!f || !f.geometry) return;
      const g = f.geometry;
      if (g.type === 'LineString' || g.type === 'Polygon') {
        setGeometry(g as MeasuredGeometry);
      }
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
        // Terrain surface (slope) area when a DEM is active. Shown as
        // the primary "ground" number; horizontal (deed) area stays
        // underneath. Slope only adds a few percent on mild relief —
        // pitch foreshortening is the big visual gap, which we flatten
        // on open above.
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

  // Labels on the map: one length per side and the area in the middle.
  const labels = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: geometry
        ? dimensionLabelFeatures(geometry, {
            lengths: showLengths,
            area: showArea,
            lengthUnit: distanceUnit,
            areaUnit,
          })
        : [],
    }),
    [geometry, showLengths, showArea, distanceUnit, areaUnit],
  );

  useEffect(() => {
    if (!open || !map) return;
    const apply = () => {
      try {
        const src = map.getSource(LABEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(labels);
        } else {
          map.addSource(LABEL_SOURCE_ID, { type: 'geojson', data: labels });
        }
        if (!map.getLayer(LABEL_LAYER_ID)) {
          map.addLayer({
            id: LABEL_LAYER_ID,
            type: 'symbol',
            source: LABEL_SOURCE_ID,
            layout: dimensionLabelLayout(),
            paint: dimensionLabelPaint(),
          });
        } else {
          // Keep the labels above the sketch terra-draw paints.
          map.moveLayer(LABEL_LAYER_ID);
        }
      } catch {
        /* style is mid-swap; the styledata handler below retries */
      }
    };
    apply();
    // A basemap change drops custom sources; put the labels back.
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [open, map, labels]);

  useEffect(() => {
    if (!open || !map) return;
    return () => {
      try {
        if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
        if (map.getSource(LABEL_SOURCE_ID)) map.removeSource(LABEL_SOURCE_ID);
      } catch {
        /* map already torn down */
      }
    };
  }, [open, map]);

  function resetState() {
    setLengthMeters(null);
    setAreaSqm(null);
    setSurfaceSqm(null);
    setPerimeterMeters(null);
    setGeometry(null);
    setFinishedId(null);
    setTargetInput('');
  }

  function clearMeasurement() {
    try {
      draw?.clear();
    } catch {
      /* ignore */
    }
    resetState();
    setNotice(null);
    // Back to placing points for the next sketch.
    setDrawMode(draw, modeRef.current === 'area' ? 'polygon' : 'linestring');
  }

  // "Set area": scale the finished polygon about its middle to an
  // exact size in the chosen unit.
  function applyTargetArea() {
    if (!draw || finishedId === null || !geometry || geometry.type !== 'Polygon') return;
    const value = Number(targetInput.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setNotice({ tone: 'error', text: t('mapMeasure.targetInvalid') });
      return;
    }
    const ring = geometry.coordinates[0];
    const scaled = ring
      ? scaleRingToArea(ring, value * squareMetersPerAreaUnit(areaUnit))
      : null;
    if (!scaled) {
      setNotice({ tone: 'error', text: t('mapMeasure.targetFailed') });
      return;
    }
    const next = roundCoordsToPrecision({ type: 'Polygon', coordinates: [scaled] });
    const id = finishedId;
    const put = (g: GeoJSON.Geometry) =>
      draw.addFeatures([
        { id, type: 'Feature', geometry: g as never, properties: { mode: 'polygon' } },
      ]);
    try {
      draw.deselectFeature(id);
    } catch {
      /* not selected */
    }
    try {
      draw.removeFeatures([id]);
      const result = put(next);
      if ((result ?? []).some((r) => !r.valid)) {
        // Put the old shape back and say so.
        put(geometry as GeoJSON.Geometry);
        setNotice({ tone: 'error', text: t('mapMeasure.targetFailed') });
      } else {
        setNotice(null);
      }
      draw.selectFeature(id);
    } catch {
      setNotice({ tone: 'error', text: t('mapMeasure.targetFailed') });
    }
  }

  // Save the sketch as a markup shape. It goes into the user's most
  // recent visible markup set, or a new one. The label toggles and
  // units travel with it, so the saved shape shows the same numbers.
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveToMarkup = useCallback(async () => {
    const ctx = saveRef.current;
    if (!ctx || !geometry) return;
    setSaving(true);
    setNotice(null);
    try {
      const now = new Date().toISOString();
      const feature: DrawingFeature = {
        id: clientUuid(),
        kind: geometry.type === 'Polygon' ? 'polygon' : 'line',
        geometry: roundCoordsToPrecision(geometry as GeoJSON.Geometry),
        ...(showLengths || showArea
          ? {
              dimensions: {
                ...(showLengths ? { lengths: true } : {}),
                ...(showArea && geometry.type === 'Polygon' ? { area: true } : {}),
                lengthUnit: distanceUnit,
                areaUnit,
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      const updated = await appendToMarkup(ctx, feature);
      // The saved shape now draws from markup; clear the sketch so
      // there are not two on top of each other.
      try {
        draw?.clear();
      } catch {
        /* ignore */
      }
      resetState();
      setDrawMode(draw, modeRef.current === 'area' ? 'polygon' : 'linestring');
      setNotice({ tone: 'ok', text: t('mapMeasure.savedTo', { title: updated.title }) });
    } catch {
      setNotice({ tone: 'error', text: t('mapMeasure.saveFailed') });
    } finally {
      setSaving(false);
    }
  }, [geometry, showLengths, showArea, distanceUnit, areaUnit, draw, t]);


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
      resetState();
      setNotice(null);
      setMode('distance');
    }
  }, [open]);

  const container = map?.getContainer() ?? null;
  if (!open || !container) return null;

  // Sit above MapLibre's bottom-left ScaleControl + area-scale
  // square. Covering the scale chrome made it impossible to
  // sanity-check a sketch against ground distance — the WV
  // terrain report that looked like "~144 acres" vs "10 ac" was
  // consistent with the scale bar once it was visible again
  // (geodesic math was already correct). bottom-28 clears the
  // area square (up to ~72px) stacked above the scale bar.
  return createPortal(
    <div
      className="absolute bottom-28 left-3 z-30 flex w-[min(20rem,calc(100%-5.5rem))] flex-col rounded-md border border-border bg-surface-0/95 shadow-lg backdrop-blur-xs"
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
            {finishedId !== null
              ? t('mapMeasure.hintEdit')
              : mode === 'area'
                ? surfaceSqm != null
                  ? t('mapMeasure.hintAreaTerrain')
                  : t('mapMeasure.hintArea')
                : t('mapMeasure.hintDistance')}
          </p>
        </div>

        <fieldset>
          <legend className="mb-1 text-xs font-medium text-ink-1">
            {t('mapMeasure.labels')}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <label className="inline-flex items-center gap-1.5 text-xs text-ink-1">
              <input
                type="checkbox"
                checked={showLengths}
                onChange={(e) => setShowLengths(e.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--accent))]"
              />
              {t('mapMeasure.showLengths')}
            </label>
            {mode === 'area' ? (
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-1">
                <input
                  type="checkbox"
                  checked={showArea}
                  onChange={(e) => setShowArea(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--accent))]"
                />
                {t('mapMeasure.showArea')}
              </label>
            ) : null}
          </div>
        </fieldset>

        {mode === 'area' && finishedId !== null ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyTargetArea();
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-xs font-medium text-ink-1">
                {t('mapMeasure.setArea')} ({AREA_UNIT_SUFFIX[areaUnit]})
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                aria-label={t('mapMeasure.setAreaAria')}
                placeholder="10"
                className="h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-hidden focus:ring-1 focus:ring-accent/30"
              />
            </label>
            <button
              type="submit"
              disabled={targetInput.trim() === ''}
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('mapMeasure.apply')}
            </button>
          </form>
        ) : null}

        {notice ? (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`text-2xs ${notice.tone === 'error' ? 'text-danger' : 'text-success'}`}
          >
            {notice.text}
          </p>
        ) : null}

        {save ? (
          <button
            type="button"
            onClick={() => void saveToMarkup()}
            disabled={saving || finishedId === null}
            className="inline-flex h-8 w-full items-center justify-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? t('mapMeasure.saving') : t('mapMeasure.saveToMarkup')}
          </button>
        ) : null}

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
