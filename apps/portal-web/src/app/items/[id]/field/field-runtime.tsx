'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  CircleSlash,
  CloudDownload,
  CloudOff,
  ClipboardList,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  MapPin,
  Plus,
  Wifi,
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
  generateFormFromLayer,
  type FormSchema,
  type Question,
  type Response as FormResponse,
} from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import { FormRuntime } from '@/components/form-runtime';
import {
  formatBytes,
  getDeployment,
  listFeaturesForLayer,
  listPickListsForDeployment,
  type CachedDeployment,
} from '@/lib/offline-store';
import {
  downloadDeployment,
  type DownloadLayer,
  type DownloadProgress,
} from '@/lib/offline-download';

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
  /** Sublayer geometry type; null = table (filtered out at the page
   *  level for Slice 2). */
  geometryType: Exclude<LayerGeometryType, null>;
  fields: FeatureField[];
  editingPolicy: 'all-rows' | 'own-rows-only';
  /** Optional explicit form binding from the data_collection's
   *  formBindings map. When absent, an auto-form is generated. */
  boundFormItemId?: string;
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
  }, [isOnline, cachedDeployment, editableLayers, dataCollectionId]);

  // Effective MapData: visibility overrides + offline source
  // substitution. The two transforms compose: each layer is first
  // checked for visibility (off when hiddenLayerIds includes it),
  // then for offline substitution (when offline + cached + the
  // source has an inline FC available).
  const effectiveMapData = useMemo<MapData>(() => {
    const offlineActive = !isOnline && Object.keys(offlineFeatures).length > 0;
    if (hiddenLayerIds.size === 0 && !offlineActive) return mapData;
    return {
      ...mapData,
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
  }, [mapData, hiddenLayerIds, isOnline, offlineFeatures]);

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

  const startDownload = useCallback(async () => {
    if (downloadProgress?.phase && downloadProgress.phase !== 'done' &&
        downloadProgress.phase !== 'failed') {
      return; // already running
    }
    // Collect the pick-list ids referenced by any editable layer's
    // coded-value-ref domain. Same logic the server-side page does
    // for online; we duplicate here so the download manager has the
    // full set without an extra round-trip.
    const pickListIdSet = new Set<string>();
    for (const l of editableLayers) {
      for (const f of l.fields) {
        if (f.domain && f.domain.type === 'coded-value-ref') {
          pickListIdSet.add(f.domain.pickListItemId);
        }
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
    try {
      const manifest = await downloadDeployment(
        {
          dataCollectionId,
          title,
          mapId: '', // will be set by the caller of FieldRuntime in a future pass; not load-bearing
          layers: downloadLayers,
          pickListIds: Array.from(pickListIdSet),
        },
        (p) => setDownloadProgress({ ...p }),
      );
      setCachedDeployment(manifest);
    } catch (err) {
      setDownloadProgress({
        phase: 'failed',
        message: 'Download failed',
        estimatedSize: 0,
        featuresFetched: 0,
        formsFetched: 0,
        pickListsFetched: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [downloadProgress, editableLayers, dataCollectionId, title]);

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
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  const handleMapReady = useCallback((map: maplibregl.Map | null) => {
    mapRef.current = map;
  }, []);

  // Wire the map's click handler manually so we can branch on
  // tap-on-feature (always edit) without colliding with MapCanvas's
  // own selection machinery. Add-mode no longer uses click-to-drop --
  // it uses the explicit "Add at center" button below.
  useEffect(() => {
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
    return () => {
      map.off('click', onClick);
    };
  }, [editableLayers, mapData.layers]);

  // Commit the active template: drop a feature at the current map
  // center and open the form pre-filled with presetAttributes. Used
  // by the "Add at center" button. Field Maps' equivalent: pan to
  // position, tap "Add Point", form opens.
  const commitAtCenter = useCallback(() => {
    const tpl = activeTemplate;
    const map = mapRef.current;
    if (!tpl || !map) return;
    if (!isPointGeometry(tpl.layer.geometryType)) {
      // Slice 2/3 ship point capture only. Polygon / line need a
      // multi-step gesture (tap-to-add-vertex, double-tap-to-finish)
      // and are #196 territory. Surface a hint and bail rather than
      // dropping a degenerate single-point line.
      // eslint-disable-next-line no-alert
      alert(
        `Adding ${tpl.layer.geometryType} features arrives in a follow-up slice.`,
      );
      return;
    }
    const c = map.getCenter();
    setFormModal({
      layer: tpl.layer,
      mode: 'add',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      presetAttributes: tpl.presetAttributes,
    });
    setActiveTemplate(null);
    // Plant a preview marker at the drop location so the user can
    // see WHERE they're adding while filling in the form. The real
    // feature only appears in the data source after a successful
    // save (#194 refresh), so without this preview the location
    // appears to vanish the moment the form opens. Tinted with the
    // template's color so the visual carries through from the
    // crosshair-reticle phase.
    clearPendingMarker();
    pendingMarkerRef.current = new maplibregl.Marker({ color: tpl.color })
      .setLngLat([c.lng, c.lat])
      .addTo(map);
    // The form takes the bottom ~60% of the screen, which would hide
    // the feature we just dropped at the geometric center. Ease the
    // camera up so the same lng/lat ends up roughly in the middle of
    // the visible (non-form) area. offset is in pixels; positive y
    // moves the displayed center *down*, so a negative y here shifts
    // the geographic center upward on screen. ~30% of viewport
    // height splits the difference: feature lands centered in the
    // ~40% of map still visible above the form.
    const h = map.getContainer().clientHeight;
    map.easeTo({
      center: [c.lng, c.lat],
      offset: [0, -h * 0.3],
      duration: 350,
    });
  }, [activeTemplate, clearPendingMarker]);

  return (
    // Field-mode lives below the standard portal nav (3.5rem) just like
    // the editor runtime does. Avoids `fixed inset-0` so the standard
    // page chrome stays on top of the canvas instead of bleeding through
    // it.
    <div className="flex h-[calc(100vh-3.5rem)] flex-col bg-surface-1">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <Link
          href={`/items/${dataCollectionId}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          aria-label="Back to deployment"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-ink-0">{title}</h1>
          <p className="truncate text-[11px] text-muted">
            Field deployment of <span className="text-ink-1">{mapTitle}</span>
          </p>
        </div>
        <ConnectivityPill
          isOnline={isOnline}
          cachedAt={cachedDeployment?.cachedAt ?? null}
        />
      </header>

      <div className="relative min-h-0 flex-1">
        <MapCanvas
          ref={canvasRef}
          map={effectiveMapData}
          basemaps={basemaps}
          selection={selection}
          selectTool="off"
          onSelectionChange={setSelection}
          onCameraChange={() => {
            /* Camera changes don't persist in field-mode. */
          }}
          onMapReady={handleMapReady}
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
            drops below when tapped. */}
        <button
          type="button"
          onClick={() => setLayerPanelOpen((v) => !v)}
          className="absolute left-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-1 shadow-card hover:bg-surface-2"
          aria-label="Toggle layers"
          aria-pressed={layerPanelOpen}
        >
          <Layers className="h-4 w-4 text-ink-1" />
        </button>

        {layerPanelOpen ? (
          <LayerVisibilityPanel
            layers={mapData.layers ?? []}
            hiddenLayerIds={hiddenLayerIds}
            onToggle={(layerId) => {
              setHiddenLayerIds((prev) => {
                const next = new Set(prev);
                if (next.has(layerId)) next.delete(layerId);
                else next.add(layerId);
                return next;
              });
            }}
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
          />
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 p-2">
        {editableLayers.length === 0 ? (
          <p className="flex-1 text-center text-xs text-muted">
            No editable layers in this map.
          </p>
        ) : activeTemplate ? (
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
                <p className="truncate text-[11px] text-muted">
                  {activeTemplate.sublabel}
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
            <button
              type="button"
              onClick={commitAtCenter}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90"
            >
              <MapPin className="h-4 w-4" />
              Add at center
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={templates.length === 0}
            onClick={() => setPickerOpen(true)}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add feature
          </button>
        )}
      </footer>

      {pickerOpen ? (
        <TemplatePicker
          templates={templates}
          onPick={(tpl) => {
            setActiveTemplate(tpl);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {formModal ? (
        <FormModal
          dataCollectionId={dataCollectionId}
          modal={formModal}
          pickLists={effectivePickLists}
          boundForms={boundForms}
          currentUserId={currentUserId}
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
            // GeoJSONSource forces a refetch (#194).
            for (const ml of mapData.layers ?? []) {
              const source = ml.source;
              if (source?.kind !== 'data-layer') continue;
              if (source.itemId !== submittedLayer.dataLayerId) continue;
              if (source.layerKey && source.layerKey !== submittedLayer.layerKey) {
                continue;
              }
              canvasRef.current?.refreshLayerSource(ml.id);
            }
          }}
        />
      ) : null}

      {downloadProgress ? (
        <DownloadProgressModal
          progress={downloadProgress}
          onClose={() => setDownloadProgress(null)}
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
        className="flex max-h-[75vh] w-full flex-col rounded-t-xl border-t border-border bg-surface-1 shadow-overlay sm:max-h-[80vh]"
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
                <h3 className="bg-surface-0 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
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
 * Compact panel that lists every map layer with an eye toggle.
 * Session-local (doesn't mutate the bound map item). Clicking the
 * eye flips visibility for this open of the deployment only.
 */
function LayerVisibilityPanel({
  layers,
  hiddenLayerIds,
  onToggle,
  cachedDeployment,
  isDownloading,
  onDownload,
  onClose,
}: {
  layers: MapLayer[];
  hiddenLayerIds: Set<string>;
  onToggle: (layerId: string) => void;
  cachedDeployment: CachedDeployment | null;
  isDownloading: boolean;
  onDownload: () => void;
  onClose: () => void;
}) {
  // Group sources are headers, not togglable rows themselves -- but
  // we still show them so the panel reads like the desktop layer
  // tree. Per-row visibility only applies to leaf layers; toggling a
  // group is a polish item for later.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Layer visibility"
      className="absolute right-3 top-14 z-20 w-64 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-surface-1 shadow-overlay"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Layers
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-0 px-3 text-xs font-medium text-ink-0 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudDownload className="h-3.5 w-3.5" />
          )}
          {cachedDeployment ? 'Refresh offline cache' : 'Download for offline'}
        </button>
        {cachedDeployment ? (
          <p className="mt-1 text-[10px] text-muted">
            Cached {formatRelativeTime(cachedDeployment.cachedAt)} ·{' '}
            {formatBytes(cachedDeployment.estimatedSize)}
          </p>
        ) : null}
      </div>
      <ul className="max-h-72 overflow-y-auto p-1">
        {layers.length === 0 ? (
          <li className="p-2 text-center text-xs text-muted">
            No layers in this map.
          </li>
        ) : (
          layers.map((l) => {
            const isGroup = l.source?.kind === 'group';
            if (isGroup) {
              return (
                <li
                  key={l.id}
                  className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted"
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
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  aria-pressed={visible}
                >
                  {visible ? (
                    <Eye className="h-4 w-4 shrink-0 text-accent" />
                  ) : (
                    <EyeOff className="h-4 w-4 shrink-0 text-muted" />
                  )}
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
          })
        )}
      </ul>
    </div>
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
  onClose,
  onSubmitted,
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
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

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
    // Slice 4 caches reads only; the write-through queue is Slice 5
    // (#199). Until that lands we refuse offline submits loudly so
    // users don't think their edit saved when it didn't. Better
    // than silently dropping the response.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const msg =
        "You're offline. Saving edits while offline arrives in the next slice; reconnect to submit this form.";
      setError(msg);
      throw new Error(msg);
    }
    try {
      const properties = response;
      if (modal.mode === 'add') {
        const res = await fetch(
          `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
            modal.layer.layerKey,
          )}/features`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              features: [
                {
                  geometry: modal.geometry,
                  properties,
                },
              ],
            }),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`POST failed (${res.status}): ${body || res.statusText}`);
        }
      } else {
        const res = await fetch(
          `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
            modal.layer.layerKey,
          )}/features/${modal.featureId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ properties }),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `PATCH failed (${res.status}): ${body || res.statusText}`,
          );
        }
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
      // Bottom-anchored sheet: form occupies the lower portion of the
      // viewport so the map stays visible above. Matches Field Maps'
      // pattern, which is the right call for field collection -- the
      // collector can verify their dropped location while they fill
      // out attributes. Tap the dim backdrop above to dismiss.
      className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[60vh] w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay sm:max-h-[55vh]"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
          >
            <ClipboardList className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-ink-0">
              {modal.mode === 'add'
                ? `New ${modal.layer.layerLabel}`
                : `Edit ${modal.layer.layerLabel}`}
            </h2>
            <p className="truncate text-[11px] text-muted">
              {modal.layer.dataLayerTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <FormRuntime
            form={form}
            initial={initial}
            onSubmit={handleSubmit}
            submitLabel={modal.mode === 'add' ? 'Save feature' : 'Save changes'}
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact pill in the runtime header showing network state. Three
 * variants: green "Online", amber "Offline (cached)" when we have a
 * deployment manifest, red "Offline (no cache)" when we don't and
 * the user can't actually do anything until they reconnect. Tooltip
 * carries the cache timestamp.
 */
function ConnectivityPill({
  isOnline,
  cachedAt,
}: {
  isOnline: boolean;
  cachedAt: string | null;
}) {
  if (isOnline) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
        title="Online: edits sync immediately"
      >
        <Wifi className="h-3 w-3" />
        Online
      </span>
    );
  }
  if (cachedAt) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
        title={`Offline. Cached on ${new Date(cachedAt).toLocaleString()}.`}
      >
        <CloudOff className="h-3 w-3" />
        Offline
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700"
      title="Offline and no cached data for this deployment."
    >
      <CircleSlash className="h-3 w-3" />
      No cache
    </span>
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
}: {
  progress: DownloadProgress;
  onClose: () => void;
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
            <Check className="h-5 w-5 text-emerald-600" />
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
        <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
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
          <p className="mt-2 text-[11px] text-muted">
            ~{formatBytes(progress.estimatedSize)} cached
          </p>
        ) : null}
        {progress.error ? (
          <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {progress.error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={!finished}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {finished ? 'Close' : 'Working...'}
          </button>
        </div>
      </div>
    </div>
  );
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
