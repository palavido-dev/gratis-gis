// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type maplibregl from 'maplibre-gl';
import {
  ArrowLeft,
  ChevronDown,
  ClipboardList,
  Layers as LayersIcon,
  Map as MapBaseIcon,
  MousePointer2,
  PencilLine,
  PencilRuler,
  Pentagon,
  Plus,
  Printer,
  Redo2,
  Ruler,
  Sparkles,
  Spline,
  Square,
  Table as TableIcon,
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
import type { FormSchema } from '@gratis-gis/form-schema';
import { FormView } from '../responses/form-view';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import {
  EDITOR_TARGET_LAYER_PREFIX,
  editorTargetLayerId,
  type ResolvedTarget,
} from './build-map-data';
import { AttributeForm } from './attribute-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  AREA_UNIT_LABELS,
  DISTANCE_UNIT_LABELS,
  formatAreaIn,
  formatLengthIn,
  lineLengthMeters,
  ringAreaSquareMeters,
} from '@/lib/measure';
import type { AreaUnit, DistanceUnit } from '@/lib/measure';

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
  /**
   * Render the Print toolbar entry (#259 slice 4). Read-side affordance
   * that triggers `window.print()` against a print-only stylesheet
   * which expands the canvas to fill the page and hides the chrome
   * (toolbars, layer panel, attribute table). The viewer runtime sets
   * this from `viewer.tools.includes('print')`; the editor runtime
   * leaves it false today (a future slice can wire `editor.tools` to
   * include 'print' too if Matt wants editors to print as well).
   *
   * Eventually (#132) the click will open a Print Template chooser
   * instead of going straight to the browser print dialog.
   */
  printEnabled?: boolean;
  /**
   * Survey-runtime-only: the bound form's schema. When set, a Form
   * View toggle appears in the header next to the layers / attribute
   * table pills, and clicking surfaces a side panel that renders the
   * currently-selected feature's properties through the form's
   * question structure (#320). When unset (the default for editor /
   * viewer runtimes), the toggle is hidden.
   */
  formViewSchema?: FormSchema | null;
  /**
   * Layer id to read the active feature's properties off of. The
   * survey runtime passes the paired data_layer's primary sublayer
   * id; the form view reads `selection[surveyTargetLayerId]` and
   * pulls properties from the matching feature in the cached
   * collection. When unset, the form-view toggle is hidden even if
   * formViewSchema is set.
   */
  surveyTargetLayerId?: string | null;
  /**
   * Open the bottom attribute table on first render. Editor / Viewer
   * land map-first because the user wants to see the canvas; the
   * Response Viewer (#321) lands data-first because the user is
   * here to inspect submissions, so the table should be visible
   * immediately. Defaults false.
   */
  tableOpenDefault?: boolean;
  /**
   * v3 data_layer item id whose feature_attachment rows the Form
   * View should look up for the active submission (#351). When
   * set alongside surveyTargetLayerKey, the Form View renders an
   * Attachments section with thumbnails. Survey runtimes pass this
   * through; Editor / Viewer leave it unset so they don't pay the
   * fetch cost.
   */
  surveyAttachmentsLayerItemId?: string | null;
  /** Sublayer key (e.g. 'submissions') paired with
   *  surveyAttachmentsLayerItemId. */
  surveyAttachmentsLayerKey?: string | null;
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

// Decimal places terra-draw is configured to enforce on every
// coordinate. Has to match the `coordinatePrecision` we pass to the
// MapLibre adapter below; both reference this constant so they
// cannot drift apart. Nine digits is roughly 0.1 mm at the equator,
// which is well past anything that matters at portal-display scales.
const EDITOR_COORD_PRECISION = 9;

