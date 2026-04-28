'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type maplibregl from 'maplibre-gl';
import {
  ArrowLeft,
  MousePointer2,
  PencilRuler,
  Plus,
  Redo2,
  Ruler,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { LayerPanel } from '../map/layer-panel';
import {
  discoverLayerMetadata,
  type LayerMetadata,
} from '../map/layer-metadata';
import { SearchBar } from '../map/search-bar';
import { AttributeTable } from '../map/attribute-table';
import type {
  EditorData,
  EditorTool,
  MapData,
  PickListData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import {
  EDITOR_TARGET_LAYER_PREFIX,
  editorTargetLayerId,
  type ResolvedTarget,
} from './build-map-data';
import { AttributeForm } from './attribute-form';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface Props {
  /** The Editor item id (used for the back link and POST URLs). */
  editorId: string;
  /** The Editor item's title (rendered in the runtime header). */
  editorTitle: string;
  /** Persisted Editor configuration. Targets, tools, snapping. */
  editor: EditorData;
  /** Server-resolved per-target metadata: data_layer title + sublayer
   *  with field schema + geometry type. Used to drive the active-
   *  target picker, the drawing-mode selector, and the attribute
   *  form. Targets whose layer could not be resolved are still in
   *  the list with `layer === null`; the runtime hides them from
   *  Add-tool eligibility. */
  resolvedTargets: ResolvedTarget[];
  /** Server-resolved pick lists referenced by any target field's
   *  coded-value-ref domain, indexed by pick_list item id. Lets
   *  the AttributeForm render a real <select> instead of a raw
   *  text input for fields backed by a domain. */
  pickLists: Record<string, PickListData>;
  /**
   * Title of the referenced map, if any. Server resolves this so we
   * can show "Reference map: <title>" in the header without a
   * client-side fetch.
   */
  referencedMapTitle: string | null;
  /**
   * Synthesized MapData composed of the referenced map's layers + the
   * Editor's targets as new layers. See build-map-data.ts.
   */
  initialMapData: MapData;
  /** Synthetic ids for the target-layer entries within initialMapData. */
  targetLayerIds: string[];
  /** Basemap items in the org, for MapCanvas's basemap library. */
  basemaps: CustomBasemap[];
  /** Whether the caller has edit rights on the Editor item. Drives
   *  whether tool buttons are enabled at all. */
  canEdit: boolean;
}

/**
 * Editor runtime canvas (slice 3b-2: read-only render + Add tool).
 *
 * Renders the editor's composed MapData via MapCanvas. Mounts
 * terra-draw on the same MapLibre instance via MapCanvas's
 * onMapReady callback so drawing primitives don't require a
 * separate map. Active tool + active target drive terra-draw's
 * mode; on draw `finish`, the AttributeForm modal pops with
 * fields generated from the layer schema, and submission POSTs to
 * the v3 features endpoint.
 *
 * Authorization (the conjunctive rule, see docs/editing-and-collection.md):
 *
 *   - data_layer.editingEnabled gates whether the layer is editable
 *     at all. Targets pointing at editingEnabled=false layers are
 *     filtered out of Add-tool eligibility client-side AND the
 *     server's existing v3 share-edit check rejects writes that
 *     reach it anyway.
 *   - The Editor target's canCreate flag narrows from there. Targets
 *     with canCreate=false are not in the active-target picker.
 *   - editableFields narrows the attribute form. Fields not in the
 *     allowed set render read-only (or do not appear at all if the
 *     list is empty).
 *
 * The server-side editor-policy enforcement (so a malicious client
 * cannot bypass the Editor UI by hitting the v3 endpoint directly
 * with a forbidden combination) lands in a follow-up commit. Today
 * the data_layer's own editing.policy + share-edit check are the
 * authoritative gates server-side; the Editor UI's stricter rules
 * are advisory until the policy middleware ships.
 *
 * Tool status:
 *   - select: render-only (no special UI yet, MapCanvas's built-in
 *     popup handles single-feature inspection)
 *   - add: ON. Picks active target, switches terra-draw mode to
 *     match geometry type, captures the drawn geometry, opens the
 *     attribute form, POSTs the new feature, refreshes the layer.
 *   - edit / delete: stubs (slice 3b-3, 3b-4)
 *   - snap toggle / measure: stubs (slice 3b-5)
 *   - undo / redo: stubs (slice 3b-5)
 */
export function EditorRuntime({
  editorId,
  editorTitle,
  editor,
  resolvedTargets,
  pickLists,
  referencedMapTitle,
  initialMapData,
  targetLayerIds,
  basemaps,
  canEdit,
}: Props) {
  const [mapData, setMapData] = useState<MapData>(initialMapData);
  // Track the camera's current zoom so LayerPanel can render the
  // "current view" tick under each layer's scale-range slider.
  const [currentZoom, setCurrentZoom] = useState<number>(initialMapData.zoom);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Tool / active-target machinery. activeTool drives terra-draw and
  // toolbar highlight; activeTargetKey is "<dataLayerId>:<layerKey>"
  // so we can look the resolved target up cheaply. canEdit gates
  // whether any of this is enabled.
  const [activeTool, setActiveTool] = useState<EditorTool | 'off'>('off');
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);

  // Pending feature waiting for attribute submission. For Add (mode
  // 'create'), set by terra-draw 'finish'; for Edit ('update'), set
  // by the click-to-pick handler with the feature's existing
  // properties prefilled. featureId is null for create and the
  // global_id (UUID) for update.
  const [pendingFeature, setPendingFeature] = useState<{
    mode: 'create' | 'update';
    geometry: unknown;
    targetKey: string;
    featureId: string | null;
    initialProperties: Record<string, unknown>;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Tracks the underlying maplibregl.Map captured via onMapReady.
  // useState (not useRef) so the terra-draw setup effect can react
  // to it.
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);

  // Refs that the terra-draw 'finish' closure reads. Avoids stale
  // closures when activeTargetKey changes between drawings.
  const activeTargetKeyRef = useRef(activeTargetKey);
  activeTargetKeyRef.current = activeTargetKey;

  // Active feature template (#121). When the chosen target has
  // templates configured, picking one overrides the geometry tool
  // for the next draw and prefills the attribute form with the
  // template's preset attributes. Cleared when the user exits Add
  // mode, switches to a different target, or successfully submits.
  // Stored as state for re-renders + a ref so the terra-draw
  // 'finish' closure (which is registered once and reads through
  // a ref to avoid stale closures, same pattern as
  // activeTargetKeyRef) sees the current value.
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(
    null,
  );
  const activeTemplateIdRef = useRef(activeTemplateId);
  activeTemplateIdRef.current = activeTemplateId;

  const drawRef = useRef<unknown | null>(null);

  // Per-layer probe metadata. Mirrors the pattern map-editor uses:
  // when the layer list changes, fetch each layer's geojson (or
  // arcgis-rest description) once and cache fields / geometryTypes
  // / sample features / etc. LayerPanel consumes this to render
  // proper swatches and field pickers in style/popup editors;
  // SearchBar (slice 3b-x) will consume the cached
  // featureCollection for attribute search; AttributeTable will
  // consume both. AbortController per layer so a rapid layer-list
  // churn doesn't leave us with in-flight fetches scribbling over
  // newer state.
  const [metadata, setMetadata] = useState<Record<string, LayerMetadata>>({});
  const probeAbortsRef = useRef<Record<string, AbortController>>({});
  const sourceKeysJoined = mapData.layers
    .map((l) => `${l.id}|${JSON.stringify(l.source)}`)
    .join('\n');
  useEffect(() => {
    const seen = new Set(mapData.layers.map((l) => l.id));
    // Drop metadata for layers that were removed (visibility toggle
    // doesn't drop; full removal does).
    setMetadata((prev) => {
      const next: Record<string, LayerMetadata> = {};
      for (const [id, md] of Object.entries(prev)) {
        if (seen.has(id)) next[id] = md;
      }
      return next;
    });

    for (const layer of mapData.layers) {
      const existing = metadata[layer.id];
      if (existing && !existing.loading && !existing.error) continue;
      probeAbortsRef.current[layer.id]?.abort();
      const controller = new AbortController();
      probeAbortsRef.current[layer.id] = controller;
      setMetadata((prev) => ({
        ...prev,
        [layer.id]: {
          fields: prev[layer.id]?.fields ?? [],
          valuesByField: prev[layer.id]?.valuesByField ?? {},
          sampleProperties: prev[layer.id]?.sampleProperties ?? null,
          featureCollection: prev[layer.id]?.featureCollection ?? null,
          geometryTypes: prev[layer.id]?.geometryTypes ?? new Set(),
          isTable: prev[layer.id]?.isTable ?? false,
          error: null,
          loading: true,
        },
      }));
      void discoverLayerMetadata(layer, controller.signal).then((md) => {
        if (controller.signal.aborted) return;
        setMetadata((prev) => ({ ...prev, [layer.id]: md }));
      });
    }
    return () => {
      for (const c of Object.values(probeAbortsRef.current)) c.abort();
    };
    // The joined source-key string changes when a layer is added /
    // removed / has its source swapped; that's exactly when we want
    // to re-probe. Including `metadata` in the deps would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKeysJoined]);

  // Cached feature collections per layer, derived from metadata so
  // SearchBar + AttributeTable don't refetch. featuresByLayer stays
  // in sync with metadata automatically; consumers see null while
  // a layer is loading, then the FeatureCollection once the probe
  // settles.
  const featuresByLayer = useMemo(() => {
    const out: Record<string, GeoJSON.FeatureCollection | null> = {};
    for (const [id, md] of Object.entries(metadata)) {
      out[id] = md.featureCollection;
    }
    return out;
  }, [metadata]);

  // Pending-delete state for the Delete tool. Holds the feature
  // the user clicked + a short label for the confirm dialog.
  // Settled when the user confirms or cancels the dialog.
  const [pendingDelete, setPendingDelete] = useState<{
    dataLayerId: string;
    layerKey: string;
    featureId: string;
    layerTitle: string;
    /** Short user-facing description for the dialog body, e.g.
     *  "Building #4127" or "feature 0a1b2c3d...". Falls back to
     *  the global_id prefix when no obvious display field exists. */
    summary: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Geometry-edit state. Drives terra-draw's select mode + the
  // floating action bar that lets the author commit / cancel /
  // hop into attribute editing. originalGeometry stays around so
  // Cancel can put the on-canvas overlay back where it started
  // (terra-draw mutates currentGeometry as the user drags). The
  // featureId is the global_id (uuid); properties are stashed so
  // the user can switch over to attribute editing without losing
  // their in-flight geometry edit -- the geometry is saved first,
  // then the attribute form opens with the up-to-date row.
  const [pendingGeometryEdit, setPendingGeometryEdit] = useState<{
    dataLayerId: string;
    layerKey: string;
    targetKey: string;
    featureId: string;
    geometryType: 'point' | 'line' | 'polygon';
    originalGeometry: GeoJSON.Geometry;
    currentGeometry: GeoJSON.Geometry;
    properties: Record<string, unknown>;
  } | null>(null);
  const [geomEditSaving, setGeomEditSaving] = useState(false);
  const [geomEditError, setGeomEditError] = useState<string | null>(null);
  // Internal terra-draw id for the feature we're editing; held in a
  // ref so cleanup effects can clear it without re-creating the
  // setup effect's closure on every render.
  const tdEditFeatureIdRef = useRef<string | null>(null);

  // Snap-to-vertex on/off for this session. Initialized from the
  // editor item's persisted snapping config so authors who set
  // snapping off in the editor's config don't have it suddenly
  // turn back on at runtime. Toggling persists for the session
  // only; we don't write back to editor.snapping so a viewer
  // can't mutate someone else's config. tolerancePx and selfSnap
  // from the persisted config aren't yet wired -- terra-draw 1.28
  // exposes binary toLine / toCoordinate snapping flags rather
  // than a configurable pixel tolerance, and the "self only" idea
  // doesn't map cleanly to terra-draw's store-scoped model. Today
  // the feature is just on / off; richer snap controls land in a
  // follow-up.
  const [snappingEnabled, setSnappingEnabled] = useState<boolean>(
    editor.snapping.enabled,
  );
  // Ref so the terra-draw setup closure (which only re-runs on
  // mapInstance change, not every render) can read the latest
  // value when constructing modes. Toggle effect below
  // updateModeOptions for runtime changes.
  const snappingEnabledRef = useRef(snappingEnabled);
  snappingEnabledRef.current = snappingEnabled;

  // AttributeTable state. tableOpen drives the bottom-overlay
  // panel; tableFocusLayerId anchors the table to a specific layer
  // when the user opens it from a layer-panel kebab. selection is
  // shared with MapCanvas + AttributeTable so highlighting a row
  // also highlights the feature on the canvas (and vice versa).
  // Same shape map-editor uses.
  const [tableOpen, setTableOpen] = useState(false);
  const [tableFocusLayerId, setTableFocusLayerId] = useState<string | null>(
    null,
  );
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  // Index resolvedTargets by key so the picker / panel / submit
  // path can look up O(1).
  const targetByKey = useMemo(() => {
    const m = new Map<string, ResolvedTarget>();
    for (const t of resolvedTargets) {
      m.set(`${t.dataLayerId}:${t.layerKey}`, t);
    }
    return m;
  }, [resolvedTargets]);

  // Targets eligible for the Add tool: must have canCreate, a
  // resolved layer, layer.editingEnabled !== false, and a non-null
  // geometry type (we can't draw geometry into attribute-only
  // related tables).
  const eligibleAddTargets = useMemo(() => {
    return editor.targets
      .map((t) => {
        const key = `${t.dataLayerId}:${t.layerKey}`;
        const resolved = targetByKey.get(key);
        return { editorTarget: t, resolved, key };
      })
      .filter(
        (e) =>
          e.editorTarget.canCreate &&
          e.resolved?.layer &&
          e.resolved.layer.editingEnabled !== false &&
          e.resolved.layer.geometryType !== null,
      );
  }, [editor.targets, targetByKey]);

  // Top-level target layer count (for the toolbar's "N editable
  // layer(s)" label). LayerPanel handles its own tree rendering so
  // we don't need a full split anymore -- just count how many
  // editor-target layers landed in the synthesized MapData.
  const targetCount = useMemo(() => {
    const targetSet = new Set(targetLayerIds);
    return mapData.layers.filter((l) => targetSet.has(l.id)).length;
  }, [mapData.layers, targetLayerIds]);

  // LayerPanel emits a fresh layers array on every mutation
  // (visibility toggle, drag-reorder, opacity, kebab actions); we
  // just splice it back into mapData. MapCanvas's blunt sync
  // picks up the change and re-paints.
  const onLayersChange = useCallback(
    (next: typeof mapData.layers) => {
      setMapData((cur) => ({ ...cur, layers: next }));
    },
    [],
  );

  // Basemap switcher. The runtime allows the user to swap the
  // basemap for THEIR session view; the change does not persist
  // back to the editor item. Always-on; even view-only users get
  // the picker so they can pick a basemap that suits the task at
  // hand (satellite for context, plain for legibility, etc).
  const onBasemapChange = useCallback((id: string) => {
    setMapData((cur) => ({ ...cur, basemap: id }));
  }, []);

  // Refresh a target layer's source by appending a fresh _ts param
  // to its geojson URL. MapCanvas's blunt sync tears down + rebuilds
  // any layer whose URL changes, which forces a re-fetch and
  // re-renders the new feature without flicker on the basemap.
  const refreshTarget = useCallback(
    (dataLayerId: string, layerKey: string) => {
      const id = editorTargetLayerId(dataLayerId, layerKey);
      const ts = Date.now();
      setMapData((cur) => ({
        ...cur,
        layers: cur.layers.map((l) => {
          if (l.id !== id) return l;
          if (l.source.kind !== 'geojson-url') return l;
          // Strip any prior _ts param so the URL stays clean.
          const baseUrl = l.source.url.replace(/[?&]_ts=\d+/, '');
          const sep = baseUrl.includes('?') ? '&' : '?';
          return {
            ...l,
            source: { ...l.source, url: `${baseUrl}${sep}_ts=${ts}` },
          };
        }),
      }));
    },
    [],
  );

  // Set up terra-draw once the map instance is ready. We import
  // dynamically so the bundle stays small for non-runtime pages
  // (config view, items list, etc). Single setup effect creates
  // the instance and the finish listener; mode changes happen in
  // a separate effect below.
  useEffect(() => {
    if (!mapInstance) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const td = await import('terra-draw');
      const adapterMod = await import('terra-draw-maplibre-gl-adapter');
      if (cancelled) return;
      // Snap-to-vertex initial config. terra-draw exposes snapping
      // as a per-mode option on the line / polygon DRAW modes
      // (snap candidates as the user clicks the next vertex) AND
      // as a `snappable` flag on the SELECT mode's coordinate
      // settings (snap candidates as the user drags an existing
      // vertex during geometry edit). Point-mode has no snapping
      // story because a point IS its vertex. We set the same
      // toLine + toCoordinate booleans across both surfaces so
      // the experience is consistent, then `updateModeOptions`
      // below for runtime toggles.
      const snapInit = snappingEnabledRef.current
        ? { toLine: true, toCoordinate: true }
        : undefined;
      const draw = new td.TerraDraw({
        adapter: new adapterMod.TerraDrawMapLibreGLAdapter({
          map: mapInstance,
          coordinatePrecision: 9,
        }),
        modes: [
          new td.TerraDrawPointMode(),
          new td.TerraDrawLineStringMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          new td.TerraDrawPolygonMode(
            snapInit ? { snapping: snapInit } : undefined,
          ),
          // Select mode is what powers geometry editing. The flags
          // tell terra-draw which interactions are allowed for each
          // geometry family the editor exposes:
          //   - point: drag the whole feature (no vertices to drag
          //     because a point IS the vertex).
          //   - linestring / polygon: drag the whole feature, drag
          //     individual vertices, click midpoints to insert new
          //     vertices, alt-click a vertex to delete it.
          //   - snappable on coordinates wires snap-during-drag for
          //     the geometry edit flow (#120).
          // We don't pass a `selectable: false` flag because the
          // setup effect explicitly calls selectFeature() when
          // entering geometry edit, then deselects on exit; the
          // default click-to-select behaviour is fine here too.
          new td.TerraDrawSelectMode({
            flags: {
              point: { feature: { draggable: true } },
              linestring: {
                feature: {
                  draggable: true,
                  coordinates: {
                    midpoints: true,
                    draggable: true,
                    deletable: true,
                    snappable: snapInit ?? false,
                  },
                },
              },
              polygon: {
                feature: {
                  draggable: true,
                  coordinates: {
                    midpoints: true,
                    draggable: true,
                    deletable: true,
                    snappable: snapInit ?? false,
                  },
                },
              },
            },
          }),
        ],
      });
      // We don't start() yet; that happens when the user activates
      // the Add tool. Keeping terra-draw inert until then prevents
      // it from intercepting MapCanvas's click handlers (popups,
      // hover, etc.) on the read-only path.
      drawRef.current = draw;

      cleanup = () => {
        try {
          (draw as { stop?: () => void }).stop?.();
        } catch {
          /* terra-draw throws if it wasn't started; ignore */
        }
        drawRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [mapInstance]);

  // Runtime snap toggle. When the user clicks the Snap tool button
  // we flip `snappingEnabled`; this effect picks it up and patches
  // the draw + select modes via terra-draw's `updateModeOptions`
  // so we don't have to tear down + rebuild the whole instance
  // (which would interrupt any in-progress draw / edit). Mirrors
  // the per-mode shape used at construction time above.
  useEffect(() => {
    const draw = drawRef.current as
      | {
          updateModeOptions: (
            mode: string,
            options: Record<string, unknown>,
          ) => void;
        }
      | null;
    if (!draw) return;
    const snap = snappingEnabled
      ? { toLine: true, toCoordinate: true }
      : undefined;
    try {
      draw.updateModeOptions('linestring', { snapping: snap });
    } catch {
      /* mode not available on this build; ignore */
    }
    try {
      draw.updateModeOptions('polygon', { snapping: snap });
    } catch {
      /* same */
    }
    try {
      // Select mode's snapping is per geometry family, nested under
      // each flag profile. We match the construction-time shape so
      // the partial update only changes the snappable bit.
      draw.updateModeOptions('select', {
        flags: {
          point: { feature: { draggable: true } },
          linestring: {
            feature: {
              draggable: true,
              coordinates: {
                midpoints: true,
                draggable: true,
                deletable: true,
                snappable: snap ?? false,
              },
            },
          },
          polygon: {
            feature: {
              draggable: true,
              coordinates: {
                midpoints: true,
                draggable: true,
                deletable: true,
                snappable: snap ?? false,
              },
            },
          },
        },
      });
    } catch {
      /* same */
    }
  }, [snappingEnabled, mapInstance]);

  // Keep an "on draw finish" listener registered against the live
  // draw instance. Re-registers if the instance changes (rare; only
  // on map remount). The closure reads activeTargetKeyRef so it
  // always sees the current active target even if the user
  // switched targets between drawings.
  useEffect(() => {
    const draw = drawRef.current as
      | {
          on: (
            ev: 'finish',
            cb: (id: string, ctx: { mode: string }) => void,
          ) => void;
          off: (
            ev: 'finish',
            cb: (id: string, ctx: { mode: string }) => void,
          ) => void;
          getSnapshot: () => Array<{
            id: string | number;
            geometry: { type: string; coordinates: unknown };
          }>;
          clear: () => void;
          setMode: (m: string) => void;
        }
      | null;
    if (!draw) return;

    const handleFinish = (id: string) => {
      const snap = draw.getSnapshot();
      const f = snap.find((x) => String(x.id) === String(id));
      if (!f || !f.geometry) return;
      const targetKey = activeTargetKeyRef.current;
      if (!targetKey) return;
      // When a feature template is active, prefill the attribute
      // form with its preset attributes (#121). The form's existing
      // type-coercion and pick-list rendering kick in normally;
      // presets are just the starting state, not locked-in.
      const tplId = activeTemplateIdRef.current;
      let initialProperties: Record<string, unknown> = {};
      if (tplId) {
        const [tplDataLayerId, tplLayerKey] = targetKey.split(':');
        const tplTarget = editor.targets.find(
          (t) =>
            t.dataLayerId === tplDataLayerId && t.layerKey === tplLayerKey,
        );
        const tpl = tplTarget?.templates.find((t) => t.id === tplId);
        if (tpl) {
          // Copy so the user editing in the form doesn't mutate the
          // persisted template config.
          initialProperties = { ...tpl.presetAttributes };
        }
      }
      // Snapshot the geometry, then drop it from terra-draw's
      // internal store so the sketch doesn't linger after the
      // attribute form opens. The real feature lands on the layer's
      // geojson source after submit + refresh.
      setPendingFeature({
        mode: 'create',
        geometry: f.geometry,
        targetKey,
        featureId: null,
        initialProperties,
      });
      draw.clear();
      // Park the draw in select mode so click events go back to
      // MapCanvas's popup handler while the attribute form is up.
      draw.setMode('select');
    };
    draw.on('finish', handleFinish);
    return () => {
      try {
        draw.off('finish', handleFinish);
      } catch {
        /* terra-draw race on unmount; ignore */
      }
    };
  }, [mapInstance, drawRef.current]);

  // Switch terra-draw mode based on activeTool + activeTarget. When
  // the user activates the Add tool with a chosen target whose
  // geometry type is point/line/polygon, terra-draw enters that
  // drawing mode. Otherwise we keep terra-draw in 'select' mode so
  // it doesn't interfere with map interactions.
  useEffect(() => {
    const draw = drawRef.current as
      | { start: () => void; setMode: (m: string) => void }
      | null;
    if (!draw) return;
    if (activeTool !== 'add' || !activeTargetKey) {
      try {
        draw.setMode('select');
      } catch {
        /* not started yet */
      }
      return;
    }
    const target = targetByKey.get(activeTargetKey);
    const layerGt = target?.layer?.geometryType;
    if (!layerGt) return;
    // Active feature template (#121) overrides the geometry tool:
    // a template explicitly chooses point / line / polygon, even
    // for layers whose schema-level geometry type would normally
    // dictate it. The detail-page authoring UI keeps the template
    // tool in sync with the layer's geometry; runtime trusts the
    // persisted config.
    let geomTool: 'point' | 'line' | 'polygon' = layerGt;
    if (activeTemplateId) {
      const editorTarget = editor.targets.find(
        (t) => `${t.dataLayerId}:${t.layerKey}` === activeTargetKey,
      );
      const tpl = editorTarget?.templates.find(
        (t) => t.id === activeTemplateId,
      );
      if (tpl) geomTool = tpl.geometryTool;
    }
    const mode =
      geomTool === 'point'
        ? 'point'
        : geomTool === 'line'
          ? 'linestring'
          : 'polygon';
    try {
      draw.start();
    } catch {
      /* already started */
    }
    draw.setMode(mode);
  }, [activeTool, activeTargetKey, activeTemplateId, targetByKey, editor.targets]);

  // Eligible-edit predicate. A target is editable when its resolved
  // layer is non-null, the layer is editingEnabled, and the editor
  // target itself allows attribute or geometry edits. We don't gate
  // on geometry-type here because attribute-only related tables can
  // still have their fields edited in slice 3b-3 even though
  // geometry editing requires a geometry-bearing layer.
  const editableTargetKeys = useMemo(() => {
    const out = new Set<string>();
    for (const t of editor.targets) {
      const key = `${t.dataLayerId}:${t.layerKey}`;
      const r = targetByKey.get(key);
      if (!r?.layer) continue;
      if (r.layer.editingEnabled === false) continue;
      if (!t.canEditAttributes && !t.canEditGeometry) continue;
      out.add(key);
    }
    return out;
  }, [editor.targets, targetByKey]);

  // Deletable predicate. Target's canDelete flag plus the layer
  // being editingEnabled. The data_layer's editing.policy gates at
  // the server too; the client predicate is a UX guard so users
  // don't get a 403 for clicking a delete that was never going to
  // work.
  const deletableTargetKeys = useMemo(() => {
    const out = new Set<string>();
    for (const t of editor.targets) {
      const key = `${t.dataLayerId}:${t.layerKey}`;
      const r = targetByKey.get(key);
      if (!r?.layer) continue;
      if (r.layer.editingEnabled === false) continue;
      if (!t.canDelete) continue;
      out.add(key);
    }
    return out;
  }, [editor.targets, targetByKey]);

  // Tool-button handler. Add wires up the active-target picker;
  // Edit activates click-to-pick mode (handled via map click below);
  // Select drops back to off. Other tools surface the coming-soon
  // toast until their slices ship.
  function onToolClick(tool: EditorTool) {
    if (!canEdit) return;
    if (tool === 'add') {
      if (eligibleAddTargets.length === 0) {
        setToast(
          'No editable target layers configured. Open the editor config to add one.',
        );
        scheduleToastClear();
        return;
      }
      setActiveTool('add');
      // Always start template-less; the user picks a template from
      // the chip's tray after the target settles. (If the target
      // has only one template, future polish could auto-pick it.)
      setActiveTemplateId(null);
      if (eligibleAddTargets.length === 1) {
        setActiveTargetKey(eligibleAddTargets[0]!.key);
      } else {
        setActiveTargetKey(null);
      }
      return;
    }
    if (tool === 'edit') {
      if (editableTargetKeys.size === 0) {
        setToast(
          'No editable target layers. Turn on attribute or geometry editing on a target in the config.',
        );
        scheduleToastClear();
        return;
      }
      setActiveTool('edit');
      setActiveTargetKey(null);
      return;
    }
    if (tool === 'delete') {
      if (deletableTargetKeys.size === 0) {
        setToast(
          'No targets allow delete. Turn on Delete on a target in the config.',
        );
        scheduleToastClear();
        return;
      }
      setActiveTool('delete');
      setActiveTargetKey(null);
      return;
    }
    if (tool === 'select') {
      setActiveTool('off');
      setActiveTargetKey(null);
      return;
    }
    if (tool === 'snap') {
      // Snap is a session toggle, not a tool that takes over the
      // canvas. We flip the persisted-config-seeded local state
      // and the mode-update effect above patches terra-draw via
      // updateModeOptions. activeTool is left alone; the user can
      // still draw / edit / delete with snap on or off.
      setSnappingEnabled((v) => !v);
      const next = !snappingEnabled;
      setToast(next ? 'Snapping on' : 'Snapping off');
      scheduleToastClear();
      return;
    }
    setToast(`${TOOL_LABELS[tool]} lands in a follow-up slice.`);
    scheduleToastClear();
  }

  // Click-pick handler shared by Edit and Delete modes. Queries
  // rendered features at the click point, filters to ones in
  // editor-target sources (so reference layers can never be
  // edited / deleted through the Editor), and dispatches based
  // on which write tool is active. The global_id needed for both
  // PATCH and DELETE lives in properties._global_id (inlined by
  // the v3 service because MapCanvas's generateId: true overwrites
  // the top-level Feature.id at render time).
  useEffect(() => {
    const m = mapInstance;
    if (!m) return;
    if (activeTool !== 'edit' && activeTool !== 'delete') return;
    const handler = (e: maplibregl.MapMouseEvent) => {
      const features = m.queryRenderedFeatures(e.point);
      const hit = features.find((f) => {
        const sid = f.source as string | undefined;
        return (
          typeof sid === 'string' &&
          sid.startsWith(`gg:${EDITOR_TARGET_LAYER_PREFIX}`)
        );
      });
      if (!hit) return;
      const sid = hit.source as string;
      const stripped = sid.slice(`gg:${EDITOR_TARGET_LAYER_PREFIX}`.length);
      const sep = stripped.lastIndexOf(':');
      if (sep === -1) return;
      const dataLayerId = stripped.slice(0, sep);
      const layerKey = stripped.slice(sep + 1);
      const targetKey = `${dataLayerId}:${layerKey}`;
      const props = (hit.properties ?? {}) as Record<string, unknown>;
      const featureId =
        typeof props['_global_id'] === 'string'
          ? (props['_global_id'] as string)
          : null;
      if (!featureId) {
        setToast(
          'Couldn\'t recover the feature id. Refresh the page and try again.',
        );
        scheduleToastClear();
        return;
      }

      if (activeTool === 'edit') {
        if (!editableTargetKeys.has(targetKey)) {
          setToast('That layer is not editable in this editor.');
          scheduleToastClear();
          return;
        }
        const initialProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith('_')) continue;
          initialProps[k] = v;
        }
        // Branch on what the target permits. When the target allows
        // geometry editing AND the clicked feature has geometry,
        // first enter geometry-edit mode -- vertex handles appear,
        // a floating toolbar lets the user save / cancel / hop into
        // attribute editing. Attribute-only targets (or features
        // without geometry, e.g. a related-table row that snuck
        // into the click handler) skip straight to the form.
        const editorTarget = editor.targets.find(
          (t) =>
            t.dataLayerId === dataLayerId && t.layerKey === layerKey,
        );
        const canEditGeom =
          editorTarget?.canEditGeometry === true &&
          targetByKey.get(targetKey)?.layer?.geometryType !== null;
        if (canEditGeom && hit.geometry) {
          setActiveTargetKey(targetKey);
          const layerGeomType =
            targetByKey.get(targetKey)?.layer?.geometryType ?? 'point';
          // hit.geometry from queryRenderedFeatures is already a
          // GeoJSON.Geometry. Clone via JSON to break MapLibre's
          // internal references; terra-draw reads its own copy.
          const cloned = JSON.parse(
            JSON.stringify(hit.geometry),
          ) as GeoJSON.Geometry;
          setGeomEditError(null);
          setPendingGeometryEdit({
            dataLayerId,
            layerKey,
            targetKey,
            featureId,
            geometryType: layerGeomType as 'point' | 'line' | 'polygon',
            originalGeometry: cloned,
            currentGeometry: cloned,
            properties: initialProps,
          });
          return;
        }
        setActiveTargetKey(targetKey);
        setPendingFeature({
          mode: 'update',
          geometry: hit.geometry as unknown,
          targetKey,
          featureId,
          initialProperties: initialProps,
        });
        return;
      }

      // delete tool
      if (!deletableTargetKeys.has(targetKey)) {
        setToast('That layer cannot be deleted from in this editor.');
        scheduleToastClear();
        return;
      }
      // Build a short user-facing summary for the dialog. Pick the
      // first non-underscore string-ish property (so users see e.g.
      // "Building #4127" rather than the raw uuid). Fall back to a
      // truncated global_id when the row has no obvious display
      // field.
      let summary = featureId.slice(0, 8) + '...';
      const target = targetByKey.get(targetKey);
      if (target?.layer) {
        for (const f of target.layer.fields) {
          const v = props[f.name];
          if (v === null || v === undefined || v === '') continue;
          summary = String(v);
          break;
        }
      }
      setActiveTargetKey(targetKey);
      setPendingDelete({
        dataLayerId,
        layerKey,
        featureId,
        layerTitle: `${target?.dataLayerTitle ?? ''} / ${target?.layer?.label ?? layerKey}`,
        summary,
      });
    };
    m.on('click', handler);
    return () => {
      try {
        m.off('click', handler);
      } catch {
        /* map may have torn down */
      }
    };
  }, [
    mapInstance,
    activeTool,
    editableTargetKeys,
    deletableTargetKeys,
    targetByKey,
    editor.targets,
  ]);

  // Geometry-edit setup. When pendingGeometryEdit is set, terra-draw
  // takes over: switch to select mode, push the feature into its
  // store with a `mode` property matching the geometry family (so
  // the right flag set applies), then call selectFeature so the
  // vertex / midpoint handles render immediately.
  //
  // The original feature stays rendered on the underlying MapLibre
  // layer during the edit (we don't filter it out). terra-draw
  // overlays the editable copy with handles on top, which is enough
  // to communicate "this is the one being moved" without the
  // complexity of a transient layer filter. After save, refreshTarget
  // reloads the layer source and the styled feature snaps to the
  // new position.
  //
  // tdEditFeatureIdRef holds the terra-draw id so the cleanup
  // function can remove the feature even after the user navigates
  // away mid-edit.
  useEffect(() => {
    const draw = drawRef.current as
      | {
          start: () => void;
          setMode: (m: string) => void;
          addFeatures: (features: unknown[]) => void;
          selectFeature: (id: string) => void;
          deselectFeature: (id: string) => void;
          removeFeatures: (ids: Array<string | number>) => void;
        }
      | null;
    if (!draw || !pendingGeometryEdit) return;

    try {
      draw.start();
    } catch {
      /* already started */
    }
    try {
      draw.setMode('select');
    } catch {
      /* not started */
    }

    // terra-draw uses `mode` on the feature properties to decide
    // which flag profile to apply -- we want the per-geometry-type
    // flags from the constructor above. Map our internal geometry
    // family ('point' | 'line' | 'polygon') to terra-draw's mode
    // names ('point' | 'linestring' | 'polygon').
    const tdMode =
      pendingGeometryEdit.geometryType === 'line'
        ? 'linestring'
        : pendingGeometryEdit.geometryType;
    const tdId = `gg-edit-${pendingGeometryEdit.featureId}`;
    tdEditFeatureIdRef.current = tdId;

    try {
      draw.addFeatures([
        {
          id: tdId,
          type: 'Feature',
          geometry: pendingGeometryEdit.originalGeometry,
          properties: { mode: tdMode },
        },
      ]);
      draw.selectFeature(tdId);
    } catch (err) {
      // addFeatures rejects when terra-draw can't validate the
      // geometry. We surface this as the in-modal error so the
      // user can cancel out cleanly rather than getting stuck.
      setGeomEditError(
        err instanceof Error
          ? `Could not load geometry: ${err.message}`
          : 'Could not load geometry into the editor.',
      );
    }

    return () => {
      try {
        draw.deselectFeature(tdId);
      } catch {
        /* ignore: race on unmount */
      }
      try {
        draw.removeFeatures([tdId]);
      } catch {
        /* ignore: race on unmount */
      }
      if (tdEditFeatureIdRef.current === tdId) {
        tdEditFeatureIdRef.current = null;
      }
    };
    // We deliberately key on the (target, feature) pair so swapping
    // to a different feature mid-edit cleans up the previous one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingGeometryEdit?.targetKey,
    pendingGeometryEdit?.featureId,
  ]);

  // Watch terra-draw 'change' events while a geometry edit is in
  // flight. terra-draw emits 'change' on every drag step + every
  // midpoint insert + every vertex delete; we read the latest
  // geometry off getSnapshot and drop it into pendingGeometryEdit
  // so the floating action bar can show "Save changes" enabled
  // only when the geometry actually differs from the original.
  useEffect(() => {
    const draw = drawRef.current as
      | {
          on: (ev: 'change', cb: (ids: Array<string | number>) => void) => void;
          off: (ev: 'change', cb: (ids: Array<string | number>) => void) => void;
          getSnapshot: () => Array<{
            id: string | number;
            geometry: GeoJSON.Geometry;
          }>;
        }
      | null;
    if (!draw || !pendingGeometryEdit) return;

    const tdId = tdEditFeatureIdRef.current;
    if (!tdId) return;

    const handleChange = (ids: Array<string | number>) => {
      if (!ids.includes(tdId)) return;
      const snap = draw.getSnapshot();
      const f = snap.find((x) => String(x.id) === tdId);
      if (!f) return;
      setPendingGeometryEdit((prev) =>
        prev ? { ...prev, currentGeometry: f.geometry } : null,
      );
    };
    draw.on('change', handleChange);
    return () => {
      try {
        draw.off('change', handleChange);
      } catch {
        /* terra-draw race on unmount; ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingGeometryEdit?.targetKey,
    pendingGeometryEdit?.featureId,
  ]);

  // Save the in-flight geometry edit. PATCH only the geometry; the
  // server keeps the existing properties. On success we refresh the
  // target layer's source so the moved feature paints in its new
  // position, and exit edit mode.
  async function saveGeometryEdit() {
    if (!pendingGeometryEdit) return;
    setGeomEditSaving(true);
    setGeomEditError(null);
    try {
      const url = `/api/portal/items/${pendingGeometryEdit.dataLayerId}/layers/${pendingGeometryEdit.layerKey}/features/${pendingGeometryEdit.featureId}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-editor-id': editorId,
        },
        body: JSON.stringify({
          geometry: pendingGeometryEdit.currentGeometry,
        }),
      });
      if (!res.ok) {
        setGeomEditError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      const dl = pendingGeometryEdit.dataLayerId;
      const lk = pendingGeometryEdit.layerKey;
      setPendingGeometryEdit(null);
      setActiveTool('off');
      refreshTarget(dl, lk);
    } catch (err) {
      setGeomEditError(
        err instanceof Error
          ? err.message
          : 'Network error during geometry save.',
      );
    } finally {
      setGeomEditSaving(false);
    }
  }

  function cancelGeometryEdit() {
    if (geomEditSaving) return;
    setPendingGeometryEdit(null);
    setGeomEditError(null);
  }

  /**
   * Hop from geometry edit into attribute edit on the same feature.
   * Saves the in-flight geometry first (so any vertex moves don't
   * get lost when the form opens), then opens the attribute form
   * with the same row's properties prefilled. Two-step save -- one
   * PATCH for geometry, one PATCH for properties when the form
   * submits -- but it's the simplest contract that doesn't require
   * stitching the two payloads together client-side.
   */
  async function switchToAttributeEdit() {
    if (!pendingGeometryEdit) return;
    const moved =
      JSON.stringify(pendingGeometryEdit.currentGeometry) !==
      JSON.stringify(pendingGeometryEdit.originalGeometry);
    if (moved) {
      // Persist geometry first; if the save fails, stay in geometry
      // mode so the user can retry rather than silently losing the
      // edit when the modal opens.
      await saveGeometryEdit();
      // saveGeometryEdit already cleared pendingGeometryEdit on
      // success. If we got here without success, bail.
      if (geomEditError) return;
    }
    const targetKey = pendingGeometryEdit.targetKey;
    const featureId = pendingGeometryEdit.featureId;
    const properties = pendingGeometryEdit.properties;
    setPendingGeometryEdit(null);
    setActiveTargetKey(targetKey);
    setPendingFeature({
      mode: 'update',
      geometry: pendingGeometryEdit.currentGeometry,
      targetKey,
      featureId,
      initialProperties: properties,
    });
  }

  // Delete submit. Calls the v3 DELETE endpoint with the captured
  // global_id. The data_layer's own editing.policy gates server-
  // side; the Editor's canDelete is the UX gate. On success we
  // refresh the layer; the deleted feature drops off the canvas
  // when the new geojson lands.
  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/portal/items/${pendingDelete.dataLayerId}/layers/${pendingDelete.layerKey}/features/${pendingDelete.featureId}`,
        {
          method: 'DELETE',
          headers: { 'x-editor-id': editorId },
        },
      );
      if (!res.ok && res.status !== 204) {
        setDeleteError(`Delete failed: ${res.status} ${await res.text()}`);
        return;
      }
      const dl = pendingDelete.dataLayerId;
      const lk = pendingDelete.layerKey;
      setPendingDelete(null);
      setActiveTool('off');
      refreshTarget(dl, lk);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'Network error during delete.',
      );
    } finally {
      setDeleting(false);
    }
  }

  function scheduleToastClear() {
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setToast(null), 2500);
    }
  }

  // Submit the pending feature. POST for create, PATCH for update.
  // The server stamps editor-tracking columns (created_by /
  // created_at on insert; edited_by / edited_at on update). On
  // success we clear the form, drop the active tool back to off
  // (so the user can pick a fresh action), and refresh the layer's
  // source URL so the new or edited feature paints.
  //
  // For update we send `properties` only -- attribute-only edits
  // are slice 3b-3 scope. Geometry editing via terra-draw select
  // mode is a follow-up commit; the existing geometry is left
  // untouched server-side because the PATCH body omits geometry.
  async function submitPending(values: Record<string, unknown>) {
    if (!pendingFeature) return;
    const target = targetByKey.get(pendingFeature.targetKey);
    if (!target?.layer) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const baseUrl = `/api/portal/items/${target.dataLayerId}/layers/${target.layerKey}/features`;
      // x-editor-id tells the API "this write is happening through
      // an Editor item; apply that item's per-target policy as
      // additional gate over the existing data_layer share-edit
      // check". Without the header the existing share-edit gate is
      // the only enforcement.
      const writeHeaders: Record<string, string> = {
        'content-type': 'application/json',
        'x-editor-id': editorId,
      };
      let res: Response;
      if (pendingFeature.mode === 'create') {
        res = await fetch(baseUrl, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({
            features: [
              {
                geometry: pendingFeature.geometry,
                properties: values,
              },
            ],
          }),
        });
      } else {
        if (!pendingFeature.featureId) {
          setSubmitError(
            'Missing feature id; cannot update. Refresh the page and try again.',
          );
          return;
        }
        res = await fetch(`${baseUrl}/${pendingFeature.featureId}`, {
          method: 'PATCH',
          headers: writeHeaders,
          body: JSON.stringify({ properties: values }),
        });
      }
      if (!res.ok) {
        const verb = pendingFeature.mode === 'create' ? 'Save' : 'Update';
        setSubmitError(`${verb} failed: ${res.status} ${await res.text()}`);
        return;
      }
      // Success: clear pending, refresh layer, return to select.
      setPendingFeature(null);
      setActiveTool('off');
      refreshTarget(target.dataLayerId, target.layerKey);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Network error during save.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function cancelPending() {
    if (submitting) return;
    setPendingFeature(null);
    setSubmitError(null);
    // Keep the Add tool active so the user can immediately try
    // again rather than re-clicking through the toolbar. Drop the
    // chosen target only if we auto-selected it; respecting the
    // user's manual pick keeps things less surprising.
  }

  const activeTarget = activeTargetKey ? targetByKey.get(activeTargetKey) : undefined;
  const pendingTarget = pendingFeature
    ? targetByKey.get(pendingFeature.targetKey)
    : undefined;
  // Synthetic-layer id allowlist for AttributeTable inline edit.
  // For each editor target with attribute editing turned on, map
  // (dataLayerId, layerKey) back to the editor-target layer id we
  // injected into mapData. Reference-map layers never land here, so
  // double-clicking a cell on a reference layer can never trigger
  // a write -- the UX gate matches the server policy.
  const inlineEditableLayerIds = useMemo(() => {
    const out = new Set<string>();
    for (const t of editor.targets) {
      const r = targetByKey.get(`${t.dataLayerId}:${t.layerKey}`);
      if (!r?.layer) continue;
      if (r.layer.editingEnabled === false) continue;
      if (!t.canEditAttributes) continue;
      out.add(editorTargetLayerId(t.dataLayerId, t.layerKey));
    }
    return out;
  }, [editor.targets, targetByKey]);

  // Per-layer field allowlist. Mirrors the AttributeForm's
  // editableFields gate: when the target stores a non-null list,
  // only those fields are inline-editable; null means "all fields"
  // and the table reads `editableFieldsByLayer[layerId]` as
  // undefined to allow everything. Underscore-prefixed editor-
  // tracking columns are excluded inside AttributeTable, not here.
  const inlineEditableFieldsByLayer = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    for (const t of editor.targets) {
      if (!t.canEditAttributes) continue;
      if (t.editableFields === null) continue;
      const id = editorTargetLayerId(t.dataLayerId, t.layerKey);
      out[id] = new Set(t.editableFields);
    }
    return out;
  }, [editor.targets]);

  // PATCH a single feature's properties from the AttributeTable's
  // inline-edit cell. Resolves the synthetic editor-target layer id
  // back to its (dataLayerId, layerKey) pair, hits the v3 PATCH
  // endpoint with the x-editor-id header so EditorPolicyService can
  // re-validate the write against the editor's per-target rules,
  // then bumps the layer's URL so MapCanvas and the metadata probe
  // pick up the new value. AttributeTable handles its own error
  // surfacing; we re-throw so it can show the server message.
  const onInlineEditFeature = useCallback(
    async (
      layerId: string,
      featureId: string,
      properties: Record<string, unknown>,
    ) => {
      if (!layerId.startsWith(EDITOR_TARGET_LAYER_PREFIX)) {
        throw new Error('Inline edit is only allowed on editor target layers.');
      }
      const stripped = layerId.slice(EDITOR_TARGET_LAYER_PREFIX.length);
      const sep = stripped.lastIndexOf(':');
      if (sep === -1) {
        throw new Error('Could not resolve editor target from layer id.');
      }
      const dataLayerId = stripped.slice(0, sep);
      const layerKey = stripped.slice(sep + 1);
      const res = await fetch(
        `/api/portal/items/${dataLayerId}/layers/${layerKey}/features/${featureId}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'x-editor-id': editorId,
          },
          body: JSON.stringify({ properties }),
        },
      );
      if (!res.ok) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
      refreshTarget(dataLayerId, layerKey);
    },
    [editorId, refreshTarget],
  );

  const editableSet = useMemo(() => {
    if (!pendingTarget) return null;
    const ed = editor.targets.find(
      (t) =>
        t.dataLayerId === pendingTarget.dataLayerId &&
        t.layerKey === pendingTarget.layerKey,
    );
    if (!ed) return null;
    if (ed.editableFields === null) return null;
    return new Set(ed.editableFields);
  }, [pendingTarget, editor.targets]);

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      {/* Top bar: back link + title + reference map breadcrumb.
          "Back to items" matches the standard item detail page so
          users who arrive here from the items list have a
          consistent escape. Owners get a separate "Configure"
          link that takes them to the editor's detail/config page. */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/items"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to items
          </Link>
          <span className="text-muted">/</span>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-0">
            <PencilRuler className="h-4 w-4 text-purple-600" />
            {editorTitle}
          </span>
          {referencedMapTitle ? (
            <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">
              <span>against</span>
              <span className="font-medium text-ink-1">
                {referencedMapTitle}
              </span>
            </span>
          ) : null}
          {!canEdit ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted">
              View only
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <label className="inline-flex items-center gap-1">
            <span className="font-medium uppercase tracking-wide">
              Basemap
            </span>
            <select
              value={mapData.basemap || ''}
              onChange={(e) => onBasemapChange(e.target.value)}
              className="h-7 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {basemaps.length === 0 ? (
                <option value="">No basemaps</option>
              ) : null}
              {basemaps.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <span>
            {targetCount} editable layer{targetCount === 1 ? '' : 's'}
          </span>
          {canEdit ? (
            <Link
              href={`/items/${editorId}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
              title="Open the editor's configuration page"
            >
              Configure
            </Link>
          ) : null}
        </div>
      </header>

      {/* Body: docked LayerPanel (left rail) + map canvas (right).
          Same layout the map editor uses for parity. The editing
          tool palette + active-mode chips + coming-soon toast all
          float as overlays over the canvas. */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0">
          <LayerPanel
            layers={mapData.layers}
            metadata={metadata}
            canEdit={canEdit}
            currentZoom={currentZoom}
            onOpenAdd={() => {
              /* Add-layer is suppressed in the runtime; the layer
                 set is fixed by the editor's configuration + the
                 referenced map. Owners use the editor's Configure
                 page (in the toolbar) to add or remove targets. */
            }}
            onAddGroup={() => {
              /* Same: groups are inherited from the referenced
                 map; no group authoring inside the runtime. */
            }}
            onOpenAttributeTable={(focusLayerId) => {
              setTableFocusLayerId(focusLayerId ?? null);
              setTableOpen(true);
            }}
            onZoomToLayer={(layerId) => {
              const layer = mapData.layers.find((l) => l.id === layerId);
              const bbox = layer
                ? null /* MapCanvas doesn't expose a bbox helper here yet */
                : null;
              if (bbox) canvasRef.current?.zoomTo(bbox);
            }}
            onChange={onLayersChange}
            showAddLayer={false}
          />
        </div>

        <div className="relative min-w-0 flex-1">
          <MapCanvas
            ref={canvasRef}
            map={mapData}
            basemaps={basemaps}
            onCameraChange={(next) => {
              setMapData((cur) => ({ ...cur, ...next }));
              if (typeof next.zoom === 'number') setCurrentZoom(next.zoom);
            }}
            selection={selection}
            selectTool="off"
            onSelectionChange={setSelection}
            onMapReady={(m) => setMapInstance(m)}
          />

          {/* SearchBar overlay. Same component the map editor
              renders. Geocoding + per-layer attribute search;
              picking a result flies the canvas to the feature
              and briefly highlights it. mapData.search drives the
              enable / geocoding flags so the runtime honors what
              the referenced map already configured. */}
          {mapData.search?.enabled !== false ? (
            <SearchBar
              layers={mapData.layers}
              featuresByLayer={featuresByLayer}
              geocodingEnabled={mapData.search?.geocoding !== false}
              onPick={(r) => {
                canvasRef.current?.flyAndHighlight({
                  bbox: r.bbox,
                  center: r.center,
                  ...(r.kind === 'feature'
                    ? {
                        layerId: r.layerId,
                        featureProps: (r.feature.properties ?? {}) as Record<
                          string,
                          unknown
                        >,
                      }
                    : {}),
                });
              }}
            />
          ) : null}

          {/* Tool palette overlay. Top-left of the canvas. Renders
              only the tools the author enabled in the editor's
              config; disabled when canEdit is false. */}
          <div className="pointer-events-auto absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-border bg-surface-1 p-1 shadow-card">
            {ALL_TOOLS.filter((t) => editor.tools.includes(t.key)).map((t) => {
              // Snap is the only tool today that's a session toggle
              // rather than an exclusive activeTool: you can have
              // Snap on while drawing or geometry-editing. Its
              // "active" state mirrors snappingEnabled so the user
              // sees a clear on / off indicator.
              const isToggle = t.key === 'snap';
              const isActive = isToggle
                ? snappingEnabled
                : activeTool === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onToolClick(t.key)}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive
                      ? isToggle
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-purple-100 text-purple-800'
                      : ''
                  }`}
                  title={
                    isToggle
                      ? `${t.label}: ${snappingEnabled ? 'on' : 'off'}`
                      : t.label
                  }
                  aria-label={t.label}
                  aria-pressed={isActive}
                >
                  <t.Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>

          {/* Active-mode chip / banner overlay. Add shows a target
              dropdown; Edit shows a "click any feature" prompt;
              Delete shows the same in rose to telegraph the
              destructive nature. */}
          {activeTool === 'add' ? (
            <div className="pointer-events-auto absolute left-16 top-3 z-10 flex flex-col gap-1 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs text-purple-900 shadow-card">
              <div className="flex items-center gap-2">
                <span className="font-medium">Drawing into:</span>
                <select
                  value={activeTargetKey ?? ''}
                  onChange={(e) => {
                    setActiveTargetKey(e.target.value || null);
                    // Switching the target invalidates the active
                    // template (each target has its own list).
                    setActiveTemplateId(null);
                  }}
                  className="rounded-md border border-purple-300 bg-white px-2 py-0.5 text-xs"
                >
                  <option value="">pick a layer...</option>
                  {eligibleAddTargets.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.resolved?.dataLayerTitle} /{' '}
                      {e.resolved?.layer?.label} (
                      {e.resolved?.layer?.geometryType})
                    </option>
                  ))}
                </select>
                {activeTarget?.layer?.geometryType ? (
                  <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    click to add{' '}
                    {(() => {
                      const tplTarget = activeTargetKey
                        ? editor.targets.find(
                            (t) =>
                              `${t.dataLayerId}:${t.layerKey}` ===
                              activeTargetKey,
                          )
                        : undefined;
                      const tpl = activeTemplateId
                        ? tplTarget?.templates.find(
                            (t) => t.id === activeTemplateId,
                          )
                        : undefined;
                      return tpl?.geometryTool ?? activeTarget?.layer?.geometryType ?? '';
                    })()}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setActiveTool('off');
                    setActiveTargetKey(null);
                    setActiveTemplateId(null);
                  }}
                  className="rounded-md p-0.5 text-purple-900 hover:bg-purple-100"
                  aria-label="Exit add mode"
                  title="Exit add mode"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Feature-template tray (#121). Renders only when
                  the chosen target has templates configured. The
                  Default tile clears the active template so the
                  next draw uses the layer's plain geometry tool
                  with empty initial attributes (today's behaviour
                  when no templates exist). Each template tile shows
                  the label + a small swatch in the optional preview
                  color so authors who configured many templates can
                  pick the right one at a glance. */}
              {(() => {
                const tplTarget = activeTargetKey
                  ? editor.targets.find(
                      (t) =>
                        `${t.dataLayerId}:${t.layerKey}` === activeTargetKey,
                    )
                  : undefined;
                const tpls = tplTarget?.templates ?? [];
                if (tpls.length === 0) return null;
                return (
                  <div className="flex flex-wrap items-center gap-1 border-t border-purple-200 pt-1">
                    <span className="text-[10px] uppercase tracking-wide text-purple-700">
                      Template:
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveTemplateId(null)}
                      aria-pressed={activeTemplateId === null}
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                        activeTemplateId === null
                          ? 'border-purple-400 bg-purple-100 text-purple-900'
                          : 'border-purple-200 bg-white text-purple-800 hover:bg-purple-100'
                      }`}
                    >
                      Default
                    </button>
                    {tpls.map((tpl) => {
                      const selected = activeTemplateId === tpl.id;
                      return (
                        <button
                          key={tpl.id}
                          type="button"
                          onClick={() => setActiveTemplateId(tpl.id)}
                          aria-pressed={selected}
                          title={`${tpl.label} · ${tpl.geometryTool}`}
                          className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${
                            selected
                              ? 'border-purple-400 bg-purple-100 text-purple-900'
                              : 'border-purple-200 bg-white text-purple-800 hover:bg-purple-100'
                          }`}
                        >
                          <span
                            aria-hidden
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-purple-300"
                            style={{
                              backgroundColor: tpl.previewColor ?? '#a78bfa',
                            }}
                          />
                          {tpl.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ) : activeTool === 'edit' ? (
            <div className="pointer-events-auto absolute left-16 top-3 z-10 flex items-center gap-2 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs text-purple-900 shadow-card">
              <span className="font-medium">Edit mode:</span>
              <span>
                click a feature to edit its geometry, or open attributes
                from the floating bar
              </span>
              <button
                type="button"
                onClick={() => {
                  setActiveTool('off');
                  setActiveTargetKey(null);
                  cancelGeometryEdit();
                }}
                className="rounded-md p-0.5 text-purple-900 hover:bg-purple-100"
                aria-label="Exit edit mode"
                title="Exit edit mode"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : activeTool === 'delete' ? (
            <div className="pointer-events-auto absolute left-16 top-3 z-10 flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs text-rose-900 shadow-card">
              <span className="font-medium">Delete mode:</span>
              <span>
                click a feature to remove it (you'll confirm before it's
                gone)
              </span>
              <button
                type="button"
                onClick={() => {
                  setActiveTool('off');
                  setActiveTargetKey(null);
                }}
                className="rounded-md p-0.5 text-rose-900 hover:bg-rose-100"
                aria-label="Exit delete mode"
                title="Exit delete mode"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {toast ? (
            <div className="pointer-events-auto absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 shadow-card">
              {toast}
            </div>
          ) : null}

          {/* Geometry-edit floating action bar. Anchored bottom-
              center of the canvas so it doesn't fight the toolbar
              (top-left), the active-mode chip (top), or the
              attribute-table panel (full-width bottom dock). The
              "Save" button is enabled only when the geometry has
              actually changed -- a click without a drag is just
              feature selection and shouldn't fire a PATCH. */}
          {pendingGeometryEdit ? (
            <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-col items-stretch gap-1 rounded-md border border-purple-300 bg-white px-3 py-2 text-xs shadow-overlay">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-purple-900">
                  Editing{' '}
                  {targetByKey.get(pendingGeometryEdit.targetKey)?.layer
                    ?.label ?? 'feature'}{' '}
                  geometry
                </span>
                <span className="text-[10px] uppercase tracking-wide text-purple-700">
                  drag vertices · click midpoints to add · alt-click to
                  delete
                </span>
              </div>
              {geomEditError ? (
                <p
                  className="text-[11px] text-danger"
                  role="alert"
                >
                  {geomEditError}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelGeometryEdit}
                  disabled={geomEditSaving}
                  className="inline-flex h-7 items-center rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void switchToAttributeEdit()}
                  disabled={geomEditSaving}
                  className="inline-flex h-7 items-center rounded border border-purple-300 bg-purple-50 px-2 text-xs font-medium text-purple-900 hover:bg-purple-100 disabled:opacity-50"
                >
                  Edit attributes
                </button>
                <button
                  type="button"
                  onClick={() => void saveGeometryEdit()}
                  disabled={
                    geomEditSaving ||
                    JSON.stringify(pendingGeometryEdit.currentGeometry) ===
                      JSON.stringify(pendingGeometryEdit.originalGeometry)
                  }
                  className="inline-flex h-7 items-center gap-1 rounded bg-purple-600 px-3 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {geomEditSaving ? 'Saving...' : 'Save geometry'}
                </button>
              </div>
            </div>
          ) : null}

          {/* AttributeTable bottom-overlay. Same component the map
              editor uses; pulls from the same featuresByLayer
              cache. Open via the layer-panel kebab's "Open
              attribute table" item; close with the panel's X.
              onPatchLayer mutates the layer client-side (used for
              filter / column reorder / similar attr-table-driven
              edits). Inline row editing is wired here for the
              editor's targets only -- the editableLayerIds set is
              built from each target's canEditAttributes flag,
              and editableFieldsByLayer narrows further when the
              target carries a non-null editableFields allowlist.
              Reference-map layers stay read-only because they are
              not in the editable set, and the v3 PATCH server-
              side gate still enforces this anyway. */}
          <AttributeTable
            open={tableOpen}
            layers={mapData.layers}
            featuresByLayer={featuresByLayer}
            metadata={metadata}
            canEdit={canEdit}
            selection={selection}
            setSelection={setSelection}
            onClose={() => {
              setTableOpen(false);
              setTableFocusLayerId(null);
            }}
            onZoomTo={(bbox) => canvasRef.current?.zoomTo(bbox)}
            onPatchLayer={(layerId, patch) => {
              setMapData((cur) => ({
                ...cur,
                layers: cur.layers.map((l) =>
                  l.id === layerId ? { ...l, ...patch } : l,
                ),
              }));
            }}
            focusLayerId={tableFocusLayerId}
            // exactOptionalPropertyTypes treats `prop?: T` as
            // "may be omitted" rather than "may be undefined", so
            // we conditionally spread the prop instead of passing
            // `undefined` through it. canEdit=false editors omit
            // it entirely and inherit the read-only path the map
            // editor uses.
            {...(canEdit ? { onPatchFeature: onInlineEditFeature } : {})}
            editableLayerIds={inlineEditableLayerIds}
            editableFieldsByLayer={inlineEditableFieldsByLayer}
          />
        </div>
      </div>

      {/* Attribute form modal. Driven by pendingFeature; rendered
          at the document root via fixed-position portal-style div
          so MapCanvas events under it still register but the form
          stays on top. */}
      {pendingFeature && pendingTarget?.layer ? (
        <AttributeForm
          fields={pendingTarget.layer.fields}
          editableFieldNames={editableSet}
          pickLists={pickLists}
          initial={pendingFeature.initialProperties}
          layerTitle={`${pendingTarget.dataLayerTitle} / ${pendingTarget.layer.label}`}
          submitting={submitting}
          errorMessage={submitError}
          onCancel={cancelPending}
          onSubmit={submitPending}
          submitLabel={
            pendingFeature.mode === 'create' ? 'Save feature' : 'Update feature'
          }
          title={
            pendingFeature.mode === 'create'
              ? 'New feature attributes'
              : 'Edit feature attributes'
          }
        />
      ) : null}

      {/* Delete confirm. Uses the shared ConfirmDialog for visual
          consistency with the rest of the portal's destructive
          actions (group delete, item move-to-trash, etc.). The
          dialog component handles its own focus trap + escape
          key. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onCancel={() => {
          if (deleting) return;
          setPendingDelete(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDelete}
        title="Delete this feature?"
        description={
          pendingDelete
            ? `${pendingDelete.summary} on ${pendingDelete.layerTitle}. This cannot be undone from the editor runtime.`
            : ''
        }
        confirmLabel={deleting ? 'Deleting...' : 'Delete feature'}
        tone="danger"
      >
        {deleteError ? (
          <p className="text-sm text-danger" role="alert">
            {deleteError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

const TOOL_LABELS: Record<EditorTool, string> = {
  select: 'Select',
  add: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  snap: 'Snap toggle',
  measure: 'Measure',
  undo: 'Undo',
  redo: 'Redo',
};

const ALL_TOOLS: Array<{
  key: EditorTool;
  label: string;
  Icon: typeof MousePointer2;
}> = [
  { key: 'select', label: 'Select', Icon: MousePointer2 },
  { key: 'add', label: 'Add', Icon: Plus },
  { key: 'edit', label: 'Edit', Icon: PencilRuler },
  { key: 'delete', label: 'Delete', Icon: Trash2 },
  { key: 'snap', label: 'Snap', Icon: Wand2 },
  { key: 'measure', label: 'Measure', Icon: Ruler },
  { key: 'undo', label: 'Undo', Icon: Undo2 },
  { key: 'redo', label: 'Redo', Icon: Redo2 },
];
