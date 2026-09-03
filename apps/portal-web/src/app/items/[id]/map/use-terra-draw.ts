// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The one terra-draw integration, shared by the editor runtime and the
 * map builder.
 *
 * Before this module the editor runtime carried the whole thing inline
 * across five effects and seven structurally-typed casts of a
 * `useRef<unknown>`, and the geo-boundary editor had grown a second
 * copy with different precision and no snapping. Giving the map builder
 * geometry editing (#82) would have made three. This is the extraction
 * the editor's own comments kept deferring, done once so the next
 * surface that wants to move a vertex mounts a hook rather than
 * copying 400 lines.
 *
 * Two hooks:
 *
 *  - `useTerraDraw(map, { snapping })` owns the instance: dynamic
 *    import (the bundle stays small for every page that never edits),
 *    adapter on the SAME MapLibre instance the canvas created, the four
 *    modes, the permissive id strategy, snapping kept in sync, and
 *    teardown. It does NOT call `start()`: an inert terra-draw does not
 *    intercept the canvas's own click handlers, and a started one
 *    contends with MapCanvas's select tool for every click. Callers
 *    start it when a write tool activates.
 *
 *  - `useGeometryEdit(draw, edit)` runs one feature's vertex-editing
 *    session: normalise the geometry to the adapter's precision, push
 *    it into the store with the right mode profile, select it so the
 *    handles render, track every drag through 'change', and remove it
 *    on exit. Returns the live geometry and whether it differs from the
 *    original; persisting is the caller's job, because the two callers
 *    persist differently (the editor sends `x-editor-id`, the builder
 *    relies on the layer share alone).
 *
 * What stays in the callers on purpose: feature-id resolution from a
 * map click (the editor keys on synthesised `gg:` source ids, the
 * builder on `source.kind === 'data-layer'`), the repaint after a save
 * (the editor bumps a geojson-url cache-buster, the builder calls
 * `refreshLayerSource`), undo/redo, templates, and the attribute form.
 */

import { useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import type { TerraDraw } from 'terra-draw';

/**
 * Decimal places terra-draw enforces on every coordinate. Has to match
 * the `coordinatePrecision` handed to the adapter; both read this so
 * they cannot drift. Nine digits is roughly 0.1 mm at the equator.
 *
 * Mandatory, not cosmetic: terra-draw's precision validator runs on
 * every `addFeatures`, and PostGIS returns full doubles (15-ish digits),
 * so a feature loaded from the server is rejected until it has been
 * through `roundCoordsToPrecision`.
 */
export const DRAW_COORD_PRECISION = 9;

/** Geometry families the draw modes map onto. */
export type DrawGeometryType = 'point' | 'line' | 'polygon';

/** terra-draw mode names this module registers. */
export type DrawMode = 'select' | 'point' | 'linestring' | 'polygon';

export function drawModeFor(geometryType: DrawGeometryType): DrawMode {
  return geometryType === 'line' ? 'linestring' : geometryType;
}

/**
 * Round every coordinate in a geometry to `precision` places, returning
 * a fresh structure. See DRAW_COORD_PRECISION for why this exists.
 */
export function roundCoordsToPrecision(
  geom: GeoJSON.Geometry,
  precision: number = DRAW_COORD_PRECISION,
): GeoJSON.Geometry {
  const factor = Math.pow(10, precision);
  const r = (n: number) => Math.round(n * factor) / factor;
  const rPos = (p: GeoJSON.Position): GeoJSON.Position =>
    p.length === 2
      ? [r(p[0]!), r(p[1]!)]
      : (p.map((v) => r(v)) as GeoJSON.Position);
  switch (geom.type) {
    case 'Point':
      return { type: 'Point', coordinates: rPos(geom.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geom.coordinates.map(rPos) };
    case 'LineString':
      return { type: 'LineString', coordinates: geom.coordinates.map(rPos) };
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geom.coordinates.map((line) => line.map(rPos)),
      };
    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geom.coordinates.map((ring) => ring.map(rPos)),
      };
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geom.coordinates.map((poly) =>
          poly.map((ring) => ring.map(rPos)),
        ),
      };
    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geom.geometries.map((g) =>
          roundCoordsToPrecision(g, precision),
        ),
      };
  }
}

/**
 * The select-mode flag profile, in one place. It used to be duplicated
 * verbatim between construction and the runtime snapping toggle, which
 * is the kind of pair that drifts the first time someone edits one.
 *
 *   - point: drag the whole feature; a point IS its vertex.
 *   - linestring / polygon: drag the feature, drag vertices, click
 *     midpoints to insert, alt-click a vertex to delete.
 *   - snappable: snap while dragging a vertex, when snapping is on.
 */
