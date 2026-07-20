// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Point-cloud overlay manager for MapCanvas (#179 unit 3).
 *
 * MapCanvas is shared by the map editor, the map viewer, and the
 * viewer/editor/field/custom app runtimes, so the 3D stack
 * (maplibre-gl-lidar -> deck.gl + copc.js + laz-perf wasm) must
 * not ride in its bundle. This module dynamic-imports the library
 * the first time a map actually shows a point-cloud layer;
 * 2D-only maps never pay for it.
 *
 * One LidarControl instance per MapLibre map handles every
 * point-cloud layer on that map (the control natively manages
 * multiple clouds). Layer visibility maps to load/unload of the
 * corresponding cloud. Styling (color scheme, point size) is
 * control-global, so the topmost visible point-cloud layer's
 * persisted choices win -- documented on the source type.
 *
 * Calls are serialized per map: the sync runs on every layer-list
 * change and loads are slow (network + wasm decode), so without a
 * queue two rapid toggles could double-load a cloud.
 */
import type maplibregl from 'maplibre-gl';
import type { MapLayer } from '@gratis-gis/shared-types';
import type { LidarControl } from 'maplibre-gl-lidar';

type PointCloudSource = Extract<MapLayer['source'], { kind: 'point-cloud' }>;

interface OverlayState {
  control: LidarControl;
  /** layer id -> point cloud id inside the control */
  loaded: Map<string, string>;
  /** last applied style signature, to avoid re-style churn */
  styleSig: string;
  /** maxPitch to restore when the last 3D layer leaves */
  prevMaxPitch: number;
  /** serialization chain for sync calls */
  op: Promise<void>;
  /** "Loading point cloud..." chip shown during initial loads. A
   *  200M-point cloud takes ~10s of header + hierarchy fetches
   *  before the first point draws; without messaging that reads
   *  as "the layer is broken" (user feedback). */
  indicator: HTMLDivElement;
}

const states = new WeakMap<maplibregl.Map, OverlayState>();

/**
 * Reconcile the control's loaded clouds with the map's visible
 * point-cloud layers. Fire-and-forget from the canvas layer
 * effect; errors degrade to a console warning + missing layer
 * rather than breaking the 2D map.
 */
export function syncPointCloudOverlay(
  map: maplibregl.Map,
  layers: MapLayer[],
): void {
  const state = states.get(map);
  const desired = layers.filter(
    (l): l is MapLayer & { source: PointCloudSource } =>
      l.source.kind === 'point-cloud' && l.visible,
  );
  if (desired.length === 0 && !state) return; // common case: 2D map
  const chain = (state?.op ?? Promise.resolve()).then(() =>
    reconcile(map, desired).catch((err) => {
      console.warn('point-cloud overlay sync failed', err);
    }),
  );
  if (state) state.op = chain;
}

/** Full teardown for canvas unmount. Safe when nothing mounted. */
export function teardownPointCloudOverlay(map: maplibregl.Map): void {
  const state = states.get(map);
  if (!state) return;
  states.delete(map);
  state.indicator.remove();
  try {
    state.control.stopStreaming();
  } catch {
    /* not streaming */
  }
  try {
    map.removeControl(state.control);
  } catch {
    /* map may already be tearing down */
  }
}

/** Bottom-left chip matching the portal's surface tokens. Plain
 *  DOM because this module manages the map imperatively; a React
 *  portal here would invert the ownership for one div. */
function makeIndicator(map: maplibregl.Map): HTMLDivElement {
  const el = document.createElement('div');
  el.className =
    'pointer-events-none absolute bottom-8 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-1/95 px-3 py-1.5 text-xs text-ink-1 shadow-raised backdrop-blur';
  el.style.display = 'none';
  el.setAttribute('role', 'status');
  map.getContainer().appendChild(el);
  return el;
}

function showIndicator(state: OverlayState, text: string): void {
  state.indicator.textContent = text;
  state.indicator.style.display = 'block';
}

