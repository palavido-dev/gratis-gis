// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronUp,
  CircleSlash,
  CloudDownload,
  CloudOff,
  Compass,
  Crosshair,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  LocateFixed,
  MapPin,
  Minus,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import maplibregl from 'maplibre-gl';
import type {
  FeatureField,
  LayerGeometryType,
  MapData,
  MapLayer,
  MapLayerRenderer,
  PickListData,
} from '@gratis-gis/shared-types';
import {
  splitByPrefetchPolicy,
  stampSubmissionMetadata,
} from '@gratis-gis/shared-types';
import {
  generateFormFromLayer,
  type FormSchema,
  type Question,
  type Response as FormResponse,
} from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import {
  searchLayers,
  type SearchResult as MapSearchResult,
} from '../map/search-sources';
import { FormRuntime } from '@/components/form-runtime';
import { PwaInstallButton } from '@/components/pwa-install-button';
import {
  deleteDeployment,
  enqueueEdit,
  getDeployment,
  hashLayerSchema,
  listFeaturesForLayer,
  listPickListsForDeployment,
  listQueue,
  putFeatures,
  type CachedDeployment,
  type CachedFeature,
  type QueueRecord,
} from '@/lib/offline-store';
import { formatBytes } from '@/lib/format-bytes';
import {
  listRejected,
  newGlobalId,
  syncQueue,
  type SyncResult,
} from '@/lib/offline-sync';
import { RejectedEditsDialog } from './rejected-edits-dialog';
import {
  downloadDeployment,
  type DownloadLayer,
  type DownloadProgress,
} from '@/lib/offline-download';
import {
  checkDownloadFits,
  estimateStorage,
  isPersistent,
  requestPersistentStorage,
  type StorageEstimate,
} from '@/lib/offline-storage-quota';
import {
  clearTileCache,
  estimateTileCount,
  readTileCacheStats,
} from '@/lib/offline-tile-warmer';
import {
  postQueueManifest,
  postQueueManifestThrottled,
} from '@/lib/offline-queue-beacon';
import {
  useGeolocation,
  gpsAccuracyBand,
  type GpsPosition,
} from './use-geolocation';
import {
  useOfflineBasemap,
  type OfflineBasemapState,
} from './use-offline-basemap';
import { OfflineBasemapRow } from './offline-basemap-row';
import { createGpsMarker, type GpsMarkerHandle } from './gps-map-marker';
import { stampGpsMetadata } from './gps-metadata-stamp';
import { V3FeatureAttachments } from '../data-layer/v3-feature-attachments';
import { describeZoom } from '@/lib/map-scale';
import { parseApiError } from '@/lib/api-error';
import { useT } from '@/lib/i18n/locale-context';

/**
 * Per-layer descriptor the field runtime consumes. Server-built (see
 * field/page.tsx) so the client lands ready to render. boundFormItemId
 * is set when the data_collection has an explicit form binding for
 * this layer; otherwise the runtime falls through to schema-derived
 * forms via generateFormFromLayer (Slice 1).
 */
export interface EditableLayer {
  /** data_layer item id this sublayer belongs to. */
  dataLayerId: string;
  /** data_layer item title (shown in the layer picker as a parent label). */
  dataLayerTitle: string;
  /** v3 sublayer id; matches MapLayerSource.layerKey for the
   *  corresponding map layer. */
  layerKey: string;
  /** Sublayer label; the runtime's primary on-screen identifier. */
  layerLabel: string;
  /** Sublayer geometry type. null = table (no geometry). Spatial
   *  sublayers appear in the Add-feature picker and the layer panel;
   *  table sublayers are reachable as related-record targets from a
   *  parent feature's edit drawer (see childLayers below). */
  geometryType: LayerGeometryType;
  fields: FeatureField[];
  editingPolicy: 'all-rows' | 'own-rows-only';
  /**
   * Whether the runtime should offer this layer as an Add target.
   * Defaults to true. When false (the data_layer's sublayer.
   * editingEnabled is false, OR the map's per-layer "Editable in
   * field deployments" toggle is off), the layer is still kept in
   * editableLayers so the layer-visibility panel can find its
   * geometry type and surface a toggle row, but the Add picker
   * skips it. Lets a map include a layer for context without
   * inviting field collectors to author records into it.
   */
  addable?: boolean;
  /** Optional explicit form binding from the data_collection's
   *  formBindings map. When absent, an auto-form is generated. */
  boundFormItemId?: string;
  /** Phase C: child layers (within the same data_layer item) that
   *  reference this layer via parentFkColumn. Lets the FormModal
   *  surface "Add related" buttons in edit mode so a user can drop
   *  child records under the current feature without having to find
   *  the child layer in the picker. Only children whose layerKey
   *  also appears in editableLayers should get a wired Add button --
   *  others are visible as descriptive lines but Add is disabled. */
  childLayers?: Array<{
    layerKey: string;
    layerLabel: string;
    geometryType: LayerGeometryType;
    parentFkColumn: string;
  }>;
}

/**
 * #247 / #265 / #266: a row in a parent feature's related-records list.
 * Surfaced both from the FormModal (edit-mode parent) and from the
 * popup bottom sheet (#265). _pending=true when the row was sourced
 * from the offline queue; the renderer shows an "unsynced" badge so
 * the worker can tell their just-captured row apart.
 */
type RelatedFeature = {
  id: string;
  properties: Record<string, unknown>;
  geometry: GeoJSON.Geometry | null;
  _pending?: boolean;
};

type RelatedRowsState = {
  loading: boolean;
  error: string | null;
  rows: RelatedFeature[];
};

/**
 * #247 / #265 / #266: build a per-child-layer map of related-record
 * rows for a given parent feature. Online: fetch synced rows from
 * the API + merge pending-insert rows from the offline queue (those
 * land first in the rendered list, tagged _pending=true). Offline
 * or fetch failure: render only the pending rows. Returns a stable
 * empty map ({}) when there's no parent or no child layers, which
 * lets callers always render unconditionally.
 *
 * Used by FormModal (parent in edit mode) AND FieldFeaturePopupSheet
 * (#265: popup.showRelatedRecords). Both surfaces want exactly the
 * same data so the queue/sync logic stays in one place.
 */
function useRelatedRowsByChild(args: {
  parentDataLayerId: string | null;
  parentId: string | null;
  childLayers:
    | Array<{
        layerKey: string;
        layerLabel: string;
        geometryType: LayerGeometryType;
        parentFkColumn: string;
      }>
    | undefined;
  dataCollectionId: string;
  isOnline: boolean;
}): Record<string, RelatedRowsState> {
  const {
    parentDataLayerId,
    parentId,
    childLayers,
    dataCollectionId,
    isOnline,
  } = args;
  const [state, setState] = useState<Record<string, RelatedRowsState>>({});

  useEffect(() => {
    if (!parentId || !parentDataLayerId) return undefined;
    const children = childLayers ?? [];
    if (children.length === 0) return undefined;
    const ctrl = new AbortController();
    setState((prev) => {
      const next: Record<string, RelatedRowsState> = { ...prev };
      for (const c of children) {
        next[c.layerKey] = { loading: true, error: null, rows: [] };
      }
      return next;
    });

    const loadQueued = async (): Promise<Map<string, RelatedFeature[]>> => {
      const out = new Map<string, RelatedFeature[]>();
      try {
        const all = await listQueue(dataCollectionId);
        for (const c of children) {
          const matches: RelatedFeature[] = [];
          for (const q of all) {
            if (q.op !== 'insert') continue;
            if (q.syncStatus !== 'pending') continue;
            if (q.dataLayerId !== parentDataLayerId) continue;
            if (q.layerKey !== c.layerKey) continue;
            const props = (q.properties ?? {}) as Record<string, unknown>;
            if (props[c.parentFkColumn] !== parentId) continue;
            matches.push({
              id: q.globalId,
              properties: props,
              geometry: q.geometry ?? null,
              _pending: true,
            });
          }
          out.set(c.layerKey, matches);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[related] queue read failed:', err);
      }
      return out;
    };

    void (async () => {
      const queuedByLayer = await loadQueued();
      if (ctrl.signal.aborted) return;

      if (!isOnline) {
        setState((prev) => {
          const next: Record<string, RelatedRowsState> = { ...prev };
          for (const c of children) {
            next[c.layerKey] = {
              loading: false,
              error: null,
              rows: queuedByLayer.get(c.layerKey) ?? [],
            };
          }
          return next;
        });
        return;
      }

      await Promise.all(
        children.map(async (c) => {
          const queued = queuedByLayer.get(c.layerKey) ?? [];
          try {
            const url =
              `/api/portal/items/${parentDataLayerId}/layers/${c.layerKey}` +
              `/features?parentFk=${encodeURIComponent(c.parentFkColumn)}` +
              `&parentId=${encodeURIComponent(parentId)}`;
            const res = await fetch(url, {
              signal: ctrl.signal,
              headers: { Accept: 'application/json' },
            });
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            const json = (await res.json()) as {
              features?: Array<{
                id?: string;
                properties?: Record<string, unknown>;
                geometry?: GeoJSON.Geometry | null;
              }>;
            };
            const synced: RelatedFeature[] = (json.features ?? []).map(
              (f) => ({
                id: String(f.id ?? ''),
                properties: f.properties ?? {},
                geometry: f.geometry ?? null,
              }),
            );
            const syncedIds = new Set(synced.map((r) => r.id));
            const stillPending = queued.filter((q) => !syncedIds.has(q.id));
            const rows = [...stillPending, ...synced];
            setState((prev) => ({
              ...prev,
              [c.layerKey]: { loading: false, error: null, rows },
            }));
          } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') return;
            setState((prev) => ({
              ...prev,
              [c.layerKey]: {
                loading: false,
                error:
                  err instanceof Error ? err.message : 'Failed to load',
                rows: queued,
              },
            }));
          }
        }),
      );
    })();

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, parentDataLayerId, dataCollectionId, isOnline]);

  return state;
}

interface Props {
  dataCollectionId: string;
  title: string;
  mapData: MapData;
  mapTitle: string;
  basemaps: CustomBasemap[];
  editableLayers: EditableLayer[];
  pickLists: Record<string, PickListData>;
  /** Pre-fetched bound form schemas keyed by form item id. */
  boundForms: Record<string, FormSchema>;
  currentUserId: string;
}

/**
 * One row in the field-mode template picker. Field Maps' equivalent
 * of an "editing template" -- a (layer, symbology class) pair that
 * can be added with one tap, with the categorical attribute already
 * pre-filled. Derived from each editable layer's MapLayer renderer
 * at runtime:
 *
 *   - simple renderer    -> one template per layer, no preset
 *                            attributes (color from the simple style)
 *   - unique-values      -> one template per category, presetAttributes
 *                            sets the renderer's `field` to the
 *                            category's `value` so the form opens
 *                            with that field already populated
 *   - class-breaks       -> not yet templated; collapses to one
 *                            "Add to this layer" template (numeric
 *                            ranges aren't classifications you'd
 *                            pre-fill at create time)
 */
interface FieldTemplate {
  /** Stable id, unique within the runtime. Used as React key + as the
   *  active-template handle. */
  id: string;
  layer: EditableLayer;
  /** Display label: "<class>" for unique-values, "<layer label>" for
   *  simple. */
  label: string;
  /** Subtitle shown beneath the label: layer name for unique-values
   *  templates, or the data_layer title for simple ones. */
  sublabel: string;
  /** Color swatch matching how this class renders on the map. */
  color: string;
  /**
   * Attribute name -> value to pre-fill on add. Empty when the layer
   * uses a simple renderer; for unique-values, the renderer's `field`
   * is keyed to the category's value. The form modal merges these
   * into the FormRuntime's `initial` response.
   */
  presetAttributes: Record<string, string>;
}

/**
 * Field Maps Slice 3 runtime.
 *
 * Phone-friendly canvas around MapCanvas with the Field Maps drop-at-
 * crosshair workflow:
 *
 *   - The user taps "Add Feature" to open a template sheet listing
 *     every (editable layer, symbology class) pair derived from the
 *     bound map's renderers. Each row shows a colored swatch matching
 *     the layer's render style so the picker reads visually like the
 *     map itself.
 *   - Selecting a template arms add-mode: a centered crosshair
 *     reticle appears on the map, and the footer changes to show the
 *     chosen template plus an "Add at center" commit button. The
 *     user pans the map to position; "Add at center" drops a feature
 *     at the map's current center (or the GPS position, when
 *     available) and opens the form pre-filled with the template's
 *     presetAttributes.
 *   - Tapping an existing feature on an editable layer opens the
 *     form in edit mode regardless of armed state -- editing is
 *     always available; armed state only changes what tapping
 *     EMPTY map space does.
 *
 * Plus a session-local layer-visibility panel: collectors can toggle
 * layers off without modifying the bound map (toggles reset on next
 * deployment open, matching Field Maps' behaviour).
 *
 * Slice 2 (#193) shipped the canvas + form modal + tap-to-edit /
 * tap-to-add. Slice 3 (#195) replaces the dropdown picker with the
 * symbology-driven template sheet, switches the gesture to drop-at-
 * crosshair, and adds the layer toggle. Offline / sync remain Slice
 * 4-5 territory; line + polygon draw still need a multi-step gesture
 * and ride along with terra-draw integration.
 */
