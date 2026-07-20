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
 * ONE LidarControl instance PER point-cloud LAYER (user feedback:
 * styling must be tied to each individual layer, and the library's
 * styling API is control-global). Each layer's persisted style
 * (color scheme, colormap, point size) plus the layer's opacity
 * apply to its own control, so two clouds on one map can disagree
 * freely. The library's own gear-button panel is hidden in maps
 * via the `className` option + CSS: its load-file / load-URL
 * inputs belong to the standalone item viewer, and styling lives
 * in OUR layer panel. The deck.gl canvas the control drives is
 * mounted on the map itself, so hiding the button container does
 * not affect rendering.
 *
 * Calls are serialized per map: the sync runs on every layer-list
 * change and loads are slow (network + wasm decode), so without a
 * queue two rapid toggles could double-load a cloud.
 */
import type maplibregl from 'maplibre-gl';
import type { MapLayer } from '@gratis-gis/shared-types';
import type { LidarControl } from 'maplibre-gl-lidar';

type PointCloudSource = Extract<MapLayer['source'], { kind: 'point-cloud' }>;
type PcLayer = MapLayer & { source: PointCloudSource };

interface CloudEntry {
  control: LidarControl;
  /** last applied style signature, to avoid re-style churn */
  styleSig: string;
}

interface OverlayState {
  /** layer id -> its dedicated control */
  clouds: Map<string, CloudEntry>;
  /** maxPitch to restore when the last 3D layer leaves */
  prevMaxPitch: number;
  /** serialization chain for sync calls */
  op: Promise<void>;
  /** "Loading point cloud..." chip shown during initial loads. A
   *  200M-point cloud takes ~10s of header + hierarchy fetches
   *  before the first point draws; without messaging that reads
   *  as "the layer is broken" (user feedback). */
  indicator: HTMLDivElement;
  /** cached module so later layer adds skip the dynamic import */
  mod: typeof import('maplibre-gl-lidar') | null;
}

const states = new WeakMap<maplibregl.Map, OverlayState>();

/**
 * Reconcile the loaded controls with the map's visible point-cloud
 * layers. Fire-and-forget from the canvas layer effect; errors
 * degrade to a console warning + missing layer rather than
 * breaking the 2D map.
 */
export function syncPointCloudOverlay(
  map: maplibregl.Map,
  layers: MapLayer[],
): void {
  const state = states.get(map);
  const desired = layers.filter(
    (l): l is PcLayer => l.source.kind === 'point-cloud' && l.visible,
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
  for (const [, entry] of state.clouds) {
    removeControl(map, entry);
  }
  state.clouds.clear();
}

function removeControl(map: maplibregl.Map, entry: CloudEntry): void {
  try {
    entry.control.stopStreaming();
  } catch {
    /* not streaming */
  }
  try {
    map.removeControl(entry.control);
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

function styleSigFor(layer: PcLayer): string {
  const scheme =
    layer.source.colorScheme ?? (layer.source.hasRgb ? 'rgb' : 'elevation');
  const colormap = layer.source.colormap ?? 'viridis';
  const size = layer.source.pointSize ?? 2;
  return `${scheme}:${colormap}:${size}:${layer.opacity ?? 1}`;
}

function applyStyle(entry: CloudEntry, layer: PcLayer): void {
  const sig = styleSigFor(layer);
  if (sig === entry.styleSig) return;
  entry.styleSig = sig;
  try {
    entry.control.setColorScheme(
      layer.source.colorScheme ??
        (layer.source.hasRgb ? 'rgb' : 'elevation'),
    );
    entry.control.setColormap(layer.source.colormap ?? 'viridis');
    entry.control.setPointSize(layer.source.pointSize ?? 2);
    entry.control.setOpacity(layer.opacity ?? 1);
  } catch {
    /* control mid-teardown */
  }
}

async function reconcile(
  map: maplibregl.Map,
  desired: PcLayer[],
): Promise<void> {
  let state = states.get(map);

  if (desired.length === 0) {
    if (state) {
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
      state = {
        clouds: new Map(),
        prevMaxPitch: map.getMaxPitch(),
        op: Promise.resolve(),
        indicator: makeIndicator(map),
        mod,
      };
      states.set(map, state);
      // 3D needs headroom to look under the horizon; MapLibre's
      // default 60 reads flat for terrain.
      map.setMaxPitch(85);
    }
    state.mod = mod;
  }

  // Drop controls for layers that were removed or hidden.
  const wantIds = new Set(desired.map((l) => l.id));
  for (const [layerId, entry] of Array.from(state.clouds)) {
    if (!wantIds.has(layerId)) {
      removeControl(map, entry);
      state.clouds.delete(layerId);
    }
  }

  // Create + load a control for each new layer.
  const toLoad = desired.filter((l) => !state.clouds.has(l.id));
  for (const [i, layer] of toLoad.entries()) {
    const mod = state.mod;
    if (!mod) return; // teardown raced the import
    const isHuge = (layer.source.pointCount ?? 0) > 20_000_000;
    const theme = document.documentElement.classList.contains('dark')
      ? ('dark' as const)
      : ('light' as const);
    const control = new mod.LidarControl({
      title: layer.title,
      collapsed: true,
      theme,
      // Hidden in maps (see module doc). The class carries a
      // display:none rule in globals.css.
      className: 'gg-lidar-hidden',
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
    const entry: CloudEntry = { control, styleSig: '' };
    state.clouds.set(layer.id, entry);

    const url = `${window.location.origin}${layer.source.dataUrl}`;
    showIndicator(
      state,
      toLoad.length > 1
        ? `Loading point clouds (${i + 1} of ${toLoad.length})...`
        : `Loading ${layer.title}...`,
    );
    try {
      await control.loadPointCloud(url);
    } catch (err) {
      console.warn(`point cloud layer "${layer.title}" failed to load`, err);
      showIndicator(state, `${layer.title} failed to load.`);
      // Leave the failure visible briefly instead of vanishing.
      await new Promise((r) => setTimeout(r, 2500));
      removeControl(map, entry);
      state.clouds.delete(layer.id);
    }
  }
  if (toLoad.length > 0) hideIndicator(state);

  // Per-layer styling: each control gets its own layer's persisted
  // choices. No topmost-wins compromise anymore.
  for (const layer of desired) {
    const entry = state.clouds.get(layer.id);
    if (entry) applyStyle(entry, layer);
  }
}
