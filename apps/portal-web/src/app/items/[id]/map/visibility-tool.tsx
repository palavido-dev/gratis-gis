'use client';
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Visibility tool: pick a spot on the map, choose a height and a
 * look distance, and the analysis worker computes what ground is
 * visible from there (gdal_viewshed on the map's elevation layer).
 * The result is a normal raster overlay item; while the map stays
 * open we poll the job and drop the finished layer straight onto
 * the map so the user never has to go hunting for it.
 *
 * Same hosting contract as the elevation profile tool: takes a
 * live MapLibre instance, portals its chrome into the map's own
 * container, keeps its map furniture outside the `gg:` teardown
 * namespace.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type maplibregl from 'maplibre-gl';
import { Eye, Loader2, X } from 'lucide-react';

import type { Item, MapLayer } from '@gratis-gis/shared-types';
import type { DemRef } from '@/lib/dem-resolver';
import { buildTileLayer, fetchHydratedItem } from './portal-item-layers';

const PICK_SOURCE = 'gg-visibility-pt';
const M_TO_FT = 3.28084;
const M_TO_MI = 1 / 1609.344;

export interface VisibilityToolProps {
  map: maplibregl.Map | null;
  open: boolean;
  onClose: () => void;
  /** Same resolver the profile tool uses; must include itemId. */
  resolveDemUrl: (
    bbox: [number, number, number, number],
  ) => Promise<DemRef | null>;
  /** Called with the finished visibility layer to add to the map. */
  onLayerReady: (layer: MapLayer) => void;
}

type Phase =
  | { step: 'pick' }
  | { step: 'configure'; lng: number; lat: number }
  | {
      step: 'running';
      lng: number;
      lat: number;
      demItemId: string;
      jobId: string;
      targetItemId: string;
      progress: number;
    }
  | { step: 'done'; title: string }
  | { step: 'error'; message: string };

type Units = 'imperial' | 'metric';

function loadUnits(): Units {
  if (typeof window === 'undefined') return 'imperial';
  return window.localStorage.getItem('gg-profile-units') === 'metric'
    ? 'metric'
    : 'imperial';
}

export function VisibilityTool({
  map,
  open,
  onClose,
  resolveDemUrl,
  onLayerReady,
}: VisibilityToolProps) {
  const [phase, setPhase] = useState<Phase>({ step: 'pick' });
  const [units, setUnits] = useState<Units>(loadUnits);
  // Height above ground and look distance, stored in the display
  // unit and converted to meters at submit.
  const [heightVal, setHeightVal] = useState<string>('6');
  const [distVal, setDistVal] = useState<string>('1');

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // ---- Pick interaction ------------------------------------------
  const picking = open && phase.step === 'pick';
  useEffect(() => {
    if (!map || !picking) return;
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => {
      setPhase({ step: 'configure', lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    map.on('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      map.off('click', onClick);
      window.removeEventListener('keydown', onKey);
      canvas.style.cursor = prevCursor;
    };
  }, [map, picking, onClose]);

  // ---- Picked-spot marker ----------------------------------------
  const picked =
    phase.step === 'configure' || phase.step === 'running'
      ? { lng: phase.lng, lat: phase.lat }
      : null;
  useEffect(() => {
    if (!map) return;
    const ensure = () => {
      if (!open) return;
      try {
        if (!map.getSource(PICK_SOURCE)) {
          map.addSource(PICK_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          });
          map.addLayer({
            id: `${PICK_SOURCE}-halo`,
            type: 'circle',
            source: PICK_SOURCE,
            paint: {
              'circle-radius': 12,
              'circle-color': '#2ea043',
              'circle-opacity': 0.25,
            },
          });
          map.addLayer({
            id: `${PICK_SOURCE}-dot`,
            type: 'circle',
            source: PICK_SOURCE,
            paint: {
              'circle-radius': 5,
              'circle-color': '#2ea043',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          });
        }
        (map.getSource(PICK_SOURCE) as maplibregl.GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: picked
            ? [
                {
                  type: 'Feature',
                  geometry: {
                    type: 'Point',
                    coordinates: [picked.lng, picked.lat],
                  },
                  properties: {},
                },
              ]
            : [],
        });
      } catch {
        // Style mid-swap; styledata re-runs us.
      }
    };
    ensure();
    map.on('styledata', ensure);
    return () => {
      map.off('styledata', ensure);
    };
  }, [map, open, picked?.lng, picked?.lat]);

  useEffect(() => {
    if (!map || open) return;
    cleanupMarker(map);
  }, [map, open]);
  useEffect(() => {
    return () => {
      if (map) cleanupMarker(map);
    };
  }, [map]);
  useEffect(() => {
    if (!open) setPhase({ step: 'pick' });
  }, [open]);

  // ---- Submit ----------------------------------------------------
  const submit = useCallback(async () => {
    if (phaseRef.current.step !== 'configure') return;
    const { lng, lat } = phaseRef.current;
    const height = Number(heightVal);
    const dist = Number(distVal);
    if (!Number.isFinite(height) || !Number.isFinite(dist)) {
      setPhase({
        step: 'error',
        message: 'Height and distance need to be numbers.',
      });
      return;
    }
    const heightM = units === 'imperial' ? height / M_TO_FT : height;
    const maxDistanceM = units === 'imperial' ? dist / M_TO_MI : dist * 1000;
    try {
      const dem = await resolveDemUrl([lng, lat, lng, lat]);
      if (!dem) {
        setPhase({
          step: 'error',
          message:
            'No elevation layer covers this spot. Create one from a point cloud first (its page has a "Create elevation layer" button).',
        });
        return;
      }
      const res = await fetch(
        `/api/portal/items/${dem.itemId}/analysis/viewshed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lng, lat, heightM, maxDistanceM }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string | string[];
        } | null;
        const msg = Array.isArray(body?.message)
          ? body.message.join(' ')
          : body?.message;
        setPhase({
          step: 'error',
          message: msg || 'The visibility job could not be started.',
        });
        return;
      }
      const out = (await res.json()) as {
        job: { id: string };
        targetItemId: string;
      };
      setPhase({
        step: 'running',
        lng,
        lat,
        demItemId: dem.itemId,
        jobId: out.job.id,
        targetItemId: out.targetItemId,
        progress: 1,
      });
    } catch {
      setPhase({
        step: 'error',
        message: 'The visibility job could not be started.',
      });
    }
  }, [heightVal, distVal, units, resolveDemUrl]);

  // ---- Poll the running job --------------------------------------
  useEffect(() => {
    if (phase.step !== 'running') return;
    const { demItemId, jobId, targetItemId } = phase;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${demItemId}/analysis/jobs`,
        );
        if (!res.ok || cancelled) return;
        const jobs = (await res.json()) as Array<{
          id: string;
          state: string;
          progress: number | null;
          error: string | null;
        }>;
        const job = jobs.find((j) => j.id === jobId);
        if (!job || cancelled) return;
        if (job.state === 'failed') {
          setPhase({
            step: 'error',
            message: job.error || 'The visibility job failed.',
          });
        } else if (job.state === 'done') {
          const { item, error } = await fetchHydratedItem({
            id: targetItemId,
            title: 'Visible area',
            type: 'tile_layer',
          } as Item);
          if (cancelled) return;
          if (!item) {
            setPhase({
              step: 'error',
              message: error || 'The result layer could not be loaded.',
            });
            return;
          }
          const built = buildTileLayer(item);
          if (built.error !== undefined) {
            setPhase({ step: 'error', message: built.error });
          } else {
            onLayerReady(built.layer);
            setPhase({ step: 'done', title: item.title });
          }
        } else {
          setPhase((cur) =>
            cur.step === 'running'
              ? { ...cur, progress: job.progress ?? cur.progress }
              : cur,
          );
        }
      } catch {
        // Transient fetch error; keep polling.
      }
    };
    const timer = window.setInterval(() => void tick(), 4000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // phase.step transition to 'running' carries stable ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.step === 'running' ? phase.jobId : null]);

  function setUnitsPersist(u: Units) {
    // Convert current field values so the numbers keep meaning.
    const h = Number(heightVal);
    const d = Number(distVal);
    if (Number.isFinite(h)) {
      setHeightVal(
        u === 'imperial'
          ? (h * M_TO_FT).toFixed(0)
          : (h / M_TO_FT).toFixed(1),
      );
    }
    if (Number.isFinite(d)) {
      setDistVal(
        u === 'imperial'
          ? (d * 0.621371).toFixed(2)
          : (d / 0.621371).toFixed(2),
      );
    }
    setUnits(u);
    try {
      window.localStorage.setItem('gg-profile-units', u);
    } catch {
      /* private mode */
    }
  }

  const container = map?.getContainer() ?? null;
  if (!open || !container) return null;

  return createPortal(
    <>
      {phase.step === 'pick' ? (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-surface-0/95 px-4 py-1.5 text-xs font-medium text-ink-1 shadow-card backdrop-blur"
        >
          Click the spot you want to look from.
        </div>
      ) : null}
      <div className="absolute bottom-2 left-1/2 z-20 w-[min(26rem,calc(100%-1rem))] -translate-x-1/2 rounded-lg border border-border bg-surface-0/95 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <Eye className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-ink-0">
            Visibility
          </span>
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
                  {u === 'imperial' ? 'ft / mi' : 'm / km'}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close visibility tool"
              className="rounded-md p-1 text-muted hover:bg-surface-1 hover:text-ink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-3 py-2.5 text-sm">
          {phase.step === 'pick' ? (
            <p className="text-muted">
              Pick a spot on the map, then choose how high up and how
              far to look. The result shows the ground that can be
              seen from there.
            </p>
          ) : phase.step === 'configure' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block text-xs text-muted">
                  Height above the ground (
                  {units === 'imperial' ? 'ft' : 'm'})
                  <input
                    type="number"
                    value={heightVal}
                    min={1}
                    onChange={(e) => setHeightVal(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-ink-0"
                  />
                </label>
                <label className="block text-xs text-muted">
                  How far to look (
                  {units === 'imperial' ? 'miles' : 'km'})
                  <input
                    type="number"
                    value={distVal}
                    min={0.1}
                    step={0.25}
                    onChange={(e) => setDistVal(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-ink-0"
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPhase({ step: 'pick' })}
                  className="text-xs text-muted underline-offset-2 hover:underline"
                >
                  Pick a different spot
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
                >
                  <Eye className="h-3.5 w-3.5" />
                  See what&apos;s visible
                </button>
              </div>
            </div>
          ) : phase.step === 'running' ? (
            <div className="flex items-center gap-2.5 py-1 text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              <div className="min-w-0 flex-1">
                <p>Working it out... {phase.progress}%</p>
                <p className="text-2xs">
                  This can take a minute or two. The layer will drop
                  onto the map when it&apos;s ready.
                </p>
              </div>
            </div>
          ) : phase.step === 'done' ? (
            <div className="space-y-1.5 py-0.5">
              <p className="text-ink-1">
                Done. &quot;{phase.title}&quot; was added to the map;
                green is the ground visible from that spot.
              </p>
              <button
                type="button"
                onClick={() => setPhase({ step: 'pick' })}
                className="text-xs text-accent underline-offset-2 hover:underline"
              >
                Try another spot
              </button>
            </div>
          ) : (
            <div className="space-y-1.5 py-0.5">
              <p className="text-danger">{phase.message}</p>
              <button
                type="button"
                onClick={() => setPhase({ step: 'pick' })}
                className="text-xs text-accent underline-offset-2 hover:underline"
              >
                Start over
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    container,
  );
}

function cleanupMarker(map: maplibregl.Map) {
  try {
    for (const id of [`${PICK_SOURCE}-halo`, `${PICK_SOURCE}-dot`]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(PICK_SOURCE)) map.removeSource(PICK_SOURCE);
  } catch {
    // Map torn down mid-cleanup.
  }
}