function selectFlags(snapping: boolean) {
  const coordinates = {
    midpoints: true,
    draggable: true,
    deletable: true,
    snappable: snapping ? { toLine: true, toCoordinate: true } : false,
  };
  return {
    point: { feature: { draggable: true } },
    linestring: { feature: { draggable: true, coordinates } },
    polygon: { feature: { draggable: true, coordinates } },
  };
}

function drawSnapping(snapping: boolean) {
  return snapping ? { toLine: true, toCoordinate: true } : undefined;
}

export interface UseTerraDrawOptions {
  /** Snap to existing vertices and lines while drawing or dragging. */
  snapping: boolean;
}

/**
 * Own a terra-draw instance on `map`. `draw` is null until the dynamic
 * import resolves; `ready` flips when it does, so an effect that must
 * act on the instance can list `ready` in its deps instead of hoping
 * the import beat it (the inline version had exactly that race: a tool
 * activated before the import resolved was silently ignored).
 */
export function useTerraDraw(
  map: maplibregl.Map | null,
  options: UseTerraDrawOptions,
): { draw: TerraDraw | null; ready: boolean } {
  const drawRef = useRef<TerraDraw | null>(null);
  const [ready, setReady] = useState(false);
  // Read at construction time only; runtime changes go through the
  // updateModeOptions effect below. A ref so the setup effect does not
  // rebuild the instance when the toggle flips.
  const snappingRef = useRef(options.snapping);
  snappingRef.current = options.snapping;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const td = await import('terra-draw');
      const adapterMod = await import('terra-draw-maplibre-gl-adapter');
      if (cancelled) return;
      const snapping = snappingRef.current;
      const snapInit = drawSnapping(snapping);
      const draw = new td.TerraDraw({
        adapter: new adapterMod.TerraDrawMapLibreGLAdapter({
          map,
          coordinatePrecision: DRAW_COORD_PRECISION,
        }),
        // Permissive id strategy. terra-draw's default validator wants
        // every id UUIDv4-shaped; the geometry-edit flow pushes the
        // server's feature id into the store, and that id's format is
        // not guaranteed across historical and engine-issued rows. Any
        // non-empty string or number is accepted. getId still mints a
        // real UUID for features terra-draw creates itself.
        idStrategy: {
          isValidId: (id) =>
            (typeof id === 'string' && id.length > 0) ||
            typeof id === 'number',
          getId: () =>
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
        },
        modes: [
          new td.TerraDrawPointMode(),
          new td.TerraDrawLineStringMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          new td.TerraDrawPolygonMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          new td.TerraDrawSelectMode({ flags: selectFlags(snapping) }),
        ],
      });
      drawRef.current = draw;
      setReady(true);

      cleanup = () => {
        try {
          draw.stop();
        } catch {
          /* terra-draw throws if it was never started; that is fine */
        }
        drawRef.current = null;
        setReady(false);
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [map]);

  // Runtime snapping toggle. Each call is wrapped separately because a
  // mode that is not registered throws, and a missing linestring mode
  // must not stop the polygon and select updates from landing.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !ready) return;
    const snap = drawSnapping(options.snapping);
    for (const mode of ['linestring', 'polygon'] as const) {
      try {
        draw.updateModeOptions(mode, { snapping: snap });
      } catch {
        /* mode not registered on this build */
      }
    }
    try {
      draw.updateModeOptions('select', { flags: selectFlags(options.snapping) });
    } catch {
      /* same */
    }
  }, [options.snapping, ready]);

  return { draw: ready ? drawRef.current : null, ready };
}

/** Safe wrappers: terra-draw throws on start-twice and on stop-before-start. */
export function startDraw(draw: TerraDraw | null): void {
  if (!draw) return;
  try {
    draw.start();
  } catch {
    /* already started */
  }
}

export function setDrawMode(draw: TerraDraw | null, mode: DrawMode): void {
  if (!draw) return;
  try {
    draw.setMode(mode);
  } catch {
    /* not started yet */
  }
}

/** One feature's vertex-editing session. */
export interface GeometryEditRequest {
  /**
   * Distinguishes two edits of the same feature id, so a session keyed
   * on this restarts cleanly. The editor uses its target key, the map
   * builder its map-layer id.
   */
  key: string;
  featureId: string;
  geometryType: DrawGeometryType;
  /** As read from the server; rounded to precision before loading. */
  geometry: GeoJSON.Geometry;
}