// Round every numeric coordinate component in a GeoJSON geometry to
// EDITOR_COORD_PRECISION decimal places, returning a fresh
// structure. terra-draw rejects features whose coordinates exceed
// the configured precision (its precision validator runs on every
// addFeatures call), and PostGIS hands geometries back at full
// double precision (15-ish digits), so any feature loaded from the
// server has to be normalized before it can re-enter terra-draw
// for geometry editing. We don't mutate the input.
function roundCoordsToPrecision(
  geom: GeoJSON.Geometry,
  precision: number,
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
      return {
        type: 'MultiPoint',
        coordinates: geom.coordinates.map(rPos),
      };
    case 'LineString':
      return {
        type: 'LineString',
        coordinates: geom.coordinates.map(rPos),
      };
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
  printEnabled = false,
  formViewSchema = null,
  surveyTargetLayerId = null,
  tableOpenDefault = false,
  surveyAttachmentsLayerItemId = null,
  surveyAttachmentsLayerKey = null,
}: Props) {
  const [mapData, setMapData] = useState<MapData>(initialMapData);
  // Track the camera's current zoom so LayerPanel can render the
  // "current view" tick under each layer's scale-range slider.
  const [currentZoom, setCurrentZoom] = useState<number>(initialMapData.zoom);
  /**
   * Current map viewport bbox, fed to AttributeTable's "Records in
   * map extent" toggle (#115 P13). Updated via MapCanvas's
   * onViewportChange callback on every settled camera move.
   */
  const [mapBbox, setMapBbox] = useState<
    [number, number, number, number] | null
  >(null);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Tool / active-target machinery. activeTool drives terra-draw and
  // toolbar highlight; activeTargetKey is "<dataLayerId>:<layerKey>"
  // so we can look the resolved target up cheaply. canEdit gates
  // whether any of this is enabled.
  const [activeTool, setActiveTool] = useState<EditorTool | 'off'>('off');
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);

  // Select-mode picker (#312). When activeTool === 'select', this
  // drives the canvas's selectTool prop: click | rectangle | polygon
  // | lasso. The toolbar's Select button is split: main button toggles
  // select on/off in the current mode; chevron opens a dropdown to
  // change the mode.
  const [selectMode, setSelectMode] = useState<
    'click' | 'rectangle' | 'polygon' | 'lasso'
  >('click');
  const [selectMenuOpen, setSelectMenuOpen] = useState(false);
  const selectMenuRef = useRef<HTMLDivElement | null>(null);

  // Basemap popover (#313). AGOL-style: icon button in the header
  // opens a popover listing the org's basemaps; cleaner than a wide
  // inline <select>.
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);
  const basemapMenuRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismissal for both menus.
  useEffect(() => {
    if (!selectMenuOpen && !basemapMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        selectMenuOpen &&
        selectMenuRef.current &&
        !selectMenuRef.current.contains(t)
      ) {
        setSelectMenuOpen(false);
      }
      if (
        basemapMenuOpen &&
        basemapMenuRef.current &&
        !basemapMenuRef.current.contains(t)
      ) {
        setBasemapMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [selectMenuOpen, basemapMenuOpen]);

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

  // Terra-draw id of the in-flight Add sketch. Set when the user
  // finishes a draw and we capture its geometry into pendingFeature;
  // cleared when the user submits or cancels. Keeping the sketch in
  // terra-draw's store while the attribute form is open lets the
  // user see where the point/line/polygon will land before they
  // commit, so they can decide whether to cancel and re-place.
  const pendingDrawFeatureIdRef = useRef<string | number | null>(null);

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
  // Per-layer last-probed source key. The probe effect re-fetches a
  // layer whenever its current source key differs from the entry
  // here, which captures both initial mount AND
  // refreshTarget-driven URL bumps (`_ts=` cache-buster). Without
  // this tracking, the previous "skip if loaded" check would short-
  // circuit the re-probe after refreshTarget, leaving the
  // attribute-table cache stale after a save.
  const probedSourceKeyRef = useRef<Record<string, string>>({});
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
    // Drop probed-source-key entries for removed layers too.
    for (const id of Object.keys(probedSourceKeyRef.current)) {
      if (!seen.has(id)) delete probedSourceKeyRef.current[id];
    }

    for (const layer of mapData.layers) {
      const sourceKey = JSON.stringify(layer.source);
      // Skip when we've already kicked a probe for this exact
      // source key. A change here (different URL after
      // refreshTarget, swapped source kind, etc.) drops through
      // and re-probes.
      if (probedSourceKeyRef.current[layer.id] === sourceKey) continue;
      probedSourceKeyRef.current[layer.id] = sourceKey;
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
    // removed / has its source swapped (including the _ts=
    // cache-buster bump from refreshTarget). The per-layer
    // probedSourceKeyRef captures the "do we already have data for
    // THIS source URL" check that the effect needs.
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
    /** Captured at click time so the undo stack can re-create the
     *  row if the user undoes the delete. The properties already
     *  have underscore-prefixed editor-tracking keys stripped --
     *  the v3 INSERT path stamps them on the new row. */
    geometry: GeoJSON.Geometry | null;
    properties: Record<string, unknown>;
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

  // Measure tool state (#122). The measure tool is its own
  // activeTool path: when on, terra-draw enters linestring or
  // polygon mode (depending on the sub-mode), the right-docked
  // Measure pane opens, and the runtime shows the live readout
  // there. The measurement is local; nothing persists to a layer.
  const [measureMode, setMeasureMode] = useState<'distance' | 'area'>(
    'distance',
  );
  // Raw measurements in meters / square meters. The pane formats
  // these on render based on the user's chosen unit, so unit
  // changes don't require re-clicking on the map.
  const [measureLengthMeters, setMeasureLengthMeters] = useState<
    number | null
  >(null);
  const [measureAreaSqm, setMeasureAreaSqm] = useState<number | null>(null);
  // Per-mode unit pick. Defaults track AGO's US-friendly imperial
  // defaults; the user can flip via the dropdown and the readout
  // re-formats live.
  const [measureDistanceUnit, setMeasureDistanceUnit] =
    useState<DistanceUnit>('miles');
  const [measureAreaUnit, setMeasureAreaUnit] =
    useState<AreaUnit>('square-miles');
  // Internal terra-draw id for the in-progress measurement feature.
  const measureFeatureIdRef = useRef<string | null>(null);

  // In-session undo / redo stacks (#123). Every successful create /
  // update / delete pushes an op carrying enough state to invert
  // it: a create remembers the new feature id (undo -> DELETE), an
  // update remembers prev + next properties / geometry (undo
  // -> PATCH back), a delete remembers the full row (undo -> POST
  // with the same global_id, which the v3 insert path accepts).
  // Caps at 20 entries; older ops drop off the bottom. Stacks are
  // session-local: a page refresh clears them. Persistent
  // historical revert (via the temporal model on the data layer)
  // is a separate larger feature.
  const [undoStack, setUndoStack] = useState<EditorOp[]>([]);
  const [redoStack, setRedoStack] = useState<EditorOp[]>([]);
  const [undoBusy, setUndoBusy] = useState(false);

  function pushOp(op: EditorOp) {
    setUndoStack((cur) => {
      const next = [...cur, op];
      // Cap at 20 by dropping the oldest. Numbers higher than this
      // make the memory cost real for image-heavy properties.
      if (next.length > 20) next.shift();
      return next;
    });
    // A new operation invalidates anything in the redo stack the
    // user could otherwise re-apply -- standard undo/redo
    // semantics.
    setRedoStack([]);
  }

  // AttributeTable state. tableOpen drives the bottom-overlay
  // panel; tableFocusLayerId anchors the table to a specific layer
  // when the user opens it from a layer-panel kebab. selection is
  // shared with MapCanvas + AttributeTable so highlighting a row
  // also highlights the feature on the canvas (and vice versa).
  // Same shape map-editor uses.
  const [tableOpen, setTableOpen] = useState(tableOpenDefault);
  const [tableFocusLayerId, setTableFocusLayerId] = useState<string | null>(
    null,
  );
  // #318: feature ids are string | number. v3 data-layer sources use
  // promoteId='_global_id' so feature.id is the row's UUID (string);
  // other sources fall through to generateId (number).
  const [selection, setSelection] = useState<
    Record<string, Set<number | string>>
  >({});
  // #306 WAB-style chrome: LayerPanel slides in from the right
  // instead of taking a permanent left rail. Defaults open so the
  // first-time viewer sees what's on the map; the user can close
  // it from the X to gain canvas. The Layers button in the toolbar
  // toggles it. Same right-slide pattern will house future Legend
  // + Filter panels in follow-up slices.
  const [layersOpen, setLayersOpen] = useState(true);
  // #320: form-view side panel (Survey runtime). Defaults open when a
  // schema is bound so users see the response renderer immediately
  // without hunting for the toggle.
  const [formViewOpen, setFormViewOpen] = useState(
    Boolean(formViewSchema && surveyTargetLayerId),
  );
  // 0-based index into the active selection set for the survey
  // runtime's prev/next navigation. Reset to 0 whenever the
  // selection set changes.
  const [formViewIndex, setFormViewIndex] = useState(0);
  // Editor pane (right-docked): houses the editing tools row, the
  // per-target template list, and (Phase C) the attribute editing
  // surface. Defaults open for users with edit rights so the
  // first-time visitor lands ready to edit; viewers with no edit
  // rights never see it. Toggle in the header mirrors LayerPanel's
  // pattern: open by default, close to gain canvas, re-open from
  // the icon. A separate effect below force-opens the pane whenever
  // an attribute edit is staged so the user never loses sight of
  // an in-flight form.
  const [editorPaneOpen, setEditorPaneOpen] = useState(canEdit);

  // Force the editor pane open whenever an attribute edit is
  // staged. Without this, a user who closed the pane would draw a
  // feature, terra-draw fires finish, pendingFeature lands, and
  // there'd be no visible form -- the pane is now the only home
  // for attribute editing.
  useEffect(() => {
    if (pendingFeature && canEdit) setEditorPaneOpen(true);
  }, [pendingFeature, canEdit]);

  // Cancel an in-flight geometry edit when the user switches to a
  // different tool. Without this, a user who clicks a feature for
  // geometry edit and then picks a Create-features template (or
  // hits the Add / Delete / Select / Measure tools) leaves
  // pendingGeometryEdit set, which keeps the geometry-edit panel
  // visible alongside the new tool's UI. The two states aren't
  // meaningfully composable -- if the user switches tools, they
  // want out of the geometry edit.
  useEffect(() => {
    if (pendingGeometryEdit && activeTool !== 'edit') {
      cancelGeometryEdit();
    }
    // cancelGeometryEdit is stable (defined in this component);
    // pendingGeometryEdit and activeTool drive the cancel decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, pendingGeometryEdit]);

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
          coordinatePrecision: EDITOR_COORD_PRECISION,
        }),
        // Permissive id strategy. terra-draw 1.x's default validator
        // requires every feature id to be a UUIDv4-shaped string
        // (length 36). The geometry-edit setup pushes the server's
        // feature id (a UUID, but format not guaranteed across
        // historical and engine-issued rows) into terra-draw's store,
        // so we accept any non-empty string or number to avoid silent
        // rejection. getId still produces a real UUIDv4 for any
        // feature terra-draw creates internally during the draw flow.
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

  // Measure tool change listener (#122). When active, terra-draw
  // emits 'change' on every click while the user is sketching the
  // line / polygon. We read the latest geometry from getSnapshot,
  // compute length or area depending on the sub-mode, and update
  // the floating readout. The shape stays in terra-draw's store
  // until the user clicks Clear or exits the measure tool, so the
  // last measurement keeps rendering alongside the final readout.
  useEffect(() => {
    if (activeTool !== 'measure') return;
    const draw = drawRef.current as
      | {
          on: (
            ev: 'change',
            cb: (ids: Array<string | number>) => void,
          ) => void;
          off: (
            ev: 'change',
            cb: (ids: Array<string | number>) => void,
          ) => void;
          getSnapshot: () => Array<{
            id: string | number;
            geometry: GeoJSON.Geometry;
          }>;
        }
      | null;
    if (!draw) return;
    const handleChange = () => {
      const snap = draw.getSnapshot();
      // Newest sketch wins; old measurements that the user didn't
      // clear stay rendered but don't compete for the readout.
      const f = snap[snap.length - 1];
      if (!f || !f.geometry) return;
      measureFeatureIdRef.current = String(f.id);
      const g = f.geometry;
      if (
        measureMode === 'distance' &&
        g.type === 'LineString' &&
        Array.isArray(g.coordinates)
      ) {
        const len = lineLengthMeters(
          g.coordinates as Array<[number, number]>,
        );
        setMeasureLengthMeters(len);
      } else if (
        measureMode === 'area' &&
        g.type === 'Polygon' &&
        Array.isArray(g.coordinates) &&
        g.coordinates[0]
      ) {
        const a = ringAreaSquareMeters(
          g.coordinates[0] as Array<[number, number]>,
        );
        setMeasureAreaSqm(a);
      }
    };
    draw.on('change', handleChange);
    return () => {
      try {
        draw.off('change', handleChange);
      } catch {
        /* terra-draw race on unmount; ignore */
      }
    };
  }, [activeTool, measureMode, mapInstance]);

  // Clear the in-canvas measurement(s). Drops every feature in
  // terra-draw's store; that's safe here because the only things
  // the store holds while in measure mode are measurement sketches
  // (the geometry-edit feature is removed on exit; the Add tool's
  // sketch is dropped on finish).
  function clearMeasurement() {
    const draw = drawRef.current as { clear: () => void } | null;
    try {
      draw?.clear();
    } catch {
      /* ignore */
    }
    measureFeatureIdRef.current = null;
    setMeasureLengthMeters(null);
    setMeasureAreaSqm(null);
  }

  // Switch sub-mode without exiting the tool. Clears the existing
  // sketch so the user starts fresh with the new geometry kind.
  function switchMeasureMode(next: 'distance' | 'area') {
    if (next === measureMode) return;
    clearMeasurement();
    setMeasureMode(next);
  }

  // Exit the measure tool entirely. Mirrors the Add / Edit / Delete
  // exit paths for consistency: clears whatever was being measured,
  // drops back to the read-only canvas.
  function exitMeasure() {
    clearMeasurement();
    setActiveTool('off');
  }

  // Apply a single op to the server (create / update / delete) and
  // refresh the affected layer. Used by both undo and redo via two
  // small wrappers below: undo runs the inverse of the popped op,
  // redo re-runs the popped op as-is.
  async function applyOp(op: EditorOp, mode: 'create' | 'update' | 'delete') {
    const baseUrl = `/api/portal/items/${op.dataLayerId}/layers/${op.layerKey}/features`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-editor-id': editorId,
    };
    if (mode === 'create') {
      // Reinsert the original row with its captured global_id so
      // dependents pointing at that uuid stay intact. Used for
      // undoing a delete AND for redoing a create (both ops carry
      // the same featureId / geometry / properties shape).
      if (op.kind === 'update') {
        throw new Error('Apply.create requires a create or delete op');
      }
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          features: [
            {
              globalId: op.featureId,
              geometry: op.geometry,
              properties: op.properties,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } else if (mode === 'update') {
      if (op.kind !== 'update') {
        throw new Error('Apply.update requires an update op');
      }
      const res = await fetch(`${baseUrl}/${op.featureId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          geometry: op.geometry,
          properties: op.properties,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } else {
      const res = await fetch(`${baseUrl}/${op.featureId}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`${res.status} ${await res.text()}`);
      }
    }
    refreshTarget(op.dataLayerId, op.layerKey);
  }

  /**
   * Pop the most recent op and run its inverse. Pushes the same op
   * onto the redo stack so the user can step forward again. On
   * server failure (e.g. someone else deleted the row out from
   * under us), the op stays popped: trying to undo it again would
   * keep failing, and surfacing the error so the user knows the
   * stack is partially stale is more honest than silently retrying.
   */
  async function undo() {
    if (undoBusy || undoStack.length === 0) return;
    const op = undoStack[undoStack.length - 1]!;
    setUndoBusy(true);
    try {
      if (op.kind === 'create') {
        // Undo a create -> delete the row that got created. The
        // op carries the global_id we returned at create time.
        await applyOp(op, 'delete');
      } else if (op.kind === 'update') {
        // Undo an update -> PATCH back to the previous geometry +
        // properties. Build a synthetic update op that swaps prev
        // and next for the apply call.
        await applyOp(
          {
            ...op,
            geometry: op.previousGeometry,
            properties: op.previousProperties,
          },
          'update',
        );
      } else {
        // Undo a delete -> re-insert the original row with the
        // captured global_id, geometry, and properties.
        await applyOp(op, 'create');
      }
      setUndoStack((cur) => cur.slice(0, -1));
      setRedoStack((cur) => [...cur, op]);
    } catch (err) {
      setToast(
        err instanceof Error ? `Undo failed: ${err.message}` : 'Undo failed',
      );
      scheduleToastClear();
    } finally {
      setUndoBusy(false);
    }
  }

  /**
   * Pop the most recent redoable op and re-apply it. Mirrors the
   * undo path in the opposite direction; same failure behaviour.
   */
  async function redo() {
    if (undoBusy || redoStack.length === 0) return;
    const op = redoStack[redoStack.length - 1]!;
    setUndoBusy(true);
    try {
      if (op.kind === 'create') {
        // Redo a create -> POST again with captured global_id +
        // snapshot. The captured snapshot ensures we re-create
        // the same row, not a fresh uuid.
        await applyOp(op, 'create');
      } else if (op.kind === 'update') {
        // Redo an update -> PATCH to the new state.
        await applyOp(op, 'update');
      } else {
        // Redo a delete -> DELETE the row again.
        await applyOp(op, 'delete');
      }
      setRedoStack((cur) => cur.slice(0, -1));
      setUndoStack((cur) => {
        const next = [...cur, op];
        if (next.length > 20) next.shift();
        return next;
      });
    } catch (err) {
      setToast(
        err instanceof Error ? `Redo failed: ${err.message}` : 'Redo failed',
      );
      scheduleToastClear();
    } finally {
      setUndoBusy(false);
    }
  }

  // Keyboard: Ctrl+Z (undo), Ctrl+Shift+Z (redo). Cmd on macOS.
  // We don't override the browser's default outside of the editor
  // runtime, so the listener checks document.activeElement to
  // avoid eating Cmd+Z when the user is typing in an input -- if
  // they're in a text field, the browser's text-undo wins.
  useEffect(() => {
    if (!canEdit) return;
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.key.toLowerCase() !== 'z') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) void redo();
      else void undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, undoStack.length, redoStack.length, undoBusy]);

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
          removeFeatures: (ids: Array<string | number>) => void;
        }
      | null;
    if (!draw) return;

    const handleFinish = (id: string) => {
      // terra-draw emits 'finish' both when a draw completes (the
      // create flow we want to handle) AND when a drag completes in
      // select mode. The latter happens during geometry-edit mode
      // (e.g. the user drags a point or vertex). Ignore those: the
      // geometry-edit change listener already mirrors the dragged
      // geometry into pendingGeometryEdit.currentGeometry, and the
      // floating "Save geometry" button is what should commit it.
      // tdEditFeatureIdRef is set whenever a geometry edit is in
      // flight, so gate on that.
      if (tdEditFeatureIdRef.current) return;
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
      // Capture the geometry into pendingFeature and KEEP the sketch
      // in terra-draw's store. The user can see where the new
      // feature is going to land while filling out the attribute
      // form, and decide whether to cancel and re-place. The sketch
      // is removed in submitPending (after the real feature lands
      // on the layer source) or cancelPending (the user backed out).
      // Park terra-draw in select mode so subsequent canvas clicks
      // don't keep adding new sketches while the form is up.
      pendingDrawFeatureIdRef.current = f.id;
      setPendingFeature({
        mode: 'create',
        geometry: f.geometry,
        targetKey,
        featureId: null,
        initialProperties,
      });
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
    // Measure tool path (#122). Independent of editor targets:
    // entering measure mode + sub-mode flips terra-draw into the
    // matching draw mode without needing an activeTargetKey. The
    // change-listener effect below picks up the in-progress
    // geometry and updates the readout.
    if (activeTool === 'measure') {
      try {
        draw.start();
      } catch {
        /* already started */
      }
      try {
        draw.setMode(measureMode === 'area' ? 'polygon' : 'linestring');
      } catch {
        /* not started yet */
      }
      return;
    }
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
  }, [
    activeTool,
    activeTargetKey,
    activeTemplateId,
    targetByKey,
    editor.targets,
    measureMode,
  ]);

  // Map cursor override. MapLibre's pan default (grab/grabbing
  // hand) reads as "drag the map" and offers no precision
  // affordance for placing a feature. When the user is in Add mode
  // (or Edit / Delete / Measure, which also expect precise click
  // placement), force the cursor to 'crosshair' so the user has a
  // clear target for dropping the next click.
  //
  // The cursor has to be set on the canvas-container (not the
  // canvas itself): MapLibre styles `.maplibregl-canvas-container.maplibregl-interactive`
  // with `cursor: grab` directly, so inheritance shows grab on the
  // child canvas regardless of what the canvas's own cursor style
  // says. Setting cursor inline on the container wins over the
  // class-level rule.
  useEffect(() => {
    if (!mapInstance) return;
    const container = mapInstance.getCanvasContainer();
    if (!container) return;
    const wantCrosshair =
      (activeTool === 'add' && activeTargetKey !== null) ||
      activeTool === 'edit' ||
      activeTool === 'measure';
    if (wantCrosshair) {
      container.style.cursor = 'crosshair';
    } else {
      container.style.cursor = '';
    }
    return () => {
      // Reset when the effect tears down so we don't strand the
      // cursor in a non-default state if the map remounts.
      container.style.cursor = '';
    };
  }, [mapInstance, activeTool, activeTargetKey]);

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
    // Read-side tools (select, measure) are available in viewer mode
    // (canEdit=false) too. Write-side tools (add/edit/delete/snap/
    // undo/redo) require canEdit. Bail early on the write-side ones
    // when canEdit is false; the button's `disabled` styling already
    // signals this, so a stray click is harmless.
    const isReadOnlyTool = tool === 'select' || tool === 'measure';
    if (!canEdit && !isReadOnlyTool) return;
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
    if (tool === 'select') {
      // Toggle: clicking Select again drops back to off (default
      // pan + click-to-popup). When 'select' is active, MapCanvas's
      // selectTool='click' mode kicks in: clicks pick features into
      // the selection set without opening popups, mirroring AGOL's
      // Select tool. The button's `isActive` highlight reflects
      // activeTool === 'select'.
      setActiveTool((prev) => (prev === 'select' ? 'off' : 'select'));
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
    if (tool === 'undo') {
      if (undoStack.length === 0) {
        setToast('Nothing to undo.');
        scheduleToastClear();
        return;
      }
      void undo();
      return;
    }
    if (tool === 'redo') {
      if (redoStack.length === 0) {
        setToast('Nothing to redo.');
        scheduleToastClear();
        return;
      }
      void redo();
      return;
    }
    if (tool === 'measure') {
      // Measure takes over the canvas the same way Add does, but
      // has nothing to do with editor targets: it's a sketch
      // overlay that reports length / area without persisting.
      // We default to distance; the right-docked Measure pane
      // lets the user toggle to area without exiting the tool.
      setActiveTool('measure');
      setActiveTargetKey(null);
      setActiveTemplateId(null);
      setMeasureMode('distance');
      setMeasureLengthMeters(null);
      setMeasureAreaSqm(null);
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
    if (activeTool !== 'edit') return;
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
      // first enter geometry-edit mode: vertex handles appear and
      // the pane shows the geometry-edit panel (cancel / edit attrs
      // / save / delete). Attribute-only targets (or features
      // without geometry, e.g. a related-table row that snuck into
      // the click handler) skip straight to the attribute form.
      const editorTarget = editor.targets.find(
        (t) => t.dataLayerId === dataLayerId && t.layerKey === layerKey,
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
        // internal references, then round coordinates to terra-
        // draw's configured precision: PostGIS returns 15-digit
        // doubles, terra-draw rejects anything past
        // EDITOR_COORD_PRECISION. The rounded geometry is what
        // both originalGeometry and currentGeometry start as, so
        // the change-detection comparison still round-trips
        // cleanly when the user drags a vertex.
        const cloned = roundCoordsToPrecision(
          JSON.parse(JSON.stringify(hit.geometry)) as GeoJSON.Geometry,
          EDITOR_COORD_PRECISION,
        );
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
          addFeatures: (
            features: unknown[],
          ) => Array<{ id?: string | number; valid: boolean; reason?: string }>;
          selectFeature: (id: string) => void;
          deselectFeature: (id: string) => void;
          removeFeatures: (ids: Array<string | number>) => void;
          hasFeature: (id: string | number) => boolean;
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
    // Use the bare server feature id as terra-draw's feature id.
    // We previously wrapped this with a `gg-edit-` prefix on the
    // assumption that it would collide with the underlying source
    // layer's feature id, but terra-draw maintains its own store
    // separate from MapLibre's source, so there is no collision.
    // The prefix made debugging harder (any rejection surfaced as
    // "No feature with this id (gg-edit-...)") and was unnecessary.
    const tdId = pendingGeometryEdit.featureId;
    tdEditFeatureIdRef.current = tdId;

    // Belt-and-suspenders: if a previous edit on the same feature id
    // somehow left a record in terra-draw's store (e.g. cleanup raced
    // with a re-entry), the duplicate check inside _store.load would
    // reject the new feature with "Feature already exists with this id".
    // Clear it before adding.
    try {
      if (draw.hasFeature(tdId)) {
        draw.removeFeatures([tdId]);
      }
    } catch {
      /* ignore */
    }

    try {
      const results = draw.addFeatures([
        {
          id: tdId,
          type: 'Feature',
          geometry: pendingGeometryEdit.originalGeometry,
          properties: { mode: tdMode },
        },
      ]);
      // _store.load returns a StoreValidation[]: one entry per input
      // feature with `{valid, reason?}`. addFeatures swallows
      // rejections silently, so a feature that fails validation never
      // lands in the store and selectFeature then throws "No feature
      // with this id, can not get properties copy". Read the result
      // here so we can surface the actual reason in the in-modal error.
      const rejection = (results ?? []).find((r) => !r.valid);
      if (rejection) {
        setGeomEditError(
          `Could not load geometry: ${rejection.reason ?? 'unknown reason'}`,
        );
      } else {
        draw.selectFeature(tdId);
      }
    } catch (err) {
      // selectFeature throws when the feature is missing from the
      // store. We surface this as the in-modal error so the user can
      // cancel out cleanly rather than getting stuck.
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
      // Push undo op (#123). Geometry-only edit: properties stay
      // the same on both sides so a redo or undo round-trips
      // cleanly through applyOp.update.
      pushOp({
        kind: 'update',
        dataLayerId: pendingGeometryEdit.dataLayerId,
        layerKey: pendingGeometryEdit.layerKey,
        featureId: pendingGeometryEdit.featureId,
        previousGeometry: pendingGeometryEdit.originalGeometry,
        previousProperties: pendingGeometryEdit.properties,
        geometry: pendingGeometryEdit.currentGeometry,
        properties: pendingGeometryEdit.properties,
      });
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
      // Push undo op (#123). The captured geometry + properties
      // (recorded at click time) let the user undo the delete by
      // re-creating the row with the same global_id.
      pushOp({
        kind: 'delete',
        dataLayerId: pendingDelete.dataLayerId,
        layerKey: pendingDelete.layerKey,
        featureId: pendingDelete.featureId,
        geometry: pendingDelete.geometry,
        properties: pendingDelete.properties,
      });
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
      // Generate a client-side global_id for new features so the
      // undo stack (#123) can refer to the same row by uuid even
      // before we re-fetch the layer. The v3 INSERT path accepts
      // `globalId` and uses COALESCE so client-generated ids
      // round-trip cleanly.
      let createdGlobalId: string | null = null;
      if (pendingFeature.mode === 'create') {
        createdGlobalId =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
        res = await fetch(baseUrl, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({
            features: [
              {
                globalId: createdGlobalId,
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
      // Push an undo op so the user can step backward. Capture
      // enough state to invert: a create remembers its globalId +
      // submitted geometry / properties (undo -> DELETE that
      // row); an update remembers prev + next properties (undo
      // -> PATCH back). For the update path, geometry is
      // unchanged here -- the attribute form doesn't touch
      // geometry; that's a separate save path (saveGeometryEdit).
      if (pendingFeature.mode === 'create' && createdGlobalId) {
        pushOp({
          kind: 'create',
          dataLayerId: target.dataLayerId,
          layerKey: target.layerKey,
          featureId: createdGlobalId,
          geometry: (pendingFeature.geometry ??
            null) as GeoJSON.Geometry | null,
          properties: values,
        });
      } else if (pendingFeature.mode === 'update' && pendingFeature.featureId) {
        pushOp({
          kind: 'update',
          dataLayerId: target.dataLayerId,
          layerKey: target.layerKey,
          featureId: pendingFeature.featureId,
          previousGeometry: (pendingFeature.geometry ??
            null) as GeoJSON.Geometry | null,
          previousProperties: pendingFeature.initialProperties,
          // Geometry is unchanged on attribute-only edits, so
          // record the same value for both sides.
          geometry: (pendingFeature.geometry ??
            null) as GeoJSON.Geometry | null,
          properties: values,
        });
      }
      // Success: clear pending, refresh layer, return to select.
      setPendingFeature(null);
      setActiveTool('off');
      // Drop the in-flight Add sketch from terra-draw now that the
      // real feature is about to land on the layer source. If we
      // skipped this, the user would briefly see two copies of the
      // feature (the sketch + the freshly-loaded source row).
      clearPendingDrawSketch();
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
    // Drop the in-flight Add sketch -- the user backed out and
    // doesn't want it. If they re-enter Add mode the next click
    // starts a fresh draw cleanly.
    clearPendingDrawSketch();
    // Keep the Add tool active so the user can immediately try
    // again rather than re-clicking through the toolbar. Drop the
    // chosen target only if we auto-selected it; respecting the
    // user's manual pick keeps things less surprising.
  }

  // Helper for the create-flow: removes the sketch we kept visible
  // while the attribute form was open. Safe to call when the ref is
  // null (no-ops). Tolerates the case where terra-draw has already
  // dropped the feature for some other reason (mode switch, draw
  // restart, etc.).
  function clearPendingDrawSketch() {
    const id = pendingDrawFeatureIdRef.current;
    pendingDrawFeatureIdRef.current = null;
    if (id == null) return;
    const draw = drawRef.current as
      | { removeFeatures: (ids: Array<string | number>) => void }
      | null;
    if (!draw) return;
    try {
      draw.removeFeatures([id]);
    } catch {
      /* feature already gone or terra-draw unmounting */
    }
  }

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

  // Per-layer FeatureField list for AttributeTable's domain-aware
  // inline editor. When a field has a coded-value (or
  // coded-value-ref) domain, the table renders a <select> of the
  // configured options instead of a freeform text input. Built
  // once from resolvedTargets so the table's editor doesn't have
  // to fetch schema on its own.
  const inlineFieldsByLayer = useMemo(() => {
    const out: Record<
      string,
      NonNullable<ResolvedTarget['layer']>['fields']
    > = {};
    for (const t of resolvedTargets) {
      if (!t.layer) continue;
      const id = editorTargetLayerId(t.dataLayerId, t.layerKey);
      out[id] = t.layer.fields;
    }
    return out;
  }, [resolvedTargets]);

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

  // #320: Survey-runtime form-view derived state. surveyKeys is the
  // ordered list of selected feature keys on the survey target layer
  // (number indexes for non-v3 sources, _global_id strings for v3
  // data_layers thanks to the promoteId='_global_id' configuration in
  // map-canvas, so the selection survives bbox-driven setData refresh
  // on pan/zoom). activeFeature resolves the current key back to the
  // feature in the cached collection so the FormView panel can render
  // its properties through the form schema.
  const surveySelectionSet =
    surveyTargetLayerId ? selection[surveyTargetLayerId] : undefined;
  const surveyKeys = useMemo<Array<number | string>>(() => {
    if (!surveySelectionSet) return [];
    return [...surveySelectionSet];
  }, [surveySelectionSet]);

  // Reset the prev/next index whenever the selection set changes so
  // the user always lands on the first selected response after a new
  // box-select / lasso / etc. We key the reset on the joined sorted
  // keys; permutations within the same set don't bounce the user.
  const surveyKeysJoined = surveyKeys
    .map((k) => String(k))
    .sort()
    .join('|');
  useEffect(() => {
    setFormViewIndex(0);
  }, [surveyKeysJoined]);

  const surveyActiveFeature = useMemo<GeoJSON.Feature | null>(() => {
    if (!surveyTargetLayerId) return null;
    if (surveyKeys.length === 0) return null;
    const idx = Math.min(formViewIndex, surveyKeys.length - 1);
    const key = surveyKeys[idx];
    const fc = featuresByLayer[surveyTargetLayerId];
    if (!fc) return null;
    if (typeof key === 'number') {
      // Numeric index into the original collection. Used by non-v3
      // sources whose features have no stable id we can promote.
      return fc.features[key] ?? null;
    }
    // String key = _global_id; v3 collections always carry it on
    // properties (the form mirror writes it when seeding the row).
    const hit = fc.features.find(
      (f) => (f.properties as Record<string, unknown> | null)?.['_global_id'] === key,
    );
    return hit ?? null;
  }, [surveyTargetLayerId, surveyKeys, formViewIndex, featuresByLayer]);

  const surveyActiveProperties = useMemo<Record<string, unknown> | null>(() => {
    if (!surveyActiveFeature) return null;
    return (surveyActiveFeature.properties ?? {}) as Record<string, unknown>;
  }, [surveyActiveFeature]);

  const surveyTargetLayer = useMemo(() => {
    if (!surveyTargetLayerId) return null;
    return mapData.layers.find((l) => l.id === surveyTargetLayerId) ?? null;
  }, [surveyTargetLayerId, mapData.layers]);

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      {/* Top bar: back link + title + reference map breadcrumb.
          "Back to items" matches the standard item detail page so
          users who arrive here from the items list have a
          consistent escape. Owners get a separate "Configure"
          link that takes them to the editor's detail/config page. */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* "Back to items" only renders for editors. Viewers --
              especially anonymous public-share visitors -- don't have
              an items list to return to, and AGOL's shared viewer
              link opens in a new tab without back-nav. Editors keep
              the link as a quick escape to the items list. */}
          {canEdit ? (
            <>
              <Link
                href="/items"
                className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to items
              </Link>
              <span className="text-muted">/</span>
            </>
          ) : null}
          {/* Title icon mirrors the item-type tile color from the
              items list (purple for editor, orange for viewer)
              so the user can recognize which template they're in
              at a glance. PencilRuler reads as "edit"; Sparkles
              matches the web_app accent we use in the items grid
              for runnable viewer apps. */}
          <span className="inline-flex items-center gap-1.5 text-base font-semibold text-ink-0">
            {canEdit ? (
              <PencilRuler className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            ) : (
              <Sparkles className="h-4 w-4 text-orange-500" />
            )}
            {editorTitle}
          </span>
          {referencedMapTitle && canEdit ? (
            <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">
              <span>against</span>
              <span className="font-medium text-ink-1">
                {referencedMapTitle}
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          {/* Editor tools (Add, Edit, Delete, Select, Snap, Measure,
              Undo, Redo) used to live in a header pill here. They
              now live in the right-docked Editor pane below, which
              also hosts the per-target template list (Phase B) and
              the attribute editing surface (Phase C). The header
              keeps just the Print pill (when enabled) plus the
              "what's on the map" panel toggles. */}
          {printEnabled ? (
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-1 p-1">
              <button
                type="button"
                onClick={() => {
                  if (typeof window === 'undefined') return;
                  document.body.classList.add('print-runtime');
                  window.dispatchEvent(new Event('resize'));
                  setTimeout(() => {
                    window.print();
                    document.body.classList.remove('print-runtime');
                    window.dispatchEvent(new Event('resize'));
                  }, 50);
                }}
                className="inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0"
                title="Print the current view"
                aria-label="Print"
              >
                <Printer className="h-5 w-5" />
              </button>
            </div>
          ) : null}
          {/* Header toolbar: a single pill that holds the editor pane
              toggle (canEdit only), the read-side interaction tools
              (Select with mode dropdown, Measure -- not
              edit-specific so they live here, not in the pane), and
              the panel toggles (Layers, Attribute Table, Form View,
              Basemap). One pill instead of three because all of
              these icons share the same visual rhythm and splitting
              them by function created more noise than it relieved.
              Active panel / active tool both highlight in purple to
              match. */}
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-1 p-1">
            {/* Order (per user request): Basemap, Layers, Attribute
                Table, Form View (survey only), Measure, Select,
                Edit. Reading left to right: "what map am I looking
                at?" then "what's on it?" then read-side interaction
                tools, then write-side editor entry. */}
            {/* Basemap switcher (#313): icon + popover. Listed
                first because "what background am I looking at?" is
                the most foundational question. */}
            <div ref={basemapMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setBasemapMenuOpen((v) => !v)}
                className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                  basemapMenuOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
                }`}
                title="Basemap"
                aria-label="Basemap"
                aria-haspopup="menu"
                aria-expanded={basemapMenuOpen}
              >
                <MapBaseIcon className="h-5 w-5" />
              </button>
              {basemapMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-11 z-30 w-56 overflow-hidden rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
                >
                  <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Basemap
                  </div>
                  {basemaps.length === 0 ? (
                    <div className="px-3 py-2 italic text-muted">
                      No basemaps available
                    </div>
                  ) : (
                    <ul className="max-h-72 overflow-auto py-1">
                      {basemaps.map((b) => {
                        const active = (mapData.basemap || '') === b.id;
                        return (
                          <li key={b.id}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                onBasemapChange(b.id);
                                setBasemapMenuOpen(false);
                              }}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 ${
                                active
                                  ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                                  : 'text-ink-1'
                              }`}
                            >
                              <span className="truncate">{b.label}</span>
                              {active ? (
                                <span className="ml-auto text-[10px] uppercase tracking-wide">
                                  active
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setLayersOpen((v) => !v)}
              className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                layersOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
              }`}
              title="Layers"
              aria-label="Layers"
              aria-pressed={layersOpen}
            >
              <LayersIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setTableOpen((v) => !v);
                if (!tableOpen) setTableFocusLayerId(null);
              }}
              className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                tableOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
              }`}
              title="Attribute table"
              aria-label="Attribute table"
              aria-pressed={tableOpen}
            >
              <TableIcon className="h-5 w-5" />
            </button>
            {/* #320: Form view side panel toggle. Only renders for the
                Survey runtime (formViewSchema + surveyTargetLayerId).
                Editor / Viewer don't pass these props so the toggle
                is hidden on those surfaces. */}
            {formViewSchema && surveyTargetLayerId ? (
              <button
                type="button"
                onClick={() => setFormViewOpen((v) => !v)}
                className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                  formViewOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
                }`}
                title="Form view"
                aria-label="Form view"
                aria-pressed={formViewOpen}
              >
                <ClipboardList className="h-5 w-5" />
              </button>
            ) : null}
            {editor.tools.includes('measure') ? (
              <button
                type="button"
                onClick={() => onToolClick('measure')}
                className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                  activeTool === 'measure'
                    ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                    : ''
                }`}
                title="Measure"
                aria-label="Measure"
                aria-pressed={activeTool === 'measure'}
              >
                <Ruler className="h-5 w-5" />
              </button>
            ) : null}
            {editor.tools.includes('select') ? (() => {
              const ModeIcon =
                selectMode === 'click'
                  ? MousePointer2
                  : selectMode === 'rectangle'
                    ? Square
                    : selectMode === 'polygon'
                      ? Pentagon
                      : Spline;
              const isActive = activeTool === 'select';
              return (
                <div
                  key="select"
                  ref={selectMenuRef}
                  className="relative flex items-stretch"
                >
                  <button
                    type="button"
                    onClick={() => onToolClick('select')}
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-l text-muted hover:bg-surface-2 hover:text-ink-0 ${
                      isActive ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
                    }`}
                    title={`Select (${selectMode})`}
                    aria-label={`Select (${selectMode})`}
                    aria-pressed={isActive}
                  >
                    <ModeIcon className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectMenuOpen((v) => !v)}
                    className={`inline-flex h-9 w-5 items-center justify-center rounded-r text-muted hover:bg-surface-2 hover:text-ink-0 ${
                      isActive ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
                    }`}
                    aria-label="Select mode"
                    aria-haspopup="menu"
                    aria-expanded={selectMenuOpen}
                    title="Select mode"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {selectMenuOpen ? (
                    <div
                      role="menu"
                      className="absolute right-0 top-11 z-30 w-44 overflow-hidden rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
                    >
                      <SelectModeItem
                        Icon={MousePointer2}
                        label="Click"
                        active={selectMode === 'click'}
                        onClick={() => {
                          setSelectMode('click');
                          setSelectMenuOpen(false);
                          if (activeTool !== 'select') onToolClick('select');
                        }}
                      />
                      <SelectModeItem
                        Icon={Square}
                        label="Rectangle"
                        active={selectMode === 'rectangle'}
                        onClick={() => {
                          setSelectMode('rectangle');
                          setSelectMenuOpen(false);
                          if (activeTool !== 'select') onToolClick('select');
                        }}
                      />
                      <SelectModeItem
                        Icon={Pentagon}
                        label="Polygon"
                        active={selectMode === 'polygon'}
                        onClick={() => {
                          setSelectMode('polygon');
                          setSelectMenuOpen(false);
                          if (activeTool !== 'select') onToolClick('select');
                        }}
                      />
                      <SelectModeItem
                        Icon={Spline}
                        label="Lasso"
                        active={selectMode === 'lasso'}
                        onClick={() => {
                          setSelectMode('lasso');
                          setSelectMenuOpen(false);
                          if (activeTool !== 'select') onToolClick('select');
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })() : null}
            {/* Editor pane toggle: write-side entry. Last in the
                pill so the order reads "what's on the map" first,
                then the editor as the action affordance. canEdit
                only. */}
            {canEdit ? (
              <button
                type="button"
                onClick={() => setEditorPaneOpen((v) => !v)}
                className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
                  editorPaneOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
                }`}
                title={editorPaneOpen ? 'Close editor pane' : 'Open editor pane'}
                aria-label="Editor pane"
                aria-pressed={editorPaneOpen}
              >
                <PencilLine className="h-5 w-5" />
              </button>
            ) : null}
          </div>
          {/* Editable-layers count is meaningless in the read-only
              viewer (always 0) and clutters the public-share header.
              Only show for editors. */}
          {canEdit ? (
            <span>
              {targetCount} editable layer{targetCount === 1 ? '' : 's'}
            </span>
          ) : null}
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

      {/* #306 WAB-style chrome: full-bleed map canvas with the
          LayerPanel sliding in from the RIGHT instead of taking a
          permanent left rail. Toggleable from the Layers icon in
          the header so users can dismiss the panel to gain canvas
          and re-summon it without navigating away. The panel is
          absolutely positioned over the canvas (not pushing it),
          which keeps the map at full width when the panel is
          closed and gives the visual sense of "summoning a
          drawer" from the side rather than re-flowing the page. */}
      <div className="relative flex flex-1 overflow-hidden">
        <div
          className={`absolute right-0 top-0 z-20 flex h-full w-80 shrink-0 transform flex-col border-l border-border bg-surface-1 shadow-overlay transition-transform duration-200 ${
            layersOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          aria-hidden={!layersOpen}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Layers
            </span>
            <button
              type="button"
              onClick={() => setLayersOpen(false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0"
              aria-label="Close layers panel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
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
        </div>

        {/* #320: Survey runtime form-view side panel. Wider than the
            Layers panel because the rendered form needs room for
            labels + values + optional group nesting. Sits at z-30 so
            it overlays the Layers panel when both are open (matches
            the Esri Survey123 Data tab pattern: form-view takes
            precedence visually). */}
        {formViewSchema && surveyTargetLayerId ? (
          <div
            className={`absolute right-0 top-0 z-30 flex h-full w-96 shrink-0 transform flex-col border-l border-border bg-surface-1 shadow-overlay transition-transform duration-200 ${
              formViewOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
            aria-hidden={!formViewOpen}
          >
            <FormView
              open={formViewOpen}
              schema={formViewSchema}
              pickLists={pickLists}
              layer={surveyTargetLayer}
              activeProperties={surveyActiveProperties}
              selectedCount={surveyKeys.length}
              activeIndex={Math.min(
                formViewIndex,
                Math.max(0, surveyKeys.length - 1),
              )}
              attachmentsLayerItemId={surveyAttachmentsLayerItemId}
              attachmentsLayerKey={surveyAttachmentsLayerKey}
              onPrev={() =>
                setFormViewIndex((i) => {
                  const n = surveyKeys.length;
                  if (n <= 1) return 0;
                  return (i - 1 + n) % n;
                })
              }
              onNext={() =>
                setFormViewIndex((i) => {
                  const n = surveyKeys.length;
                  if (n <= 1) return 0;
                  return (i + 1) % n;
                })
              }
              onClose={() => setFormViewOpen(false)}
            />
          </div>
        ) : null}

        {/* Editor pane (Phase A scaffold). Right-docked, slides in
            like LayerPanel. Houses the editing tools row that used
            to live in the header. Phase B will add the
            "Create features" template list under the tools; Phase C
            will route the attribute editing surface through here.
            Only renders for canEdit users; viewers never see it.
            z-25 sits above LayerPanel (z-20) so the pane is reachable
            even with Layers open, and below FormView (z-30) so the
            survey runtime's form view still wins for that surface. */}
        {canEdit ? (
          <div
            className={`absolute right-0 top-0 flex h-full w-80 shrink-0 transform flex-col border-l border-border bg-surface-1 shadow-overlay transition-transform duration-200 ${
              editorPaneOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
            aria-hidden={!editorPaneOpen}
            style={{ zIndex: 25 }}
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                {pendingFeature
                  ? pendingFeature.mode === 'create'
                    ? 'New feature'
                    : 'Edit feature'
                  : pendingGeometryEdit
                    ? 'Edit geometry'
                    : 'Editor'}
              </span>
              <button
                type="button"
                onClick={() => {
                  // If there's a pending edit in flight, closing the
                  // pane should also cancel it. Otherwise just hide
                  // the pane.
                  if (pendingFeature) cancelPending();
                  else if (pendingGeometryEdit) cancelGeometryEdit();
                  else setEditorPaneOpen(false);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0"
                aria-label={
                  pendingFeature
                    ? 'Cancel attribute edit'
                    : pendingGeometryEdit
                      ? 'Cancel geometry edit'
                      : 'Close editor pane'
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {pendingFeature && pendingTarget?.layer ? (
              // Phase C: attribute editing surfaces inside the pane
              // instead of as a modal. The form fully takes over the
              // pane body until the user submits or cancels. Tools
              // and templates aren't shown during this state since
              // they're irrelevant to filling out a form. Delete is
              // available as a footer extra on the update flow only
              // (create has nothing to delete).
              <div className="min-h-0 flex-1">
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
                  extraFooter={
                    pendingFeature.mode === 'update' &&
                    pendingFeature.featureId &&
                    deletableTargetKeys.has(pendingFeature.targetKey) ? (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          // Stage a soft-delete confirm against the
                          // current pending feature. Mirrors the
                          // delete summary computation used in the
                          // floating geometry-edit bar so the dialog
                          // displays a meaningful label.
                          const props = pendingFeature.initialProperties ?? {};
                          let summary =
                            (pendingFeature.featureId ?? '').slice(0, 8) +
                            '...';
                          if (pendingTarget?.layer) {
                            for (const f of pendingTarget.layer.fields) {
                              const v = (props as Record<string, unknown>)[
                                f.name
                              ];
                              if (v === null || v === undefined || v === '')
                                continue;
                              summary = String(v);
                              break;
                            }
                          }
                          const captureProps: Record<string, unknown> = {};
                          for (const [k, v] of Object.entries(props)) {
                            if (k.startsWith('_')) continue;
                            captureProps[k] = v;
                          }
                          setPendingDelete({
                            dataLayerId:
                              pendingTarget?.dataLayerId ??
                              pendingFeature.targetKey.split(':')[0]!,
                            layerKey:
                              pendingTarget?.layerKey ??
                              pendingFeature.targetKey.split(':')[1]!,
                            featureId: pendingFeature.featureId!,
                            layerTitle: `${pendingTarget?.dataLayerTitle ?? ''} / ${pendingTarget?.layer?.label ?? ''}`,
                            summary,
                            geometry:
                              (pendingFeature.geometry as
                                | GeoJSON.Geometry
                                | undefined) ?? null,
                            properties: captureProps,
                          });
                          // Close the pending attribute edit so the
                          // delete confirm doesn't sit behind the
                          // form.
                          cancelPending();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger/15 disabled:opacity-50"
                        title="Delete this feature"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    ) : null
                  }
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
              {/* Edit features section: tool buttons specific to the
                  editing workflow (Add, Edit, Snap, Undo, Redo).
                  Select and Measure live in the top toolbar instead
                  because they are also useful in viewer mode and are
                  not edit-specific. Delete is no longer a tool at
                  all (was pruned along with the EditorTool union);
                  the per-feature panels carry the destructive
                  action where it belongs. */}
              {ALL_TOOLS.filter(
                (t) =>
                  editor.tools.includes(t.key) &&
                  t.key !== 'select' &&
                  t.key !== 'measure',
              ).length > 0 ? (
                <section>
                  <h3 className="mb-1.5 text-xs font-semibold text-ink-0">
                    Edit features
                  </h3>
                  <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-surface-0 p-1">
                    {ALL_TOOLS.filter(
                      (t) =>
                        editor.tools.includes(t.key) &&
                        t.key !== 'select' &&
                        t.key !== 'measure',
                    ).map((t) => {
                      const isToggle = t.key === 'snap';
                      const isActive = isToggle
                        ? snappingEnabled
                        : activeTool === t.key;
                      const stackEmpty =
                        (t.key === 'undo' && undoStack.length === 0) ||
                        (t.key === 'redo' && redoStack.length === 0);
                      const isStackButton =
                        t.key === 'undo' || t.key === 'redo';
                      const isReadOnlyTool =
                        t.key === 'select' || t.key === 'measure';
                      const disabled =
                        (!canEdit && !isReadOnlyTool) ||
                        (isStackButton && stackEmpty) ||
                        (isStackButton && undoBusy);
                      if (t.key === 'select') {
                        const ModeIcon =
                          selectMode === 'click'
                            ? MousePointer2
                            : selectMode === 'rectangle'
                              ? Square
                              : selectMode === 'polygon'
                                ? Pentagon
                                : Spline;
                        return (
                          <div
                            key={t.key}
                            ref={selectMenuRef}
                            className="relative flex items-stretch"
                          >
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => onToolClick(t.key)}
                              className={`inline-flex h-9 w-9 items-center justify-center rounded-l text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                                isActive
                                  ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                                  : ''
                              }`}
                              title={`Select (${selectMode})`}
                              aria-label={`Select (${selectMode})`}
                              aria-pressed={isActive}
                            >
                              <ModeIcon className="h-5 w-5" />
                            </button>
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => setSelectMenuOpen((v) => !v)}
                              className={`inline-flex h-9 w-5 items-center justify-center rounded-r text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                                isActive
                                  ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                                  : ''
                              }`}
                              aria-label="Select mode"
                              aria-haspopup="menu"
                              aria-expanded={selectMenuOpen}
                              title="Select mode"
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </button>
                            {selectMenuOpen ? (
                              <div
                                role="menu"
                                className="absolute left-0 top-11 z-30 w-44 overflow-hidden rounded-md border border-border bg-surface-1 text-xs shadow-overlay"
                              >
                                <SelectModeItem
                                  Icon={MousePointer2}
                                  label="Click"
                                  active={selectMode === 'click'}
                                  onClick={() => {
                                    setSelectMode('click');
                                    setSelectMenuOpen(false);
                                    if (activeTool !== 'select')
                                      onToolClick('select');
                                  }}
                                />
                                <SelectModeItem
                                  Icon={Square}
                                  label="Rectangle"
                                  active={selectMode === 'rectangle'}
                                  onClick={() => {
                                    setSelectMode('rectangle');
                                    setSelectMenuOpen(false);
                                    if (activeTool !== 'select')
                                      onToolClick('select');
                                  }}
                                />
                                <SelectModeItem
                                  Icon={Pentagon}
                                  label="Polygon"
                                  active={selectMode === 'polygon'}
                                  onClick={() => {
                                    setSelectMode('polygon');
                                    setSelectMenuOpen(false);
                                    if (activeTool !== 'select')
                                      onToolClick('select');
                                  }}
                                />
                                <SelectModeItem
                                  Icon={Spline}
                                  label="Lasso"
                                  active={selectMode === 'lasso'}
                                  onClick={() => {
                                    setSelectMode('lasso');
                                    setSelectMenuOpen(false);
                                    if (activeTool !== 'select')
                                      onToolClick('select');
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      }
                      return (
                        <button
                          key={t.key}
                          type="button"
                          disabled={disabled}
                          onClick={() => onToolClick(t.key)}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                            isActive
                              ? isToggle
                                ? 'bg-success/15 text-success'
                                : 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                              : ''
                          }`}
                          title={
                            isToggle
                              ? `${t.label}: ${snappingEnabled ? 'on' : 'off'}`
                              : isStackButton
                                ? `${t.label}${
                                    t.key === 'undo'
                                      ? ` (${undoStack.length} available)`
                                      : ` (${redoStack.length} available)`
                                  }`
                                : t.label
                          }
                          aria-label={t.label}
                          aria-pressed={isActive}
                        >
                          <t.Icon className="h-5 w-5" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null}
              {/* Geometry-edit panel: when the user clicks an
                  existing feature for geometry editing, the pane
                  swaps to this view. Replaces the bottom-center
                  floating bar that used to host these controls.
                  The Create features section below is suppressed
                  during this state so the workflow is unambiguous:
                  finish or cancel the edit before starting
                  something new. The tools row stays visible so the
                  user can still toggle snap and use undo/redo
                  while editing. */}
              {pendingGeometryEdit ? (
                <section className="rounded-md border border-purple-300 dark:border-purple-800 bg-purple-50 dark:bg-purple-950 px-3 py-2 text-xs text-purple-900 dark:text-purple-200">
                  <div>
                    <p className="font-medium">
                      Editing{' '}
                      {targetByKey.get(pendingGeometryEdit.targetKey)?.layer
                        ?.label ?? 'feature'}{' '}
                      geometry
                    </p>
                    <p className="mt-0.5 text-[11px] text-purple-700 dark:text-purple-400">
                      {pendingGeometryEdit.geometryType === 'point'
                        ? 'Drag the point to move it.'
                        : 'Drag vertices to move them. Click midpoints to add a vertex. Alt-click a vertex to delete it.'}
                    </p>
                  </div>
                  {geomEditError ? (
                    <p
                      className="mt-1 text-[11px] text-danger"
                      role="alert"
                    >
                      {geomEditError}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={cancelGeometryEdit}
                      disabled={geomEditSaving}
                      className="inline-flex h-7 items-center rounded border border-border bg-white px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void switchToAttributeEdit()}
                      disabled={geomEditSaving}
                      className="inline-flex h-7 items-center rounded border border-purple-300 dark:border-purple-800 bg-white px-2 text-xs font-medium text-purple-900 dark:text-purple-200 hover:bg-purple-100 dark:hover:bg-purple-900 disabled:opacity-50"
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
                    {deletableTargetKeys.has(pendingGeometryEdit.targetKey) ? (
                      <button
                        type="button"
                        onClick={() => {
                          const target = targetByKey.get(
                            pendingGeometryEdit.targetKey,
                          );
                          const props = pendingGeometryEdit.properties;
                          let summary =
                            pendingGeometryEdit.featureId.slice(0, 8) + '...';
                          if (target?.layer) {
                            for (const f of target.layer.fields) {
                              const v = props[f.name];
                              if (v === null || v === undefined || v === '')
                                continue;
                              summary = String(v);
                              break;
                            }
                          }
                          const captureProps: Record<string, unknown> = {};
                          for (const [k, v] of Object.entries(props)) {
                            if (k.startsWith('_')) continue;
                            captureProps[k] = v;
                          }
                          setPendingDelete({
                            dataLayerId: pendingGeometryEdit.dataLayerId,
                            layerKey: pendingGeometryEdit.layerKey,
                            featureId: pendingGeometryEdit.featureId,
                            layerTitle: `${target?.dataLayerTitle ?? ''} / ${target?.layer?.label ?? pendingGeometryEdit.layerKey}`,
                            summary,
                            geometry: pendingGeometryEdit.originalGeometry,
                            properties: captureProps,
                          });
                          // Exit geometry-edit mode so the confirm
                          // dialog isn't competing with the panel.
                          setPendingGeometryEdit(null);
                        }}
                        disabled={geomEditSaving}
                        className="ml-auto inline-flex h-7 items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 text-xs font-medium text-danger hover:bg-danger/15 disabled:opacity-50"
                        title="Delete this feature"
                        aria-label="Delete this feature"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : activeTool === 'edit' ? (
                <section className="flex items-start gap-2 rounded-md border border-purple-300 dark:border-purple-800 bg-purple-50 dark:bg-purple-950 px-3 py-2 text-xs text-purple-900 dark:text-purple-200">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Edit mode</p>
                    <p className="mt-0.5">
                      Click a feature on the map to edit its geometry
                      or attributes.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTool('off');
                      setActiveTargetKey(null);
                      cancelGeometryEdit();
                    }}
                    className="shrink-0 rounded-md p-0.5 text-purple-900 dark:text-purple-200 hover:bg-purple-100 dark:hover:bg-purple-900"
                    aria-label="Exit edit mode"
                    title="Exit edit mode"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </section>
              ) : null}

              {/* Create features section (Phase B). Lists every
                  editor target the user can add to (canCreate +
                  resolved layer + non-null geometry type), grouped
                  by layer, with each per-target template rendered
                  as a clickable row. Clicking a template enters Add
                  mode pre-bound to that target and template; the
                  active row highlights so the user can see what is
                  about to drop on the next click. The first row in
                  each group is a "New feature" default that uses
                  the layer's plain geometry tool with no preset
                  attributes -- mirrors today's no-template flow.
                  Replaces the previous floating template tray; the
                  pane is the home for this surface now.

                  Hidden while a geometry edit is in flight so the
                  user isn't tempted to start a new feature mid-
                  edit and there's no ambiguity about which workflow
                  they're in. */}
              {pendingGeometryEdit ? null : eligibleAddTargets.length > 0 ? (
                <section>
                  <h3 className="mb-1.5 text-xs font-semibold text-ink-0">
                    Create features
                  </h3>
                  <div className="space-y-3">
                    {eligibleAddTargets.map((e) => {
                      const layerTitle =
                        e.resolved?.layer?.label ??
                        e.resolved?.dataLayerTitle ??
                        'Layer';
                      const dataLayerTitle = e.resolved?.dataLayerTitle;
                      const templates = e.editorTarget.templates ?? [];
                      const geomType =
                        e.resolved?.layer?.geometryType ?? 'point';
                      // The default "New feature" row inherits the
                      // layer's geometry type; templates can pick a
                      // different geometryTool, which is reflected
                      // by the per-template swatch.
                      return (
                        <div key={e.key}>
                          <p className="mb-1 text-[11px] font-medium text-muted">
                            {dataLayerTitle && dataLayerTitle !== layerTitle
                              ? `${dataLayerTitle} / ${layerTitle}`
                              : layerTitle}
                          </p>
                          <div className="space-y-0.5">
                            {(() => {
                              const isActive =
                                activeTool === 'add' &&
                                activeTargetKey === e.key &&
                                activeTemplateId === null;
                              return (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isActive) {
                                      // Toggle off if clicking the
                                      // already-active default row
                                      // again (lets the user back
                                      // out of Add mode without
                                      // hunting for a different
                                      // tool button).
                                      setActiveTool('off');
                                      setActiveTargetKey(null);
                                      setActiveTemplateId(null);
                                    } else {
                                      setActiveTool('add');
                                      setActiveTargetKey(e.key);
                                      setActiveTemplateId(null);
                                    }
                                  }}
                                  aria-pressed={isActive}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                                    isActive
                                      ? 'bg-purple-100 dark:bg-purple-950 text-purple-900 dark:text-purple-200'
                                      : 'text-ink-1 hover:bg-surface-2'
                                  }`}
                                >
                                  <span
                                    aria-hidden
                                    className={`inline-block h-3 w-3 shrink-0 border ${
                                      geomType === 'point'
                                        ? 'rounded-full border-ink-2 bg-purple-400'
                                        : geomType === 'line'
                                          ? 'h-[3px] rounded-sm border-ink-2 bg-purple-500'
                                          : 'rounded-sm border-ink-2 bg-purple-300'
                                    }`}
                                  />
                                  <span>New feature</span>
                                </button>
                              );
                            })()}
                            {templates.map((tpl) => {
                              const isActive =
                                activeTool === 'add' &&
                                activeTargetKey === e.key &&
                                activeTemplateId === tpl.id;
                              return (
                                <button
                                  key={tpl.id}
                                  type="button"
                                  onClick={() => {
                                    if (isActive) {
                                      setActiveTool('off');
                                      setActiveTargetKey(null);
                                      setActiveTemplateId(null);
                                    } else {
                                      setActiveTool('add');
                                      setActiveTargetKey(e.key);
                                      setActiveTemplateId(tpl.id);
                                    }
                                  }}
                                  aria-pressed={isActive}
                                  title={`${tpl.label} - ${tpl.geometryTool}`}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                                    isActive
                                      ? 'bg-purple-100 dark:bg-purple-950 text-purple-900 dark:text-purple-200'
                                      : 'text-ink-1 hover:bg-surface-2'
                                  }`}
                                >
                                  <span
                                    aria-hidden
                                    className={`inline-block h-3 w-3 shrink-0 border border-ink-2 ${
                                      tpl.geometryTool === 'point'
                                        ? 'rounded-full'
                                        : tpl.geometryTool === 'line'
                                          ? 'h-[3px] rounded-sm'
                                          : 'rounded-sm'
                                    }`}
                                    style={{
                                      backgroundColor:
                                        tpl.previewColor ?? '#a78bfa',
                                    }}
                                  />
                                  <span className="truncate">{tpl.label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <section className="rounded-md border border-dashed border-border bg-surface-0 px-3 py-4 text-xs text-muted">
                  No editable target layers configured. Open the
                  editor's Configure page to add one.
                </section>
              )}
              </div>
            )}
          </div>
        ) : null}

        {/* Measure pane. Right-docked, opens when activeTool ===
            'measure'. Replaces the wide floating chip that used to
            sit at top-left and overlap the search bar. Pane is
            available to viewers as well as editors (Measure is a
            read-side tool), so it's NOT gated on canEdit and lives
            as its own surface independent of the editor pane.
            z-30 sits above the editor pane (z-25) so the user can
            be on the editor and pop the Measure tool without
            having to close the editor pane first. */}
        {activeTool === 'measure' ? (
          <div
            className="absolute right-0 top-0 flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface-1 shadow-overlay"
            style={{ zIndex: 30 }}
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-1 px-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                Measure
              </span>
              <button
                type="button"
                onClick={exitMeasure}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0"
                aria-label="Exit measure"
                title="Exit measure"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
              {/* Mode toggle: Distance vs Area as a small icon row.
                  Switching clears the in-canvas sketch (the existing
                  switchMeasureMode does this) so the new mode starts
                  with no stale geometry. */}
              <div
                role="radiogroup"
                aria-label="Measure mode"
                className="inline-flex overflow-hidden rounded-md border border-border bg-surface-0"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={measureMode === 'distance'}
                  onClick={() => switchMeasureMode('distance')}
                  className={`inline-flex items-center gap-1 px-3 py-1 text-xs ${
                    measureMode === 'distance'
                      ? 'bg-purple-100 dark:bg-purple-950 text-purple-900 dark:text-purple-200'
                      : 'text-muted hover:bg-surface-2'
                  }`}
                  title="Distance"
                >
                  <Ruler className="h-3.5 w-3.5" />
                  Distance
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={measureMode === 'area'}
                  onClick={() => switchMeasureMode('area')}
                  className={`inline-flex items-center gap-1 border-l border-border px-3 py-1 text-xs ${
                    measureMode === 'area'
                      ? 'bg-purple-100 dark:bg-purple-950 text-purple-900 dark:text-purple-200'
                      : 'text-muted hover:bg-surface-2'
                  }`}
                  title="Area"
                >
                  <Pentagon className="h-3.5 w-3.5" />
                  Area
                </button>
              </div>

              {/* Unit picker. Distance / area lists differ by mode.
                  Defaults are imperial-friendly (mi / sq mi); the
                  user can flip and the readout re-formats live
                  without re-clicking on the map. */}
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-1">
                  Unit
                </label>
                {measureMode === 'distance' ? (
                  <select
                    value={measureDistanceUnit}
                    onChange={(e) =>
                      setMeasureDistanceUnit(e.target.value as DistanceUnit)
                    }
                    className="h-8 w-full rounded border border-border bg-surface-0 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
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
                    value={measureAreaUnit}
                    onChange={(e) =>
                      setMeasureAreaUnit(e.target.value as AreaUnit)
                    }
                    className="h-8 w-full rounded border border-border bg-surface-0 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  >
                    {(Object.keys(AREA_UNIT_LABELS) as AreaUnit[]).map((u) => (
                      <option key={u} value={u}>
                        {AREA_UNIT_LABELS[u]}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Live readout. Big enough to read at a glance; mono
                  font so digits line up while the user is dragging
                  vertices around. Empty placeholder before the user
                  has clicked on the map so the pane doesn't look
                  half-rendered. */}
              <div>
                <p className="mb-1 text-xs font-medium text-ink-1">
                  {measureMode === 'distance' ? 'Distance' : 'Area'}
                </p>
                <p className="font-mono text-base font-semibold text-ink-0">
                  {measureMode === 'distance'
                    ? measureLengthMeters !== null
                      ? formatLengthIn(
                          measureLengthMeters,
                          measureDistanceUnit,
                        )
                      : '—'
                    : measureAreaSqm !== null
                      ? formatAreaIn(measureAreaSqm, measureAreaUnit)
                      : '—'}
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  {measureMode === 'area'
                    ? 'Click to add vertices on the map. Double-click to finish.'
                    : 'Click to add points on the map. Double-click to finish.'}
                </p>
              </div>

              <button
                type="button"
                onClick={clearMeasurement}
                disabled={
                  measureLengthMeters === null && measureAreaSqm === null
                }
                className="inline-flex h-8 w-full items-center justify-center gap-1 rounded-md bg-purple-600 px-3 text-xs font-medium text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                New measurement
              </button>
            </div>
          </div>
        ) : null}

        <div className="relative min-w-0 flex-1">
          <MapCanvas
            ref={canvasRef}
            map={mapData}
            basemaps={basemaps}
            onCameraChange={(next) => {
              setMapData((cur) => ({ ...cur, ...next }));
              if (typeof next.zoom === 'number') setCurrentZoom(next.zoom);
            }}
            onViewportChange={setMapBbox}
            selection={selection}
            // #312: the Select tool now supports four modes (click,
            // rectangle, polygon, lasso). The toolbar's Select button
            // is a split control: tap to toggle on/off in the current
            // mode; chevron opens a dropdown to switch modes. We
            // pass selectMode through whenever activeTool === 'select';
            // otherwise 'off' so the canvas falls back to its normal
            // pan / popup behavior.
            selectTool={activeTool === 'select' ? selectMode : 'off'}
            // Suppress the canvas's default click-to-popup behavior
            // only while a tool that fully owns the click is active.
            // Measure uses terra-draw to place vertices, and add /
            // edit use clicks to start their own pane flows; popups
            // would compete. Select is the exception: it WANTS the
            // popup so the user gets feature info alongside the
            // selection highlight (AGOL-style Select / Identify
            // behavior). The MapCanvas 'click' branch falls through
            // to the popup logic so a single click both highlights
            // and pops.
            suppressPopup={
              activeTool === 'measure' ||
              activeTool === 'add' ||
              activeTool === 'edit'
            }
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

          {/* Active-mode status banners used to live here. Per user
              feedback (no floating windows for editor flows), the
              Add and Delete banners are gone -- the pane's
              highlighted Create-features template plus the
              crosshair cursor signal "armed" already, and
              click-to-delete is no longer surfaced. The Measure
              chip stays because Measure is a top-toolbar tool that
              works for viewers too, and the chip's distance/area
              toggle and live readout don't have an obvious pane
              home. */}
          {/* Measure tool used to live in a wide floating chip at
              top-left that overlapped the search bar and other map
              controls. Replaced by the right-docked Measure pane
              below the canvas div. */}

          {toast ? (
            <div className="pointer-events-auto absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 shadow-card">
              {toast}
            </div>
          ) : null}

          {/* Geometry-edit controls live inside the editor pane now
              (see the pane content above). The bottom-center
              floating bar was removed per user feedback. */}

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
            mapBbox={mapBbox}
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
            fieldsByLayer={inlineFieldsByLayer}
            pickLists={pickLists}
          />
        </div>
      </div>

      {/* Attribute form: previously a doc-root modal. Phase C moves
          it inside the editor pane (see the pane's content swap
          above). The pane is force-opened by an effect when
          pendingFeature flips on so the user always sees the form
          even if they had closed the pane earlier. */}

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

/**
 * One step in the editor runtime's in-session undo/redo stack
 * (#123). Each kind carries enough state to either undo (run the
 * inverse) or redo (re-apply). Stack is session-local; persistent
 * historical revert via the temporal model is a separate feature.
 *
 * `featureId` is always the row's global_id (uuid). For creates,
 * we generate the uuid client-side at submit time and pass it
 * through the v3 POST `globalId` field so undo can target it
 * directly. For deletes and updates, we capture the row's full
 * pre-mutation snapshot at the call site.
 */
type EditorOp =
  | {
      kind: 'create';
      dataLayerId: string;
      layerKey: string;
      featureId: string;
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
    }
  | {
      kind: 'update';
      dataLayerId: string;
      layerKey: string;
      featureId: string;
      previousGeometry: GeoJSON.Geometry | null;
      previousProperties: Record<string, unknown>;
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
    }
  | {
      kind: 'delete';
      dataLayerId: string;
      layerKey: string;
      featureId: string;
      geometry: GeoJSON.Geometry | null;
      properties: Record<string, unknown>;
    };

const TOOL_LABELS: Record<EditorTool, string> = {
  select: 'Select',
  add: 'Add',
  edit: 'Edit',
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
  { key: 'snap', label: 'Snap', Icon: Wand2 },
  { key: 'measure', label: 'Measure', Icon: Ruler },
  { key: 'undo', label: 'Undo', Icon: Undo2 },
  { key: 'redo', label: 'Redo', Icon: Redo2 },
];

/**
 * Single row of the Select-mode dropdown (#312). Mirrors the
 * MenuItem pattern used in the LayerPanel kebab. Highlights the
 * active mode in purple and dispatches the change up.
 */
function SelectModeItem({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof MousePointer2;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 ${
        active ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : 'text-ink-1'
      }`}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{label}</span>
      {active ? (
        <span className="text-[10px] uppercase tracking-wide">active</span>
      ) : null}
    </button>
  );
}