export function FieldRuntime({
  dataCollectionId,
  title,
  mapData,
  mapTitle,
  basemaps,
  editableLayers,
  pickLists,
  boundForms,
  currentUserId,
}: Props) {
  // Where the back arrow goes. Defaults to the deployment's item
  // detail page (admin / desktop flow); when the user came from the
  // /field catalog, we honor that with ?from=field on the deep link.
  // Persisted to sessionStorage so subsequent in-app nav within the
  // runtime (e.g. Add Layer dialog reopening this page) keeps the
  // mobile-correct destination instead of falling back to item-
  // detail. Cleared on next visit when ?from is absent.
  const searchParams = useSearchParams();
  const backHref = useMemo(() => {
    if (typeof window === 'undefined') return `/items/${dataCollectionId}`;
    const fromParam = searchParams?.get('from');
    const key = `gratis:field:back:${dataCollectionId}`;
    if (fromParam === 'field') {
      try {
        window.sessionStorage.setItem(key, '/field');
      } catch {
        /* private browsing etc -- best effort */
      }
      return '/field';
    }
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    return `/items/${dataCollectionId}`;
  }, [dataCollectionId, searchParams]);

  // The active template: which (layer, symbology class) pair is armed
  // for add-mode. null = no armed template (the user hasn't picked
  // anything from the picker yet, or just cancelled).
  const [activeTemplate, setActiveTemplate] = useState<FieldTemplate | null>(
    null,
  );

  // Whether the template-picker bottom sheet is open. Separate state
  // from `activeTemplate` so the user can re-open the sheet to swap
  // their armed selection without having to "cancel" first.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Layer-toggle panel state. Visibility overrides keyed by MapLayer.id
  // (NOT the v3 sublayer key). Session-local: toggling a layer off
  // hides it for this open of the deployment but doesn't touch the
  // bound map item. Reopening the deployment shows the original
  // visibility from MapData. Matches Field Maps.
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  const [hiddenLayerIds, setHiddenLayerIds] = useState<Set<string>>(
    () => new Set(),
  );
  // #249.11: address search collapses to a single icon by default.
  // Per-request: search isn't used often enough to justify the persistent
  // bar at the top of the canvas, and on iPhone it overlapped MapLibre's
  // top-right zoom controls. Tapping the magnifier expands an input;
  // tapping the X collapses it again.
  const [searchExpanded, setSearchExpanded] = useState(false);

  // #249.16 / #253: Field-Maps-style feature popup state. Tapping a
  // feature on the map surfaces a bottom sheet (instead of a
  // MapLibre canvas popup). Two modes:
  //   - 'list': the user tapped a point with multiple overlapping
  //     features; show one row per feature with the layer label,
  //     a swatch, and the row title. Tap a row to drill into detail.
  //   - 'detail': single feature view: title, full attribute table,
  //     and Edit / Copy / More action buttons.
  // The sheet is also expandable from default (~55vh) to fullscreen
  // (~92vh) so a long attribute list can spread out without leaving
  // the sheet.
  type FeatureSheetHit = {
    /** MapLayer id that produced this hit. */
    mapLayerId: string;
    /** Layer label rendered in the sheet header / list row. */
    layerLabel: string;
    /** global_id of the feature, if available -- needed for Edit. */
    globalId: string | null;
    /** Properties exposed to the user (underscore-prefixed system
     *  metadata is stripped). */
    properties: Record<string, unknown>;
    /** Raw geometry as MapLibre returned it. */
    geometry: GeoJSON.Geometry | null;
    /** Editable layer if the user has edit access; null otherwise. */
    editable: EditableLayer | null;
  };
  type FeatureSheetState =
    | null
    | { mode: 'list'; hits: FeatureSheetHit[]; expanded: boolean }
    | {
        mode: 'detail';
        hit: FeatureSheetHit;
        from: 'list' | 'direct';
        listHits: FeatureSheetHit[];
        expanded: boolean;
      };
  const [featureSheet, setFeatureSheet] = useState<FeatureSheetState>(null);

  // Form modal state. mode='add' starts with the template's
  // presetAttributes plus a geometry stamped from the map center;
  // mode='edit' pre-fills from the tapped feature's properties.
  const [formModal, setFormModal] = useState<
    | null
    | {
        layer: EditableLayer;
        mode: 'add';
        geometry: GeoJSON.Geometry | null;
        presetAttributes: Record<string, string>;
      }
    | {
        layer: EditableLayer;
        mode: 'edit';
        featureId: string;
        properties: Record<string, unknown>;
        geometry: GeoJSON.Geometry | null;
      }
  >(null);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // GPS state (Phase A). Hook owns the watch lifecycle and follow-mode
  // toggle; marker handle paints the dot + accuracy ring on the map and
  // is created on first map-ready. The two are intentionally
  // decoupled: the hook updates the marker only when the map has
  // mounted (the GPS dot doesn't need to render before the map does).
  const gps = useGeolocation();
  const gpsMarkerRef = useRef<GpsMarkerHandle | null>(null);
  // Temporary preview marker shown while the add-form is open. Held
  // by ref (not state) so we don't re-render the whole canvas when
  // the marker comes and goes; maplibre's Marker primitive plants
  // an HTML node directly. Cleared on form close (cancel OR save).
  const pendingMarkerRef = useRef<maplibregl.Marker | null>(null);

  const clearPendingMarker = useCallback(() => {
    if (pendingMarkerRef.current) {
      pendingMarkerRef.current.remove();
      pendingMarkerRef.current = null;
    }
  }, []);

  // #273: line/polygon vertex collection state. While the user is
  // drawing a multi-vertex feature, vertices accumulate here and a
  // live preview line / ring renders on the map. Empty array means
  // we're not in vertex-collection mode (the active template is a
  // point template, OR no template is armed).
  const [pendingVertices, setPendingVertices] = useState<
    Array<[number, number]>
  >([]);
  // Per-vertex MapLibre Markers so each tap leaves a visible dot at
  // its actual position. Held by ref so React doesn't churn on
  // every push; the UI vertex count reads from `pendingVertices`.
  const vertexMarkersRef = useRef<maplibregl.Marker[]>([]);
  // GeoJSON source id used by the live preview line / ring. The
  // source is added lazily on the first vertex push (we can't add
  // it before the map is ready) and removed on cancel / finish.
  const PENDING_GEOM_SRC = 'gratis-pending-geom';
  const PENDING_GEOM_LINE_LAYER = 'gratis-pending-geom-line';
  const PENDING_GEOM_FILL_LAYER = 'gratis-pending-geom-fill';

  /**
   * Clear every vertex marker, the preview source/layers, and the
   * accumulated coordinates. Used by Cancel and after a successful
   * Finish.
   */
  const clearVertices = useCallback(() => {
    for (const m of vertexMarkersRef.current) {
      try {
        m.remove();
      } catch {
        /* maplibre is forgiving here; ignore */
      }
    }
    vertexMarkersRef.current = [];
    const map = mapRef.current;
    if (map) {
      try {
        if (map.getLayer(PENDING_GEOM_FILL_LAYER)) {
          map.removeLayer(PENDING_GEOM_FILL_LAYER);
        }
        if (map.getLayer(PENDING_GEOM_LINE_LAYER)) {
          map.removeLayer(PENDING_GEOM_LINE_LAYER);
        }
        if (map.getSource(PENDING_GEOM_SRC)) {
          map.removeSource(PENDING_GEOM_SRC);
        }
      } catch {
        /* style may be in flight on basemap swap; safe to skip */
      }
    }
    setPendingVertices([]);
  }, []);

  /**
   * Update (or create) the live preview line/ring on the map from
   * the current vertex array + the in-progress template. Called on
   * each push / undo so the worker sees what they're drawing as
   * they tap.
   *
   * The source always carries a Polygon feature (with a closed ring)
   * for polygon templates and a LineString for line templates.
   * Both layer types tolerate sparse vertex counts (an open
   * 2-vertex polygon ring still renders as a triangle stub once we
   * close it). Below 2 vertices we tear the source down -- a single
   * marker is enough visual context.
   */
  const refreshPreviewGeom = useCallback(
    (verts: Array<[number, number]>, color: string, isPolygon: boolean) => {
      const map = mapRef.current;
      if (!map) return;
      const tearDown = () => {
        try {
          if (map.getLayer(PENDING_GEOM_FILL_LAYER)) {
            map.removeLayer(PENDING_GEOM_FILL_LAYER);
          }
          if (map.getLayer(PENDING_GEOM_LINE_LAYER)) {
            map.removeLayer(PENDING_GEOM_LINE_LAYER);
          }
          if (map.getSource(PENDING_GEOM_SRC)) {
            map.removeSource(PENDING_GEOM_SRC);
          }
        } catch {
          /* style may be in flight on basemap swap; safe to skip */
        }
      };
      if (verts.length < 2) {
        tearDown();
        return;
      }
      const data: GeoJSON.Feature = isPolygon
        ? {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [[...verts, verts[0]!]],
            },
          }
        : {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: verts,
            },
          };
      const existing = map.getSource(PENDING_GEOM_SRC) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (existing) {
        existing.setData(data);
        return;
      }
      map.addSource(PENDING_GEOM_SRC, { type: 'geojson', data });
      if (isPolygon) {
        // Translucent fill underneath the dashed line so the
        // worker sees the area they're enclosing. Light enough
        // that the basemap stays legible.
        map.addLayer({
          id: PENDING_GEOM_FILL_LAYER,
          type: 'fill',
          source: PENDING_GEOM_SRC,
          paint: {
            'fill-color': color,
            'fill-opacity': 0.15,
          },
        });
      }
      map.addLayer({
        id: PENDING_GEOM_LINE_LAYER,
        type: 'line',
        source: PENDING_GEOM_SRC,
        paint: {
          'line-color': color,
          'line-width': 3,
          'line-dasharray': [2, 1.5],
        },
      });
    },
    [],
  );

  // Online/offline detection. navigator.onLine is the simplest
  // signal; combined with online/offline events it covers the
  // typical "connection dropped" path. We default to online during
  // SSR-fallback (typeof navigator !== 'undefined' check), then
  // re-evaluate on mount.
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setIsOnline(navigator.onLine);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Tier 4 beacon: post a queue manifest on mount so the admin view
  // sees a fresh row every time a worker opens the runtime. The
  // helper is throttled internally; subsequent calls (after sync, on
  // online-flip) won't double-post inside the same window. See
  // docs/field-offline-areas.md.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!navigator.onLine) return;
    void postQueueManifestThrottled();
  }, []);

  // Cached-deployment manifest. Loaded once on mount; refreshed
  // after a successful download. Drives the "cached on <date>" pill
  // and the offline-data substitution path below.
  const [cachedDeployment, setCachedDeployment] =
    useState<CachedDeployment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await getDeployment(dataCollectionId);
        if (!cancelled) setCachedDeployment(d);
      } catch {
        /* IndexedDB unavailable (private mode + Safari pre-15.4):
           swallow; the runtime stays online-only without surfacing
           an error. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataCollectionId]);

  // Offline feature substitution. When the user is offline AND we
  // have a cached manifest, swap each editable data-layer source
  // for an inline GeoJSON FeatureCollection sourced from IndexedDB.
  // MapCanvas already handles `geojson-inline` natively, so the
  // canvas renders cached features without any service-worker
  // interception path. Loaded asynchronously per layer; results
  // are keyed by `<itemId>:<layerKey>`.
  const [offlineFeatures, setOfflineFeatures] = useState<
    Record<string, GeoJSON.FeatureCollection>
  >({});
  // Slice 5 state: declared early so the offlineFeatures useEffect
  // can list it as a dep (and re-read after offline writes / sync).
  // The runSync callback + auto-sync effect that consume these live
  // further down with the other Slice 5 logic.
  const [offlineWriteCounter, setOfflineWriteCounter] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  // Rows the server refused deterministically. Not part of queueCount:
  // the sync chip promises "tap to send", and these will not send.
  const [rejectedRecords, setRejectedRecords] = useState<QueueRecord[]>([]);
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);
  useEffect(() => {
    if (isOnline || !cachedDeployment) {
      // Online: don't bother loading inline data. The MapCanvas
      // will keep fetching the URL-backed source.
      setOfflineFeatures({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: Record<string, GeoJSON.FeatureCollection> = {};
      for (const layer of editableLayers) {
        try {
          const features = await listFeaturesForLayer(
            dataCollectionId,
            layer.dataLayerId,
            layer.layerKey,
          );
          out[`${layer.dataLayerId}:${layer.layerKey}`] = {
            type: 'FeatureCollection',
            features,
          };
        } catch {
          /* missing per-layer cache: leave undefined; MapCanvas
             will render an empty source for that layer offline */
        }
      }
      if (!cancelled) setOfflineFeatures(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isOnline,
    cachedDeployment,
    editableLayers,
    dataCollectionId,
    // Slice 5: re-read after every offline write so the new / updated
    // feature appears on the map without a manual reload. Same dep
    // shape works for sync completion (the runner bumps the counter).
    offlineWriteCounter,
  ]);

  // Field-mode basemap override (#223.8). Per-session selection
  // surfaced via the layer list's basemap chip. null = honor the
  // map item's authored basemap; otherwise the override id wins
  // and effectiveMapData injects it at render time. Resets on
  // navigation away (state lives on the runtime), so a new field
  // session falls back to the authored basemap until the user
  // picks one again.
  const [basemapOverrideId, setBasemapOverrideId] = useState<string | null>(
    null,
  );

  // Effective MapData: visibility overrides + offline source
  // substitution + per-session basemap swap. Each transform composes:
  // visibility (off when hiddenLayerIds includes the layer),
  // offline substitution (when offline + cached + the source has an
  // inline FC available), and basemap (when the user has picked one
  // via the layer panel chip).
  const effectiveMapData = useMemo<MapData>(() => {
    const offlineActive = !isOnline && Object.keys(offlineFeatures).length > 0;
    const basemapOverride =
      basemapOverrideId && basemapOverrideId !== mapData.basemap
        ? basemapOverrideId
        : null;
    if (hiddenLayerIds.size === 0 && !offlineActive && !basemapOverride) {
      return mapData;
    }
    return {
      ...mapData,
      ...(basemapOverride ? { basemap: basemapOverride } : {}),
      layers: mapData.layers.map((l) => {
        let next: MapLayer = l;
        if (hiddenLayerIds.has(l.id)) {
          next = { ...next, visible: false };
        }
        if (offlineActive && next.source?.kind === 'data-layer') {
          const key = `${next.source.itemId}:${next.source.layerKey ?? ''}`;
          // Try with an empty layerKey first (legacy v1/v2), then
          // with the layerKey when present.
          const fc =
            offlineFeatures[`${next.source.itemId}:${next.source.layerKey ?? ''}`] ??
            (next.source.layerKey
              ? offlineFeatures[`${next.source.itemId}:${next.source.layerKey}`]
              : undefined);
          if (fc) {
            next = {
              ...next,
              source: { kind: 'geojson-inline', geojson: fc },
            };
          }
          // If no cached FC, fall through to the original source.
          // It'll fail to fetch offline, but MapCanvas tolerates
          // that (empty source) and the user sees an empty layer
          // rather than a broken canvas.
          void key;
        }
        return next;
      }),
    };
  }, [mapData, hiddenLayerIds, isOnline, offlineFeatures, basemapOverrideId]);

  // Effective pickLists. When offline, pick from IndexedDB instead of
  // the prop so newly-added pick lists from the download cache work.
  const [offlinePickLists, setOfflinePickLists] =
    useState<Record<string, PickListData>>({});
  useEffect(() => {
    if (isOnline || !cachedDeployment) {
      setOfflinePickLists({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const cached = await listPickListsForDeployment(dataCollectionId);
        if (!cancelled) setOfflinePickLists(cached);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline, cachedDeployment, dataCollectionId]);
  const effectivePickLists = useMemo(
    () => (isOnline ? pickLists : { ...pickLists, ...offlinePickLists }),
    [isOnline, pickLists, offlinePickLists],
  );

  // Download flow state. Null = no active download; non-null = in
  // progress. The progress object is rendered in a small modal so
  // the user sees per-layer status as the run completes.
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);

  // Slice 5 (queue + sync; see docs/field-offline-recovery.md).
  // State declarations are higher up next to offlineFeatures so the
  // useEffect there can include them as deps. The pieces below own
  // the runner + auto-sync wiring.
  // Throttle handle so back-to-back online/offline flips (Wi-Fi
  // flapping while a worker walks past a building corner) don't
  // schedule N parallel syncs.
  const lastSyncAttemptRef = useRef<number>(0);

  // Refresh the queue count whenever something might have changed it:
  // an offline write added a record, a sync run drained records, the
  // user re-opened the page after an offline session. Polling the
  // queue store on these dep changes is cheap (the read is keyed by
  // deployment) and avoids a separate event bus.
  useEffect(() => {
    void (async () => {
      const records = await listQueue(dataCollectionId);
      setQueueCount(records.filter((r) => r.syncStatus !== 'rejected').length);
      setRejectedRecords(await listRejected(dataCollectionId));
    })();
  }, [dataCollectionId, offlineWriteCounter, lastSyncResult]);

  // The actual sync runner. Wrapped in a callback so both the
  // online-flip auto-trigger and the manual button share the same
  // path (and so the throttle ref is honoured uniformly).
  const runSync = useCallback(
    async (reason: 'auto' | 'manual') => {
      // 5-second throttle: the network can flap on/off many times in
      // quick succession at the edge of coverage. We don't want to
      // start a fresh sync each flip; the second flip's records will
      // be picked up by the running sync's queue read.
      const now = Date.now();
      if (reason === 'auto' && now - lastSyncAttemptRef.current < 5000) {
        return;
      }
      lastSyncAttemptRef.current = now;
      setSyncing(true);
      try {
        const result = await syncQueue(dataCollectionId);
        setLastSyncResult(result);
        // After a successful sync the live API reflects the queued
        // edits; refresh every editable layer's source so the user
        // sees the post-sync state on the map. Skip when offline (the
        // refresh would 500). The bump to offlineWriteCounter also
        // forces the cached-features read to re-run, which keeps the
        // offline GeoJSON path consistent if the user goes back
        // offline immediately after.
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          for (const ml of mapData.layers ?? []) {
            const source = ml.source;
            if (source?.kind !== 'data-layer') continue;
            canvasRef.current?.refreshLayerSource(ml.id);
          }
        }
        setOfflineWriteCounter((n) => n + 1);
        // Beacon after every sync run so the admin view's row
        // reflects the post-sync queue depth (often zero, which is
        // exactly the signal admins want to see). Throttled, so the
        // mount-time + sync-time + online-flip beacons coalesce.
        void postQueueManifestThrottled();
      } finally {
        setSyncing(false);
      }
    },
    [dataCollectionId, mapData.layers],
  );

  // Auto-sync when isOnline flips from false -> true. Captured via a
  // ref so we don't fire on the initial mount when isOnline starts
  // true and there's nothing queued (the queue read is cheap but
  // pointless).
  const wasOnlineRef = useRef(isOnline);
  useEffect(() => {
    if (!wasOnlineRef.current && isOnline) {
      void runSync('auto');
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline, runSync]);

  // Slice 6 (persistence floor; see docs/field-offline-areas.md):
  // surface whether the browser will keep our IndexedDB across
  // disk-pressure events, and how much storage we're using vs the
  // origin's quota. Both are read on mount and refreshed whenever
  // the cached deployment changes (downloads + cache writes shift
  // usage). The persistence prompt itself fires inside startDownload
  // so the user sees it as a follow-up to the click, not a cold
  // landing ambush.
  const [persistentState, setPersistentState] = useState<
    'unknown' | 'persistent' | 'best-effort'
  >('unknown');
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const t = useT();
  // Lets the user stop a download. Held in a ref rather than state
  // because the modal's Cancel needs the CURRENT controller, and a
  // state update would hand it whichever one the closure captured.
  const downloadAbortRef = useRef<AbortController | null>(null);
  // #71: prepared offline basemaps for this deployment. Held at this
  // level because two places need it: the layer panel renders the
  // download row, and MapCanvas takes the resulting style.
  const offlineBasemap = useOfflineBasemap(dataCollectionId);
  // Mirrored into a ref, and startDownload reads the ref rather than
  // the value it captured. The dep array below lists this too, but
  // belt and braces on purpose: the areas arrive from the network
  // after first render, so a callback memoized without them warms a
  // million tiles instead of fetching one file, and the two download
  // buttons then disagree depending on which the user pressed first.
  // A future edit that trims the dep array must not be able to bring
  // that back.
  const offlineBasemapRef = useRef(offlineBasemap);
  offlineBasemapRef.current = offlineBasemap;
  // Slice 10 polish: tile-cache breakdown surfaced separately from
  // total IndexedDB usage so a user can answer "what's eating my
  // quota" without guessing. Null = no SW (dev mode, browsers
  // without SW support); the panel hides the row in that case.
  const [tileCache, setTileCache] = useState<{
    count: number;
    bytes: number;
  } | null>(null);
  // #272: per-download tile zoom range. Defaults to the global
  // [12, 19] from the offline-tile-warmer (the deepest most
  // basemap providers serve), but the layer panel exposes a
  // pair of pickers so a worker can shrink to [12, 17] for a
  // faster smaller cache or push to [12, 22] when their basemap
  // supports it. Persisted as session state -- the next visit to
  // this deployment defaults back to [12, 19] until the user
  // adjusts again.
  const [tileZoomMin, setTileZoomMin] = useState<number>(12);
  const [tileZoomMax, setTileZoomMax] = useState<number>(19);
  useEffect(() => {
    void (async () => {
      const [persisted, est, tiles] = await Promise.all([
        isPersistent(),
        estimateStorage(),
        readTileCacheStats(),
      ]);
      setPersistentState(persisted ? 'persistent' : 'best-effort');
      setStorage(est);
      setTileCache(tiles);
    })();
  }, [cachedDeployment]);

  // Refresh tile-cache stats on demand (after download, after
  // clear). Wrapped as a callback so the LayerVisibilityPanel can
  // call it from its "Clear tiles" affordance.
  const refreshTileCacheStats = useCallback(async () => {
    const tiles = await readTileCacheStats();
    setTileCache(tiles);
    const est = await estimateStorage();
    setStorage(est);
  }, []);

  const startDownload = useCallback(async () => {
    if (downloadProgress?.phase && downloadProgress.phase !== 'done' &&
        downloadProgress.phase !== 'failed') {
      return; // already running
    }
    // Slice 6 step 1: ask the browser to mark our origin's storage
    // as "important" before any bytes land in IndexedDB. The prompt
    // reads as natural follow-up to the user's Download click; if
    // they deny, the download still proceeds, just with reduced
    // resilience. Sets persistentState immediately so the badge in
    // the header reflects the user's choice without a refresh.
    const persistResult = await requestPersistentStorage();
    setPersistentState(persistResult.persistent ? 'persistent' : 'best-effort');

    // Slice 6 step 2: pre-flight quota check. The download manager's
    // estimate is rough (layers * 50 features * ~800 bytes) but
    // close enough to detect cases where the user is about to
    // start a download that has no chance of completing. We reuse
    // that estimate here -- duplicating the math would risk drift.
    const roughEstimate =
      editableLayers.length * 50 * 800 + 5 * 1024 * 1024; // + 5MB headroom for forms+pick-lists
    const quota = await checkDownloadFits(roughEstimate);
    if (!quota.fits) {
      setDownloadProgress({
        phase: 'failed',
        message: 'Not enough storage for this download',
        estimatedSize: quota.estimatedDownloadBytes,
        layerCount: editableLayers.length,
        featuresFetched: 0,
        formsFetched: 0,
        pickListsFetched: 0,
        tilesFetched: 0,
        tilesTotal: 0,
        error: `Need ~${formatBytes(quota.shortfallBytes)} more space. Free up cached deployments or device storage and try again.`,
      });
      return;
    }
    // Refresh the persisted storage gauge so the LayerVisibilityPanel
    // reflects the post-prompt state immediately.
    void estimateStorage().then(setStorage);

    // Collect every pick-list id the deployment will need offline.
    // Two surfaces reference picklists, and we have to walk both:
    //
    //   1. Layer field domains: a feature field with a coded-value-
    //      ref domain points at a pick_list item id directly. The
    //      auto-generated form path consumes this when no bound
    //      form is configured.
    //   2. Bound form questions: a select-one question can carry
    //      its own pickListId (form-schema/index.ts), which the
    //      bound form designer may set independently of the layer
    //      field's domain. Skipping this surface is what made the
    //      first offline download report 0 picklists when the
    //      bound form actually referenced one.
    //
    // De-duped by the Set; downloadDeployment fetches each id once.
    const pickListIdSet = new Set<string>();
    for (const l of editableLayers) {
      for (const f of l.fields) {
        if (f.domain && f.domain.type === 'coded-value-ref') {
          pickListIdSet.add(f.domain.pickListItemId);
        }
      }
    }
    // Walk every bound form's questions for question-level
    // pickListId references. The form schema is a tree of
    // questions / groups / repeats so we recurse with a stack.
    const formStack: unknown[] = Object.values(boundForms);
    while (formStack.length > 0) {
      const node = formStack.pop();
      if (!node || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;
      // QuestionBase has pickListId on select-one / select-many.
      // Group / repeat nodes don't, but we still recurse into
      // their .questions array.
      if (typeof obj.pickListId === 'string' && obj.pickListId.length > 0) {
        pickListIdSet.add(obj.pickListId);
      }
      const children = obj.questions;
      if (Array.isArray(children)) {
        for (const c of children) formStack.push(c);
      }
    }
    const downloadLayers: DownloadLayer[] = editableLayers.map((l) => {
      const out: DownloadLayer = {
        dataLayerId: l.dataLayerId,
        layerKey: l.layerKey,
        layerLabel: l.layerLabel,
        fields: l.fields,
      };
      if (l.boundFormItemId) out.boundFormItemId = l.boundFormItemId;
      return out;
    });
    // Slice 10: collect tile URL templates from the currently
    // rendered basemap and any raster/vector overlay sources. Read
    // them off the live MapLibre style rather than parsing the
    // basemap config -- that way we cover whatever basemap variant,
    // provider, or proxy URL is actually in use, including stuff
    // we'll add later (vector tile sources, ArcGIS rest tile URLs).
    // Bbox: use the current viewport for v1. The cached deployment
    // bbox would be more durable, but field workers download for
    // "where I am right now," which the viewport captures naturally.
    const tileUrlTemplates = collectTileTemplates(mapRef.current);
    const viewportBbox = mapRef.current
      ? (() => {
          const b = mapRef.current.getBounds();
          return [
            b.getWest(),
            b.getSouth(),
            b.getEast(),
            b.getNorth(),
          ] as [number, number, number, number];
        })()
      : undefined;
    // #71: prepared areas beat warming tiles. The author declared
    // where the crews work; that is a better answer than the
    // viewport, and it is a handful of single-file downloads instead
    // of a million tile fetches. ALL ready areas download, so a
    // deployment split into crew areas works from either end.
    const preparedAreas = offlineBasemapRef.current.areas.filter(
      (a) => a.current,
    );
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const manifest = await downloadDeployment(
        {
          dataCollectionId,
          title,
          mapId: '', // will be set by the caller of FieldRuntime in a future pass; not load-bearing
          layers: downloadLayers,
          pickListIds: Array.from(pickListIdSet),
          ...(viewportBbox !== undefined ? { bbox: viewportBbox } : {}),
          ...(preparedAreas.length > 0
            ? {
                preparedPackages: preparedAreas.map((a) => ({
                  areaId: a.area.id,
                  packageId: a.current!.id,
                })),
              }
            : {}),
          ...(preparedAreas.length === 0 && tileUrlTemplates.length > 0
            ? {
                tileUrlTemplates,
                // #272: user-chosen range from the layer-panel
                // pickers. Defaults to [12, 19] (deepest most
                // basemap providers serve), shrinkable for a
                // smaller/faster cache, or expandable up to z22
                // when the basemap supports it. The warmer's
                // DEFAULT_MAX_TILES (200k) is still the hard
                // ceiling -- the live tile-count estimate next to
                // the picker tells the worker if they're about to
                // hit it.
                tileZoomRange: [tileZoomMin, tileZoomMax] as [
                  number,
                  number,
                ],
              }
            : {}),
        },
        (p) => setDownloadProgress({ ...p }),
        controller.signal,
      );
      setCachedDeployment(manifest);
      // The archive just landed; re-read it so the map swaps to the
      // local copy without the collector having to reload.
      if (preparedAreas.length > 0) await offlineBasemapRef.current.reload();
      // Tile-cache stats jumped during the warm phase; refresh so
      // the panel's "Map tiles: X (Y MB)" line catches up without
      // forcing the user to reopen the layer panel.
      void refreshTileCacheStats();
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError');
      setDownloadProgress({
        // A cancel is a completed action, not a failure. Reporting
        // it as one leaves the user wondering what broke and whether
        // the data they already have is trustworthy.
        phase: aborted ? 'done' : 'failed',
        message: aborted
          ? t('offlineBasemap.downloadStopped')
          : 'Download failed',
        estimatedSize: 0,
        layerCount: editableLayers.length,
        featuresFetched: 0,
        formsFetched: 0,
        pickListsFetched: 0,
        tilesFetched: 0,
        tilesTotal: 0,
        ...(aborted
          ? {}
          : { error: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      downloadAbortRef.current = null;
    }
    // `boundForms` and the zoom pickers were already missing here,
    // and #71 added a third omission that made the bug visible: the
    // prepared areas. A memoized callback keeps whatever it captured
    // until a listed dep changes, so this one held an empty area list
    // and warmed tiles, then silently started working after some
    // unrelated `downloadProgress` change happened to rebuild it.
    // The same button did different things depending on what the
    // user had tapped earlier, which is the worst kind of bug to be
    // told about, because neither report is wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    downloadProgress,
    editableLayers,
    dataCollectionId,
    title,
    offlineBasemap.areas,
    offlineBasemap.reload,
    boundForms,
    tileZoomMin,
    tileZoomMax,
  ]);

  // Remove this deployment from the device. Cascades through every
  // IDB store keyed on dataCollectionId (features, queue, forms,
  // pick lists, manifest), AND clears the tile cache (#270).
  //
  // The original design left the tile cache alone on remove because
  // it's a shared origin-wide cache and other deployments may still
  // need those tiles. In practice that means a worker who removes a
  // city-scale offline area and downloads a smaller one keeps paying
  // for the old area's tiles forever -- the storage gauge never goes
  // down even though the IDB rows are gone. For a small org with one
  // or two active deployments at a time, clearing the tile cache on
  // remove is the right tradeoff: a tiny re-download cost on the
  // next download in exchange for honest storage accounting and
  // actually reclaiming the bytes the user just asked us to free.
  // The user is sent back to /field afterwards so the catalog
  // reflects the new state.
  const removeCache = useCallback(async () => {
    try {
      await deleteDeployment(dataCollectionId);
      setCachedDeployment(null);
      // Clear the SW tile cache too so the storage gauge reflects
      // the removal. Best-effort: a failure here doesn't block the
      // remove (the IDB rows are gone regardless).
      try {
        await clearTileCache();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Tile cache clear failed during remove:', err);
      }
      // Beacon the now-empty manifest so the admin's field-queues
      // view stops showing this deployment as cached. Bypasses the
      // throttle because this is a meaningful state change, not the
      // periodic chatter the throttle exists to dampen.
      void postQueueManifest();
    } catch (err) {
      // Swallow + log: deletion failures are rare (IDB transaction
      // race) and a retry from the user's next tap usually succeeds.
      // eslint-disable-next-line no-console
      console.error('Failed to remove offline cache:', err);
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.assign('/field');
    }
  }, [dataCollectionId]);

  // Templates: one row per (editable layer, symbology class) pair.
  // Computed once unless the source data changes; stable React keys
  // come from `template.id`.
  const templates = useMemo<FieldTemplate[]>(
    () => buildTemplates(editableLayers, mapData),
    [editableLayers, mapData],
  );

  // Selection is unused at this slice but MapCanvas requires the
  // controlled-state props. Empty selection + an off-tool keeps the
  // canvas rendering without firing select-related side effects.
  // #318: feature ids may be string (v3 promoteId UUID) or number.
  const [selection, setSelection] = useState<
    Record<string, Set<number | string>>
  >({});

  const handleMapReady = useCallback((map: maplibregl.Map | null) => {
    mapRef.current = map;
    // Tear down any prior marker before re-attaching: handleMapReady can
    // fire again on a basemap swap that recreates the underlying map.
    if (gpsMarkerRef.current) {
      gpsMarkerRef.current.detach();
      gpsMarkerRef.current = null;
    }
    if (map) {
      gpsMarkerRef.current = createGpsMarker(map);
      gpsMarkerRef.current.attach();
      // Replay the latest position into the freshly attached marker
      // so the dot doesn't disappear after a basemap change.
      if (gps.position) gpsMarkerRef.current.update(gps.position);
    }
  }, [gps.position]);

  // Push every new GPS fix into the marker source. Separate from
  // handleMapReady because positions arrive asynchronously and the
  // marker handle may already exist from the initial map ready.
  useEffect(() => {
    if (!gpsMarkerRef.current) return;
    gpsMarkerRef.current.update(gps.position);
  }, [gps.position]);

  // Follow-me mode: recenter the map on each new fix, keeping the
  // current zoom. easeTo is animated but short so a brisk walk
  // doesn't feel jumpy. Skipped when the user is mid-pan: maplibre's
  // isMoving() check would lie (camera also moves during easeTo), so
  // we trust the user's follow toggle as the only signal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !gps.follow || !gps.position) return;
    map.easeTo({
      center: [gps.position.lon, gps.position.lat],
      duration: 600,
    });
  }, [gps.follow, gps.position]);

  // #249: tap-on-map-to-override during active collect. When the
  // FormModal is open in add-mode for a point layer, a tap on the
  // visible map area (the part above the bottom-anchored sheet) sets
  // the proposed location to the tap point. Complementary to the
  // FormModal's "Update Point" button: Update Point re-snaps to GPS,
  // tap-to-override picks an arbitrary spot. Both feed through the
  // same setActiveGeometry path inside the modal via the
  // pendingMarker.setLngLat we already wired, plus a state hand-off
  // through a small bridge.
  //
  // Implementation: register map.on('click') only while the gating
  // conditions hold; cleanup detaches when the modal closes or the
  // mode changes. The handler is a no-op outside the gated state, so
  // the existing popup/feature-tap behaviour in MapCanvas keeps
  // working in non-collect mode.
  const isPointAddCollect =
    formModal?.mode === 'add' && formModal.layer.geometryType === 'point';
  useEffect(() => {
    if (!isPointAddCollect) return;
    const map = mapRef.current;
    if (!map) return;
    function onMapClick(e: maplibregl.MapMouseEvent) {
      const { lng, lat } = e.lngLat;
      // Move the preview marker to the tap; the FormModal's coord
      // readout reads from activeGeometry which we update via a
      // dedicated bridge below. We also update the modal's geometry
      // by mutating formModal in place via setFormModal so the next
      // render of FormModal re-initializes activeGeometry from the
      // new geometry (init effect fires on modal-object change).
      if (pendingMarkerRef.current) {
        pendingMarkerRef.current.setLngLat([lng, lat]);
      }
      // Update the formModal's geometry so the FormModal re-derives
      // its activeGeometry on next render. setFormModal with a new
      // object reference is the trigger.
      setFormModal((prev) =>
        prev && prev.mode === 'add'
          ? {
              ...prev,
              geometry: { type: 'Point', coordinates: [lng, lat] },
            }
          : prev,
      );
    }
    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
  }, [isPointAddCollect]);

  // #273: tap-to-add-vertex during line/polygon collection. The
  // effect itself lives below commitTemplateAt's declaration so
  // the closure captures it without a hoist error; this gate is
  // declared up front because featureSheetGate (next block) reads
  // it.
  const isLineOrPolyArming =
    activeTemplate !== null &&
    activeTemplate.layer.geometryType !== 'point' &&
    formModal === null;

  // #249.16 / #253: Field-Maps-style tap-to-popup. When the user
  // taps a feature on the canvas (and we're not in template-arming
  // or active-collect modes) we collect every hit at the point with
  // a small radius, build a FeatureSheetHit per layer, and open the
  // bottom sheet. One hit -> detail mode; two or more -> list mode.
  // No hit -> close any open sheet so a clear-canvas tap dismisses
  // the popup.
  //
  // Gated to formModal === null AND activeTemplate === null AND
  // !isPointAddCollect so the existing collect / template-arming /
  // override-tap paths stay untouched.
  const featureSheetGate =
    formModal === null && activeTemplate === null && !isPointAddCollect;
  // #273: when the user cancels a line/polygon template (X on the
  // chip in the footer), drop any vertices they'd accumulated.
  // Done as an effect so the cleanup runs even if the cancel comes
  // from a non-X path (Escape key in a future slice, route
  // navigation, etc).
  useEffect(() => {
    if (activeTemplate === null && pendingVertices.length > 0) {
      clearVertices();
    }
  }, [activeTemplate, pendingVertices.length, clearVertices]);
  useEffect(() => {
    if (!featureSheetGate) return;
    const map = mapRef.current;
    if (!map) return;
    const liveMap = map;

    function onClick(e: maplibregl.MapMouseEvent) {
      // Build the list of MapLibre style-layer ids that correspond
      // to MapData.layers' overlay layers. We accept any of -fill /
      // -line / -circle suffixes (added by the canvas's symbology
      // composer) plus the bare id (legacy single-layer renderers).
      const styleLayers = liveMap.getStyle().layers ?? [];
      const styleLayerIds = new Set<string>(
        styleLayers.map((l) => l.id),
      );
      // #253 fix: MapCanvas synthesizes overlay style layers with the
      // 'gg:' prefix and a fixed set of suffixes (see overlayLayerIds
      // in map-canvas.tsx). The original suffix list here was wrong
      // ('' / '-fill' / '-line' / '-circle' / '-stroke' with no
      // 'gg:' prefix) which made queryRenderedFeatures match nothing
      // and the sheet never opened. Mirror the canvas's exact list.
      const queryLayerIds: string[] = [];
      for (const ml of mapData.layers ?? []) {
        for (const suffix of [
          '-fill',
          '-poly-line',
          '-line',
          '-icon-halo',
          '-circle',
          '-label',
        ]) {
          const id = `gg:${ml.id}${suffix}`;
          if (styleLayerIds.has(id)) queryLayerIds.push(id);
        }
      }
      if (queryLayerIds.length === 0) {
        setFeatureSheet(null);
        return;
      }
      // Use a small bbox around the tap so a slightly-off touch
      // still grabs the feature. 10px on each side matches Field
      // Maps' touch tolerance roughly.
      const bbox: [
        [number, number],
        [number, number],
      ] = [
        [e.point.x - 10, e.point.y - 10],
        [e.point.x + 10, e.point.y + 10],
      ];
      const rawHits = liveMap.queryRenderedFeatures(bbox, {
        layers: queryLayerIds,
      });
      // Dedupe across the -fill/-line/-circle expansions: keep one
      // hit per (mapLayerId, globalId). Walking in order preserves
      // top-most-on-canvas wins.
      const seen = new Set<string>();
      const hits: FeatureSheetHit[] = [];
      for (const raw of rawHits) {
        const styleLayerId = (raw.layer as { id?: string }).id ?? '';
        // #253 fix: match the 'gg:<mlId>...' shape that the canvas
        // emits. Strip the 'gg:' prefix once and find the longest
        // matching MapLayer.id by prefix; longest-prefix wins so a
        // layer named 'foo' doesn't accidentally claim a hit on
        // 'foo-bar-fill'.
        const stripped = styleLayerId.startsWith('gg:')
          ? styleLayerId.slice(3)
          : styleLayerId;
        const candidates = mapData.layers ?? [];
        type Candidate = (typeof candidates)[number];
        let ml: Candidate | null = null;
        let bestMatchLen = -1;
        for (const candidate of candidates) {
          if (
            stripped === candidate.id ||
            stripped.startsWith(`${candidate.id}-`)
          ) {
            if (candidate.id.length > bestMatchLen) {
              ml = candidate;
              bestMatchLen = candidate.id.length;
            }
          }
        }
        if (!ml) continue;
        const props =
          (raw.properties as Record<string, unknown> | null) ?? {};
        const globalId =
          typeof props._global_id === 'string'
            ? (props._global_id as string)
            : typeof raw.id === 'string' || typeof raw.id === 'number'
              ? String(raw.id)
              : null;
        const dedupeKey = `${ml.id}:${globalId ?? `_p${hits.length}`}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        // Strip underscore-prefixed system metadata for the user-
        // facing attribute table; keep them on the raw hit if a
        // future feature needs them.
        const cleanProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith('_')) continue;
          cleanProps[k] = v;
        }
        // Resolve to an EditableLayer when possible (the Edit
        // button is gated on this). data-layer-sourced layers are
        // the only ones the field runtime can edit; arcgis-rest is
        // out of scope for v1.
        let editable: EditableLayer | null = null;
        if (ml.source && ml.source.kind === 'data-layer') {
          // Narrow `ml.source` once into a local so the find()
          // closure doesn't lose the discriminator. TS's structural
          // narrowing across `ml.source!.x` is too pessimistic
          // inside arrow callbacks.
          const src = ml.source;
          const dl = editableLayers.find(
            (e) =>
              e.dataLayerId === src.itemId && e.layerKey === src.layerKey,
          );
          if (dl) editable = dl;
        }
        hits.push({
          mapLayerId: ml.id,
          layerLabel: ml.title || ml.id,
          globalId,
          properties: cleanProps,
          geometry: (raw.geometry as GeoJSON.Geometry | null) ?? null,
          editable,
        });
      }
      if (hits.length === 0) {
        setFeatureSheet(null);
        return;
      }
      if (hits.length === 1) {
        setFeatureSheet({
          mode: 'detail',
          hit: hits[0]!,
          from: 'direct',
          listHits: hits,
          expanded: false,
        });
        return;
      }
      setFeatureSheet({ mode: 'list', hits, expanded: false });
    }
    liveMap.on('click', onClick);
    return () => {
      liveMap.off('click', onClick);
    };
  }, [featureSheetGate, mapData.layers, editableLayers]);

  // Tap-to-edit was Field Maps Quick Capture style: tap a feature,
  // form opens directly in edit mode. Earlier prod test feedback
  // surfaced two problems with that flow: (1) it suppressed the
  // popup that shows attribute values, which is the primary "what's
  // here" affordance users expect, and (2) without an explicit Edit
  // button, users couldn't tell that tapping a feature was about to
  // open an edit form. Both stem from forcing the same gesture
  // (tap) to do two things at once.
  //
  // Reverted to popup-first: tapping a feature lets MapCanvas open
  // its read-only popup, which now shows attributes. Editing is
  // accessed via a future "Edit" button inside that popup
  // (#223.4 follow-up). This matches Field Maps' own popup-then-
  // Edit workflow, and matches the desktop map item where popups
  // already work the same way.
  //
  // The block below is left in place but disabled so the field
  // runtime's onClick listener is gone. Reintroduce when the
  // popup-with-Edit-button surface lands and we wire its Edit
  // button to setFormModal.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _legacyTapToEditEffect(): void {
    const map = mapRef.current;
    if (!map) return;
    const liveMap = map; // narrow non-null inside the closure below
    const editableMapLayerIds: string[] = [];
    for (const ml of mapData.layers ?? []) {
      const source = ml.source;
      if (source?.kind !== 'data-layer') continue;
      const sourceItemId = source.itemId;
      const sourceLayerKey = source.layerKey;
      const matches = editableLayers.some(
        (e) =>
          e.dataLayerId === sourceItemId &&
          (sourceLayerKey ? e.layerKey === sourceLayerKey : true),
      );
      if (matches) editableMapLayerIds.push(ml.id);
    }

    function onClick(e: maplibregl.MapMouseEvent) {
      const styleLayerIds = new Set<string>(
        liveMap.getStyle().layers?.map((l) => l.id) ?? [],
      );
      const queryLayerIds = editableMapLayerIds
        .flatMap((id) => [`${id}-fill`, `${id}-line`, `${id}-circle`, id])
        .filter((id) => styleLayerIds.has(id));
      const hits = queryLayerIds.length
        ? liveMap.queryRenderedFeatures(e.point, { layers: queryLayerIds })
        : [];
      const hit = hits[0];
      if (!hit) return;

      const mapLayerId = (hit.layer as { id?: string }).id ?? '';
      const sourceMapLayer = (mapData.layers ?? []).find((ml) =>
        mapLayerId.startsWith(ml.id),
      );
      if (!sourceMapLayer) return;
      if (sourceMapLayer.source?.kind !== 'data-layer') return;
      const sourceItemId = sourceMapLayer.source.itemId;
      const sourceLayerKey = sourceMapLayer.source.layerKey;
      const editable = editableLayers.find(
        (l) =>
          l.dataLayerId === sourceItemId && l.layerKey === sourceLayerKey,
      );
      if (!editable) return;
      const props = (hit.properties as Record<string, unknown> | null) ?? {};
      const featureId =
        typeof props._global_id === 'string'
          ? (props._global_id as string)
          : null;
      if (!featureId) return;
      const geometry = (hit.geometry as GeoJSON.Geometry | null) ?? null;
      const cleanProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('_')) continue;
        cleanProps[k] = v;
      }
      setFormModal({
        layer: editable,
        mode: 'edit',
        featureId,
        properties: cleanProps,
        geometry,
      });
    }
    map.on('click', onClick);
  }
  void _legacyTapToEditEffect; // referenced to silence unused-warning

  // Commit the active template: drop a feature at the current map
  // center and open the form pre-filled with presetAttributes. Used
  // by the "Add at center" button. Field Maps' equivalent: pan to
  // position, tap "Add Point", form opens.
  // #249: shared commit path. Takes a template + a coord pair and
  // opens the form modal with the matching geometry, plants the
  // preview marker, and eases the camera so the marker isn't hidden
  // behind the bottom-sheet form. Both the explicit "Add at center"
  // and "Add at GPS" buttons funnel through here, AND the
  // template-picker's onPick uses it directly when GPS is available
  // so a single tap (FAB → pick template) collapses to one tap when
  // there's only one template (the picker self-dismisses).
  const commitTemplateAt = useCallback(
    (tpl: FieldTemplate, lon: number, lat: number) => {
      const map = mapRef.current;
      if (!map) return;
      if (isPointGeometry(tpl.layer.geometryType)) {
        // Point: drop immediately, open the form. This is the
        // original Field-Maps-style one-tap commit path.
        setFormModal({
          layer: tpl.layer,
          mode: 'add',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          presetAttributes: tpl.presetAttributes,
        });
        setActiveTemplate(null);
        clearPendingMarker();
        pendingMarkerRef.current = new maplibregl.Marker({ color: tpl.color })
          .setLngLat([lon, lat])
          .addTo(map);
        // Form takes the bottom ~60%; offset the camera so the
        // dropped marker stays visible above the sheet. Negative y
        // shifts the geographic center upward on screen.
        const h = map.getContainer().clientHeight;
        map.easeTo({
          center: [lon, lat],
          offset: [0, -h * 0.3],
          duration: 350,
        });
        return;
      }
      // #273: line / polygon path. Each call from here PUSHES a
      // vertex onto pendingVertices and refreshes the preview, but
      // does NOT commit -- the user has to tap Finish on the footer
      // when they have enough vertices.
      const isPolygon = tpl.layer.geometryType === 'polygon';
      setPendingVertices((prev) => {
        const next: Array<[number, number]> = [...prev, [lon, lat]];
        refreshPreviewGeom(next, tpl.color, isPolygon);
        return next;
      });
      // Vertex marker (dot at the tapped location). Smaller than the
      // point-template marker so the polyline reads as the primary
      // visual.
      const marker = new maplibregl.Marker({
        color: tpl.color,
        scale: 0.6,
      })
        .setLngLat([lon, lat])
        .addTo(map);
      vertexMarkersRef.current.push(marker);
    },
    [clearPendingMarker, refreshPreviewGeom],
  );

  /**
   * #273: remove the last vertex pushed. Field-mapping convention
   * is "single tap removes one." If the user undoes the last
   * remaining vertex, vertex-collection mode stays armed (template
   * is still active) -- they can keep tapping to start over.
   */
  const undoLastVertex = useCallback(() => {
    const tpl = activeTemplate;
    if (!tpl) return;
    setPendingVertices((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice(0, -1);
      const removed = vertexMarkersRef.current.pop();
      if (removed) {
        try {
          removed.remove();
        } catch {
          /* ignore */
        }
      }
      refreshPreviewGeom(
        next,
        tpl.color,
        tpl.layer.geometryType === 'polygon',
      );
      return next;
    });
  }, [activeTemplate, refreshPreviewGeom]);

  /**
   * #273: finalize the in-progress geometry and open the form
   * modal. Validates min vertex count (2 for line, 3 for polygon)
   * before committing. Polygon rings are closed automatically -- we
   * append the first vertex to the end so PostGIS / GeoJSON sees a
   * valid linear ring without making the user tap the start vertex
   * again.
   */
  const finishVertices = useCallback(() => {
    const tpl = activeTemplate;
    if (!tpl) return;
    const isPolygon = tpl.layer.geometryType === 'polygon';
    const minVerts = isPolygon ? 3 : 2;
    if (pendingVertices.length < minVerts) return;
    const geometry: GeoJSON.Geometry = isPolygon
      ? {
          type: 'Polygon',
          coordinates: [[...pendingVertices, pendingVertices[0]!]],
        }
      : {
          type: 'LineString',
          coordinates: pendingVertices,
        };
    setFormModal({
      layer: tpl.layer,
      mode: 'add',
      geometry,
      presetAttributes: tpl.presetAttributes,
    });
    setActiveTemplate(null);
    clearVertices();
  }, [activeTemplate, pendingVertices, clearVertices]);

  const commitAtCenter = useCallback(() => {
    const tpl = activeTemplate;
    const map = mapRef.current;
    if (!tpl || !map) return;
    const c = map.getCenter();
    commitTemplateAt(tpl, c.lng, c.lat);
  }, [activeTemplate, commitTemplateAt]);

  // Phase A3 / #249: drop a point at the current GPS fix. Funnels
  // through commitTemplateAt so the marker + camera-pan logic stays
  // in one place.
  const commitAtGps = useCallback(() => {
    const tpl = activeTemplate;
    const pos = gps.position;
    if (!tpl || !pos) return;
    commitTemplateAt(tpl, pos.lon, pos.lat);
  }, [activeTemplate, gps.position, commitTemplateAt]);

  // #273: map-click handler that pushes a vertex while a line/
  // polygon template is armed. Mirrors the isPointAddCollect
  // handler structure (gated useEffect that attaches/detaches the
  // listener) so the tap-to-popup, tap-to-override-point, and
  // tap-to-add-vertex flows don't fight each other. Lives below
  // commitTemplateAt's declaration so the closure captures the
  // helper without a use-before-declaration error.
  useEffect(() => {
    if (!isLineOrPolyArming) return;
    const map = mapRef.current;
    if (!map) return;
    const tpl = activeTemplate;
    if (!tpl) return;
    function onMapClick(e: maplibregl.MapMouseEvent) {
      const { lng, lat } = e.lngLat;
      commitTemplateAt(tpl!, lng, lat);
    }
    map.on('click', onMapClick);
    return () => {
      map.off('click', onMapClick);
    };
  }, [isLineOrPolyArming, activeTemplate, commitTemplateAt]);

  return (
    // Field mode owns the entire viewport: AppShell suppresses its
    // chrome on this route (see app-shell.tsx) so we render edge-to-
    // edge. dvh keeps the layout stable when iOS hides the URL bar
    // mid-scroll. The bottom sheets below honor env(safe-area-inset-
    // bottom) so iPhones with rounded corners don't clip the action
    // buttons.
    <div className="flex h-[100dvh] flex-col bg-surface-1">
      {/* Header reserves env(safe-area-inset-top) so iOS status bar
          / dynamic island doesn't sit on top of the back arrow when
          the runtime is launched from a home-screen PWA install
          (viewport-fit=cover puts the page under the status bar). */}
      {/* #249: Hide the runtime's top chrome while a collect is in
          progress. The FormModal sheet has its own Cancel / Collect
          / Submit header (Slice 3). Showing back/title/kebab on top
          of an active collect lets the worker accidentally tap into
          the More menu, navigate away, or trigger search -- all
          interruptions to the focused capture flow. Field Maps does
          the same: the runtime chrome melts away once you're
          collecting. */}
      {formModal === null ? (
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Link
          href={backHref}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {/* Single-line title. Subtitle ("Field deployment of <map>")
            moved into the More menu's header; field workers care
            about the deployment name, not the underlying map name,
            and the secondary line was eating vertical space + visual
            weight. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-ink-0">
            {title}
          </h1>
        </div>
        {/* Sync chip: only renders when records are queued. Tapping
            the chip kicks off a manual sync. The badge handles its
            own busy state. Kept on the header (not in the More menu)
            because a queued count is a notification, not a setting. */}
        {queueCount > 0 ? (
          <QueueBadge
            count={queueCount}
            syncing={syncing}
            isOnline={isOnline}
            onSync={() => {
              void runSync('manual');
            }}
          />
        ) : null}
        {rejectedRecords.length > 0 ? (
          <button
            type="button"
            onClick={() => setRejectedOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-2xs font-medium text-danger hover:bg-danger/20"
            title={t('fieldQueue.rejectedChipTitle')}
          >
            <AlertTriangle className="h-3 w-3" />
            {t('fieldQueue.rejectedChip', { count: rejectedRecords.length })}
          </button>
        ) : null}
        {/* The More menu collects every status pill + secondary
            action that used to crowd the header (connectivity,
            persistence, download, install). Field Maps does the
            same: a single 3-dot button at the top-right keeps the
            collection chrome out of the way of the canvas. */}
        <FieldMoreMenu
          mapTitle={mapTitle}
          isOnline={isOnline}
          cachedAt={cachedDeployment?.cachedAt ?? null}
          persistentState={persistentState}
          downloadInFlight={
            downloadProgress !== null &&
            downloadProgress.phase !== 'done' &&
            downloadProgress.phase !== 'failed'
          }
          hasCache={cachedDeployment !== null}
          // Rejected rows are unsynced too: removing the cache loses
          // them just the same, so the warnings count both.
          queueCount={queueCount + rejectedRecords.length}
          gpsStatus={gps.status}
          gpsAccuracyM={gps.position?.accuracyM ?? null}
          onDownload={() => void startDownload()}
          onRemoveCache={() => void removeCache()}
        />
      </header>
      ) : null}

      <RejectedEditsDialog
        open={rejectedOpen}
        onOpenChange={setRejectedOpen}
        records={rejectedRecords}
        layerLabelFor={(record) => {
          const layer = editableLayers.find(
            (l) =>
              l.dataLayerId === record.dataLayerId &&
              l.layerKey === record.layerKey,
          );
          return layer ? layer.layerLabel : null;
        }}
        onChanged={(action) => {
          setOfflineWriteCounter((n) => n + 1);
          if (action === 'retried' && isOnline) void runSync('manual');
        }}
      />

      {/* #249.18: persistent GPS accuracy strip below the header.
          Field Maps shows accuracy in a thin always-visible band so
          the worker can glance up at any time -- not just during a
          capture -- and know whether the fix is good enough to act
          on. Sits between the header and the canvas; hidden during
          active collect because the FormModal already shows its own
          accuracy banner at the top of the canvas in that mode. The
          strip is hidden entirely when GPS hasn't been requested
          yet (idle) so unauthorized users don't see a stale "no
          fix" message; once they enable location it surfaces. */}
      {formModal === null ? (
        <FieldGpsStrip
          gpsStatus={gps.status}
          accuracyM={gps.position?.accuracyM ?? null}
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        <MapCanvas
          ref={canvasRef}
          map={effectiveMapData}
          basemaps={basemaps}
          // #71: when a prepared area's archive is on this device,
          // draw from it instead of from the deployment's basemap,
          // which points at a tile server a collector out of signal
          // cannot reach. Null whenever nothing is stored, so the
          // online path is untouched.
          styleOverride={offlineBasemap.styleOverride}
          selection={selection}
          selectTool="off"
          onSelectionChange={setSelection}
          onCameraChange={() => {
            /* Camera changes don't persist in field-mode. */
          }}
          onMapReady={handleMapReady}
          // #249.15: hide MapLibre's default NavigationControl so the
          // field-runtime can render its own zoom + compass buttons
          // sized to match Layers / Search / Locate / FAB. The default
          // 29px buttons looked tiny next to the 44px field controls.
          hideNavigationControl
          // #253 fix: suppress MapLibre's HTML popup. The field
          // runtime now owns the click-on-feature surface via
          // FieldFeaturePopupSheet (a bottom sheet). Without this,
          // the canvas's popup fires alongside the bottom sheet and
          // wins the visual layer because it's rendered as a fixed
          // anchored overlay; the user sees the old HTML popup with
          // raw "_created_by / _edited_at" rows instead of the new
          // sheet.
          suppressPopup
        />

        {/* Crosshair reticle: only visible while a template is armed.
            Centered absolutely over the canvas with pointer-events:none
            so the maplibre canvas stays interactive underneath. The
            color is tinted from the active template so the user sees
            the symbology of the feature they're about to drop. */}
        {activeTemplate ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="relative h-16 w-16">
              {/* Outer ring -- low-contrast halo */}
              <div
                className="absolute inset-0 rounded-full border-2 border-white/70 shadow-[0_0_0_2px_rgba(0,0,0,0.15)]"
                style={{ borderColor: 'rgba(255,255,255,0.85)' }}
              />
              {/* Inner colored ring (the template's color) */}
              <div
                className="absolute inset-2 rounded-full border-2"
                style={{ borderColor: activeTemplate.color }}
              />
              {/* Center dot */}
              <div
                className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ backgroundColor: activeTemplate.color }}
              />
              {/* Crosshair lines */}
              <div className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-white/85" />
              <div className="absolute left-1/2 bottom-0 h-3 w-px -translate-x-1/2 bg-white/85" />
              <div className="absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 bg-white/85" />
              <div className="absolute top-1/2 right-0 h-px w-3 -translate-y-1/2 bg-white/85" />
            </div>
          </div>
        ) : null}

        {/* Layer-toggle button (top-left). MapLibre's NavigationControl
            (zoom +/- + compass) plants itself at top-right via
            map-canvas.tsx, so we keep this button on the opposite
            side to avoid overlap. Compact icon-only and the panel
            drops below when tapped. Hidden during active collect
            (#249) so it doesn't compete with the form sheet. */}
        {formModal === null ? (
        <button
          type="button"
          onClick={() => setLayerPanelOpen((v) => !v)}
          className="absolute left-3 top-3 z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface-1 shadow-card hover:bg-surface-2"
          aria-label="Toggle layers"
          aria-pressed={layerPanelOpen}
        >
          <Layers className="h-5 w-5 text-ink-1" />
        </button>
        ) : null}

        {/* #249.15: zoom + compass cluster at top-right. Replaces
            MapLibre's default NavigationControl (29px buttons) with
            three h-11 w-11 buttons stacked vertically and visually
            joined (shared rounded outer, internal borders). Sized to
            match Layers / Search / Locate / FAB so the right rail
            reads as one consistent set of map tools. Compass is
            de-emphasized (text-muted) in north-up state and brightens
            when the bearing/pitch is non-default. Hidden during
            active collect (#249) so it doesn't compete with the
            Cancel/Submit header. */}
        {formModal === null ? (
          <FieldNavCluster mapRef={mapRef} />
        ) : null}

        {/* Locate-me FAB. Sits top-right under MapLibre's zoom +
            compass cluster (#249.13: moved from bottom-left so the
            map's right rail groups all viewport controls together,
            matching the natural left-to-right top-to-bottom scan).
            Three-state interaction:
              - idle             -> tap requests permission + starts watch
              - watching, no follow -> tap centers on current fix
              - follow            -> button shows filled + tap toggles off
            The hook handles the OS subscription lifecycle; this
            button is purely a UI affordance. Hidden during active
            collect (#249) -- the FormModal sheet covers most of the
            canvas, AND the form's own "Update Point" button serves
            the same re-snap-to-GPS purpose. */}
        {formModal === null ? (
        <FieldLocateButton
          gpsStatus={gps.status}
          hasPosition={gps.position !== null}
          follow={gps.follow}
          accuracyM={gps.position?.accuracyM ?? null}
          onTap={() => {
            const map = mapRef.current;
            if (gps.status === 'idle') {
              gps.start();
              return;
            }
            if (gps.position && map) {
              map.easeTo({
                center: [gps.position.lon, gps.position.lat],
                zoom: Math.max(map.getZoom(), 16),
                duration: 600,
              });
            }
            // Toggle follow mode on the second tap. Each tap after that
            // alternates follow on/off. Tapping while not yet watching
            // starts the watch above.
            gps.toggleFollow();
          }}
        />
        ) : null}

        {/* Address search overlay (#223.3, collapsed by default in #249.11).
            Sits to the right of the Layers FAB at top-left. Default state
            is a magnifier icon; tapping expands an input. Right edge is
            held at right-14 when expanded so the input never extends
            under MapLibre's NavigationControl (zoom +/- + compass) at
            top-right. Hidden during active collect (#249) -- the worker
            is committing a feature, not navigating, and the form sheet
            sits where the search bar would otherwise extend. */}
        {formModal === null ? (
          searchExpanded ? (
            <div className="absolute left-[3.75rem] right-14 top-3 z-10">
              <div className="w-full max-w-xs">
                <FieldAddressSearch
                  mapRef={mapRef}
                  canvasRef={canvasRef}
                  layers={mapData.layers ?? []}
                  autoFocus
                  onClose={() => setSearchExpanded(false)}
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSearchExpanded(true)}
              aria-label="Search address"
              className="absolute left-[3.75rem] top-3 z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-surface-1 shadow-card hover:bg-surface-2"
            >
              <Search className="h-5 w-5 text-ink-1" />
            </button>
          )
        ) : null}

        {/* #249: Field Maps-style GPS accuracy banner during active
            collect. Sits at the top of the canvas (where the
            runtime's header would be, but that's hidden during
            collect via Slice 5). One-line, semi-transparent, just a
            number + units. The collector glances up to see "is my
            fix good enough to commit this point?" without taking
            a hand off the form. Hidden when there's no fix or the
            user hasn't enabled location yet. */}
        {formModal !== null && gps.position ? (
          <div
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-[max(0.5rem,env(safe-area-inset-top))]"
          >
            <span
              className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-card backdrop-blur-sm ${
                (() => {
                  const band = gpsAccuracyBand(gps.position.accuracyM);
                  if (band === 'excellent' || band === 'good') {
                    return 'border-success/40 bg-surface-1/95 text-success';
                  }
                  if (band === 'fair') {
                    return 'border-warn/40 bg-surface-1/95 text-warn';
                  }
                  return 'border-danger/40 bg-surface-1/95 text-danger';
                })()
              }`}
            >
              <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
              GPS accuracy{' '}
              {gps.position.accuracyM < 1
                ? '<1'
                : Math.round(gps.position.accuracyM)}
              {' m'}
            </span>
          </div>
        ) : null}

        {/* #249: Field Maps-style circular FAB at bottom-right.
            Replaces the previous full-width footer button. Only
            renders in the default state (no activeTemplate, layers
            available, no active collect). Tap opens the template
            picker; if there's exactly one template AND GPS is
            watching, the picker auto-dismisses and the form opens
            in one tap (Slice 2 behaviour). Hidden during active
            collect (#249 chrome rules) so it doesn't compete with
            the Cancel/Submit header. */}
        {/* Gate on templates, NOT editableLayers. editableLayers
            deliberately retains layers the collector may not add to
            (see EditableLayer.addable) so the visibility panel can
            still list them, so testing it here rendered a FAB with
            nothing behind it: `disabled` then greyed it to 50% on a
            dark FAB, which reads as an enabled button that ignores
            you. Reported as "I press this and nothing happens". */}
        {formModal === null &&
        activeTemplate === null &&
        templates.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              // #249: single-template deployments skip the picker.
              // Field Maps does the same: with one feature type to
              // collect, asking "which one?" is friction. Combined
              // with Slice 2's GPS-fast-path, the common case
              // (single template + GPS watching) collapses to one
              // tap from FAB to FormModal.
              if (templates.length === 1) {
                const only = templates[0]!;
                // #273: same gating as the picker -- only the
                // point geometry uses the GPS one-tap commit;
                // line/polygon templates always enter vertex
                // collection.
                if (gps.position && only.layer.geometryType === 'point') {
                  commitTemplateAt(only, gps.position.lon, gps.position.lat);
                } else {
                  setActiveTemplate(only);
                }
                return;
              }
              setPickerOpen(true);
            }}
            aria-label="Add feature"
            // #249.11: previous version applied paddingBottom for safe
            // area, which distorted the circle on iPhone (icon shoved
            // off-center). Move the inset onto `bottom` so the button
            // stays a perfect circle and just rides above the home
            // indicator instead of stretching.
            className="absolute right-3 z-10 inline-flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-overlay hover:opacity-90 disabled:opacity-50"
            style={{ bottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
          >
            <Plus className="h-7 w-7" />
          </button>
        ) : null}

        {/* Someone who opened a field deployment came here to collect.
            Removing the dead button without saying anything just moves
            the confusion, so say what is wrong and where it is fixed.
            Only in the idle state, and only when the deployment really
            has nothing to add to. */}
        {formModal === null &&
        activeTemplate === null &&
        templates.length === 0 ? (
          <div
            className="absolute inset-x-3 z-10 rounded-md border border-border bg-surface-1/95 p-2.5 shadow-overlay"
            style={{ bottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
          >
            <p className="text-xs font-medium text-ink-0">
              Nothing to collect in this deployment
            </p>
            <p className="mt-0.5 text-2xs text-muted">
              {editableLayers.length > 0
                ? 'Its layers are set to view-only. Turn on "Editable in field deployments" for a layer on the map, and make sure editing is enabled on the data layer itself.'
                : 'Its map has no layers you can add to.'}
            </p>
          </div>
        ) : null}

        {layerPanelOpen ? (
          <LayerVisibilityPanel
            layers={mapData.layers ?? []}
            editableLayers={editableLayers}
            hiddenLayerIds={hiddenLayerIds}
            onToggle={(layerId) => {
              setHiddenLayerIds((prev) => {
                const next = new Set(prev);
                if (next.has(layerId)) next.delete(layerId);
                else next.add(layerId);
                return next;
              });
            }}
            basemaps={basemaps}
            currentBasemapId={basemapOverrideId ?? mapData.basemap}
            onBasemapChange={setBasemapOverrideId}
            cachedDeployment={cachedDeployment}
            isDownloading={
              downloadProgress !== null &&
              downloadProgress.phase !== 'done' &&
              downloadProgress.phase !== 'failed'
            }
            onDownload={() => {
              setLayerPanelOpen(false);
              void startDownload();
            }}
            onClose={() => setLayerPanelOpen(false)}
            storage={storage}
            persistentState={persistentState}
            onRequestPersist={async () => {
              const r = await requestPersistentStorage();
              setPersistentState(
                r.persistent ? 'persistent' : 'best-effort',
              );
            }}
            tileCache={tileCache}
            onClearTiles={async () => {
              const ok = await clearTileCache();
              if (ok) await refreshTileCacheStats();
            }}
            tileZoomMin={tileZoomMin}
            tileZoomMax={tileZoomMax}
            onTileZoomMinChange={(z) => {
              // Keep the pair coherent: if the user shrinks the
              // upper bound below the lower bound, snap the lower
              // bound to match. Same the other way around in the
              // max handler.
              setTileZoomMin(z);
              if (z > tileZoomMax) setTileZoomMax(z);
            }}
            onTileZoomMaxChange={(z) => {
              setTileZoomMax(z);
              if (z < tileZoomMin) setTileZoomMin(z);
            }}
            estimatedTileCount={(() => {
              // #272: live estimate against the current viewport.
              // Recomputed on every render of the panel; cheap math
              // (just sums per-zoom tile counts), no allocation.
              const map = mapRef.current;
              if (!map) return 0;
              const b = map.getBounds();
              return estimateTileCount(
                [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
                [tileZoomMin, tileZoomMax],
              );
            })()}
            blockedTileSources={(() => {
              // The estimate above counts tile coordinates, not tiles
              // we are allowed to fetch. Quoting a number the warmer
              // will then refuse to honour is worse than quoting
              // none, so the panel needs to know which sources are
              // off limits before the download runs, not after.
              const { refused } = splitByPrefetchPolicy(
                collectTileTemplates(mapRef.current),
                typeof window !== 'undefined'
                  ? window.location.origin
                  : undefined,
              );
              return refused;
            })()}
            centerLat={(() => {
              const map = mapRef.current;
              if (!map) return 0;
              return map.getCenter().lat;
            })()}
            offlineBasemap={offlineBasemap}
          />
        ) : null}
      </div>

      {/* #249: Footer only renders when there's something to put in it
          (activeTemplate location-pick step or the empty-layers
          message). Default state moves to a circular FAB at
          bottom-right of the canvas (rendered separately above), so
          the map gets the full height when nothing is happening. */}
      {(editableLayers.length === 0 || activeTemplate !== null) ? (
      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {editableLayers.length === 0 ? (
          <p className="flex-1 text-center text-xs text-muted">
            No editable layers in this map.
          </p>
        ) : activeTemplate ? (
          (() => {
            const isMultiVertex =
              activeTemplate.layer.geometryType === 'line' ||
              activeTemplate.layer.geometryType === 'polygon';
            const isPolygon =
              activeTemplate.layer.geometryType === 'polygon';
            const minVerts = isPolygon ? 3 : 2;
            const canFinish = pendingVertices.length >= minVerts;
            return (
              <>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-0 px-2 py-1.5">
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 rounded-sm border border-border"
                    style={{ backgroundColor: activeTemplate.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-0">
                      {activeTemplate.label}
                    </p>
                    <p className="truncate text-2xs text-muted">
                      {/* #273: in vertex-collection mode the
                          subtitle reports the in-progress vertex
                          count + the threshold so the worker knows
                          how close they are to being able to
                          Finish. Falls back to the template's
                          sublabel for point templates. */}
                      {isMultiVertex
                        ? `${pendingVertices.length} vertex${
                            pendingVertices.length === 1 ? '' : 'es'
                          }${
                            canFinish
                              ? ' — tap Finish'
                              : ` — need ${minVerts - pendingVertices.length} more`
                          }`
                        : activeTemplate.sublabel}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTemplate(null)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
                    aria-label="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* #273: line/polygon path adds Undo + Finish to
                    the action row; the GPS / center buttons reuse
                    the same commitAt* callbacks (which now PUSH a
                    vertex instead of committing) but get relabeled
                    so the worker reads "Vertex at GPS" instead of
                    "Add at GPS". */}
                {isMultiVertex ? (
                  <>
                    <button
                      type="button"
                      onClick={undoLastVertex}
                      disabled={pendingVertices.length === 0}
                      title="Remove the last vertex"
                      className="inline-flex h-11 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Undo
                    </button>
                    <button
                      type="button"
                      onClick={finishVertices}
                      disabled={!canFinish}
                      title={
                        canFinish
                          ? 'Open the form for this feature'
                          : `Need at least ${minVerts} vertices`
                      }
                      className="inline-flex h-11 shrink-0 items-center gap-1 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" />
                      Finish
                    </button>
                  </>
                ) : null}
                {/* When GPS is watching, "Add at my location" is the
                    primary action because it's what the field worker
                    wants 90% of the time. "Add at center" stays as
                    the fallback when the user wants to record a
                    feature somewhere they're not standing (e.g., the
                    parcel's centroid, a feature visible from a
                    vantage point). When GPS is idle/denied/unavailable
                    the only button shown is "Add at center". */}
                {gps.status === 'watching' && gps.position ? (
                  <button
                    type="button"
                    onClick={commitAtGps}
                    title={`Drop the ${
                      isMultiVertex ? 'vertex' : 'feature'
                    } at your current location (~${
                      gps.position.accuracyM < 1
                        ? '<1'
                        : Math.round(gps.position.accuracyM)
                    } m accuracy)`}
                    className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90"
                  >
                    <LocateFixed className="h-4 w-4" />
                    {isMultiVertex ? 'Vertex at GPS' : 'Add at GPS'}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={commitAtCenter}
                  className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold shadow-card hover:opacity-90 ${
                    gps.status === 'watching' && gps.position
                      ? 'border border-border bg-surface-1 text-ink-1'
                      : 'bg-accent text-accent-foreground'
                  }`}
                >
                  <MapPin className="h-4 w-4" />
                  {isMultiVertex ? 'Vertex at center' : 'Add at center'}
                </button>
              </>
            );
          })()
        ) : null}
      </footer>
      ) : null}

      {pickerOpen ? (
        <TemplatePicker
          templates={templates}
          onPick={(tpl) => {
            setPickerOpen(false);
            // #249: Field Maps-style one-tap capture. When the GPS
            // hook is producing a fix AND this is a point template,
            // picking a template commits immediately at the worker's
            // current position -- no detour through the footer's
            // "Add at GPS / Add at center" choice. The user can
            // still revise the location via "Update Point" inside
            // the form sheet, or by canceling and retrying with GPS
            // off. When GPS isn't watching, we keep the footer-
            // button flow so the user can drop the feature at the
            // map center.
            //
            // #273: line/polygon templates always go through
            // setActiveTemplate first so the user enters vertex-
            // collection mode (single-tap commit doesn't apply --
            // they need 2+ vertices for line, 3+ for polygon).
            if (gps.position && tpl.layer.geometryType === 'point') {
              commitTemplateAt(tpl, gps.position.lon, gps.position.lat);
            } else {
              setActiveTemplate(tpl);
            }
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {/* #253: Field-Maps-style feature popup. Bottom sheet that
          surfaces tapped-feature info; expandable to fullscreen via
          the chevron in the header. Hidden whenever the FormModal
          is open (the form sheet owns the bottom half of the
          viewport in that mode). */}
      {featureSheet && formModal === null ? (
        <FieldFeaturePopupSheet
          state={featureSheet}
          dataCollectionId={dataCollectionId}
          isOnline={isOnline}
          editableLayers={editableLayers}
          onChangeState={setFeatureSheet}
          onClose={() => setFeatureSheet(null)}
          onOpenRelated={(childLayer, feature) => {
            // #265: tap a related row in the popup -> jump straight
            // into editing it. Mirrors the FormModal's onOpenRelated
            // path; clearing the popup first so the FormModal owns
            // the bottom of the viewport.
            setFeatureSheet(null);
            setFormModal({
              layer: childLayer,
              mode: 'edit',
              featureId: feature.id,
              properties: feature.properties,
              geometry: feature.geometry,
            });
          }}
          onEdit={(hit) => {
            // Switch the FormModal to edit mode for the hit's
            // editable layer. The same shape the legacy tap-to-edit
            // flow used; the sheet just makes the path explicit.
            if (!hit.editable || !hit.globalId) return;
            setFeatureSheet(null);
            setFormModal({
              layer: hit.editable,
              mode: 'edit',
              featureId: hit.globalId,
              properties: hit.properties,
              geometry: hit.geometry,
            });
          }}
          onCopy={(hit) => {
            // #253: Field Maps' Copy = make a new feature with the
            // tapped feature's attributes, leaving the user to
            // place + tweak it. We pre-fill via presetAttributes
            // (string-keyed because that's what the existing
            // add-mode plumbing accepts). Geometry: drop a fresh
            // point at the tapped feature's centroid, or fall
            // through to GPS / map center via the same fallback
            // the FAB uses. For non-point geometries, fall back
            // to no geometry; the FormModal already handles that.
            if (!hit.editable) return;
            const presetAttributes: Record<string, string> = {};
            for (const [k, v] of Object.entries(hit.properties)) {
              if (v === null || v === undefined) continue;
              presetAttributes[k] = typeof v === 'string' ? v : String(v);
            }
            const map = mapRef.current;
            const gpsPos = gps.position;
            const center = map ? map.getCenter() : null;
            let initialGeometry: GeoJSON.Geometry | null = null;
            if (hit.editable.geometryType === 'point') {
              if (gpsPos) {
                initialGeometry = {
                  type: 'Point',
                  coordinates: [gpsPos.lon, gpsPos.lat],
                };
              } else if (center) {
                initialGeometry = {
                  type: 'Point',
                  coordinates: [center.lng, center.lat],
                };
              }
            }
            setFeatureSheet(null);
            setFormModal({
              layer: hit.editable,
              mode: 'add',
              geometry: initialGeometry,
              presetAttributes,
            });
          }}
        />
      ) : null}

      {formModal ? (
        <FormModal
          dataCollectionId={dataCollectionId}
          modal={formModal}
          pickLists={effectivePickLists}
          boundForms={boundForms}
          currentUserId={currentUserId}
          isOnline={isOnline}
          gpsPosition={gps.position}
          editableLayers={editableLayers}
          onAddRelated={(childLayer, parentFkColumn, parentFeatureId) => {
            // Switch the modal to add-mode for the child layer with
            // the FK pre-filled. Geometry: prefer the GPS fix when
            // available, fall back to the parent's geometry, fall back
            // to map center as a last resort. Most surveys want the
            // child captured at the worker's actual position; the
            // parent's geometry is a sane fallback when GPS is off.
            const map = mapRef.current;
            const fallbackCenter = map ? map.getCenter() : null;
            const initialGeometry: GeoJSON.Geometry | null =
              gps.position
                ? {
                    type: 'Point',
                    coordinates: [gps.position.lon, gps.position.lat],
                  }
                : formModal.geometry ??
                  (fallbackCenter
                    ? {
                        type: 'Point',
                        coordinates: [fallbackCenter.lng, fallbackCenter.lat],
                      }
                    : null);
            clearPendingMarker();
            setFormModal({
              layer: childLayer,
              mode: 'add',
              geometry: initialGeometry,
              presetAttributes: { [parentFkColumn]: parentFeatureId },
            });
          }}
          onOpenRelated={(childLayer, feature) => {
            // #247: open the FormModal in edit mode for an existing
            // related row. The runtime owns the camera + pendingMarker
            // bookkeeping (mirrors onAddRelated above) so the child
            // form gets a clean slate. Geometry comes straight from
            // the feature -- if the child is a table sublayer (no
            // geom) it'll be null and FormModal already handles that
            // shape.
            clearPendingMarker();
            setFormModal({
              layer: childLayer,
              mode: 'edit',
              featureId: feature.id,
              properties: feature.properties,
              geometry: feature.geometry,
            });
          }}
          onClose={() => {
            clearPendingMarker();
            setFormModal(null);
          }}
          onSubmitted={() => {
            const submittedLayer = formModal.layer;
            clearPendingMarker();
            setFormModal(null);
            // Refresh the MapLayer(s) backed by the data_layer that
            // just received a write so the new / updated feature
            // appears immediately. setData(url) on the existing
            // GeoJSONSource forces a refetch (#194). Online-only;
            // offline writes are surfaced through the
            // offlineFeatures effect via offlineWriteCounter.
            if (isOnline) {
              for (const ml of mapData.layers ?? []) {
                const source = ml.source;
                if (source?.kind !== 'data-layer') continue;
                if (source.itemId !== submittedLayer.dataLayerId) continue;
                if (source.layerKey && source.layerKey !== submittedLayer.layerKey) {
                  continue;
                }
                canvasRef.current?.refreshLayerSource(ml.id);
              }
            }
          }}
          onLocalWriteApplied={() => setOfflineWriteCounter((n) => n + 1)}
          onUpdateGeometry={(geom) => {
            // #249: keep the pendingMarker in sync when the user taps
            // "Update Point" inside the form. We only get called for
            // Point geometries (the modal gates the button), so a
            // direct setLngLat is safe.
            if (
              pendingMarkerRef.current &&
              geom.type === 'Point' &&
              Array.isArray(geom.coordinates)
            ) {
              const [lon, lat] = geom.coordinates as [number, number];
              pendingMarkerRef.current.setLngLat([lon, lat]);
              // Pan the camera to the new spot so the user can see
              // where the feature is going to land. easeTo is a quick
              // animation; not a full flyTo because the move is small.
              const map = mapRef.current;
              if (map) {
                map.easeTo({ center: [lon, lat], duration: 200 });
              }
            }
            // Echo the change back into the modal-state geometry so
            // the FormModal's sync effect re-derives activeGeometry.
            // Map-tap-to-override (the click handler we register on
            // the map) takes the same path: setFormModal(... new
            // geom ...), so the form's coord readout converges.
            setFormModal((prev) =>
              prev && prev.mode === 'add' ? { ...prev, geometry: geom } : prev,
            );
          }}
        />
      ) : null}

      {downloadProgress ? (
        <DownloadProgressModal
          progress={downloadProgress}
          onClose={() => setDownloadProgress(null)}
          onCancel={() => downloadAbortRef.current?.abort()}
        />
      ) : null}
    </div>
  );
}

/**
 * Read-only check: does this geometry type capture a single tap?
 * Slice 2/3 only handle `point` -- line and polygon need a multi-step
 * gesture and ride along with terra-draw integration in a follow-up
 * slice (#196).
 */
function isPointGeometry(t: LayerGeometryType): boolean {
  return t === 'point';
}

/**
 * Walk the live MapLibre style and collect tile URL templates from
 * every raster + vector source that uses {z}/{x}/{y} addressing.
 * Slice 10: the offline-download manager passes these to the tile
 * warmer so the basemap (and any tiled overlays) are pre-cached for
 * the deployment's bbox.
 *
 * Reading off the live style (rather than parsing the basemap config
 * upstream) means we automatically support every basemap variant
 * the runtime can render: built-in raster XYZs, the org's custom
 * basemaps, vector style URLs (which maplibre expands into source
 * objects internally), proxy-routed URLs, etc.
 *
 * Returns an empty array when the map isn't ready or when none of
 * the active sources expose a tile template (vector-style sources
 * that pull style.json + tile URLs internally fall through here;
 * those tiles still get cached via the SW's passive interception
 * as the user pans).
 */
function collectTileTemplates(map: maplibregl.Map | null): string[] {
  if (!map) return [];
  let style: ReturnType<maplibregl.Map['getStyle']> | null = null;
  try {
    style = map.getStyle();
  } catch {
    return [];
  }
  if (!style?.sources) return [];
  const out: string[] = [];
  for (const source of Object.values(style.sources)) {
    if (
      typeof source === 'object' &&
      source !== null &&
      'tiles' in source &&
      Array.isArray((source as { tiles?: unknown }).tiles)
    ) {
      for (const t of (source as { tiles: unknown[] }).tiles) {
        if (typeof t === 'string' && t.includes('{z}') && t.includes('{x}')) {
          out.push(t);
        }
      }
    }
  }
  return out;
}

/**
 * Build the runtime template list. One template per (editable layer,
 * symbology class) pair, drawn from each layer's MapLayer renderer.
 * Layers with no MapLayer in the map (e.g. the data_collection lists
 * a layer the bound map doesn't reference) are skipped silently.
 */
function buildTemplates(
  editableLayers: EditableLayer[],
  mapData: MapData,
): FieldTemplate[] {
  const out: FieldTemplate[] = [];
  for (const layer of editableLayers) {
    // #271: skip table sublayers (geometryType === null). They live
    // in editableLayers so the FormModal's Add-related affordance
    // can wire to them from a parent feature, but they have no
    // geometry to drop and aren't valid standalone Add targets.
    // Without this filter the picker shows e.g. a "Status" table as
    // an Add option alongside spatial layers, which the user can't
    // actually use because Add starts with a map gesture.
    if (layer.geometryType === null) continue;
    // Skip layers explicitly marked as non-addable. Default-true so
    // legacy callers without the field don't lose their Add buttons.
    // The map-level "Editable in field deployments" toggle is the
    // primary writer; the data_layer's sublayer.editingEnabled
    // false is the upstream ACL. Either source can mark a layer
    // reference-only without dropping it from the layer-visibility
    // panel (geometry-type lookup still finds the entry there).
    if (layer.addable === false) continue;
    // Find the corresponding MapLayer so we can read its renderer.
    // Match on dataLayerId + layerKey. Multiple MapLayers could
    // reference the same v3 sublayer (rare but possible if the
    // author added it twice); use the first match.
    const ml = mapData.layers.find((m) => {
      const s = m.source;
      if (s?.kind !== 'data-layer') return false;
      if (s.itemId !== layer.dataLayerId) return false;
      // Tolerate a missing layerKey on legacy maps (predates Slice 1).
      // When the source has no layerKey, treat the whole data_layer as
      // a single editable target -- the legacy /items/:id/geojson
      // endpoint now routes to the first spatial sublayer (#194).
      return !s.layerKey || s.layerKey === layer.layerKey;
    });
    if (!ml) continue;

    const fallbackColor = pickFallbackColor(ml);
    const renderer = ml.renderer;

    if (!renderer || renderer.kind === 'simple') {
      out.push({
        id: `${layer.dataLayerId}:${layer.layerKey}:simple`,
        layer,
        label: layer.layerLabel,
        sublabel: layer.dataLayerTitle,
        color: fallbackColor,
        presetAttributes: {},
      });
      continue;
    }

    if (renderer.kind === 'unique-values') {
      // Each category becomes its own template. The form will open
      // with renderer.field already populated, matching Field Maps'
      // editing-template convention.
      for (const cat of renderer.categories) {
        out.push({
          id: `${layer.dataLayerId}:${layer.layerKey}:uv:${cat.value}`,
          layer,
          label: cat.value,
          sublabel: layer.layerLabel,
          color: cat.color,
          presetAttributes: { [renderer.field]: cat.value },
        });
      }
      continue;
    }

    if (renderer.kind === 'class-breaks') {
      // Class breaks are numeric ranges; "create a feature with
      // value 0-50 already filled" doesn't generally make sense.
      // Collapse to one "Add to this layer" template using the
      // layer's fallback color so the picker still has an entry.
      out.push({
        id: `${layer.dataLayerId}:${layer.layerKey}:cb`,
        layer,
        label: layer.layerLabel,
        sublabel: layer.dataLayerTitle,
        color: fallbackColor,
        presetAttributes: {},
      });
    }
  }
  return out;
}

/**
 * Choose a sensible swatch color for the simple-renderer / class-breaks
 * fallback. Picks from the layer's MapLayerStyle: point.color for
 * point layers, line.color for lines, fill.color for polygons.
 */
function pickFallbackColor(ml: MapLayer): string {
  const s = ml.style;
  // Best-effort: try every kind so an unset color falls through.
  const point = (s.point as { color?: string } | undefined)?.color;
  const line = (s.line as { color?: string } | undefined)?.color;
  const fill = (s as unknown as { fill?: { color?: string } }).fill?.color;
  return point || line || fill || '#888888';
}

/**
 * FormRuntime expects select-one / select-many / ranking questions to
 * carry `choices` populated at render time. Both the form designer
 * and the auto-form generator (Slice 1) leave `choices: []` and stash
 * the pick_list reference in `pickListId` -- the consumer is the one
 * who fetches the pick list and inlines the entries. The standalone
 * /forms/respond page does the same dance; field-mode does it here.
 *
 * Returns a new FormSchema (questions tree shallow-cloned) so React's
 * referential-identity checks don't get confused. Pick lists missing
 * from the map (item soft-deleted, caller can't see it) leave the
 * question with whatever inline choices were authored as a fallback,
 * which is usually an empty list -- the runtime will then render an
 * empty dropdown rather than a broken one.
 */
function resolvePickListChoices(
  form: FormSchema,
  pickLists: Record<string, PickListData>,
): FormSchema {
  function resolveQuestion(q: Question): Question {
    if (q.type === 'group') {
      return { ...q, children: q.children.map(resolveQuestion) };
    }
    if (
      q.type === 'select-one' ||
      q.type === 'select-many' ||
      q.type === 'ranking'
    ) {
      const pickListId = (q as { pickListId?: string }).pickListId;
      if (!pickListId) return q;
      // Don't clobber inline choices when they're already populated.
      // The designer may have authored choices and ALSO referenced a
      // pick list; the more-specific inline list wins.
      if (q.choices && q.choices.length > 0) return q;
      const list = pickLists[pickListId];
      if (!list) return q;
      const choices = list.entries.map((e) => ({
        value: e.code,
        label: e.label,
      }));
      return { ...q, choices };
    }
    return q;
  }
  return {
    ...form,
    questions: form.questions.map(resolveQuestion),
  };
}

/**
 * Reshape a FeatureField into the loose structural input the form-schema
 * package's generator accepts. We skip optional fields that are
 * undefined (rather than carrying them as `key: undefined`) to satisfy
 * `exactOptionalPropertyTypes`.
 */
type GeneratorFieldInput = NonNullable<
  Parameters<typeof generateFormFromLayer>[0]['fields']
>[number];

function layerFieldToGeneratorInput(f: FeatureField): GeneratorFieldInput {
  const out: GeneratorFieldInput = {
    name: f.name,
    type: f.type,
  };
  if (f.label !== undefined) out.label = f.label;
  if (f.nullable !== undefined) out.nullable = f.nullable;
  if (f.domain !== undefined) out.domain = f.domain;
  return out;
}

/**
 * Bottom-sheet picker shown when the user taps "Add Feature". Lists
 * every template grouped by layer label. Layer headers are derived
 * from the templates' `sublabel`, which is the parent layer's name
 * for unique-values templates and the data_layer title for simple
 * layers -- the result is "all classes for layer X" reads as one
 * cluster. Tapping a row commits the active template and closes.
 */
function TemplatePicker({
  templates,
  onPick,
  onClose,
}: {
  templates: FieldTemplate[];
  onPick: (tpl: FieldTemplate) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const filtered = term
      ? templates.filter(
          (t) =>
            t.label.toLowerCase().includes(term) ||
            t.sublabel.toLowerCase().includes(term),
        )
      : templates;
    // Group by sublabel (parent layer / data_layer title) preserving
    // insertion order. A Map preserves keys in insertion order across
    // all engines we care about.
    const byGroup = new Map<string, FieldTemplate[]>();
    for (const t of filtered) {
      const arr = byGroup.get(t.sublabel) ?? [];
      arr.push(t);
      byGroup.set(t.sublabel, arr);
    }
    return Array.from(byGroup.entries());
  }, [templates, filter]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a feature type to add"
      className="fixed inset-0 z-30 flex items-end bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-full flex-col rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)] sm:max-h-[80vh]"
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-0">Add feature</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            className="mt-2 h-9 w-full rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">
              {templates.length === 0
                ? "This deployment has no editable layers yet."
                : 'No templates match that filter.'}
            </p>
          ) : (
            groups.map(([groupLabel, groupTemplates]) => (
              <div key={groupLabel} className="border-b border-border last:border-b-0">
                <h3 className="bg-surface-0 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                  {groupLabel}
                </h3>
                <ul>
                  {groupTemplates.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onPick(t)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <span
                          aria-hidden="true"
                          className="h-5 w-5 shrink-0 rounded-sm border border-border"
                          style={{ backgroundColor: t.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-0">
                          {t.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * #272: zoom levels exposed in the offline-download scale picker.
 * Hand-picked instead of a continuous range so the dropdowns stay
 * a manageable length (12 entries instead of 23) and each entry
 * lands on a familiar map / engineering scale step:
 *
 *   z6  ~ regional         (~1:9.2M)
 *   z9  ~ metro             (~1:1.1M)
 *   z11 ~ small region     (~1:289k)
 *   z12 ~ city              (~1:144k)
 *   z14 ~ neighborhood     (~1:36k)
 *   z15 ~ district          (~1:18k)
 *   z16 ~ block            (~1:9k)
 *   z17 ~ buildings         (~1:4.5k)
 *   z18 ~ rough parcels    (~1:2.3k)
 *   z19 ~ parcels          (~1:1.1k, 1"=100 ft)
 *   z20 ~ survey           (~1:564,  1"=50 ft)
 *   z22 ~ subcentimeter    (~1:141)
 *
 * Most basemap providers cap at z19, so 20-22 may 404 against
 * standard tile sources -- the picker doesn't lock those out
 * (some providers do go deeper) but the user pays a network bill
 * for the failed requests.
 */
const ZOOM_PICKER_OPTIONS = [6, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22];

/**
 * Compact panel that lists every map layer with an eye toggle.
 * Session-local (doesn't mutate the bound map item). Clicking the
 * eye flips visibility for this open of the deployment only.
 */
function LayerVisibilityPanel({
  layers,
  editableLayers,
  hiddenLayerIds,
  onToggle,
  basemaps,
  currentBasemapId,
  onBasemapChange,
  cachedDeployment,
  isDownloading,
  onDownload,
  onClose,
  storage,
  persistentState,
  onRequestPersist,
  tileCache,
  onClearTiles,
  tileZoomMin,
  tileZoomMax,
  onTileZoomMinChange,
  onTileZoomMaxChange,
  estimatedTileCount,
  blockedTileSources,
  centerLat,
  offlineBasemap,
}: {
  layers: MapLayer[];
  /** #249.21: editable-layer list so the panel can look up the
   *  underlying sublayer geometry type per MapLayer (used for the
   *  swatch shape + table-row hiding). */
  editableLayers: EditableLayer[];
  hiddenLayerIds: Set<string>;
  onToggle: (layerId: string) => void;
  /** Available basemap items the user can swap to. */
  basemaps: CustomBasemap[];
  /** Currently active basemap id (override or authored default). */
  currentBasemapId: string;
  /** Switch to a different basemap. Pass null to clear the override
   *  and fall back to the map item's authored basemap. */
  onBasemapChange: (next: string | null) => void;
  cachedDeployment: CachedDeployment | null;
  isDownloading: boolean;
  onDownload: () => void;
  onClose: () => void;
  /** Slice 6: live storage usage for the gauge. Null = not loaded yet. */
  storage: StorageEstimate | null;
  /** Slice 6: persistence state surfaced via the in-panel chip. */
  persistentState: 'unknown' | 'persistent' | 'best-effort';
  /** Fires the storage.persist() prompt. The user can also re-request
   *  if they originally denied. */
  onRequestPersist: () => void;
  /** Slice 10: tile cache stats (count + bytes) read from the SW.
   *  Null when the SW isn't registered (dev mode, unsupported
   *  browsers); the panel hides the row in that case. */
  tileCache: { count: number; bytes: number } | null;
  /** Drops every cached tile via the SW message channel. Used for
   *  the "free up space" affordance when the storage gauge is red. */
  onClearTiles: () => void;
  /** #272: per-download tile zoom min/max. Drives the scale picker
   *  shown above the Download button so a worker can choose how
   *  detailed the cached basemap should be ("city scale" vs
   *  "parcel detail"). */
  tileZoomMin: number;
  tileZoomMax: number;
  onTileZoomMinChange: (z: number) => void;
  onTileZoomMaxChange: (z: number) => void;
  /** #272: live tile count for the chosen zoom range against the
   *  current viewport. Updated as the user adjusts the pickers
   *  so they see the storage consequence before tapping Download. */
  estimatedTileCount: number;
  /** Tile sources the provider will not let us pre-fetch. */
  blockedTileSources: Array<{ template: string; host: string; reason: string }>;
  /** #272: center latitude of the viewport. Drives the zoom-to-
   *  scale conversion so "1:1,128" reflects what the worker is
   *  actually looking at, not the equator-baseline. */
  centerLat: number;
  /** #71: prepared offline basemaps, owned by FieldRuntime. */
  offlineBasemap: OfflineBasemapState;
}) {
  // Group sources are headers, not togglable rows themselves -- but
  // we still show them so the panel reads like the desktop layer
  // tree. Per-row visibility only applies to leaf layers; toggling a
  // group is a polish item for later.
  const [basemapPickerOpen, setBasemapPickerOpen] = useState(false);
  const panelT = useT();
  const activeBasemap = basemaps.find((b) => b.id === currentBasemapId);
  return (
    // #257: layer panel converted to a bottom sheet (was a small
    // floating popover anchored to the Layers FAB at top-left).
    // Bottom-sheet matches the new feature popup pattern and gives
    // a thumb-friendly surface for outdoor use; the FAB stays as
    // the entry point. Default height ~60dvh; the panel scrolls
    // internally if content overflows.
    // #256: header + row text bumped to text-base for outdoor
    // visibility (was text-xs / text-sm). Touch targets (close
    // button, basemap chip, layer rows) all read at >= 44 px tall.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Layer visibility"
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[60dvh] flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
        <h3 className="text-base font-semibold text-ink-0">Layers</h3>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 items-center justify-center rounded text-ink-1 hover:bg-surface-2"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {/* One scroll container for the whole body, with the layer
          list FIRST. The panel is called Layers, and the list is
          what a collector opens it for; it used to sit below five
          fixed sections (basemap, detail pickers, download, prepared
          maps, storage) as the only scrollable child, so once those
          sections outgrew the sheet's 60dvh the list collapsed to
          zero height and the panel appeared to have no layers at
          all. Sections accrete; a shared scroller cannot be
          squeezed out by them (2026-08-24, found in field testing).
          */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="border-b border-border p-1">
        {(() => {
          // #249.21: filter the layer list for the field collection
          // context. Per request:
          //   - Table sublayers (geometryType === null on the
          //     underlying data_layer) are always-on and have no
          //     symbol; surfacing them here is noise and the toggle
          //     would be misleading anyway. Hide them outright.
          //   - Group headers whose every child got filtered are also
          //     hidden (an empty section header is just visual debt).
          // Compute the visible set once so we can both render and
          // know whether to render the empty state.
          const layerInfo = layers.map((l) => {
            const isGroup = l.source?.kind === 'group';
            let geometryType: LayerGeometryType = null;
            if (l.source?.kind === 'data-layer') {
              const src = l.source;
              const dl = editableLayers.find(
                (e) =>
                  e.dataLayerId === src.itemId &&
                  e.layerKey === src.layerKey,
              );
              geometryType = dl?.geometryType ?? null;
            } else if (!isGroup) {
              // Non-data-layer overlays (arcgis-rest, geojson-url):
              // we don't have a strict geometryType, but they're
              // always renderable -- treat them as polygon for
              // swatch purposes.
              geometryType = 'polygon';
            }
            const isTable =
              !isGroup &&
              l.source?.kind === 'data-layer' &&
              geometryType === null;
            return { layer: l, isGroup, isTable, geometryType };
          });
          // Drop tables entirely. Then drop group headers that have
          // no surviving children below them in the list. Walk
          // backwards so a group header at position i counts only
          // children at i+1+ that aren't another group header.
          const kept = layerInfo.filter((entry) => !entry.isTable);
          const finalSet: typeof kept = [];
          for (let i = 0; i < kept.length; i += 1) {
            const entry = kept[i]!;
            if (entry.isGroup) {
              // Look ahead: is there at least one non-group entry
              // before the next group header?
              let hasChild = false;
              for (let j = i + 1; j < kept.length; j += 1) {
                if (kept[j]!.isGroup) break;
                hasChild = true;
                break;
              }
              if (!hasChild) continue;
            }
            finalSet.push(entry);
          }
          if (finalSet.length === 0) {
            return (
              <li className="p-3 text-center text-sm text-muted">
                No layers in this map.
              </li>
            );
          }
          return finalSet.map(({ layer: l, isGroup, geometryType }) => {
            if (isGroup) {
              return (
                <li
                  key={l.id}
                  className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  {l.title}
                </li>
              );
            }
            const visible = l.visible && !hiddenLayerIds.has(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onToggle(l.id)}
                  className="flex min-h-[44px] w-full items-center gap-3 rounded px-2 py-2 text-left text-base hover:bg-surface-2"
                  aria-pressed={visible}
                >
                  {visible ? (
                    <Eye className="h-5 w-5 shrink-0 text-accent" />
                  ) : (
                    <EyeOff className="h-5 w-5 shrink-0 text-muted" />
                  )}
                  <LayerSwatch
                    layer={l}
                    dimmed={!visible}
                    geometryType={geometryType}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      visible ? 'text-ink-0' : 'text-muted line-through'
                    }`}
                  >
                    {l.title}
                  </span>
                </button>
              </li>
            );
          });
        })()}
        </ul>
      {/* Basemap chip at the top of the layer list (#223.8). Field
          workers reach for "swap to satellite" all the time; baking
          it into the layer panel keeps it one tap away without a
          dedicated tool button cluttering the canvas. Tapping the
          chip expands an inline picker; selection updates the
          runtime's session-only basemap override and the chip
          collapses back. Only renders when at least 2 basemaps are
          available -- one isn't a choice. */}
      {basemaps.length >= 2 ? (
        <div className="border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setBasemapPickerOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-0 px-3 py-2 text-left text-sm font-medium text-ink-0 hover:border-accent hover:text-accent"
            aria-expanded={basemapPickerOpen}
          >
            <Layers className="h-4 w-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              Basemap: {activeBasemap?.label ?? 'default'}
            </span>
            <span className="shrink-0 text-xs uppercase tracking-wide text-muted">
              {basemapPickerOpen ? 'Hide' : 'Change'}
            </span>
          </button>
          {basemapPickerOpen ? (
            <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border border-border bg-surface-0">
              {basemaps.map((b) => {
                const active = b.id === currentBasemapId;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onBasemapChange(b.id);
                        setBasemapPickerOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                        active
                          ? 'bg-accent/10 text-accent'
                          : 'text-ink-0 hover:bg-surface-2'
                      }`}
                      aria-pressed={active}
                    >
                      {b.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={b.thumbnailUrl}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded border border-border object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="h-6 w-6 shrink-0 rounded border border-border bg-surface-2"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.label}</span>
                      {active ? <Check className="h-3 w-3" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* #272: scale picker for the offline tile cache. Two paired
          dropdowns -- "least detailed" (zMin) and "most detailed"
          (zMax) -- each labeled with the user-facing map scale
          (1:1,128) and the engineering equivalent (1"=100 ft) at
          the viewport's center latitude. The zoom number rides
          along in parens for the technical user. The estimated
          tile count under the pickers updates live so the worker
          can see "this'll be 24,500 tiles" before tapping
          Download. */}
      <div className="border-b border-border px-3 py-2">
        {/* #74: the pickers only drive the tile-warm fallback. On
            the prepared path they wrote state that never left the
            component, which is a control that lies about doing
            something. Hidden rather than disabled: a disabled pair
            of selects begs the question of what would enable them,
            and the answer (delete the prepared area) is nothing a
            collector should be steered toward. */}
        {offlineBasemap.areas.some((a) => a.current) ? null : (<>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
          Map detail to cache
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">
              Least detail
            </span>
            <select
              value={tileZoomMin}
              onChange={(e) => onTileZoomMinChange(Number(e.target.value))}
              className="h-9 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0"
            >
              {ZOOM_PICKER_OPTIONS.filter((z) => z <= tileZoomMax).map((z) => (
                <option key={z} value={z}>
                  {describeZoom(z, centerLat)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">
              Most detail
            </span>
            <select
              value={tileZoomMax}
              onChange={(e) => onTileZoomMaxChange(Number(e.target.value))}
              className="h-9 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0"
            >
              {ZOOM_PICKER_OPTIONS.filter((z) => z >= tileZoomMin).map((z) => (
                <option key={z} value={z}>
                  {describeZoom(z, centerLat)}
                </option>
              ))}
            </select>
          </label>
        </div>
        </>)}
        {/* #71 review: the prepared-area branch comes FIRST. Before an
            archive is adopted, the live style is still the online
            basemap, so blockedTileSources is non-empty for exactly the
            deployments a prepared package rescues, and putting the
            warning first told the user their basemap would not work
            offline moments before a download made it work offline. */}
        {offlineBasemap.areas.some((a) => a.current) ? (
          <p className="mt-1.5 text-2xs text-muted">
            {offlineBasemap.areas.filter((a) => a.current).length === 1
              ? panelT('offlineBasemap.preparedNoticeOne')
              : panelT('offlineBasemap.preparedNoticeMany')}
          </p>
        ) : blockedTileSources.length > 0 ? (
          <div className="mt-1.5 rounded-md border border-warn/30 bg-warn/10 p-2">
            <p className="text-2xs font-medium text-warn">
              The basemap will not be available offline
            </p>
            {/* One line per distinct provider, not per template: a
                style can pull several URLs off one host and three
                identical sentences reads like a bug. */}
            {[...new Map(blockedTileSources.map((s) => [s.host, s])).values()].map(
              (s) => (
                <p key={s.host} className="mt-0.5 text-2xs text-muted">
                  {s.reason}
                </p>
              ),
            )}
            <p className="mt-1 text-2xs text-muted">
              Your data, forms and any self-hosted layers still download
              normally.
            </p>
          </div>
        ) : (
          <p className="mt-1.5 text-2xs text-muted">
            ~{estimatedTileCount.toLocaleString('en-US')} tiles at the
            current viewport. Cap is 200,000.
          </p>
        )}
      </div>
      <div className="border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-0 px-3 text-sm font-medium text-ink-0 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isDownloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CloudDownload className="h-4 w-4" />
          )}
          {cachedDeployment ? 'Refresh offline cache' : 'Download for offline'}
        </button>
        {cachedDeployment ? (
          <p className="mt-1 text-2xs text-muted">
            Cached {formatRelativeTime(cachedDeployment.cachedAt)} ·{' '}
            {formatBytes(cachedDeployment.estimatedSize)}
          </p>
        ) : null}
        {/* #71: the prepared basemap is a separate download from the
            data above, and a much bigger win. Self-hides when the
            author has prepared nothing. */}
        <OfflineBasemapRow state={offlineBasemap} />
      </div>
      {/* Slice 6 (persistence floor): storage gauge + persistence
          affordance. Only renders when we have real numbers; on
          unsupported browsers (older Safari, restricted WebViews)
          we show nothing rather than a misleading "0 / 0" reading. */}
      {storage && storage.available ? (
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted">
              Storage
            </span>
            {persistentState === 'best-effort' ? (
              <button
                type="button"
                onClick={onRequestPersist}
                className="text-2xs text-accent hover:underline"
              >
                Make persistent
              </button>
            ) : persistentState === 'persistent' ? (
              <span className="text-2xs text-success">Persistent</span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-ink-1">
            <span>{formatBytes(storage.usage)}</span>
            <span className="text-muted">of {formatBytes(storage.quota)}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={Math.round(storage.usagePercent * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-0"
          >
            <div
              className={`h-full transition-all ${
                storage.usagePercent >= 0.95
                  ? 'bg-danger'
                  : storage.usagePercent >= 0.8
                    ? 'bg-warn'
                    : 'bg-accent'
              }`}
              style={{
                width: `${Math.min(100, Math.round(storage.usagePercent * 100))}%`,
              }}
            />
          </div>
          {storage.usagePercent >= 0.95 ? (
            <p className="mt-1 text-2xs text-danger">
              Storage nearly full. Free up space before downloading more areas.
            </p>
          ) : null}
          {/* Slice 10: tile-cache breakdown surfaced inside the
              storage block so a user staring at the bar can answer
              "what's eating my quota" in one glance. The "Clear
              tiles" link drops only the SW tile cache; cached
              features + queued edits stay put because they're
              load-bearing for offline work. */}
          {tileCache && tileCache.count > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2 text-2xs text-muted">
              <span>
                Map tiles: {tileCache.count.toLocaleString()} (
                {formatBytes(tileCache.bytes)})
              </span>
              <button
                type="button"
                onClick={onClearTiles}
                className="text-2xs text-accent hover:underline"
              >
                Clear tiles
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

/**
 * Compact symbology swatch rendered next to a layer name in the
 * Layers panel. Three modes:
 *   - simple renderer: one filled square in the layer's primary
 *     color (polygon fill, then point, then line as fallback).
 *   - unique-values: up to three mini squares from the first three
 *     categories. A "+N" tooltip hint isn't surfaced visually
 *     (tight strip) but the panel can grow if categories matter.
 *   - class-breaks: a 3-step gradient strip taking the first, middle,
 *     and last colors so the user sees the range without us having
 *     to render every break.
 *
 * Designed to be ~14x14, fitting between the eye toggle and the
 * layer title without changing the row's vertical rhythm. When the
 * layer is hidden we drop opacity so the swatch reads as muted.
 */
function LayerSwatch({
  layer,
  dimmed,
  geometryType,
}: {
  layer: MapLayer;
  dimmed: boolean;
  /** #249.21: geometry type of the underlying sublayer. Drives the
   *  swatch shape (circle for point, stripe for line, square for
   *  polygon) so the legend matches what the worker sees on the
   *  map. Falls back to polygon when null/undefined. */
  geometryType?: LayerGeometryType;
}) {
  const geom = geometryType ?? 'polygon';
  // Pick a primary color for the simple-renderer fallback. Match the
  // geometry type: a point swatch should pull from style.point, a
  // polygon from style.polygon, a line from style.line. The earlier
  // fallback chain (polygon -> point -> line) was wrong for layers
  // whose actual geometry is point but whose style.polygon happens
  // to be populated with default values.
  const primary =
    geom === 'point'
      ? layer.style?.point?.color
      : geom === 'line'
        ? layer.style?.line?.color
        : layer.style?.polygon?.fillColor;
  const fallback =
    primary ||
    layer.style?.polygon?.fillColor ||
    layer.style?.point?.color ||
    layer.style?.line?.color ||
    '#6b7280';
  const stroke =
    (geom === 'point'
      ? layer.style?.point?.strokeColor
      : layer.style?.polygon?.strokeColor) ||
    layer.style?.line?.color ||
    '#374151';
  // #264: respect fillOpacity so an outline-only polygon (Riverside
  // Parcels has fillColor=blue but fillOpacity=0 + strokeColor=green;
  // the map paints invisible fill + green outline) shows the same
  // way in the swatch. Threshold at 0.15 -- below that the fill is
  // visually a no-op so we drop it and use the stroke color as the
  // border. The square stays square (geometry shape unchanged), it
  // just becomes a hollow outline that matches what's on screen.
  const fillOpacity = layer.style?.polygon?.fillOpacity ?? 1;
  const polygonHollow = geom === 'polygon' && fillOpacity < 0.15;
  const opacity = dimmed ? 0.4 : 1;

  // #249.21: geometry-shaped className. point -> filled circle,
  // line -> thin horizontal stripe, polygon -> rounded square.
  const baseShape =
    geom === 'point'
      ? 'h-3.5 w-3.5 rounded-full'
      : geom === 'line'
        ? 'h-1 w-4 rounded-full'
        : 'h-3.5 w-3.5 rounded-sm';

  // #264: polygon-with-transparent-fill renders as outline-only.
  // Border thickness is bumped to 2 so the color reads at the
  // 14px swatch size (1px borders disappear on hi-DPI screens).
  const polygonHollowProps = polygonHollow
    ? {
        backgroundColor: 'transparent',
        borderColor: stroke,
        borderWidth: 2,
        opacity,
      }
    : null;

  if (layer.renderer?.kind === 'unique-values') {
    const cats = layer.renderer.categories ?? [];
    const sample = cats.slice(0, 3);
    if (sample.length === 0) {
      return (
        <span
          aria-hidden="true"
          className={`${baseShape} shrink-0 border`}
          style={
            polygonHollowProps ?? {
              backgroundColor: fallback,
              borderColor: stroke,
              opacity,
            }
          }
        />
      );
    }
    return (
      <span
        aria-hidden="true"
        className="flex h-3.5 shrink-0 items-center gap-0.5"
        style={{ opacity }}
      >
        {sample.map((c, i) => (
          <span
            key={`${c.value}-${i}`}
            className="h-3.5 w-1.5 rounded-sm border border-black/20"
            style={{ backgroundColor: c.color }}
          />
        ))}
      </span>
    );
  }

  if (layer.renderer?.kind === 'class-breaks') {
    const colors = layer.renderer.colors ?? [];
    if (colors.length === 0) {
      return (
        <span
          aria-hidden="true"
          className={`${baseShape} shrink-0 border`}
          style={
            polygonHollowProps ?? {
              backgroundColor: fallback,
              borderColor: stroke,
              opacity,
            }
          }
        />
      );
    }
    // Three-step strip: first, middle, last.
    const mid = colors[Math.floor(colors.length / 2)] ?? colors[0]!;
    const stops = [colors[0]!, mid, colors[colors.length - 1]!];
    return (
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-sm border border-black/20"
        style={{ opacity }}
      >
        {stops.map((c, i) => (
          <span key={i} className="h-full flex-1" style={{ backgroundColor: c }} />
        ))}
      </span>
    );
  }

  // simple renderer (or no renderer): one swatch shaped to the
  // underlying geometry so the legend reads as the same symbology
  // the worker sees on the canvas.
  return (
    <span
      aria-hidden="true"
      className={`${baseShape} shrink-0 border`}
      style={
        polygonHollowProps ?? {
          backgroundColor: fallback,
          borderColor: stroke,
          opacity,
        }
      }
    />
  );
}

/**
 * Form modal: full-screen on mobile, right-side panel on desktop. Uses
 * FormRuntime under the hood with whichever schema applies (bound or
 * auto-derived). For add-mode, the active template's presetAttributes
 * are merged into the initial response so the categorical field
 * driving the renderer comes pre-filled. Submission posts (add) or
 * patches (edit) against the v3 features endpoint, then notifies the
 * parent so it can refresh the map.
 */
function FormModal({
  dataCollectionId,
  modal,
  pickLists,
  boundForms,
  currentUserId,
  isOnline,
  gpsPosition,
  editableLayers,
  onAddRelated,
  onOpenRelated,
  onClose,
  onSubmitted,
  onLocalWriteApplied,
  onUpdateGeometry,
}: {
  dataCollectionId: string;
  modal:
    | {
        layer: EditableLayer;
        mode: 'add';
        geometry: GeoJSON.Geometry | null;
        presetAttributes: Record<string, string>;
      }
    | {
        layer: EditableLayer;
        mode: 'edit';
        featureId: string;
        properties: Record<string, unknown>;
        geometry: GeoJSON.Geometry | null;
      };
  pickLists: Record<string, PickListData>;
  boundForms: Record<string, FormSchema>;
  currentUserId: string;
  /** Whether the runtime is currently online. Drives the choice
   *  between direct write and enqueue-to-sync-later. */
  isOnline: boolean;
  /** Latest GPS fix at the time the form opened. Stamped onto
   *  add-mode features (Phase A4) so survey-style workflows preserve
   *  fix accuracy + altitude + heading + timestamp alongside the
   *  geometry. Null when the user hasn't enabled location. */
  gpsPosition: GpsPosition | null;
  /** Phase C: full editable-layer list so the modal can resolve a
   *  child layer key to its full EditableLayer (with fields, form
   *  binding, etc.) when the user taps "Add related." */
  editableLayers: EditableLayer[];
  /** Phase C: open a fresh add-mode modal for a child layer with the
   *  parent FK pre-filled. Runtime owns the actual setFormModal call
   *  because it also has to clear pendingMarker, ease the camera,
   *  etc. */
  onAddRelated: (
    childLayer: EditableLayer,
    parentFkColumn: string,
    parentFeatureId: string,
  ) => void;
  /** #247: open the FormModal in edit mode for an existing related
   *  row. The runtime owns the camera + pendingMarker housekeeping
   *  (same reasoning as onAddRelated) so the modal hands off the
   *  full feature shape and the runtime decides what to do with it. */
  onOpenRelated: (
    childLayer: EditableLayer,
    feature: {
      id: string;
      properties: Record<string, unknown>;
      geometry: GeoJSON.Geometry | null;
    },
  ) => void;
  onClose: () => void;
  onSubmitted: () => void;
  /** Fires after an offline write (or an online write that fell
   *  back to the queue) has been applied locally. The runtime uses
   *  this to bump its offline-feature refresh counter so the new /
   *  edited feature appears on the map without a manual reload. */
  onLocalWriteApplied: () => void;
  /** #249: invoked when the user taps "Update Point" inside the
   *  form sheet. Lets the runtime move the pendingMarker so the map
   *  stays in sync with whatever the form thinks the position is.
   *  Only fires for Point-geometry add flows. */
  onUpdateGeometry: (geom: GeoJSON.Geometry) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // #249: working copy of the feature's geometry. The Field Maps
  // pattern lets the user re-snap the position to the current GPS
  // fix from inside the form (the "Update Point" button) instead of
  // committing the location up front. We start from whatever the
  // runtime handed us (GPS-at-open or map-center fallback) and let
  // the user revise without canceling out of the form.
  const [activeGeometry, setActiveGeometry] = useState<
    GeoJSON.Geometry | null
  >(modal.geometry);
  // #249: keep activeGeometry in sync with modal.geometry so a parent
  // update (e.g. tap-on-map-to-override) flows into the coord readout
  // without remounting the modal. The "Update Point" button still
  // calls setActiveGeometry directly for snappy in-form feedback;
  // the parent's onUpdateGeometry callback echoes the same value
  // back through modal.geometry, so this effect ends up as a no-op
  // for the GPS-resnap path.
  useEffect(() => {
    setActiveGeometry(modal.geometry);
  }, [modal.geometry]);

  // #247 / #265 / #266: in edit mode, build the related-records list
  // per child layer. Logic extracted to useRelatedRowsByChild so the
  // popup bottom sheet (#265) can render the same list on a tap-on-
  // feature gesture without going through the form modal first.
  const relatedRowsByChild = useRelatedRowsByChild({
    parentDataLayerId:
      modal.mode === 'edit' ? modal.layer.dataLayerId : null,
    parentId: modal.mode === 'edit' ? modal.featureId : null,
    childLayers: modal.layer.childLayers,
    dataCollectionId,
    isOnline,
  });

  const form = useMemo<FormSchema>(() => {
    let base: FormSchema;
    if (modal.layer.boundFormItemId) {
      const bound = boundForms[modal.layer.boundFormItemId];
      if (bound) base = bound;
      else {
        base = generateFormFromLayer(
          {
            key: modal.layer.layerKey,
            label: modal.layer.layerLabel,
            fields: modal.layer.fields.map(layerFieldToGeneratorInput),
          },
          {
            dataLayerId: modal.layer.dataLayerId,
            formId: modal.layer.layerKey,
          },
        );
      }
    } else {
      base = generateFormFromLayer(
        {
          key: modal.layer.layerKey,
          label: modal.layer.layerLabel,
          fields: modal.layer.fields.map(layerFieldToGeneratorInput),
        },
        {
          dataLayerId: modal.layer.dataLayerId,
          formId: modal.layer.layerKey,
        },
      );
    }
    return resolvePickListChoices(base, pickLists);
  }, [modal.layer, boundForms, pickLists]);

  // Hydrate the initial response. Edit mode pre-fills from the tapped
  // feature's properties; add mode uses the template's presetAttributes
  // so the categorical column driving the renderer comes pre-filled
  // (Field Maps editing-template convention).
  const initial = useMemo<FormResponse>(() => {
    if (modal.mode === 'edit') return { ...modal.properties };
    return { ...modal.presetAttributes };
  }, [modal]);

  async function handleSubmit(response: FormResponse) {
    setError(null);
    // GPS fix metadata stamping (#225 item 3). For add-mode features
    // only -- on edit, the existing fix was the one that mattered.
    // Walk the layer's declared fields and populate any whose name
    // matches a canonical GPS metadata key (case-insensitive) from
    // the live position. This way admins opt in by adding columns
    // with familiar names (h_accuracy, fix_at, position_source_type,
    // ...); we don't write columns the layer doesn't have, so the
    // attribute table stays the schema's source of truth.
    //
    // Recognized aliases per slot (case-insensitive, leading-underscore
    // tolerated for backwards compat with Phase A's private convention):
    //   - longitude / lon / x / gps_lon         → position.lon
    //   - latitude  / lat / y / gps_lat         → position.lat
    //   - h_accuracy / horizontal_accuracy /
    //     horiz_accuracy / accuracy / gps_accuracy_m
    //                                           → position.accuracyM
    //   - altitude / alt / alt_m / z / gps_altitude_m
    //                                           → position.altitudeM
    //   - v_accuracy / vertical_accuracy /
    //     vert_accuracy / altitude_accuracy /
    //     gps_altitude_accuracy_m               → position.altitudeAccuracyM
    //   - heading / heading_deg / gps_heading_deg
    //                                           → position.headingDeg
    //   - speed / speed_mps / gps_speed_mps     → position.speedMps
    //   - fix_at / captured_at / gps_fix_at     → ISO timestamp
    //   - position_source_type                  → "browser-geolocation"
    //   - capture_method                        → "point-collected"
    //
    // Form-supplied values always win (a user typing into a captured_at
    // field overrides our stamp); we only fill blanks.
    // Merge presetAttributes UNDER the form response so system-set
    // keys that the form doesn't surface (e.g. the parentFkColumn
    // that wires a related Status row to its parent Inspection
    // Point -- the auto-form-from-schema doesn't render a question
    // for it because it's not a user-declared field, but the value
    // still needs to land on the saved row). Form values still win
    // on collision (a preset can be overridden by typing). Edit
    // mode skips presets: the existing properties are the source
    // of truth and presets aren't carried into edit anyway.
    // #268 / #269: this fix keeps the parentFK on the saved row so
    // the related-records list filter sees the correct value AND
    // re-opening the row doesn't show empty fields.
    const responseWithPresets: FormResponse =
      modal.mode === 'add'
        ? { ...modal.presetAttributes, ...response }
        : response;
    const gpsStamped: FormResponse =
      modal.mode === 'add' && gpsPosition
        ? stampGpsMetadata(modal.layer.fields, responseWithPresets, gpsPosition)
        : responseWithPresets;
    // Submission bookkeeping, on adds only (an edit keeps the row's
    // original submitted_at). This path writes to the feature endpoint
    // rather than through the forms service, so nothing else fills
    // `submitted_at` / `submitted_by`: an offline-captured row and an
    // online one described the same act differently, and the responses
    // view has been papering over it by falling back to _created_at.
    //
    // Stamped HERE, above the online / queued fork, so both branches
    // send the same properties. Doing it in one branch is how the two
    // diverged in the first place.
    const properties: FormResponse =
      modal.mode === 'add'
        ? (stampSubmissionMetadata(modal.layer.fields, gpsStamped, {
            userId: currentUserId,
            // Capture time, not sync time. Offline is the only place
            // that knows the difference and it is the one that counts.
            capturedAt: new Date().toISOString(),
          }) as FormResponse)
        : gpsStamped;
    // Identity. For inserts we generate the globalId client-side so
    // the queue and the local feature row share a key with the
    // eventual server row -- a re-drained queue (or a sync that
    // succeeded server-side but lost the success response) doesn't
    // double-create. The portal-api COALESCEs against gen_random_uuid()
    // so the server accepts our id directly.
    const featureId =
      modal.mode === 'add' ? newGlobalId() : modal.featureId;
    // Schema hash on the queued record lets sync detect drift later
    // (Slice 5 doesn't act on it yet, but capturing it now means an
    // upgraded portal can reconcile without a queue migration).
    const schemaHash = await hashLayerSchema(modal.layer.fields);

    // Local apply path (used by both offline mode and online mode's
    // network-failure fallback). Enqueues the operation, writes the
    // feature into IndexedDB so it's visible on the map immediately,
    // and bumps the runtime's refresh counter via the callback.
    const applyLocally = async (): Promise<void> => {
      // enqueueEdit, not a raw put. The queue can hold an earlier
      // unsynced edit for this same feature, and folding the two
      // inside one transaction is what keeps an offline capture that
      // the user then corrects from being replaced by an update
      // against a globalId the server has never seen. A raw put here
      // is the original data-loss bug.
      const enqueued = await enqueueEdit({
        dataCollectionId,
        op: modal.mode === 'add' ? 'insert' : 'update',
        dataLayerId: modal.layer.dataLayerId,
        layerKey: modal.layer.layerKey,
        globalId: featureId,
        geometry: activeGeometry,
        properties,
        schemaHash,
      });
      // The fold keeps the original capture time, so the cached
      // feature's timestamps must come from the surviving row rather
      // than from now, or the map and the queue disagree about when
      // the observation was made.
      const queuedAt =
        enqueued.kind === 'annihilated'
          ? new Date().toISOString()
          : enqueued.record.queuedAt;
      // Mirror into the cached features store so the map shows the
      // feature on next render. For inserts this is a fresh row; for
      // updates it overwrites the prior cached copy under the same
      // composite key. The properties carry _global_id so the popup
      // and the existing feature-id resolution paths keep working.
      const cachedFeature: CachedFeature = {
        dataCollectionId,
        dataLayerId: modal.layer.dataLayerId,
        layerKey: modal.layer.layerKey,
        globalId: featureId,
        feature: {
          type: 'Feature',
          id: featureId,
          geometry: activeGeometry as GeoJSON.Geometry,
          properties: {
            ...properties,
            _global_id: featureId,
            _created_by: currentUserId,
            _edited_by: currentUserId,
            _created_at: queuedAt,
            _edited_at: new Date().toISOString(),
          },
        },
        cachedAt: queuedAt,
      };
      await putFeatures([cachedFeature]);
      onLocalWriteApplied();
    };

    try {
      if (isOnline) {
        // Online path. Try the live API first. On non-2xx (validation
        // error, schema mismatch, anything 4xx) we propagate to the
        // user so they can fix and retry; this is NOT a queue case.
        // On a network-level failure (TypeError from fetch) we DO
        // fall back to the queue so the edit is preserved.
        if (modal.mode === 'add') {
          let res: Response;
          try {
            res = await fetch(
              `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
                modal.layer.layerKey,
              )}/features`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  // x-data-collection-id triggers the
                  // data_collection_feature_created notification (#229)
                  // server-side. Carries the deployment id so the
                  // BFF passthrough can forward it to portal-api.
                  'x-data-collection-id': dataCollectionId,
                },
                body: JSON.stringify({
                  features: [
                    {
                      globalId: featureId,
                      geometry: activeGeometry,
                      properties,
                    },
                  ],
                }),
              },
            );
          } catch {
            // Likely network failure during a transient blip. Stash
            // it in the queue so it doesn't get lost; auto-sync will
            // retry as soon as the radio comes back.
            await applyLocally();
            onSubmitted();
            return;
          }
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Could not save'));
          }
        } else {
          let res: Response;
          try {
            res = await fetch(
              `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
                modal.layer.layerKey,
              )}/features/${modal.featureId}`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ properties }),
              },
            );
          } catch {
            await applyLocally();
            onSubmitted();
            return;
          }
          if (!res.ok) {
            throw new Error(await parseApiError(res, 'Could not save'));
          }
        }
      } else {
        // Offline path. The browser reports !navigator.onLine so we
        // know the network is down; skip the doomed fetch and go
        // straight to the queue. The user sees the same "submitted"
        // success state as online; the difference is the edit lives
        // in IndexedDB until sync runs.
        await applyLocally();
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed.');
      throw err; // FormRuntime needs to know the submit failed so it doesn't render the success state
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        modal.mode === 'add'
          ? `Add ${modal.layer.layerLabel}`
          : `Edit ${modal.layer.layerLabel}`
      }
      // #249: bottom-anchored only. Field Maps doesn't dim the map
      // while a collect is in progress -- the collector wants to keep
      // panning, zooming, and (next slice) tap-to-override the
      // location while the form is open. Drop the full-viewport
      // wrapper that captured every tap; Cancel in the header is the
      // dismiss path now. inset-x-0 + bottom-0 keeps the sheet
      // pinned to the bottom edge across iPhone safe-area variants.
      className="fixed inset-x-0 bottom-0 z-30 flex flex-col"
    >
      <div
        className="flex max-h-[60vh] w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)] sm:max-h-[55vh]"
      >
        {/* #249: Field Maps-style three-section header for the active
            collect. Cancel (left, text button) | layer-name title
            (center) | Submit (right, text button). The Submit button
            doesn't sit inside the FormRuntime tree -- it associates
            via the formId prop / HTML form attribute, so the click
            triggers the form's existing onSubmit + validation. The
            FormRuntime's own submit button stays at the bottom of
            the scroll for users who reach the end of a long form. */}
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-1 px-2 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-md px-3 text-base font-medium text-accent hover:bg-surface-2"
          >
            Cancel
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h2 className="truncate text-base font-semibold text-ink-0">
              {modal.mode === 'add'
                ? `New ${modal.layer.layerLabel}`
                : `Edit ${modal.layer.layerLabel}`}
            </h2>
            <p className="truncate text-2xs text-muted">
              {modal.layer.dataLayerTitle}
            </p>
          </div>
          <button
            type="submit"
            form={`field-form-${modal.layer.layerKey}`}
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-md px-3 text-base font-semibold text-accent hover:bg-surface-2"
          >
            Submit
          </button>
        </header>
        {/* #249: Field Maps-style location bar. Shows the current
            position of the feature (lat/lon) and lets the worker
            re-snap to the live GPS fix without canceling out of the
            form. Only meaningful for Point geometries; for polygons /
            lines the geometry is multi-vertex and "Update Point" has
            no clear semantics. Add-mode only -- on edit, the geometry
            of an existing row isn't changed from inside the attribute
            form (geometry editing has its own tool). */}
        {modal.mode === 'add' && modal.layer.geometryType === 'point' ? (
          <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-0 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-2xs font-medium uppercase tracking-wide text-muted">
                Location
              </p>
              <p className="truncate font-mono text-sm tabular-nums text-ink-0">
                {(() => {
                  const coords =
                    activeGeometry &&
                    'coordinates' in activeGeometry &&
                    Array.isArray(activeGeometry.coordinates) &&
                    typeof activeGeometry.coordinates[0] === 'number' &&
                    typeof activeGeometry.coordinates[1] === 'number'
                      ? (activeGeometry.coordinates as [number, number])
                      : null;
                  if (!coords) return 'Not set';
                  const [lon, lat] = coords;
                  return `${lat.toFixed(6)}°N  ${lon.toFixed(6)}°W`;
                })()}
              </p>
            </div>
            <button
              type="button"
              disabled={!gpsPosition}
              onClick={() => {
                if (!gpsPosition) return;
                const next: GeoJSON.Geometry = {
                  type: 'Point',
                  coordinates: [gpsPosition.lon, gpsPosition.lat],
                };
                setActiveGeometry(next);
                onUpdateGeometry(next);
              }}
              title={
                gpsPosition
                  ? `Re-snap to current GPS (~${
                      gpsPosition.accuracyM < 1
                        ? '<1'
                        : Math.round(gpsPosition.accuracyM)
                    } m)`
                  : 'Enable location to use GPS'
              }
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              <LocateFixed className="h-4 w-4" />
              Update Point
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <FormRuntime
            form={form}
            initial={initial}
            onSubmit={handleSubmit}
            submitLabel={modal.mode === 'add' ? 'Save feature' : 'Save changes'}
            formId={`field-form-${modal.layer.layerKey}`}
            // #249.14: header already has a Submit button. The
            // FormRuntime's bottom Submit was reading as a duplicate
            // ("what's the difference between Save Feature and
            // Submit?" - Matt). Suppress the bottom button; the
            // small "Submitting..." indicator the runtime renders
            // in its place keeps in-flight feedback visible.
            hideSubmitButton
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}
          {/* Phase B: per-feature attachments. Only mounted in edit
              mode because attachments need a server-side feature row
              to register against (the API path is keyed by featureId).
              Add-mode features get a fresh global id but the
              attachment endpoint requires the row to exist first;
              users can save the feature, the form re-opens in edit
              mode for picture/audio/video uploads. Online-only for
              now: the offline buffer for blobs is queued separately
              (#200). */}
          {modal.mode === 'edit' ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-1">
                Attachments
              </p>
              <V3FeatureAttachments
                itemId={modal.layer.dataLayerId}
                layerId={modal.layer.layerKey}
                featureId={modal.featureId}
                canEdit={true}
              />
            </div>
          ) : null}
          {/* Phase C: child layers in the same data_layer that
              reference this layer via parentFkColumn. Each row is
              a quick-add affordance: tap to drop a fresh child
              record under this feature, with the FK column already
              filled in. Children that aren't editable in this
              deployment (table-only sublayer or restricted
              editingPolicy) are still listed but with the Add
              button disabled so the user knows they exist. */}
          {modal.mode === 'edit' &&
          (modal.layer.childLayers ?? []).length > 0 ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-1">
                Related records
              </p>
              <div className="space-y-4">
                {(modal.layer.childLayers ?? []).map((c) => {
                  const childEditable = editableLayers.find(
                    (e) =>
                      e.dataLayerId === modal.layer.dataLayerId &&
                      e.layerKey === c.layerKey,
                  );
                  const state = relatedRowsByChild[c.layerKey];
                  const count = state?.rows.length ?? 0;
                  return (
                    <div key={c.layerKey} className="space-y-2">
                      {/* #247 / #249.21: per-child header row. Bumped
                          to text-base for the layer name + thumb-
                          friendly Add button, since this is a primary
                          field-collection action read at arm's length
                          outdoors. */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 truncate text-base font-semibold text-ink-0">
                            {c.layerLabel}
                            {state && !state.loading && !state.error ? (
                              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-ink-1">
                                {count}
                              </span>
                            ) : null}
                            {state?.loading ? (
                              <Loader2 className="h-4 w-4 animate-spin text-muted" />
                            ) : null}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={!childEditable}
                          onClick={() => {
                            if (!childEditable) return;
                            onAddRelated(
                              childEditable,
                              c.parentFkColumn,
                              modal.featureId,
                            );
                          }}
                          title={
                            childEditable
                              ? `Add a new ${c.layerLabel} record under this feature`
                              : 'This child layer is not editable in this deployment'
                          }
                          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Plus className="h-4 w-4" />
                          Add
                        </button>
                      </div>
                      {/* #247 / #249.21: existing-row list. Bumped to
                          text-base for outdoor visibility; row min-h
                          enforces a 44 px thumb target. */}
                      {state && !state.loading ? (
                        state.error ? (
                          <p className="text-sm text-danger">
                            Couldn&apos;t load existing {c.layerLabel}
                            {' '}records ({state.error}). Tap Add to
                            create a new one.
                          </p>
                        ) : state.rows.length === 0 ? (
                          <p className="text-sm text-muted">
                            No {c.layerLabel.toLowerCase()} records yet.
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            {state.rows.map((row) => {
                              // #266: rows sourced from the offline queue
                              // are tagged with _pending. Show an
                              // "(unsynced)" badge so the worker can tell
                              // their just-captured row apart from the
                              // synced ones, and disable Open since the
                              // server-side feature does not exist yet
                              // (the form runtime hydrates from the API,
                              // not from the IDB queue).
                              const pending = row._pending === true;
                              return (
                                <li
                                  key={row.id}
                                  className={
                                    'flex min-h-[44px] items-center justify-between gap-2 rounded-md border px-3 py-2 ' +
                                    (pending
                                      ? 'border-warn/40 bg-warn/10'
                                      : 'border-border bg-surface-0')
                                  }
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-base text-ink-0">
                                      {pickRelatedRowTitle(row.properties) ??
                                        row.id.slice(0, 8)}
                                      {pending ? (
                                        <span className="ml-2 inline-flex items-center rounded bg-warn/25 px-1.5 py-0.5 text-xs font-medium text-warn">
                                          unsynced
                                        </span>
                                      ) : null}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={!childEditable || pending}
                                    onClick={() => {
                                      if (!childEditable || pending) return;
                                      onOpenRelated(childEditable, row);
                                    }}
                                    title={
                                      pending
                                        ? 'This record is waiting to sync. It will be openable once it reaches the server.'
                                        : childEditable
                                          ? `Open this ${c.layerLabel} record`
                                          : 'This child layer is not editable in this deployment'
                                    }
                                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                                  >
                                    Open
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Locate-me FAB. Bottom-left of the canvas, opposite the layer-toggle
 * button at top-left so the worker's thumb stays in one corner per
 * action class. Three visual states tied to the GPS hook:
 *
 *   - idle / requesting / denied -> outlined icon, neutral tint
 *   - watching, follow=false     -> outlined icon, accent tint
 *   - follow=true                -> filled accent + small "live" pulse
 *
 * Tap behavior is controlled entirely by the parent (the runtime
 * decides whether to start, recenter, or toggle follow); this
 * component just renders the appropriate visual.
 */
function FieldLocateButton({
  gpsStatus,
  hasPosition,
  follow,
  accuracyM,
  onTap,
}: {
  gpsStatus: import('./use-geolocation').GpsStatus;
  hasPosition: boolean;
  follow: boolean;
  accuracyM: number | null;
  onTap: () => void;
}) {
  const tone =
    gpsStatus === 'denied' || gpsStatus === 'unavailable'
      ? 'bg-surface-1 border-border text-muted'
      : follow
        ? 'bg-accent border-accent text-accent-foreground'
        : hasPosition
          ? 'bg-surface-1 border-border text-accent'
          : 'bg-surface-1 border-border text-ink-1';
  const label =
    gpsStatus === 'idle'
      ? 'Show my location'
      : gpsStatus === 'requesting'
        ? 'Acquiring location'
        : gpsStatus === 'denied'
          ? 'Location permission denied'
          : gpsStatus === 'unavailable'
            ? 'Location unavailable'
            : follow
              ? 'Following location (tap to stop)'
              : hasPosition
                ? `Center on my location (~${
                    accuracyM === null
                      ? 'unknown'
                      : accuracyM < 1
                        ? '<1'
                        : Math.round(accuracyM)
                  } m)`
                : 'Show my location';
  return (
    <button
      type="button"
      onClick={onTap}
      title={label}
      aria-label={label}
      aria-pressed={follow}
      disabled={
        gpsStatus === 'requesting' ||
        gpsStatus === 'denied' ||
        gpsStatus === 'unavailable'
      }
      // #249.13: locate button moved from bottom-left to top-right,
      // anchored just below the zoom + compass cluster. Per Matt:
      // most users scan a map left-to-right across the top then down
      // the right rail, so grouping the GPS affordance with the zoom
      // controls matches that flow.
      // #249.14: sized to h-11 w-11 to match the Layers + Search
      // buttons at top-left -- consistent thumb target across all
      // map controls. The locate button keeps the rounded-full
      // shape (not square like the other two) because its filled
      // accent state needs to read as "live tracking" -- a circle
      // is the conventional shape for that.
      // #249.15: top-44 = 11rem clears the three-button zoom cluster
      // (top-3 + 3 * h-11 + a few pixels of internal border) with
      // the same 8-12px breathing room the rest of the layout uses.
      className={`absolute right-3 top-44 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border shadow-card transition-colors disabled:opacity-50 ${tone}`}
    >
      {gpsStatus === 'requesting' ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : follow ? (
        <Crosshair className="h-5 w-5" />
      ) : (
        <LocateFixed className="h-5 w-5" />
      )}
    </button>
  );
}

/**
 * #253: Field-Maps-style feature popup. Bottom sheet rendered when
 * the user taps a feature on the canvas. Two modes:
 *
 *   - list: tapped a point with multiple overlapping features.
 *     Renders one row per hit with the layer label as a header
 *     group, the row's title (first non-system property), and a
 *     chevron. Tap a row to drill into detail.
 *   - detail: single feature view. Header has back arrow (when
 *     coming from a list), feature title, and X close. Body shows
 *     the full attribute table; an action bar at top has Edit /
 *     Copy / Delete (Delete is a follow-up).
 *
 * Two height states: default (~55vh) and expanded (~92vh). The
 * chevron in the header toggles. Tap-on-backdrop is intentionally
 * NOT a dismiss path -- a stray tap on the map shouldn't lose the
 * worker's feature context. X is the dismiss.
 */
function FieldFeaturePopupSheet({
  state,
  dataCollectionId,
  isOnline,
  editableLayers,
  onChangeState,
  onClose,
  onEdit,
  onCopy,
  onOpenRelated,
}: {
  state: NonNullable<
    | { mode: 'list'; hits: Array<unknown>; expanded: boolean }
    | {
        mode: 'detail';
        hit: unknown;
        from: 'list' | 'direct';
        listHits: Array<unknown>;
        expanded: boolean;
      }
  >;
  /** #265: data_collection id for the offline-queue read in
   *  useRelatedRowsByChild. Same value that the runtime hands to the
   *  FormModal. */
  dataCollectionId: string;
  /** #265: drives whether the related-records hook fetches from the
   *  API or only renders queued offline rows. */
  isOnline: boolean;
  /** #265: the runtime's full editable-layer list. The popup looks up
   *  a child layer key against this when the user taps a related row
   *  so the FormModal can open with the full EditableLayer (fields,
   *  form binding, etc.). */
  editableLayers: EditableLayer[];
  onChangeState: (
    next:
      | null
      | {
          mode: 'list';
          hits: Array<{
            mapLayerId: string;
            layerLabel: string;
            globalId: string | null;
            properties: Record<string, unknown>;
            geometry: GeoJSON.Geometry | null;
            editable: EditableLayer | null;
          }>;
          expanded: boolean;
        }
      | {
          mode: 'detail';
          hit: {
            mapLayerId: string;
            layerLabel: string;
            globalId: string | null;
            properties: Record<string, unknown>;
            geometry: GeoJSON.Geometry | null;
            editable: EditableLayer | null;
          };
          from: 'list' | 'direct';
          listHits: Array<{
            mapLayerId: string;
            layerLabel: string;
            globalId: string | null;
            properties: Record<string, unknown>;
            geometry: GeoJSON.Geometry | null;
            editable: EditableLayer | null;
          }>;
          expanded: boolean;
        },
  ) => void;
  onClose: () => void;
  onEdit: (hit: {
    mapLayerId: string;
    layerLabel: string;
    globalId: string | null;
    properties: Record<string, unknown>;
    geometry: GeoJSON.Geometry | null;
    editable: EditableLayer | null;
  }) => void;
  onCopy: (hit: {
    mapLayerId: string;
    layerLabel: string;
    globalId: string | null;
    properties: Record<string, unknown>;
    geometry: GeoJSON.Geometry | null;
    editable: EditableLayer | null;
  }) => void;
  /** #265: open a child related record straight from the popup. The
   *  runtime owns the FormModal so the popup just hands off the
   *  resolved (childLayer, feature) pair. */
  onOpenRelated: (
    childLayer: EditableLayer,
    feature: {
      id: string;
      properties: Record<string, unknown>;
      geometry: GeoJSON.Geometry | null;
    },
  ) => void;
}) {
  // Cast through unknown to the concrete shape the parent passes; the
  // public prop type uses unknown to avoid duplicating the type alias
  // outside the parent's lexical scope.
  type Hit = {
    mapLayerId: string;
    layerLabel: string;
    globalId: string | null;
    properties: Record<string, unknown>;
    geometry: GeoJSON.Geometry | null;
    editable: EditableLayer | null;
  };
  const concrete = state as
    | { mode: 'list'; hits: Hit[]; expanded: boolean }
    | {
        mode: 'detail';
        hit: Hit;
        from: 'list' | 'direct';
        listHits: Hit[];
        expanded: boolean;
      };

  const expanded = concrete.expanded;
  const sheetClass = expanded
    ? 'max-h-[92dvh] min-h-[92dvh]'
    : 'max-h-[55dvh] min-h-[55dvh]';

  // #265: in detail mode, surface the parent feature's child-layer
  // rows under the attribute table. We pull the editable layer's
  // childLayers descriptor (the same one the FormModal uses) and
  // pass parentDataLayerId + parentId to the shared hook. Hook is
  // called unconditionally so React's rules-of-hooks stay happy in
  // list mode (the hook's first guard short-circuits on a null
  // parentId).
  const detailHit = concrete.mode === 'detail' ? concrete.hit : null;
  const parentEditable =
    detailHit && detailHit.editable && detailHit.globalId
      ? detailHit.editable
      : null;
  const relatedRowsByChild = useRelatedRowsByChild({
    parentDataLayerId: parentEditable?.dataLayerId ?? null,
    parentId:
      parentEditable && detailHit?.globalId ? detailHit.globalId : null,
    childLayers: parentEditable?.childLayers,
    dataCollectionId,
    isOnline,
  });

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 flex flex-col"
      // The sheet itself blocks the canvas; backdrop area above is
      // pointer-events-none so the user can still tap the map (which
      // queries new features and replaces the sheet).
    >
      <div
        className={`flex w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)] ${sheetClass}`}
      >
        {/* Header: back-or-X button on the left, title in the
            middle, expand-chevron + X on the right. The back button
            only appears when we drilled in from a list. */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2 py-2.5">
          {concrete.mode === 'detail' && concrete.from === 'list' ? (
            <button
              type="button"
              onClick={() => {
                onChangeState({
                  mode: 'list',
                  hits: concrete.listHits,
                  expanded: concrete.expanded,
                });
              }}
              aria-label="Back to list"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <span className="h-10 w-10 shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1 text-center">
            {concrete.mode === 'list' ? (
              <h2 className="truncate text-base font-semibold text-ink-0">
                {concrete.hits.length} item
                {concrete.hits.length === 1 ? '' : 's'}
              </h2>
            ) : (
              <>
                <h2 className="truncate text-base font-semibold text-ink-0">
                  {pickRelatedRowTitle(concrete.hit.properties) ??
                    concrete.hit.layerLabel}
                </h2>
                <p className="truncate text-2xs text-muted">
                  {concrete.hit.layerLabel}
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onChangeState({
                ...concrete,
                expanded: !concrete.expanded,
              } as typeof concrete);
            }}
            aria-label={expanded ? 'Collapse sheet' : 'Expand sheet'}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          >
            <ChevronUp
              className={`h-5 w-5 transition-transform ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Action bar (detail mode only). Edit / Copy as primary;
            the More menu can land in a follow-up. */}
        {concrete.mode === 'detail' ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-0 px-3 py-2">
            <button
              type="button"
              disabled={
                !concrete.hit.editable || !concrete.hit.globalId
              }
              onClick={() => onEdit(concrete.hit)}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              title={
                concrete.hit.editable
                  ? 'Edit this feature'
                  : 'You do not have edit access to this layer'
              }
            >
              <Crosshair className="h-4 w-4" />
              Edit
            </button>
            <button
              type="button"
              disabled={!concrete.hit.editable}
              onClick={() => onCopy(concrete.hit)}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              title={
                concrete.hit.editable
                  ? 'Create a new feature with these attributes'
                  : 'You do not have edit access to this layer'
              }
            >
              <Plus className="h-4 w-4" />
              Copy
            </button>
          </div>
        ) : null}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {concrete.mode === 'list' ? (
            <ul className="divide-y divide-border">
              {concrete.hits.map((hit, i) => (
                <li key={`${hit.mapLayerId}-${hit.globalId ?? i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onChangeState({
                        mode: 'detail',
                        hit,
                        from: 'list',
                        listHits: concrete.hits,
                        expanded: concrete.expanded,
                      });
                    }}
                    className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-2xs font-semibold uppercase tracking-wide text-muted">
                        {hit.layerLabel}
                      </p>
                      <p className="truncate text-base font-medium text-ink-0">
                        {pickRelatedRowTitle(hit.properties) ??
                          hit.globalId?.slice(0, 8) ??
                          '(unnamed)'}
                      </p>
                    </div>
                    <ChevronUp
                      className="mt-1 h-4 w-4 shrink-0 rotate-90 text-muted"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <dl className="divide-y divide-border">
                {Object.entries(concrete.hit.properties).map(([k, v]) => (
                  <div key={k} className="px-3 py-2">
                    <dt className="text-2xs uppercase tracking-wide text-muted">
                      {k}
                    </dt>
                    <dd className="mt-0.5 break-words text-sm text-ink-0">
                      {v === null || v === undefined || v === ''
                        ? <span className="text-muted">(empty)</span>
                        : typeof v === 'object'
                          ? JSON.stringify(v)
                          : String(v)}
                    </dd>
                  </div>
                ))}
                {Object.keys(concrete.hit.properties).length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted">
                    No attributes on this feature.
                  </div>
                ) : null}
              </dl>

              {/* #267: attachments (read-only thumbnails). Mounted
                  only when we have an editable layer + globalId so
                  the V3FeatureAttachments fetch URL is well-formed.
                  canEdit=false hides the upload button -- the popup
                  is a read view; users tap Edit to upload. */}
              {parentEditable && detailHit?.globalId ? (
                <div className="border-t border-border bg-surface-0/50 px-3 py-3">
                  <V3FeatureAttachments
                    itemId={parentEditable.dataLayerId}
                    layerId={parentEditable.layerKey}
                    featureId={detailHit.globalId}
                    canEdit={false}
                  />
                </div>
              ) : null}

              {/* #265: related-records (popup.showRelatedRecords).
                  Surface the parent feature's child-layer rows so a
                  worker can drill straight into a Status / Inspection
                  / etc record from the popup without first opening
                  the parent in edit mode. Same shape as the FormModal
                  list -- pending rows tagged with an unsynced badge
                  via _pending. Only rendered when the layer actually
                  declares childLayers and we have a globalId to
                  filter on. */}
              {parentEditable &&
              (parentEditable.childLayers?.length ?? 0) > 0 ? (
                <div className="border-t border-border bg-surface-0/50">
                  {(parentEditable.childLayers ?? []).map((c) => {
                    const child = editableLayers.find(
                      (e) => e.layerKey === c.layerKey,
                    );
                    const rowsState = relatedRowsByChild[c.layerKey];
                    return (
                      <section
                        key={c.layerKey}
                        className="border-t border-border first:border-t-0 px-3 py-3"
                      >
                        <div className="mb-2 flex items-baseline justify-between gap-2">
                          <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">
                            {c.layerLabel}
                          </h3>
                          {rowsState && !rowsState.loading ? (
                            <span className="text-2xs text-muted">
                              {rowsState.rows.length} row
                              {rowsState.rows.length === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </div>
                        {!rowsState || rowsState.loading ? (
                          <p className="text-sm text-muted">Loading...</p>
                        ) : rowsState.error ? (
                          <p className="text-sm text-danger">
                            Couldn&apos;t load {c.layerLabel} records
                            ({rowsState.error}).
                          </p>
                        ) : rowsState.rows.length === 0 ? (
                          <p className="text-sm text-muted">
                            No {c.layerLabel.toLowerCase()} records yet.
                          </p>
                        ) : (
                          <ul className="space-y-1.5">
                            {rowsState.rows.map((row) => {
                              const pending = row._pending === true;
                              const canOpen = !!child && !pending;
                              return (
                                <li
                                  key={row.id}
                                  className={
                                    'flex min-h-[44px] items-center justify-between gap-2 rounded-md border px-3 py-2 ' +
                                    (pending
                                      ? 'border-warn/40 bg-warn/10'
                                      : 'border-border bg-surface-0')
                                  }
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-base text-ink-0">
                                      {pickRelatedRowTitle(row.properties) ??
                                        row.id.slice(0, 8)}
                                      {pending ? (
                                        <span className="ml-2 inline-flex items-center rounded bg-warn/25 px-1.5 py-0.5 text-xs font-medium text-warn">
                                          unsynced
                                        </span>
                                      ) : null}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={!canOpen}
                                    onClick={() => {
                                      if (!canOpen || !child) return;
                                      onOpenRelated(child, row);
                                    }}
                                    title={
                                      pending
                                        ? 'This record is waiting to sync. It will be openable once it reaches the server.'
                                        : !child
                                          ? 'You do not have edit access to this layer'
                                          : `Open this ${c.layerLabel} record`
                                    }
                                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                                  >
                                    Open
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * #249.18: thin always-visible GPS accuracy strip rendered between
 * the field-runtime header and the canvas. Field Maps shows the
 * fix accuracy in a similar band so the worker doesn't have to be
 * mid-capture to know whether their position is trustworthy.
 *
 * States:
 *   - idle / requesting / denied / unavailable: nothing renders.
 *     The strip only surfaces once we have an actual fix.
 *   - watching with a fix: shows "GPS accuracy <N> m" with the
 *     band-tinted background (excellent/good = emerald, fair =
 *     amber, poor = rose) so a glance gives both the number and a
 *     fitness assessment.
 *
 * Two visual styles intentionally match: the during-collect banner
 * inside the canvas + this header strip use the same gpsAccuracyBand
 * helper so the worker sees the same color whether the form is open
 * or closed.
 */
function FieldGpsStrip({
  gpsStatus,
  accuracyM,
}: {
  gpsStatus: import('./use-geolocation').GpsStatus;
  accuracyM: number | null;
}) {
  if (gpsStatus !== 'watching' || accuracyM === null) return null;
  const band = gpsAccuracyBand(accuracyM);
  const tone =
    band === 'excellent' || band === 'good'
      ? 'bg-success/10 text-success border-success/30'
      : band === 'fair'
        ? 'bg-warn/10 text-warn border-warn/30'
        : 'bg-danger/10 text-danger border-danger/30';
  return (
    <div
      aria-live="polite"
      className={`flex shrink-0 items-center justify-center gap-1.5 border-b px-3 py-1 text-xs font-medium ${tone}`}
    >
      <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
      GPS accuracy {accuracyM < 1 ? '<1' : Math.round(accuracyM)} m
    </div>
  );
}

/**
 * #249.15: zoom in / zoom out / reset-north cluster. Replaces
 * MapLibre's built-in NavigationControl (29px buttons) so the
 * field-runtime can match the rest of its h-11 w-11 control
 * rail. Three buttons stacked top-3 right-3 with a shared rounded
 * outer + internal dividers so they read as one widget.
 *
 * The compass arrow rotates with the map's bearing -- subscribed
 * via map.on('rotate') so the arrow stays in sync as the user
 * drags-to-rotate. Tapping resets bearing AND pitch to 0 (a
 * pitched view is also "off-north" enough that one tap should
 * unwind both). Compass is de-emphasized (text-muted) at
 * bearing=0 + pitch=0 and switches to text-ink-0 when either is
 * non-zero, matching the convention from Apple/Google maps.
 */
function FieldNavCluster({
  mapRef,
}: {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
}) {
  const [bearing, setBearing] = useState(0);
  const [pitch, setPitch] = useState(0);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const update = () => {
      setBearing(map.getBearing());
      setPitch(map.getPitch());
    };
    update();
    map.on('rotate', update);
    map.on('pitch', update);
    return () => {
      map.off('rotate', update);
      map.off('pitch', update);
    };
  }, [mapRef]);

  const offNorth = Math.abs(bearing) > 0.5 || Math.abs(pitch) > 0.5;

  return (
    <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-md border border-border bg-surface-1 shadow-card">
      <button
        type="button"
        onClick={() => mapRef.current?.zoomIn()}
        aria-label="Zoom in"
        className="inline-flex h-11 w-11 items-center justify-center hover:bg-surface-2"
      >
        <Plus className="h-5 w-5 text-ink-1" />
      </button>
      <button
        type="button"
        onClick={() => mapRef.current?.zoomOut()}
        aria-label="Zoom out"
        className="inline-flex h-11 w-11 items-center justify-center border-t border-border hover:bg-surface-2"
      >
        <Minus className="h-5 w-5 text-ink-1" />
      </button>
      <button
        type="button"
        onClick={() => {
          // #249.15: reset bearing AND pitch to 0. MapLibre's default
          // compass click only resets bearing, but in a touch-driven
          // context we routinely catch a 3D pitch from a two-finger
          // drag. Resetting both with one tap matches the "I want
          // north up, flat" mental model.
          mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 300 });
        }}
        aria-label="Reset bearing"
        className="inline-flex h-11 w-11 items-center justify-center border-t border-border hover:bg-surface-2"
      >
        <Compass
          className={`h-5 w-5 transition-colors ${
            offNorth ? 'text-ink-0' : 'text-muted'
          }`}
          // The arrow rotates with the map bearing so the user sees
          // which direction is north at a glance. Negative because
          // MapLibre's bearing is "the direction the camera is
          // facing" while the compass needle points north -- the
          // two are inverses.
          style={{ transform: `rotate(${-bearing}deg)` }}
        />
      </button>
    </div>
  );
}

/**
 * Field-Maps-style "More" menu in the top-right of the field
 * runtime header. Replaces the connectivity pill / persistence
 * badge / download button / PWA install button cluster that used to
 * fill the right side. All of those affordances are still present;
 * they're just collected into one dropdown so the canvas isn't
 * crowded by chrome.
 *
 * The dropdown is a self-contained popover with a backdrop that
 * dismisses on outside-tap. Status rows in the menu are read-only;
 * actions (Refresh offline cache, Install app) are buttons.
 */
function FieldMoreMenu({
  mapTitle,
  isOnline,
  cachedAt,
  persistentState,
  downloadInFlight,
  hasCache,
  queueCount,
  gpsStatus,
  gpsAccuracyM,
  onDownload,
  onRemoveCache,
}: {
  mapTitle: string;
  isOnline: boolean;
  cachedAt: string | null;
  persistentState: 'unknown' | 'persistent' | 'best-effort';
  downloadInFlight: boolean;
  hasCache: boolean;
  queueCount: number;
  gpsStatus: import('./use-geolocation').GpsStatus;
  gpsAccuracyM: number | null;
  onDownload: () => void;
  onRemoveCache: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Two-tap confirm for the destructive Remove action: first tap arms
  // the button (turns red, label flips to Confirm), second tap commits.
  // Cheaper than a full modal on mobile and stays inside the popover.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Same two-tap pattern, but only triggered when the queue has
  // unsynced edits. Refresh itself is non-destructive (downloadDeployment
  // upserts cached features and never touches the queue store), but
  // the runtime renders from cached features, so after a refresh the
  // user sees server state and any locally-edited rows look "lost"
  // until the queue drains. Warning the user lets them sync first.
  const [confirmingRefresh, setConfirmingRefresh] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-tap dismisses. Field workers expect tap-on-canvas to do
  // map work, not stay-trapped-in-menu, so a global listener wins
  // over an internal click handler.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Reset the armed-confirm states whenever the menu closes so the
  // next time the user opens it they see the safe label again.
  useEffect(() => {
    if (!open) {
      setConfirmingRemove(false);
      setConfirmingRefresh(false);
    }
  }, [open]);

  const connStatus = isOnline
    ? { label: 'Online', tone: 'text-success' as const }
    : hasCache
      ? { label: 'Offline (cached)', tone: 'text-warn' as const }
      : { label: 'Offline (no cache)', tone: 'text-danger' as const };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More options"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface-1 shadow-overlay"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted">
              Map
            </p>
            <p className="mt-0.5 truncate text-sm text-ink-0">{mapTitle}</p>
          </div>
          <ul className="px-1 py-1 text-sm">
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
              <span className="text-muted">Connection</span>
              <span className={`font-medium ${connStatus.tone}`}>
                {connStatus.label}
              </span>
            </li>
            {cachedAt ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">Last cached</span>
                <span className="text-ink-1">
                  {formatRelativeTime(cachedAt)}
                </span>
              </li>
            ) : null}
            {persistentState !== 'unknown' ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">Storage</span>
                <span
                  className={
                    persistentState === 'persistent'
                      ? 'text-success'
                      : 'text-warn'
                  }
                >
                  {persistentState === 'persistent'
                    ? 'Persistent'
                    : 'Best effort'}
                </span>
              </li>
            ) : null}
            {/* GPS row (Phase A5). Surfaces the watch state + the
                latest accuracy band so the worker can tell at a
                glance whether the next tap-to-add will be precise.
                Only renders when the watch is active or has been
                active; idle = the user hasn't asked for location yet
                and we shouldn't pretend to know anything. */}
            {gpsStatus !== 'idle' ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">GPS</span>
                <span
                  className={
                    gpsStatus === 'denied' || gpsStatus === 'unavailable'
                      ? 'text-danger'
                      : gpsStatus === 'requesting'
                        ? 'text-muted'
                        : (() => {
                            const band = gpsAccuracyBand(gpsAccuracyM);
                            return band === 'excellent' || band === 'good'
                              ? 'text-success'
                              : band === 'fair'
                                ? 'text-warn'
                                : 'text-danger';
                          })()
                  }
                >
                  {gpsStatus === 'denied'
                    ? 'Permission denied'
                    : gpsStatus === 'unavailable'
                      ? 'Unavailable'
                      : gpsStatus === 'requesting'
                        ? 'Acquiring...'
                        : gpsStatus === 'error'
                          ? 'Error'
                          : gpsAccuracyM === null
                            ? 'Watching'
                            : `${
                                gpsAccuracyM < 1
                                  ? '<1'
                                  : Math.round(gpsAccuracyM)
                              } m`}
                </span>
              </li>
            ) : null}
          </ul>
          <div className="border-t border-border p-1">
            {/* Refresh + queue safety: when the queue has unsynced
                edits, refreshing pulls server state and the locally
                edited rows look "lost" until the queue drains in the
                background. The records are still safe (downloadDeployment
                never touches the queue), but the visual gap rattles
                users. Two-tap arm/confirm with an inline warning gives
                them the option to sync first. With an empty queue,
                refresh runs straight through. */}
            {confirmingRefresh && hasCache && queueCount > 0 ? (
              <p className="px-2 pt-1 text-2xs text-warn">
                {queueCount} edit{queueCount === 1 ? '' : 's'} not yet
                synced. Refresh anyway?
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (
                  hasCache &&
                  queueCount > 0 &&
                  !confirmingRefresh
                ) {
                  setConfirmingRefresh(true);
                  return;
                }
                setOpen(false);
                onDownload();
              }}
              disabled={downloadInFlight}
              className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm disabled:opacity-50 ${
                confirmingRefresh && hasCache && queueCount > 0
                  ? 'bg-warn/10 text-warn hover:bg-warn/20'
                  : 'text-ink-0 hover:bg-surface-2'
              }`}
            >
              {downloadInFlight ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted" />
              ) : hasCache ? (
                <RefreshCw
                  className={`h-4 w-4 ${
                    confirmingRefresh && queueCount > 0
                      ? 'text-warn'
                      : 'text-muted'
                  }`}
                />
              ) : (
                <CloudDownload className="h-4 w-4 text-muted" />
              )}
              <span>
                {confirmingRefresh && hasCache && queueCount > 0
                  ? 'Confirm refresh'
                  : hasCache
                    ? 'Refresh offline cache'
                    : 'Download for offline'}
              </span>
            </button>
            {/* Remove from device. Only meaningful when something is
                cached, and we want a hard confirm step because the
                action wipes the deployment's IDB rows. Two-tap pattern
                instead of a separate modal keeps the surface small on
                a phone screen. Queued edits are surfaced as a warning
                line; they will be lost on remove because the records
                are gone with the deployment, so the user gets one
                last chance to sync first. */}
            {hasCache ? (
              <>
                {confirmingRemove && queueCount > 0 ? (
                  <p className="px-2 pt-1 text-2xs text-danger">
                    {queueCount} unsynced edit{queueCount === 1 ? '' : 's'}{' '}
                    will be lost.
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (!confirmingRemove) {
                      setConfirmingRemove(true);
                      return;
                    }
                    setOpen(false);
                    onRemoveCache();
                  }}
                  disabled={downloadInFlight}
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm disabled:opacity-50 ${
                    confirmingRemove
                      ? 'bg-danger/10 text-danger hover:bg-danger/15'
                      : 'text-ink-0 hover:bg-surface-2'
                  }`}
                >
                  <Trash2
                    className={`h-4 w-4 ${
                      confirmingRemove ? 'text-danger' : 'text-muted'
                    }`}
                  />
                  <span>
                    {confirmingRemove
                      ? 'Confirm remove from device'
                      : 'Remove from device'}
                  </span>
                </button>
              </>
            ) : null}
            <div className="px-2 py-1">
              <PwaInstallButton variant="compact" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Queue badge + sync trigger (Slice 5). Renders only when there's
 * something queued; the field worker shouldn't see queue-related
 * chrome during normal online work. Three visual states:
 *
 *   - Online + queued: amber, clickable, runs sync on click.
 *   - Online + syncing: amber + spinner, click-disabled.
 *   - Offline + queued: muted gray, not clickable. Tooltip explains
 *     that sync is paused until reconnect.
 *
 * The count is the live queue depth (pending + failed records). A
 * failed record stays visible here until the next sync run resolves
 * it or the user explicitly drops it from the admin recovery view
 * (which lands later in this slice).
 */
function QueueBadge({
  count,
  syncing,
  isOnline,
  onSync,
}: {
  count: number;
  syncing: boolean;
  isOnline: boolean;
  onSync: () => void;
}) {
  if (!isOnline) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-2xs font-medium text-muted"
        title={`${count} ${count === 1 ? 'edit' : 'edits'} waiting to sync. Reconnect to send.`}
      >
        <CloudOff className="h-3 w-3" />
        {count} queued
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={syncing}
      onClick={onSync}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium text-warn hover:bg-warn/20 disabled:opacity-60"
      title={`${count} ${count === 1 ? 'edit' : 'edits'} waiting to sync. Click to send now.`}
    >
      {syncing ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <CloudDownload className="h-3 w-3 rotate-180" />
      )}
      {syncing ? 'Syncing...' : `Sync ${count}`}
    </button>
  );
}


/**
 * Progress modal shown while a download is running and after it
 * finishes. The download manager reports per-phase status; we
 * mirror those phases as a simple list with an icon per state.
 */
function DownloadProgressModal({
  progress,
  onClose,
  onCancel,
}: {
  progress: DownloadProgress;
  onClose: () => void;
  onCancel: () => void;
}) {
  const finished = progress.phase === 'done' || progress.phase === 'failed';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download for offline"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-4 shadow-overlay">
        <div className="flex items-center gap-2">
          {progress.phase === 'failed' ? (
            <CircleSlash className="h-5 w-5 text-danger" />
          ) : finished ? (
            <Check className="h-5 w-5 text-success" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
          )}
          <h2 className="text-sm font-semibold text-ink-0">
            {progress.phase === 'failed'
              ? 'Download failed'
              : finished
                ? 'Ready for offline'
                : 'Downloading for offline'}
          </h2>
        </div>
        <p className="mt-2 text-xs text-muted">{progress.message}</p>
        {/* Layers leads the breakdown so the user sees a non-zero
            number even on a fresh deployment with no features yet.
            Features, Forms, and Pick lists below are secondary
            detail. */}
        <dl className="mt-3 grid grid-cols-4 gap-2 text-2xs">
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Layers</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.layerCount}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Features</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.featuresFetched}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Forms</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.formsFetched}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Pick lists</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.pickListsFetched}
            </dd>
          </div>
        </dl>
        {progress.estimatedSize > 0 ? (
          <p className="mt-2 text-2xs text-muted">
            ~{formatBytes(progress.estimatedSize)} cached
          </p>
        ) : null}
        {progress.error ? (
          <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {progress.error}
          </p>
        ) : null}
        {/* A running download must be stoppable. This button used to
            read "Working..." and be disabled, which left a user who
            had accidentally started a large download with no way out
            short of killing the tab, and on a phone in the field that
            is a genuinely bad place to be. */}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={finished ? onClose : onCancel}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Field-mode address search. Lightweight wrapper around the geocode
 * helper at /api/geocode -- no layer-attribute or arcgis-rest
 * search like the desktop SearchBar does, just place lookup so a
 * field worker can type "1234 Main St" and fly there. Per Matt's
 * test feedback (#223.3), this is what users reached for when they
 * mistook the global "Search items" bar for a map address search.
 *
 * Renders as a thin pill that grows on focus. Result selection
 * pans the map to the picked location and highlights it briefly.
 */
function FieldAddressSearch({
  mapRef,
  canvasRef,
  layers,
  autoFocus,
  onClose,
}: {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  // #249.12: passing the canvas handle lets a feature pick reuse the
  // same fly-and-highlight animation the desktop SearchBar fires, so a
  // hit on Parcels by APN flashes the polygon exactly like clicking a
  // search result on the desktop map.
  canvasRef?: React.MutableRefObject<MapCanvasHandle | null>;
  // #249.12: layers + their per-layer search settings (search.enabled,
  // search.fields, search.labelTemplate). When omitted or empty the
  // bar falls back to address-only behaviour, matching the previous
  // shape so callers that don't have a map context still work.
  layers?: MapLayer[];
  // #249.11: when the parent renders this in collapsed/expanded mode,
  // it asks us to grab focus on mount so the user can start typing
  // immediately, and surfaces a close affordance via the trailing X
  // button (collapses back to the icon).
  autoFocus?: boolean;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState('');
  // #249.12: place results (Nominatim) and feature results (layer
  // attributes) are tracked separately so the dropdown can render a
  // Features section ahead of a Places section. Place results keep
  // the previous shape (label / center / bbox); feature results carry
  // the full SearchResult so the picker has the layer id + GeoJSON
  // feature it needs for flyAndHighlight.
  const [placeResults, setPlaceResults] = useState<
    Array<{
      label: string;
      center: [number, number] | null;
      bbox: [number, number, number, number] | null;
    }>
  >([]);
  const [featureResults, setFeatureResults] = useState<MapSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // #249.12: at least one layer in the deployment has search.enabled +
  // a non-empty fields list. Used to gate the section heading so we
  // don't render an empty Features header when the deployment author
  // hasn't configured any searchable layers.
  const anyLayerSearchable = (layers ?? []).some(
    (l) => l.search?.enabled && l.search.fields.length > 0,
  );

  // Auto-focus the input when the parent expands the bar from icon mode
  // (#249.11). Only fires once on mount; the parent unmounts us when
  // collapsing so a fresh expand always re-focuses.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Close on outside click so the dropdown doesn't linger when the
  // user pans the map.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // #249.12: layer-attribute search runs synchronously off the map's
  // current source data on every keystroke. Cheap (one pass through
  // up to MAX_ATTRIBUTE_HITS_PER_LAYER features per layer), no
  // network. Snapshot featuresByLayer from MapLibre via
  // querySourceFeatures: for the GeoJSON sources field-runtime uses
  // (URL-backed online, geojson-inline offline) this returns every
  // feature in the source. Re-runs whenever the query, layer list,
  // or layer ids change.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1 || !layers || layers.length === 0) {
      setFeatureResults([]);
      return;
    }
    const map = mapRef.current;
    const featuresByLayer: Record<string, GeoJSON.FeatureCollection | null> =
      {};
    if (map) {
      for (const layer of layers) {
        if (!layer.search?.enabled) continue;
        if (layer.source.kind === 'arcgis-rest') continue;
        const sourceId = `gg:${layer.id}`;
        if (!map.getSource(sourceId)) continue;
        try {
          const features = map.querySourceFeatures(sourceId);
          featuresByLayer[layer.id] = {
            type: 'FeatureCollection',
            features,
          };
        } catch {
          /* style not ready yet for this source -- skip; the next
             keystroke after the source loads will pick it up */
        }
      }
    }
    setFeatureResults(searchLayers(q, layers, featuresByLayer));
  }, [query, layers, mapRef]);

  // Debounced geocode. Match the desktop SearchBar's 250 ms delay
  // and 3-character minimum so we don't hammer Nominatim.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setPlaceResults([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const handle = setTimeout(() => {
      fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      })
        .then((res) => (res.ok ? res.json() : []))
        .then(
          (
            rows: Array<{
              display_name?: string;
              lat?: string;
              lon?: string;
              boundingbox?: [string, string, string, string];
            }>,
          ) => {
            const mapped = rows.map((r) => {
              const lat = Number(r.lat);
              const lon = Number(r.lon);
              const bb = r.boundingbox;
              const bbox =
                bb && bb.length === 4
                  ? ([
                      Number(bb[2]),
                      Number(bb[0]),
                      Number(bb[3]),
                      Number(bb[1]),
                    ] as [number, number, number, number])
                  : null;
              return {
                label: r.display_name ?? '',
                center:
                  Number.isFinite(lat) && Number.isFinite(lon)
                    ? ([lon, lat] as [number, number])
                    : null,
                bbox,
              };
            });
            setPlaceResults(mapped);
            setLoading(false);
          },
        )
        .catch(() => {
          setLoading(false);
        });
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(handle);
      setLoading(false);
    };
  }, [query]);

  function pickPlace(r: {
    bbox: [number, number, number, number] | null;
    center: [number, number] | null;
  }) {
    const m = mapRef.current;
    if (!m) return;
    if (r.bbox) {
      m.fitBounds(
        [
          [r.bbox[0], r.bbox[1]],
          [r.bbox[2], r.bbox[3]],
        ],
        { padding: 60, duration: 400 },
      );
    } else if (r.center) {
      m.flyTo({ center: r.center, zoom: 16, duration: 400 });
    }
    setOpen(false);
  }

  // #249.12: feature picks reuse the canvas's flyAndHighlight so the
  // hit feature briefly pulses, matching the desktop bar. Falls back
  // to a plain flyTo on the picked feature's bbox/center when the
  // canvas handle isn't available (shouldn't happen in field mode but
  // keeps the code robust if a caller wires the bar up without a
  // canvas).
  function pickFeature(r: MapSearchResult) {
    if (r.kind !== 'feature') return;
    const handle = canvasRef?.current;
    if (handle) {
      // exactOptionalPropertyTypes is strict in this repo, so we
      // build the args object without undefined-valued optional
      // props rather than letting them through as `prop: undefined`.
      const args: Parameters<MapCanvasHandle['flyAndHighlight']>[0] = {
        bbox: r.bbox,
        center: r.center,
        layerId: r.layerId,
      };
      const fid = r.feature.id as string | number | undefined;
      if (fid !== undefined) args.featureId = fid;
      if (r.feature.properties)
        args.featureProps = r.feature.properties as Record<string, unknown>;
      handle.flyAndHighlight(args);
    } else {
      pickPlace({ bbox: r.bbox, center: r.center });
    }
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length >= 3) setOpen(true);
          }}
          placeholder="Search address..."
          className="h-9 w-full rounded-md border border-border bg-surface-0 pl-8 pr-8 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-none"
          aria-label="Search address"
        />
        {query || onClose ? (
          <button
            type="button"
            onClick={() => {
              // #249.11: when the parent owns expand/collapse state we
              // collapse on the trailing-X press, otherwise we just
              // clear the input. Either way wipe local state so a
              // re-expand starts clean.
              setQuery('');
              setPlaceResults([]);
              setFeatureResults([]);
              setOpen(false);
              onClose?.();
            }}
            aria-label={onClose ? 'Close search' : 'Clear search'}
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </label>
      {open &&
      (loading || featureResults.length > 0 || placeResults.length > 0) ? (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-surface-1 text-sm shadow-overlay">
          {/* #249.12: Features section -- only rendered when at least
              one searchable layer is configured AND we have hits. The
              hits are grouped by layer with the layer title as a sub-
              heading so a worker scanning for "SMITH" sees Parcels
              hits separately from Roads or Water Service hits. */}
          {anyLayerSearchable && featureResults.length > 0
            ? groupFeatureResultsByLayer(featureResults).map((group) => (
                <li key={`layer-${group.layerId}`}>
                  <div className="border-b border-border bg-surface-2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                    {group.layerTitle}
                  </div>
                  {group.results.map((r, i) => (
                    <button
                      key={`${group.layerId}-${i}`}
                      type="button"
                      onClick={() => pickFeature(r)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2"
                    >
                      <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-ink-0">
                          {r.kind === 'feature' ? r.label : ''}
                        </div>
                        {r.kind === 'feature' && r.subtitle ? (
                          <div className="truncate text-2xs text-muted">
                            {r.subtitle}
                          </div>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </li>
              ))
            : null}
          {/* Places section -- the original Nominatim address path.
              Heading only renders when feature results sit above so
              the dropdown doesn't shout PLACES at a deployment that
              never had any layer search. */}
          {placeResults.length > 0 &&
          anyLayerSearchable &&
          featureResults.length > 0 ? (
            <li>
              <div className="border-b border-border bg-surface-2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                Places
              </div>
            </li>
          ) : null}
          {placeResults.map((r, i) => (
            <li key={`place-${r.label}-${i}`}>
              <button
                type="button"
                onClick={() => pickPlace(r)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2"
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-xs text-ink-0">
                  {r.label}
                </span>
              </button>
            </li>
          ))}
          {loading && placeResults.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted">Searching...</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * #247: pick a short human-friendly label for an existing related
 * row in the FormModal's child-list. Skips underscore-prefixed keys
 * (system metadata: _created_by, _edited_at, etc.), the parent FK
 * column itself (would always read as the parent's UUID), and falls
 * back to the first non-empty user-field value. Returns null when
 * nothing fits, so the caller can show the row's globalId prefix
 * instead.
 */
function pickRelatedRowTitle(
  properties: Record<string, unknown>,
): string | null {
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (!s) continue;
    // Don't echo the parent FK back as the row's title -- it's the
    // same UUID for every row and reads as noise. Identifiable by
    // the value being a 36-char hyphenated string (UUID v4 shape).
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
      continue;
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  }
  return null;
}

/**
 * #249.12: bucket SearchResult feature hits by their owning layer so
 * the dropdown can render a sub-heading per layer. Place results
 * (kind === 'place') aren't grouped here -- they live under their
 * own Places section in the dropdown. Order is preserved so the
 * relative ranking searchLayers() produces is honoured: the first
 * layer with hits stays first.
 */
function groupFeatureResultsByLayer(
  results: MapSearchResult[],
): Array<{ layerId: string; layerTitle: string; results: MapSearchResult[] }> {
  const out: Array<{
    layerId: string;
    layerTitle: string;
    results: MapSearchResult[];
  }> = [];
  const indexById = new Map<string, number>();
  for (const r of results) {
    if (r.kind !== 'feature') continue;
    let i = indexById.get(r.layerId);
    if (i === undefined) {
      i = out.length;
      indexById.set(r.layerId, i);
      out.push({ layerId: r.layerId, layerTitle: r.layerTitle, results: [] });
    }
    out[i]!.results.push(r);
  }
  return out;
}

/**
 * Render an ISO timestamp as a relative-friendly string ("2 hours
 * ago", "yesterday", "3 days ago"). Used in the cached-deployment
 * line so the user knows how stale their offline data is at a
 * glance. Falls through to a date string past 30 days.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