export interface GeometryEditState {
  /** The geometry as it is right now, after every drag so far. */
  currentGeometry: GeoJSON.Geometry | null;
  /** True once the current geometry differs from what was loaded. */
  dirty: boolean;
  /** Why the feature could not be loaded into the editor, if it could not. */
  loadError: string | null;
}

/**
 * Drive a geometry edit on `draw` for as long as `edit` is non-null.
 *
 * On entry: start, switch to select, push the feature into the store
 * with `properties.mode` set to its geometry family (that is how
 * terra-draw picks the flag profile), and select it so the handles
 * render. The original stays painted on the underlying layer; the
 * editable copy sits on top with handles, which is enough to say
 * "this one" without a transient layer filter.
 *
 * While active: every 'change' that names this feature reads the
 * latest geometry off the snapshot.
 *
 * On exit, or when `edit.key`/`featureId` changes: deselect and remove,
 * so nothing is left in the store to collide with the next session.
 * `addFeatures` swallows a validation rejection silently and
 * `selectFeature` then throws "No feature with this id"; the rejection
 * reason is read off the result and surfaced as `loadError` instead.
 */
export function useGeometryEdit(
  draw: TerraDraw | null,
  edit: GeometryEditRequest | null,
): GeometryEditState {
  const [currentGeometry, setCurrentGeometry] = useState<GeoJSON.Geometry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const originalRef = useRef<GeoJSON.Geometry | null>(null);

  const key = edit?.key ?? null;
  const featureId = edit?.featureId ?? null;

  useEffect(() => {
    if (!draw || !edit) {
      setCurrentGeometry(null);
      setLoadError(null);
      originalRef.current = null;
      return;
    }
    startDraw(draw);
    setDrawMode(draw, 'select');

    const tdId = edit.featureId;
    const geometry = roundCoordsToPrecision(edit.geometry);
    originalRef.current = geometry;
    setCurrentGeometry(geometry);
    setLoadError(null);

    // A previous session on the same id that lost its cleanup race
    // would make the store's duplicate check reject the new one.
    try {
      if (draw.hasFeature(tdId)) draw.removeFeatures([tdId]);
    } catch {
      /* ignore */
    }

    try {
      const results = draw.addFeatures([
        {
          id: tdId,
          type: 'Feature',
          geometry: geometry as never,
          properties: { mode: drawModeFor(edit.geometryType) },
        },
      ]);
      const rejection = (results ?? []).find((r) => !r.valid);
      if (rejection) {
        setLoadError(
          `Could not load geometry: ${rejection.reason ?? 'unknown reason'}`,
        );
      } else {
        draw.selectFeature(tdId);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? `Could not load geometry: ${err.message}`
          : 'Could not load geometry into the editor.',
      );
    }

    const handleChange = (ids: Array<string | number>) => {
      if (!ids.includes(tdId)) return;
      const f = draw.getSnapshot().find((x) => String(x.id) === tdId);
      if (f) setCurrentGeometry(f.geometry as GeoJSON.Geometry);
    };
    draw.on('change', handleChange);

    return () => {
      try {
        draw.off('change', handleChange);
      } catch {
        /* race on unmount */
      }
      try {
        draw.deselectFeature(tdId);
      } catch {
        /* race on unmount */
      }
      try {
        draw.removeFeatures([tdId]);
      } catch {
        /* race on unmount */
      }
    };
    // Keyed on identity, not on the geometry object: the caller's
    // state may rebuild the request on every render, and re-running
    // this on each one would reload the feature mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, key, featureId]);

  const dirty =
    currentGeometry !== null &&
    originalRef.current !== null &&
    JSON.stringify(currentGeometry) !== JSON.stringify(originalRef.current);

  return { currentGeometry, dirty, loadError };
}

/**
 * Cursor override for precise placement. MapLibre styles
 * `.maplibregl-canvas-container.maplibregl-interactive` with
 * `cursor: grab` directly, so the child canvas inherits it whatever
 * its own style says; setting inline on the container wins.
 */
export function useCrosshairCursor(map: maplibregl.Map | null, active: boolean): void {
  useEffect(() => {
    if (!map) return;
    const container = map.getCanvasContainer();
    if (!container) return;
    container.style.cursor = active ? 'crosshair' : '';
    return () => {
      container.style.cursor = '';
    };
  }, [map, active]);
}
