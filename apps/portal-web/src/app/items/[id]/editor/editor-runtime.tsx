'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type maplibregl from 'maplibre-gl';
import {
  ArrowLeft,
  Eye,
  Layers,
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
import type {
  EditorData,
  EditorTool,
  MapData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import {
  EDITOR_TARGET_LAYER_PREFIX,
  editorTargetLayerId,
  type ResolvedTarget,
} from './build-map-data';
import { AttributeForm } from './attribute-form';

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
  referencedMapTitle,
  initialMapData,
  targetLayerIds,
  basemaps,
  canEdit,
}: Props) {
  const [mapData, setMapData] = useState<MapData>(initialMapData);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Tool / active-target machinery. activeTool drives terra-draw and
  // toolbar highlight; activeTargetKey is "<dataLayerId>:<layerKey>"
  // so we can look the resolved target up cheaply. canEdit gates
  // whether any of this is enabled.
  const [activeTool, setActiveTool] = useState<EditorTool | 'off'>('off');
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);

  // Pending feature waiting for attribute submission. Set by the
  // terra-draw 'finish' callback; cleared on submit success or
  // cancel. While this is set the AttributeForm modal is open.
  const [pendingFeature, setPendingFeature] = useState<{
    geometry: unknown;
    targetKey: string;
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

  const drawRef = useRef<unknown | null>(null);

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

  // Layer split for the side panel: target layers (purple, editable)
  // vs reference layers (read-only context).
  const { targetLayers, referenceLayers } = useMemo(() => {
    const targetSet = new Set(targetLayerIds);
    const targets = mapData.layers.filter((l) => targetSet.has(l.id));
    const references = mapData.layers.filter(
      (l) => !targetSet.has(l.id) && l.source.kind !== 'group',
    );
    return { targetLayers: targets, referenceLayers: references };
  }, [mapData.layers, targetLayerIds]);

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
      const draw = new td.TerraDraw({
        adapter: new adapterMod.TerraDrawMapLibreGLAdapter({
          map: mapInstance,
          coordinatePrecision: 9,
        }),
        modes: [
          new td.TerraDrawPointMode(),
          new td.TerraDrawLineStringMode(),
          new td.TerraDrawPolygonMode(),
          new td.TerraDrawSelectMode(),
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
      // Snapshot the geometry, then drop it from terra-draw's
      // internal store so the sketch doesn't linger after the
      // attribute form opens. The real feature lands on the layer's
      // geojson source after submit + refresh.
      setPendingFeature({ geometry: f.geometry, targetKey });
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
    const gt = target?.layer?.geometryType;
    if (!gt) return;
    const mode =
      gt === 'point' ? 'point' : gt === 'line' ? 'linestring' : 'polygon';
    try {
      draw.start();
    } catch {
      /* already started */
    }
    draw.setMode(mode);
  }, [activeTool, activeTargetKey, targetByKey]);

  // Tool-button handler. Add wires up the active-target picker
  // when there's more than one eligible target; with exactly one
  // we auto-select it so the user can immediately start drawing.
  // Other tools surface the coming-soon toast.
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
      if (eligibleAddTargets.length === 1) {
        setActiveTargetKey(eligibleAddTargets[0]!.key);
      } else {
        setActiveTargetKey(null);
      }
      return;
    }
    if (tool === 'select') {
      setActiveTool('off');
      setActiveTargetKey(null);
      return;
    }
    setToast(`${TOOL_LABELS[tool]} lands in a follow-up slice.`);
    scheduleToastClear();
  }

  function scheduleToastClear() {
    if (typeof window !== 'undefined') {
      window.setTimeout(() => setToast(null), 2500);
    }
  }

  // Submit the pending feature to the v3 features POST endpoint.
  // The server stamps editor-tracking columns (created_by /
  // created_at) and assigns a global_id. On success we close the
  // form, drop back to 'select' tool, and refresh the layer's
  // source URL so the new feature appears.
  async function submitPending(values: Record<string, unknown>) {
    if (!pendingFeature) return;
    const target = targetByKey.get(pendingFeature.targetKey);
    if (!target?.layer) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/portal/items/${target.dataLayerId}/layers/${target.layerKey}/features`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            features: [
              {
                geometry: pendingFeature.geometry,
                properties: values,
              },
            ],
          }),
        },
      );
      if (!res.ok) {
        setSubmitError(`Save failed: ${res.status} ${await res.text()}`);
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
      {/* Top bar: back link + title + reference map breadcrumb. */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/items/${editorId}`}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to config
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
        <div className="flex items-center gap-2 text-xs text-muted">
          {targetLayers.length} editable layer
          {targetLayers.length === 1 ? '' : 's'}
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* Tool palette: floats over the canvas in the top-left. */}
          <div className="pointer-events-auto absolute left-3 top-3 flex flex-col gap-1 rounded-md border border-border bg-surface-1 p-1 shadow-card">
            {ALL_TOOLS.filter((t) => editor.tools.includes(t.key)).map((t) => {
              const isActive = activeTool === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => onToolClick(t.key)}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive ? 'bg-purple-100 text-purple-800' : ''
                  }`}
                  title={t.label}
                  aria-label={t.label}
                  aria-pressed={isActive}
                >
                  <t.Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>

          {/* Active-target chip + picker (only while Add is the
              active tool). With exactly one eligible target we
              auto-pick; with more than one, we surface a small
              dropdown so the author can switch which layer they
              are drawing into without dropping out of Add mode. */}
          {activeTool === 'add' ? (
            <div className="pointer-events-auto absolute left-16 top-3 flex items-center gap-2 rounded-md border border-purple-300 bg-purple-50 px-3 py-1.5 text-xs text-purple-900 shadow-card">
              <span className="font-medium">Drawing into:</span>
              <select
                value={activeTargetKey ?? ''}
                onChange={(e) => setActiveTargetKey(e.target.value || null)}
                className="rounded-md border border-purple-300 bg-white px-2 py-0.5 text-xs"
              >
                <option value="">pick a layer...</option>
                {eligibleAddTargets.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.resolved?.dataLayerTitle} / {e.resolved?.layer?.label}{' '}
                    ({e.resolved?.layer?.geometryType})
                  </option>
                ))}
              </select>
              {activeTarget?.layer?.geometryType ? (
                <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  click to add {activeTarget.layer.geometryType}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setActiveTool('off');
                  setActiveTargetKey(null);
                }}
                className="rounded-md p-0.5 text-purple-900 hover:bg-purple-100"
                aria-label="Exit add mode"
                title="Exit add mode"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* Layer panel. Same shape as 3b-1; we now also show the
              currently-active target with a highlight ring. */}
          <aside className="pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-72 flex-col overflow-hidden rounded-md border border-border bg-surface-1 shadow-card">
            <div className="border-b border-border px-3 py-2">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-ink-0">
                <Layers className="h-3.5 w-3.5 text-muted" />
                Layers
              </h2>
            </div>
            <div className="overflow-auto">
              <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Editing ({targetLayers.length})
              </div>
              {targetLayers.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted">
                  No targets configured. Pick layers in the editor's
                  configuration page.
                </p>
              ) : (
                <ul>
                  {targetLayers.map((l) => {
                    // Recover (dataLayerId, layerKey) from the
                    // synthetic layer id so we can match the active
                    // target.
                    const stripped = l.id.startsWith(EDITOR_TARGET_LAYER_PREFIX)
                      ? l.id.slice(EDITOR_TARGET_LAYER_PREFIX.length)
                      : l.id;
                    const isActive = stripped === activeTargetKey;
                    return (
                      <li
                        key={l.id}
                        className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                          isActive ? 'bg-purple-50' : ''
                        }`}
                      >
                        <span
                          className={`h-2.5 w-2.5 rounded-sm ${
                            isActive
                              ? 'bg-purple-600 ring-2 ring-purple-300'
                              : 'bg-purple-500'
                          }`}
                        />
                        <span
                          className="truncate text-ink-1"
                          title={l.title}
                        >
                          {l.title}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="border-t border-border px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Reference ({referenceLayers.length})
              </div>
              {referenceLayers.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted">
                  {referencedMapTitle
                    ? 'The referenced map has no overlay layers.'
                    : 'No reference map. Pick one on the config page to add context layers here.'}
                </p>
              ) : (
                <ul>
                  {referenceLayers.map((l) => (
                    <li
                      key={l.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <Eye className="h-3 w-3 shrink-0 text-muted" />
                      <span className="truncate text-ink-1" title={l.title}>
                        {l.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {toast ? (
            <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 shadow-card">
              {toast}
            </div>
          ) : null}
        </div>

        <div className="absolute inset-0">
          <MapCanvas
            ref={canvasRef}
            map={mapData}
            basemaps={basemaps}
            onCameraChange={(next) =>
              setMapData((cur) => ({ ...cur, ...next }))
            }
            selection={{}}
            selectTool="off"
            onSelectionChange={() => {
              /* selection-tool wiring lands in slice 3b-3 (Edit) */
            }}
            onMapReady={(m) => setMapInstance(m)}
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
          layerTitle={`${pendingTarget.dataLayerTitle} / ${pendingTarget.layer.label}`}
          submitting={submitting}
          errorMessage={submitError}
          onCancel={cancelPending}
          onSubmit={submitPending}
          submitLabel="Save feature"
        />
      ) : null}
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