function hideIndicator(state: OverlayState): void {
  state.indicator.style.display = 'none';
}

async function reconcile(
  map: maplibregl.Map,
  desired: Array<MapLayer & { source: PointCloudSource }>,
): Promise<void> {
  let state = states.get(map);

  if (desired.length === 0) {
    if (state) {
      for (const [, pcId] of state.loaded) {
        try {
          state.control.unloadPointCloud(pcId);
        } catch {
          /* already gone */
        }
      }
      state.loaded.clear();
      map.setMaxPitch(state.prevMaxPitch);
      teardownPointCloudOverlay(map);
    }
    return;
  }

  if (!state) {
    const mod = await import('maplibre-gl-lidar');
    // The control's panel styles ship separately; loading them here
    // keeps them in the lazy chunk too.
    await import('maplibre-gl-lidar/style.css');
    // Guard against a concurrent create that won the race while we
    // awaited the import.
    state = states.get(map);
    if (!state) {
      const totalPoints = desired.reduce(
        (sum, l) => sum + (l.source.pointCount ?? 0),
        0,
      );
      const isHuge = totalPoints > 20_000_000;
      const theme = document.documentElement.classList.contains('dark')
        ? ('dark' as const)
        : ('light' as const);
      const control = new mod.LidarControl({
        title: 'Point clouds',
        collapsed: true,
        theme,
        // The map's saved viewport is authoritative; never yank the
        // camera when a map with a 3D layer opens.
        autoZoom: false,
        // 2D feature popups own the click surface in maps; deck
        // picking on top of them reads as double tooltips.
        pickable: false,
        shareUrl: false,
        restoreFromUrl: false,
        streamingPointBudget: isHuge ? 1_500_000 : 4_000_000,
        streamingViewportDebounceMs: isHuge ? 400 : 150,
      });
      map.addControl(control, 'top-right');
      state = {
        control,
        loaded: new Map(),
        styleSig: '',
        prevMaxPitch: map.getMaxPitch(),
        op: Promise.resolve(),
        indicator: makeIndicator(map),
      };
      states.set(map, state);
      // 3D needs headroom to look under the horizon; MapLibre's
      // default 60 reads flat for terrain.
      map.setMaxPitch(85);
    }
  }

  const wantIds = new Set(desired.map((l) => l.id));
  for (const [layerId, pcId] of Array.from(state.loaded)) {
    if (!wantIds.has(layerId)) {
      try {
        state.control.unloadPointCloud(pcId);
      } catch {
        /* already gone */
      }
      state.loaded.delete(layerId);
    }
  }

  const toLoad = desired.filter((l) => !state.loaded.has(l.id));
  for (const [i, layer] of toLoad.entries()) {
    const url = `${window.location.origin}${layer.source.dataUrl}`;
    showIndicator(
      state,
      toLoad.length > 1
        ? `Loading point clouds (${i + 1} of ${toLoad.length})...`
        : `Loading ${layer.title}...`,
    );
    try {
      const info = await state.control.loadPointCloud(url);
      state.loaded.set(layer.id, info.id);
    } catch (err) {
      console.warn(`point cloud layer "${layer.title}" failed to load`, err);
      showIndicator(state, `${layer.title} failed to load.`);
      // Leave the failure visible briefly instead of vanishing.
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (toLoad.length > 0) hideIndicator(state);

  // Control-global styling: topmost visible point-cloud layer wins.
  const top = desired[0]!;
  const scheme =
    top.source.colorScheme ?? (top.source.hasRgb ? 'rgb' : 'elevation');
  const size = top.source.pointSize ?? 2;
  const sig = `${scheme}:${size}`;
  if (sig !== state.styleSig) {
    state.styleSig = sig;
    try {
      state.control.setColorScheme(scheme);
      state.control.setPointSize(size);
    } catch {
      /* control mid-teardown */
    }
  }
}
