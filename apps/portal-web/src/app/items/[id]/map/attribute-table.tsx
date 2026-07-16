// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FileIcon,
  Filter as FilterIcon,
  Focus,
  History,
  ImageIcon,
  Loader2,
  Map as MapIcon,
  Paperclip,
  Search,
  Table,
  X,
} from 'lucide-react';
import { exportFeatures, type ExportFormat } from '@/lib/layer-export';
import { exportBundle } from '@/lib/bundle-export';
import type {
  FeatureField,
  MapLayer,
  MapLayerFilter,
  PickListData,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';
import { getCachedUserName, prefetchUserNames } from '@/lib/user-name-cache';

interface Props {
  open: boolean;
  layers: MapLayer[];
  /**
   * Cached feature collections keyed by layer id. The parent fetches
   * these lazily when the table opens so we don't refetch per render.
   */
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>;
  metadata: Record<string, LayerMetadata>;
  canEdit: boolean;
  /**
   * Shared selection state owned by the editor. Keys are layer ids;
   * values are Sets of feature ids that match what setFeatureState
   * sees on the map: a row's `_global_id` UUID (string) for v3
   * data-layer sources (promoteId), or a sequential index (number)
   * for sources that fall back to generateId. The table treats both
   * uniformly when matching rows to selection state. (#318)
   */
  selection: Record<string, Set<number | string>>;
  setSelection: React.Dispatch<
    React.SetStateAction<Record<string, Set<number | string>>>
  >;
  onClose: () => void;
  /** Fly to a bbox in the map canvas. */
  onZoomTo: (bbox: [number, number, number, number]) => void;
  /** Replace the layer filter (used by "convert selection to filter"). */
  onPatchLayer: (layerId: string, patch: Partial<MapLayer>) => void;
  /**
   * When the parent calls "Open attribute table" from the per-layer
   * kebab (#72), this prop carries the chosen layer id. The table
   * focuses that layer instead of defaulting to the first visible
   * one. Resetting to null between opens is the parent's job; we
   * react to changes via useEffect.
   */
  focusLayerId?: string | null;
  /**
   * Inline row editing. When defined, cells on layers in
   * `editableLayerIds` become double-click-editable, and
   * confirming the edit calls this handler with the merged full
   * properties object (underscore-prefixed editor-tracking keys
   * stripped). The parent is expected to PATCH the row server-side
   * and refresh the layer's source so the change paints. When
   * undefined, the table stays read-only and the legacy footer
   * note is shown. featureId is the row's UUID, sourced from
   * `_global_id` (which the v3 service inlines into properties so
   * MapCanvas's generateId rewrite doesn't lose it).
   */
  onPatchFeature?: (
    layerId: string,
    featureId: string,
    properties: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Layers on which inline edit is allowed at all. Cells outside
   * this set render read-only even when `onPatchFeature` is wired.
   * Pairs with the editor runtime's per-target canEditAttributes
   * gate: only target layers with attribute editing turned on land
   * here. When `onPatchFeature` is wired but this prop is omitted,
   * we treat it as "no layer is editable" (defensive default).
   */
  editableLayerIds?: Set<string>;
  /**
   * Optional per-layer field allowlist. When a layer has an entry
   * here, only fields in the Set are double-click-editable;
   * everything else stays read-only. When the layer has no entry,
   * every field on an editable layer is treated as editable. This
   * mirrors the editor target's `editableFields` constraint.
   * Underscore-prefixed columns (editor tracking) are never
   * editable regardless of what's in here.
   */
  editableFieldsByLayer?: Record<string, Set<string>>;
  /**
   * Per-layer field schema. When provided, the inline cell editor
   * uses each field's `domain` (coded-value or coded-value-ref) to
   * render a `<select>` of permitted values rather than a freeform
   * text input. When omitted (the map editor doesn't thread this
   * through yet), the editor falls back to plain text. Indexed by
   * layer id; missing layers render text inputs.
   */
  fieldsByLayer?: Record<string, FeatureField[]>;
  /**
   * Resolved pick lists keyed by pick_list item id. Used to
   * resolve `coded-value-ref` field domains in the inline editor.
   * Same shape AttributeForm consumes; the editor runtime already
   * fetches these server-side so wiring them through here is just
   * a prop passthrough.
   */
  pickLists?: Record<string, PickListData>;
  /**
   * Current map viewport bbox as `[minLng, minLat, maxLng, maxLat]`.
   * When provided and the active layer is a v3 data_layer sublayer,
   * the table switches to server-paged mode: it fetches rows from
   * `/items/:id/layers/:layerKey/features-page` instead of relying
   * on the parent-supplied `featuresByLayer` cache. Combined with
   * the "Records in map extent" toggle (default ON), this is what
   * makes the table usable on big layers like the 1.4M-row parcels
   * dataset (#115 P13). Null / undefined disables server-paged mode
   * and the legacy client-side path is used (which works fine for
   * geojson-url / arcgis-rest / inline sources).
   */
  mapBbox?: [number, number, number, number] | null;
  /**
   * When true, the table renders to fill its parent container
   * (`relative h-full w-full`) instead of overlaying the bottom 40%
   * of an `absolute` parent. The own close button is also hidden
   * and global Esc handling is skipped, on the assumption that the
   * parent (a ToolPopover, a modal dialog, etc.) owns those.
   *
   * This is what the Custom Web App designer's attribute-table
   * widget passes so it can drop the same component into a panel-
   * arrangement-positioned popover without the map-editor's
   * bottom-dock CSS fighting the popover's own sizing.
   */
  embedded?: boolean;
  /**
   * #87 -- optional bitemporal "as of" ISO timestamp.  When set, the
   * server-paged `/features-page` fetch threads `at=<ISO>` so the
   * table shows rows valid at that moment rather than current truth.
   * Null / undefined = "now" (default).  The Custom Web App runtime
   * passes its AppTimeContext value here so the table re-fetches
   * when the user scrubs the time slider.
   */
  asOfTime?: string | null;
}

type SortDir = 'asc' | 'desc';

/**
 * Bottom-overlay attribute table. One layer at a time; the top-row
 * picker switches the focused layer. Rows are the layer's features;
 * columns are the layer's attribute fields.
 *
 * Interactions:
 *   - Click a column header to sort (click again to flip direction).
 *   - Click a row to toggle its selection; shift-click for a range.
 *   - Toolbar: Zoom to selection, text Query, "Use selection as filter".
 *   - Edit is gated on canEdit + a source that supports writes. For
 *     now, feature-service sources only accept replace-all updates, so
 *     row-level edit is stubbed with a friendly message.
 */
export function AttributeTable({
  open,
  layers,
  featuresByLayer,
  metadata,
  canEdit,
  selection,
  setSelection,
  onClose,
  onZoomTo,
  onPatchLayer,
  focusLayerId,
  onPatchFeature,
  editableLayerIds,
  editableFieldsByLayer,
  fieldsByLayer,
  pickLists,
  mapBbox,
  embedded = false,
  asOfTime,
}: Props) {
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [lastPicked, setLastPicked] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [query, setQuery] = useState('');
  /**
   * Inline-edit cell state. Identifies the cell currently in
   * <input> mode + its draft string. We keep the original value
   * around so Esc cancels cleanly without an extra read out of
   * featuresByLayer. Saving toggles `saving` so concurrent
   * keystrokes cannot trigger a second PATCH while the first is
   * still in flight.
   */
  const [editingCell, setEditingCell] = useState<{
    layerId: string;
    idx: number;
    field: string;
  } | null>(null);
  const [draftValue, setDraftValue] = useState<string>('');
  const [originalValue, setOriginalValue] = useState<unknown>(null);
  const [savingCell, setSavingCell] = useState<{
    layerId: string;
    idx: number;
    field: string;
  } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Editor ref. The cell editor is sometimes a text <input> and
  // sometimes a <select> (when the field has a coded-value or
  // coded-value-ref domain). HTMLElement covers both for focus and
  // selection-on-mount.
  const editInputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  // Editor tracking columns toggle (#39). Off by default so the
  // table reads as the layer's actual schema; flip on when the
  // author wants to audit who-touched-what. The four columns are
  // sourced from underscore-prefixed properties (_created_by,
  // _created_at, _edited_by, _edited_at) the API surfaces alongside
  // the user-defined attributes.
  const [showEditorTracking, setShowEditorTracking] = useState(false);
  // Show-only-selected toggle. When on, visibleIndexes is restricted
  // to rows whose key is in activeSelection -- useful when a user has
  // picked a few features on the map out of thousands of rows and
  // wants to focus the table on just those. Off by default so the
  // table opens with everything visible. Resets when the active layer
  // changes (each layer's selection is independent).
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  // #102 followup: auto-zoom-on-select toggle.  When ON, clicking a
  // row in the table immediately zooms the map to the resulting
  // selection.  Default ON to preserve the previous unconditional
  // client-mode auto-zoom behavior AND give server-paged users
  // (parcels-style layers) the same convenience without a per-row
  // click on "Zoom to".  Toggling OFF disables both paths so users
  // who prefer click-then-zoom can opt out.
  const [autoZoomOnSelect, setAutoZoomOnSelect] = useState(true);

  // #83: Calculate Field modal state.  Right-clicking a user-field
  // column header opens this; null means closed.  Only meaningful
  // when the active layer is a v3 data_layer sublayer (serverMode);
  // we don't bother showing the menu for legacy geojson layers.
  const [calcFieldFor, setCalcFieldFor] = useState<string | null>(null);

  /**
   * "Records in map extent" toggle, default ON (#115 P13). When the
   * active layer is a v3 data_layer sublayer and mapBbox is wired
   * through from the canvas, the table switches to server-paged
   * mode and only asks for rows whose geometry intersects the map's
   * current viewport. This is the elegant primary mechanism for
   * making big layers (1.4M-row parcels datasets) usable in the
   * attribute table: the user already has the right rows on screen,
   * the table just shows them. Off means "all rows in this layer",
   * capped at 5,000 with a truncation banner.
   *
   * Persisted nowhere yet -- per-session is enough for v1. A user
   * pref would land alongside other per-user table prefs in a
   * later pass.
   */
  const [extentOnly, setExtentOnly] = useState(true);

  /**
   * Debounced search query for the server-paged fetch. Decoupling
   * the URL's `q` from every keystroke prevents a request storm
   * while typing; 300ms is the standard "feels instant but settles
   * before fetch" delay we use elsewhere (search bar, item list
   * filter). The legacy client-side path uses the raw `query`
   * directly because filtering an already-loaded array is free.
   */
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  /**
   * Server-paged results. Populated when the active layer is a v3
   * data_layer sublayer and we hit /features-page; null otherwise.
   * The shape matches the controller's return: an array of
   * `{ id, properties }` plus a count + truncation flag. We don't
   * receive geometry, so zoom-to-selection in this mode falls back
   * to a no-op (the row is still highlighted on the map via the
   * shared selection state + MVT setFeatureState path).
   */
  const [serverPage, setServerPage] = useState<{
    features: Array<{ id: string; properties: Record<string, unknown> }>;
    count: number;
    truncated: boolean;
  } | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Only layers the viewer is allowed to query belong in the table.
  // `effective.query === false` is the server's signal (from the
  // access matrix) that this layer's attributes are off-limits for
  // the current user. Group rows are excluded outright -- a group
  // is a UI-only organising header with no features, so listing it
  // in the picker would only frustrate the user. Filtering at the
  // picker level keeps both the dropdown and the auto-selected
  // "first visible" layer honest.
  const queryableLayers = useMemo(
    () =>
      layers.filter(
        (l) =>
          l.source.kind !== 'group' &&
          (l.effective === undefined || l.effective.query !== false),
      ),
    [layers],
  );

  // The active layer's selection; the table only ever shows one
  // layer at a time, so we read a single slice off the shared map.
  // Selection keys are either the row's `_global_id` UUID (string)
  // for v3 sources that use promoteId, or a numeric array index for
  // sources that fall back to generateId. Helpers below handle both.
  const activeSelection: Set<number | string> =
    (activeLayerId && selection[activeLayerId]) ||
    new Set<number | string>();

  // Default to the top visible queryable layer whenever the list
  // changes. Also resets the active layer if the currently-active one
  // just had its query permission revoked (e.g. matrix edit on an
  // editor-side map viewer refresh).
  // When the parent passes `focusLayerId` (the per-layer kebab's
  // "Open attribute table" action, #72) we honour that pick once
  // each time it transitions to a new value. The focus prop stays
  // sticky on the parent after the kebab click; if we re-applied
  // it on every render the dropdown's "Switch layer" pick would
  // snap right back the moment the effect re-ran. Track the last
  // focus we already honoured and only re-apply when it changes.
  const lastAppliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    // Honour a fresh focusLayerId from the parent (kebab click).
    // Only when it differs from the last value we already applied,
    // so the user's own dropdown picks aren't reverted.
    if (
      focusLayerId &&
      focusLayerId !== lastAppliedFocusRef.current &&
      queryableLayers.some((l) => l.id === focusLayerId)
    ) {
      lastAppliedFocusRef.current = focusLayerId;
      setActiveLayerId(focusLayerId);
      setLastPicked(null);
      setSortBy(null);
      return;
    }
    // Track focus going back to null so the next non-null value
    // counts as a fresh transition.
    if (!focusLayerId) lastAppliedFocusRef.current = null;
    if (
      activeLayerId &&
      queryableLayers.some((l) => l.id === activeLayerId)
    ) {
      return;
    }
    const first =
      queryableLayers.find((l) => l.visible) ?? queryableLayers[0] ?? null;
    setActiveLayerId(first?.id ?? null);
    setLastPicked(null);
    setSortBy(null);
    setQuery('');
    setShowOnlySelected(false);
    // Note: we deliberately don't clear the shared selection here
    // switching layers should preserve the picks on other layers.
  }, [open, queryableLayers, activeLayerId, focusLayerId]);

  /** Replace the active layer's slice; leave other layers untouched. */
  function updateActiveSelection(next: Set<number | string>) {
    if (!activeLayerId) return;
    setSelection((prev) => ({ ...prev, [activeLayerId]: next }));
  }

  /**
   * Stable key for a row in the shared selection set. v3 promoteId
   * sources expose `_global_id` in properties; we prefer that so the
   * selection survives the bbox-driven setData refresh that happens on
   * every map pan (#318). Sources without a stable property fall back
   * to the row's array index, which is fine when the source data isn't
   * being reshuffled. Returning the same value MapCanvas's setFeatureState
   * will receive lets the table's row-checkmark match the map highlight
   * one-for-one.
   */
  function featureKeyAt(idx: number): number | string {
    const f = activeFeatures[idx];
    const gid =
      f && f.properties && typeof f.properties === 'object'
        ? (f.properties as Record<string, unknown>)['_global_id']
        : undefined;
    return typeof gid === 'string' ? gid : idx;
  }

  /**
   * Resolve a stored selection key back to a row index in the active
   * feature collection. Numeric keys are used as-is; string keys hunt
   * for a row with a matching `_global_id`. Returns -1 when no match
   * (the selected feature isn't currently in the table's view, e.g.
   * the user selected something on the map that's outside the table's
   * filter / sort window).
   */
  function indexForKey(key: number | string): number {
    if (typeof key === 'number') {
      return key < activeFeatures.length ? key : -1;
    }
    for (let i = 0; i < activeFeatures.length; i += 1) {
      const props = activeFeatures[i]?.properties ?? null;
      if (
        props &&
        typeof props === 'object' &&
        (props as Record<string, unknown>)['_global_id'] === key
      ) {
        return i;
      }
    }
    return -1;
  }

  /** Set membership check using the row's stable key. */
  function isRowSelected(idx: number): boolean {
    return activeSelection.has(featureKeyAt(idx));
  }

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null;

  /**
   * Server-paged mode is on when the active layer is a v3 data_layer
   * sublayer (has both itemId + layerKey on its source). The /features-
   * page endpoint only exists for that path; for legacy geojson-url /
   * arcgis-rest / geojson-inline sources we fall back to the parent-
   * fed featuresByLayer cache + client-side filter/sort, which works
   * fine for those source sizes. (#115 P13)
   */
  const serverDataLayerSource =
    activeLayer && activeLayer.source.kind === 'data-layer'
      ? activeLayer.source
      : null;
  const serverItemId = serverDataLayerSource?.itemId ?? null;
  const serverLayerKey = serverDataLayerSource?.layerKey ?? null;
  const serverMode = Boolean(serverItemId && serverLayerKey);

  /**
   * Stable serialization of entityIds for the server-paged fetch.
   * "Show selected" in server mode maps to the `entityIds` query
   * param (UUIDs only -- numeric-index keys can't be queried by
   * entity). Capped at 1000 to match the server-side validation.
   * Returns null when the selection wouldn't usefully constrain the
   * query (mode off, empty selection, or no UUID-shaped keys).
   */
  const entityIdsForServer = useMemo<string | null>(() => {
    if (!serverMode || !showOnlySelected) return null;
    if (activeSelection.size === 0) return null;
    const ids: string[] = [];
    for (const k of activeSelection) {
      if (typeof k === 'string' && UUID_RE.test(k)) {
        ids.push(k);
        if (ids.length >= 1000) break;
      }
    }
    return ids.length > 0 ? ids.join(',') : null;
  }, [serverMode, showOnlySelected, activeSelection]);

  /**
   * Drive the server-paged fetch. Re-runs whenever any URL input
   * changes: active layer, debounced query, sort col/dir,
   * extent-only toggle + bbox (when on), or the entityIds slice
   * for show-selected. Aborts the previous in-flight request so
   * a rapid pan or sort flip doesn't paint stale rows.
   *
   * The +1-row LIMIT trick on the server returns `truncated:true`
   * without a separate COUNT scan; we surface that as the banner
   * above the table.
   */
  useEffect(() => {
    if (!serverMode || !serverItemId || !serverLayerKey) {
      setServerPage(null);
      setServerLoading(false);
      setServerError(null);
      return;
    }
    const ctrl = new AbortController();
    let abort = false;
    const params = new URLSearchParams();
    // Cap mirrors the server clamp -- explicit so a future change
    // to either side is loud.
    params.set('limit', '5000');
    if (extentOnly && mapBbox) {
      params.set(
        'bbox',
        `${mapBbox[0]},${mapBbox[1]},${mapBbox[2]},${mapBbox[3]}`,
      );
    }
    const q = debouncedQuery.trim();
    if (q.length > 0) params.set('q', q);
    if (sortBy) {
      params.set('sort', sortBy);
      params.set('dir', sortDir);
    }
    if (entityIdsForServer) params.set('entityIds', entityIdsForServer);
    // #87 -- bitemporal "as of" pass-through.  When the host runtime
    // is in time-travel mode, fetch the snapshot at the chosen
    // moment so the table matches what the map is rendering.
    if (asOfTime) params.set('at', asOfTime);
    setServerLoading(true);
    setServerError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${serverItemId}/layers/${serverLayerKey}/features-page?${params.toString()}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          if (!abort) {
            setServerPage({ features: [], count: 0, truncated: false });
            setServerError(`Server returned ${res.status}`);
          }
          return;
        }
        const data = (await res.json()) as {
          features: Array<{ id: string; properties: Record<string, unknown> }>;
          count: number;
          truncated: boolean;
        };
        if (!abort) setServerPage(data);
      } catch (err) {
        if (abort) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setServerError(err instanceof Error ? err.message : 'Fetch failed');
        setServerPage({ features: [], count: 0, truncated: false });
      } finally {
        if (!abort) setServerLoading(false);
      }
    })();
    return () => {
      abort = true;
      ctrl.abort();
    };
  }, [
    serverMode,
    serverItemId,
    serverLayerKey,
    extentOnly,
    mapBbox,
    debouncedQuery,
    sortBy,
    sortDir,
    entityIdsForServer,
    asOfTime,
  ]);

  // Drop any cached server page when the layer changes or the table
  // closes, so the next open shows a clean loading state instead of
  // briefly flashing the previous layer's rows.
  useEffect(() => {
    if (!serverMode) setServerPage(null);
  }, [serverMode, activeLayerId]);

  // #352: AGO-style Attachments column. Surfaces the v3
  // feature_attachment rows for any attribute table sourced from a
  // v3 data_layer sublayer (those carry the data-layer source kind
  // with both itemId + layerKey). Other source kinds (legacy
  // geojson-url / arcgis-rest / inline) skip the column entirely
  // since the v3 attachments controller is the only path today.
  // The drawer below renders the same thumbnails-or-file-rows the
  // FormView Attachments section ships for the Response Viewer
  // (#351), so the visual shape is consistent across surfaces.
  const attachmentsItemId =
    activeLayer && activeLayer.source.kind === 'data-layer'
      ? activeLayer.source.itemId
      : null;
  const attachmentsLayerKey =
    activeLayer && activeLayer.source.kind === 'data-layer'
      ? (activeLayer.source.layerKey ?? null)
      : null;
  const showAttachmentsColumn = Boolean(
    attachmentsItemId && attachmentsLayerKey,
  );
  // The drawer that pops up on click. featureId is the row's
  // _global_id (UUID); attachments=null while loading, [] when no
  // attachments exist.
  const [attachmentDrawer, setAttachmentDrawer] = useState<{
    featureId: string;
  } | null>(null);
  const [drawerAttachments, setDrawerAttachments] = useState<
    AttributeAttachmentRow[] | null
  >(null);
  useEffect(() => {
    if (
      !attachmentDrawer ||
      !attachmentsItemId ||
      !attachmentsLayerKey
    ) {
      setDrawerAttachments(null);
      return;
    }
    let abort = false;
    setDrawerAttachments(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${attachmentsItemId}/layers/${attachmentsLayerKey}/features/${attachmentDrawer.featureId}/attachments`,
        );
        if (!res.ok) {
          if (!abort) setDrawerAttachments([]);
          return;
        }
        const rows = (await res.json()) as AttributeAttachmentRow[];
        if (!abort) setDrawerAttachments(rows);
      } catch {
        if (!abort) setDrawerAttachments([]);
      }
    })();
    return () => {
      abort = true;
    };
  }, [attachmentDrawer, attachmentsItemId, attachmentsLayerKey]);

  // Filter the underscore-prefixed system fields out of the
  // default render. Editor-tracking fields are surfaced (formatted)
  // by the "Edit history" toggle; _global_id is a system UUID with
  // no user-facing purpose. Both are HIDDEN_SYSTEM_FIELDS.
  //
  // In server-paged mode (#115 P13) the metadata probe might still
  // be hammering the legacy /geojson endpoint on a 1.4M-row layer
  // and never settle, so we fall back to deriving the column set
  // from the first page of /features-page results. That keeps the
  // attribute table usable while the metadata probe is in flight.
  const activeFields = useMemo(() => {
    const fromMetadata =
      activeLayer && metadata[activeLayer.id]?.fields.length
        ? metadata[activeLayer.id]!.fields
        : [];
    if (fromMetadata.length > 0) {
      return fromMetadata.filter((f) => !HIDDEN_SYSTEM_FIELDS.has(f));
    }
    if (serverMode && serverPage && serverPage.features.length > 0) {
      const set = new Set<string>();
      // Sample the first ~50 rows to catch sparse columns without
      // walking the full 5000-row payload. JSONB-on-postgres rows
      // tend to share a shape so 50 is overkill, but cheap.
      const sample = serverPage.features.slice(0, 50);
      for (const f of sample) {
        for (const k of Object.keys(f.properties ?? {})) {
          if (!HIDDEN_SYSTEM_FIELDS.has(k)) set.add(k);
        }
      }
      return [...set].sort();
    }
    return [];
  }, [activeLayer, metadata, serverMode, serverPage]);

  /**
   * Unified feature array used by every downstream render and
   * handler. In server mode we wrap `/features-page` rows in a
   * Feature-shaped object (no geometry, since the endpoint doesn't
   * ship geometry to keep response size in check on 5k-row pages);
   * in legacy mode we use the parent-fed cache as before. The
   * absence of geometry in server mode is handled gracefully by
   * `bboxOfFeatures` (it skips features without geometry) and by
   * the row-click auto-zoom (gated below).
   */
  const activeFeatures = useMemo<GeoJSON.Feature[]>(() => {
    if (serverMode) {
      if (!serverPage) return [];
      return serverPage.features.map(
        (f): GeoJSON.Feature => ({
          type: 'Feature',
          // Cast satisfies TS without leaking a fake-geometry into
          // any handler that actually reads it: those callsites
          // null-check first.
          geometry: null as unknown as GeoJSON.Geometry,
          properties: f.properties,
          id: f.id,
        }),
      );
    }
    return (
      (activeLayer ? featuresByLayer[activeLayer.id] : null)?.features ?? []
    );
  }, [serverMode, serverPage, activeLayer, featuresByLayer]);

  // Field-domain lookup. Returns the configured options when the
  // field for the active layer carries a coded-value or
  // coded-value-ref domain. Used by the inline cell editor to
  // render a `<select>` of permitted values rather than a freeform
  // text input. Returns null when the field has no domain or when
  // fieldsByLayer wasn't threaded through (e.g. the map editor's
  // attribute-table use).
  function resolveFieldDomainOptions(
    fieldName: string,
  ): Array<{ code: string | number; label: string }> | null {
    if (!activeLayer || !fieldsByLayer) return null;
    const fields = fieldsByLayer[activeLayer.id];
    if (!fields) return null;
    const f = fields.find((x) => x.name === fieldName);
    if (!f || !f.domain) return null;
    if (f.domain.type === 'coded-value') {
      return f.domain.values.map((v) => ({ code: v.code, label: v.label }));
    }
    if (f.domain.type === 'coded-value-ref') {
      const list = pickLists?.[f.domain.pickListItemId];
      if (!list) return null;
      return list.entries.map((e) => ({ code: e.code, label: e.label }));
    }
    return null;
  }

  // #355: prefetch display names for every UUID-shaped value in the
  // user-id columns, then nudge a re-render once the cache is warm.
  // The metadata probe (#discoverLayerMetadata) already prefetches
  // names for popups, but it only walks _created_by / _edited_by --
  // form-mirrored rows also carry _submitted_by / submitted_by /
  // created_by / edited_by, so we cast a wider net here. The single
  // 250ms tick covers the cache fill window (50ms debounce + a
  // round-trip) without polling forever.
  const [, setNameTick] = useState(0);
  useEffect(() => {
    if (activeFeatures.length === 0) return;
    const ids: string[] = [];
    for (const f of activeFeatures) {
      const props = (f?.properties ?? {}) as Record<string, unknown>;
      for (const key of USER_ID_FIELDS) {
        const v = props[key];
        if (typeof v === 'string' && UUID_RE.test(v)) ids.push(v);
      }
    }
    if (ids.length === 0) return;
    prefetchUserNames(ids);
    const t = window.setTimeout(() => setNameTick((n) => n + 1), 250);
    return () => window.clearTimeout(t);
  }, [activeFeatures]);

  // Apply query + sort + selected-only filter. Indexes into
  // `activeFeatures`, not flattened, so selection indices always
  // line up with the source array. Selected-only is the toggle
  // exposed on the toolbar; it filters down to rows whose key is
  // in activeSelection, which is the natural follow-up to picking
  // features on the map (especially with thousands of rows).
  //
  // In server-paged mode (#115 P13) all three are already applied
  // server-side -- the bbox, the q, the sort, and the entityIds
  // for show-selected -- so we hand back identity indexes. This
  // matches the design choice spelled out in the commit body:
  // sort is a JS pass over the bounded result set when needed,
  // but we let the controller do the work when we can.
  const visibleIndexes = useMemo(() => {
    if (serverMode) {
      return activeFeatures.map((_, i) => i);
    }
    const q = query.trim().toLowerCase();
    let idxs = activeFeatures.map((_, i) => i);
    if (showOnlySelected && activeSelection.size > 0) {
      idxs = idxs.filter((i) => {
        const f = activeFeatures[i];
        const gid =
          f && f.properties && typeof f.properties === 'object'
            ? (f.properties as Record<string, unknown>)['_global_id']
            : undefined;
        const key = typeof gid === 'string' ? gid : i;
        return activeSelection.has(key);
      });
    }
    if (q.length > 0) {
      idxs = idxs.filter((i) => {
        const props = (activeFeatures[i]?.properties ?? {}) as Record<
          string,
          unknown
        >;
        for (const v of Object.values(props)) {
          if (v === null || v === undefined) continue;
          if (String(v).toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }
    if (sortBy) {
      idxs.sort((a, b) => {
        const av = ((activeFeatures[a]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const bv = ((activeFeatures[b]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const cmp = compareValues(av, bv);
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return idxs;
  }, [
    serverMode,
    activeFeatures,
    query,
    sortBy,
    sortDir,
    showOnlySelected,
    activeSelection,
  ]);

  function onHeaderClick(field: string) {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  }

  function onRowClick(displayIdx: number, shift: boolean) {
    // Respect the layer's Selectable toggle. The row still highlights
    // locally via lastPicked for shift-range anchoring, but we don't
    // mutate the shared selection that drives the map.
    if (activeLayer && activeLayer.interactions?.selectable === false) return;
    const idx = visibleIndexes[displayIdx];
    if (idx === undefined) return;
    // #318: store the stable feature key (UUID for v3, index otherwise)
    // so the map highlight survives the bbox-driven setData refresh.
    const rowKey = featureKeyAt(idx);
    const next = new Set<number | string>(activeSelection);
    if (shift && lastPicked !== null) {
      const a = Math.min(displayIdx, lastPicked);
      const b = Math.max(displayIdx, lastPicked);
      for (let i = a; i <= b; i += 1) {
        const ix = visibleIndexes[i];
        if (ix === undefined) continue;
        next.add(featureKeyAt(ix));
      }
    } else {
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
    }
    updateActiveSelection(next);
    setLastPicked(displayIdx);
    // #335 / #102 followup: auto-zoom on row click, gated on the
    // user-facing toggle.  Default ON preserves the previous
    // unconditional client-mode behavior and adds server-paged
    // auto-zoom via the /selection-extent endpoint -- so a user
    // browsing a 1.4M-row parcels layer can step through rows and
    // see each one zoom in automatically.  Toggle OFF returns to
    // click-then-zoom for users who prefer that.
    if (autoZoomOnSelect) {
      zoomToKeys(next);
    }
  }

  /**
   * Compute the union bbox of every feature whose stable key is in
   * the given set. Skips keys that resolve to a missing feature or
   * to a feature without geometry (e.g. a non-spatial table layer).
   * Returns null when the bbox would be degenerate; callers fall
   * back to no-op rather than zoom into an empty rect.
   */
  function bboxOfKeySet(
    keys: Set<number | string>,
  ): [number, number, number, number] | null {
    if (keys.size === 0) return null;
    const features = [...keys]
      .map((key) => {
        const idx = indexForKey(key);
        return idx >= 0 ? activeFeatures[idx] : null;
      })
      .filter((f): f is GeoJSON.Feature => Boolean(f && f.geometry));
    if (features.length === 0) return null;
    return bboxOfFeatures(features);
  }

  function zoomToKeys(keys: Set<number | string>) {
    // Two paths.  In client-mode the AttributeTable already has the
    // features (with geometry) in memory, so bboxOfKeySet computes
    // the union without a round-trip.  In server-paged mode the
    // /features-page response strips geometry to keep payloads
    // small, so we hit the dedicated /selection-extent endpoint
    // which runs ST_Extent against the entities in PostGIS and
    // returns the bbox.  Either way: if the bbox resolves, fly
    // there; if not, no-op (server-side may return null when the
    // selected features are all non-spatial).
    //
    // Takes the key set as an explicit parameter so callers (eg
    // onRowClick, which has the post-mutation `next` set ready
    // before React commits) can avoid the stale-state race that
    // reading `activeSelection` here would expose.
    if (keys.size === 0) return;
    const localBbox = bboxOfKeySet(keys);
    if (localBbox) {
      onZoomTo(localBbox);
      return;
    }
    if (!serverMode || !serverItemId || !serverLayerKey) return;
    // Selection in server-paged mode is a Set keyed by entity uuid
    // (string).  Filter for the uuid-shaped entries so a stray
    // numeric key (from a mixed-mode flow) doesn't slip past
    // request validation.  Cap at 1000 to match the controller.
    const UUID_RE =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const ids = [...keys]
      .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
      .slice(0, 1000)
      .join(',');
    if (ids.length === 0) return;
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/items/${serverItemId}/layers/${serverLayerKey}/selection-extent?entityIds=${encodeURIComponent(ids)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          bbox: [number, number, number, number] | null;
        };
        if (body.bbox) onZoomTo(body.bbox);
      } catch {
        // Best-effort: a network blip should not derail the table.
      }
    })();
  }
  function zoomToSelection() {
    zoomToKeys(activeSelection);
  }

  /**
   * Inline-edit predicate. A cell is editable iff:
   *   - the parent wired `onPatchFeature` (turns the feature on)
   *   - the active layer is in `editableLayerIds`
   *   - the field is not underscore-prefixed (editor tracking)
   *   - the parent didn't restrict the layer's editable fields,
   *     or the field is in the per-layer allowlist
   *   - the row carries a `_global_id` (without it we can't PATCH)
   */
  function canInlineEditField(field: string, idx: number): boolean {
    if (!onPatchFeature || !activeLayer) return false;
    if (!editableLayerIds || !editableLayerIds.has(activeLayer.id))
      return false;
    if (field.startsWith('_')) return false;
    const allow = editableFieldsByLayer?.[activeLayer.id];
    if (allow && !allow.has(field)) return false;
    const props = (activeFeatures[idx]?.properties ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof props['_global_id'] !== 'string') return false;
    // multi_select doesn't fit a single-cell inline editor (a checkbox
    // group needs more vertical space than the cell affords). Disable
    // inline edit for these fields and let the user edit them through
    // the row's full attribute form, where AttributeForm renders the
    // checkbox group properly.
    const fieldDef = fieldsByLayer?.[activeLayer.id]?.find(
      (f) => f.name === field,
    );
    if (fieldDef?.type === 'multi_select') return false;
    return true;
  }

  function startEditCell(idx: number, field: string, current: unknown) {
    if (!activeLayer) return;
    if (!canInlineEditField(field, idx)) return;
    setEditError(null);
    setEditingCell({ layerId: activeLayer.id, idx, field });
    setOriginalValue(current);
    // Render the value as a string the user can edit. JSON-stringify
    // objects so they round-trip; primitives go through String().
    setDraftValue(
      current === null || current === undefined
        ? ''
        : typeof current === 'object'
          ? JSON.stringify(current)
          : String(current),
    );
  }

  function cancelEditCell() {
    setEditingCell(null);
    setDraftValue('');
    setOriginalValue(null);
    setEditError(null);
  }

  /**
   * Commit the in-progress edit. We coerce the draft string back
   * to the same JS type as the original value so a number column
   * stays a number, a boolean stays a boolean, etc. If the user
   * blanks the cell and the field was numeric/boolean we send null
   * (so the column can clear); for string columns an empty string
   * is preserved as-is. Pick-list awareness is intentionally not
   * here yet (the LayerMetadata.fields surface is `string[]`, not
   * full FeatureField objects with domains); for now pick-list
   * fields edit as raw text. The richer cell editor that knows
   * about coded-value domains lands when we thread fieldsByLayer
   * through alongside the existing string allowlist.
   */
  async function commitEditCell() {
    if (!editingCell || !activeLayer || !onPatchFeature) return;
    const feature = activeFeatures[editingCell.idx];
    if (!feature) return;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const featureId =
      typeof props['_global_id'] === 'string'
        ? (props['_global_id'] as string)
        : null;
    if (!featureId) {
      setEditError('Missing feature id; refresh and try again.');
      return;
    }
    const coerced = coerceDraft(draftValue, originalValue);
    // No-op edits (same value typed back in) shouldn't fire a
    // server round-trip; quietly close out the editor.
    if (sameValue(coerced, originalValue)) {
      cancelEditCell();
      return;
    }
    setSavingCell({ ...editingCell });
    setEditError(null);
    try {
      // Build the merged full properties bag the server expects.
      // The v3 PATCH endpoint replaces `properties` wholesale, so
      // we send everything-except-underscore-keys plus the new
      // value for the edited field. The server stamps _edited_*
      // on its own side.
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('_')) continue;
        next[k] = v;
      }
      next[editingCell.field] = coerced;
      await onPatchFeature(activeLayer.id, featureId, next);
      // Success: drop edit state. Parent's refresh will repaint
      // the new value once the geojson re-fetch lands. Until then
      // the cell briefly shows the stale value, which is fine
      // (sub-second on local; the parent should refresh quickly).
      cancelEditCell();
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : 'Save failed; try again.',
      );
    } finally {
      setSavingCell(null);
    }
  }

  // Auto-focus the cell input when entering edit mode so users can
  // type immediately without an extra click. Selecting the existing
  // text matches Excel/Google Sheets behavior: typing replaces, but
  // the user can also arrow-key into the existing text if they only
  // want a small change.
  useEffect(() => {
    if (!editingCell) return;
    // Defer to next tick so the input has mounted.
    const id = window.requestAnimationFrame(() => {
      const el = editInputRef.current;
      if (el) {
        el.focus();
        try {
          // .select() exists on text inputs but not on selects. Cast
          // and feature-detect; on a select this is a no-op.
          if ('select' in el && typeof (el as HTMLInputElement).select === 'function') {
            (el as HTMLInputElement).select();
          }
        } catch {
          /* hidden inputs can throw on select; ignore */
        }
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [editingCell]);

  // Bail out of edit mode if the active layer changes underneath
  // us (layer dropdown, focusLayerId update, etc). Otherwise the
  // editor would be applied to the wrong row when the user comes
  // back. Same idea for the table closing.
  useEffect(() => {
    if (!open) cancelEditCell();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (editingCell && editingCell.layerId !== activeLayerId) {
      cancelEditCell();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLayerId]);

  function selectionToFilter() {
    if (!activeLayer || activeSelection.size === 0) return;
    // #318: selection keys are heterogeneous (UUID for v3 promoteId,
    // numeric idx otherwise). Resolve to numeric indexes here so
    // pickIdField + the property-extraction loop below stay simple.
    const idxSet = new Set<number>();
    for (const key of activeSelection) {
      const i = indexForKey(key);
      if (i >= 0) idxSet.add(i);
    }
    if (idxSet.size === 0) return;
    // Strategy: if the features carry a stable id field, convert to a
    // single `in` clause. Otherwise fall back to a boolean-OR of per-
    // feature primary-key guesses. If no usable id field is
    // discoverable, we bail with a visible error rather than silently
    // filtering nothing.
    const idField = pickIdField(activeFields, activeFeatures, idxSet);
    if (!idField) return;
    const values = [...idxSet]
      .map((i) => {
        const v = (activeFeatures[i]?.properties ?? {}) as Record<string, unknown>;
        return v[idField];
      })
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v));
    if (values.length === 0) return;
    // A single multi-clause filter with OR'd == clauses keeps it
    // compatible with the existing filter editor.
    const filter: MapLayerFilter = {
      combinator: 'any',
      clauses: values.map((v) => ({ field: idField, op: '==' as const, value: v })),
    };
    onPatchLayer(activeLayer.id, { filter });
  }

  if (!open) return null;

  return (
    <div
      className={
        embedded
          ? // Embedded: fill the parent (a ToolPopover content area in
            // the Custom Web App, etc.). The parent owns positioning,
            // sizing, and chrome.
            'relative flex h-full w-full flex-col bg-surface-1'
          : // Default: bottom dock over a relatively-positioned canvas
            // parent (the map editor's pattern). 40% of the canvas
            // height, full width.
            'absolute bottom-0 left-0 right-0 z-20 flex h-[40%] min-h-[240px] flex-col border-t border-border bg-surface-1 shadow-overlay'
      }
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          <Table className="h-3.5 w-3.5" />
          Attribute table
        </h3>
        {queryableLayers.length > 0 ? (
          <select
            value={activeLayerId ?? ''}
            onChange={(e) => {
              setActiveLayerId(e.target.value);
              // Preserve selection across layer switches: picks on
              // other layers keep their highlight on the map. The
              // show-only-selected and Edit-history toggles, the
              // search query, and the sort are all per-layer view
              // state and reset. Extent-only flips back to its
              // default ON so a switch to a big layer doesn't trip
              // the no-cap fallback the user disabled for a small
              // layer they were on.
              setQuery('');
              setSortBy(null);
              setLastPicked(null);
              setShowOnlySelected(false);
              setExtentOnly(true);
              setServerPage(null);
              setServerError(null);
            }}
            className="h-7 min-w-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {queryableLayers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ml-2 flex flex-1 items-center gap-2">
          <label className="relative block min-w-0 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Query any field..."
              className="h-7 w-full rounded border border-border bg-surface-1 pl-7 pr-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </label>
          <span className="text-[11px] text-muted">
            {serverLoading
              ? 'Loading...'
              : `${visibleIndexes.length.toLocaleString()} rows`}
            {serverMode && serverPage?.truncated ? '+' : ''}
            {activeSelection.size > 0 ? ` · ${activeSelection.size} selected` : ''}
          </span>
          {/* "Records in map extent" toggle (#115 P13). Default ON
              for data-layer sources so opening the table on a big
              layer (1.4M parcels) only loads rows the user can see.
              Toggle off to query all rows -- still capped at 5,000
              with a truncation banner. Hidden for legacy sources
              (geojson-url / arcgis-rest / inline) since the client-
              side path doesn't have a meaningful "in-extent" notion
              right now. */}
          {serverMode ? (
            <button
              type="button"
              onClick={() => setExtentOnly((v) => !v)}
              aria-pressed={extentOnly}
              disabled={!mapBbox}
              title={
                !mapBbox
                  ? 'Map viewport not available yet'
                  : extentOnly
                    ? 'Show all records (capped at 5,000)'
                    : 'Show only records in the current map extent'
              }
              className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                extentOnly
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-muted hover:text-ink-1'
              }`}
            >
              <MapIcon className="h-3 w-3" />
              In extent
            </button>
          ) : null}
          {/* "Show selected" toggle: when a layer has thousands of
              rows, finding the few selected ones by scrolling is
              painful. This filters visibleIndexes down to just the
              rows whose key is in activeSelection. Disabled when
              nothing is selected (the toggle would be a no-op). */}
          <button
            type="button"
            onClick={() => setShowOnlySelected((v) => !v)}
            aria-pressed={showOnlySelected}
            disabled={activeSelection.size === 0}
            title={
              activeSelection.size === 0
                ? 'Select features on the map first'
                : showOnlySelected
                  ? 'Show all rows'
                  : 'Show only the selected rows'
            }
            className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              showOnlySelected
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-1 text-muted hover:text-ink-1'
            }`}
          >
            <FilterIcon className="h-3 w-3" />
            Show selected
          </button>
          {/* "Edit history" toggle: surfaces the who-edited-when
              audit columns (Created / Created by / Edited /
              Edited by) in a properly-formatted view. Hidden in
              read-only contexts (Viewer / Survey templates pass
              canEdit=false). The button is a display toggle; the
              underlying tracking data is always being captured by
              the API regardless of whether this is on. The label
              used to read "Track edits" but that read as a verb
              that turned tracking on/off; "Edit history" reads
              correctly as a display affordance. */}
          {canEdit ? (
            <button
              type="button"
              onClick={() => setShowEditorTracking((v) => !v)}
              aria-pressed={showEditorTracking}
              title={
                showEditorTracking
                  ? 'Hide edit history columns'
                  : 'Show edit history columns (who created / edited each row)'
              }
              className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors ${
                showEditorTracking
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-muted hover:text-ink-1'
              }`}
            >
              <History className="h-3 w-3" />
              Edit history
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            // #102 followup: split-mode button.
            //   - One-time click with selection + toggle OFF:
            //     zooms to the current selection AND turns the
            //     toggle ON so subsequent row clicks auto-zoom.
            //   - Click again with toggle ON: turns it OFF (no
            //     extra zoom; the user just wanted to stop the
            //     auto-zoom behavior).
            //   - No selection + toggle OFF: still flips ON so
            //     the next row click zooms.
            // Net effect: button is a toggle that ALSO performs a
            // one-shot zoom when you turn it on with a selection
            // already in place.  Matches what most users expect
            // from a "sticky" zoom-to button.
            if (autoZoomOnSelect) {
              setAutoZoomOnSelect(false);
            } else {
              setAutoZoomOnSelect(true);
              if (activeSelection.size > 0) zoomToSelection();
            }
          }}
          aria-pressed={autoZoomOnSelect}
          className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium transition-colors ${
            autoZoomOnSelect
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
          }`}
          title={
            autoZoomOnSelect
              ? 'Auto-zoom on row click is ON. Click to turn off.'
              : 'Click to turn on auto-zoom (row clicks zoom to the feature). Also zooms to the current selection once.'
          }
        >
          <Focus className="h-3.5 w-3.5" />
          Zoom to
        </button>
        <button
          type="button"
          onClick={selectionToFilter}
          disabled={activeSelection.size === 0 || !activeLayer}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title="Filter the layer to only the selected features"
        >
          <FilterIcon className="h-3.5 w-3.5" />
          Use as filter
        </button>
        {/* #108: export the currently-displayed feature set to CSV
            or Excel.  Scope follows the table's existing scope
            controls: "all rows" exports activeFeatures; with a
            selection + the dropdown's "Selected rows" option
            we export only those.  Bundle (related tables +
            attachments) is the bigger sibling tracked as #109. */}
        <AttrTableExportMenu
          features={activeFeatures}
          fields={
            activeLayer && fieldsByLayer
              ? fieldsByLayer[activeLayer.id] ?? null
              : null
          }
          layerTitle={activeLayer?.title ?? 'layer'}
          dataLayerItemId={
            activeLayer?.source.kind === 'data-layer'
              ? activeLayer.source.itemId
              : null
          }
          dataLayerLayerKey={
            activeLayer?.source.kind === 'data-layer'
              ? activeLayer.source.layerKey ?? null
              : null
          }
          activeSelection={activeSelection}
          featureKeyAt={featureKeyAt}
          disabled={activeFeatures.length === 0 || !activeLayer}
        />
        {/* The own close button is hidden when embedded: the parent
            (a ToolPopover in the Custom Web App, etc.) owns close. */}
        {embedded ? null : (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {serverMode && serverPage?.truncated ? (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Showing 5,000+ rows
            {extentOnly ? ' in this extent' : ''}. Zoom in
            {extentOnly ? '' : ', enable "In extent",'} or filter to see more.
          </span>
        </div>
      ) : null}
      {!activeLayer ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          No layer selected.
        </div>
      ) : serverMode && serverLoading && activeFeatures.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading features...
        </div>
      ) : activeFeatures.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {serverError
            ? `Failed to load: ${serverError}`
            : serverMode
              ? extentOnly
                ? 'No features in this map extent.'
                : 'No features to show.'
              : metadata[activeLayer.id]?.loading
                ? 'Loading features...'
                : 'No features to show.'}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th className="w-8 border-b border-border px-2 py-1.5" />
                {activeFields.map((f) => (
                  <th
                    key={f}
                    onClick={() => onHeaderClick(f)}
                    onContextMenu={(e) => {
                      // #83: right-click opens Calculate Field.  Only
                      // for v3 data_layer sublayers (serverMode); the
                      // legacy geojson client-cache path can't write
                      // back per-row.  Owners + admins + edit-share
                      // recipients pass the server's write check;
                      // anyone else gets a 403 toast from the POST.
                      if (!serverMode || !canEdit) return;
                      e.preventDefault();
                      setCalcFieldFor(f);
                    }}
                    title={
                      serverMode && canEdit
                        ? 'Click to sort, right-click to Calculate Field'
                        : undefined
                    }
                    className="cursor-pointer border-b border-border px-3 py-1.5 text-left font-medium text-ink-1 hover:bg-surface-1"
                  >
                    <span className="inline-flex items-center gap-1">
                      {f}
                      {sortBy === f ? (
                        sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 text-muted/50" />
                      )}
                    </span>
                  </th>
                ))}
                {showEditorTracking
                  ? EDITOR_TRACKING_COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => onHeaderClick(col.key)}
                        className="cursor-pointer border-b border-border bg-surface-1 px-3 py-1.5 text-left font-medium italic text-muted hover:text-ink-1"
                        title={col.tooltip}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortBy === col.key ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-muted/50" />
                          )}
                        </span>
                      </th>
                    ))
                  : null}
                {showAttachmentsColumn ? (
                  <th
                    className="border-b border-border bg-surface-1 px-3 py-1.5 text-left font-medium text-muted"
                    title="Files attached to each feature (#352)"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Paperclip className="h-3 w-3" />
                      Attachments
                    </span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {visibleIndexes.map((idx, displayIdx) => {
                const feature = activeFeatures[idx];
                if (!feature) return null;
                const props = (feature.properties ?? {}) as Record<
                  string,
                  unknown
                >;
                const selected = isRowSelected(idx);
                return (
                  <tr
                    key={idx}
                    onClick={(e) => onRowClick(displayIdx, e.shiftKey)}
                    className={`cursor-pointer border-b border-border ${
                      selected
                        ? 'bg-accent/10 hover:bg-accent/15'
                        : 'hover:bg-surface-2'
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        readOnly
                        checked={selected}
                        className="pointer-events-none h-3 w-3 rounded border-border text-accent"
                      />
                    </td>
                    {activeFields.map((field) => {
                      const v = props[field];
                      const isEditing =
                        editingCell !== null &&
                        editingCell.layerId === activeLayer.id &&
                        editingCell.idx === idx &&
                        editingCell.field === field;
                      const isSaving =
                        savingCell !== null &&
                        savingCell.layerId === activeLayer.id &&
                        savingCell.idx === idx &&
                        savingCell.field === field;
                      const editable = canInlineEditField(field, idx);
                      return (
                        <td
                          key={field}
                          // Double-click matches Excel/Sheets: a
                          // single click still toggles row select
                          // (the row's onClick), and only an
                          // intentional double-click promotes the
                          // cell to edit mode. Saves us having to
                          // stopPropagation on every cell click.
                          onDoubleClick={(e) => {
                            if (!editable) return;
                            e.stopPropagation();
                            startEditCell(idx, field, v);
                          }}
                          title={
                            editable && !isEditing
                              ? 'Double-click to edit'
                              : undefined
                          }
                          className={`whitespace-nowrap px-3 py-1 text-ink-1 ${
                            editable && !isEditing
                              ? 'cursor-text hover:bg-accent/5'
                              : ''
                          } ${isEditing ? 'bg-accent/10 p-0' : ''}`}
                        >
                          {isEditing
                            ? (() => {
                                const domainOpts =
                                  resolveFieldDomainOptions(field);
                                if (domainOpts) {
                                  // Pick-list / coded-value field:
                                  // render a <select> of the
                                  // configured choices so the user
                                  // can't type an arbitrary value
                                  // that wouldn't match the domain.
                                  return (
                                    <select
                                      ref={editInputRef as React.Ref<HTMLSelectElement>}
                                      value={draftValue}
                                      disabled={isSaving}
                                      onChange={(e) => {
                                        setDraftValue(e.target.value);
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void commitEditCell();
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          cancelEditCell();
                                        }
                                      }}
                                      onBlur={() => {
                                        if (savingCell) return;
                                        void commitEditCell();
                                      }}
                                      className="w-full rounded border border-accent bg-surface-1 px-2 py-0.5 text-xs text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent/40"
                                    >
                                      {/* Empty option lets the user
                                          clear the field without
                                          having to retype. The
                                          server treats an empty
                                          string as null on
                                          coerce. */}
                                      <option value="">(none)</option>
                                      {domainOpts.map((o) => (
                                        <option
                                          key={String(o.code)}
                                          value={String(o.code)}
                                        >
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  );
                                }
                                return (
                                  <input
                                    ref={editInputRef as React.Ref<HTMLInputElement>}
                                    type="text"
                                    value={draftValue}
                                    disabled={isSaving}
                                    onChange={(e) => setDraftValue(e.target.value)}
                                    // Stop propagation so typing
                                    // space etc doesn't toggle the
                                    // row's selection.
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void commitEditCell();
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        cancelEditCell();
                                      }
                                    }}
                                    onBlur={() => {
                                      // Commit on blur unless
                                      // we're already saving
                                      // (avoids the second commit
                                      // when Enter both fires
                                      // commit + blur). The save
                                      // handler is idempotent on a
                                      // no-op anyway.
                                      if (savingCell) return;
                                      void commitEditCell();
                                    }}
                                    className="w-full rounded border border-accent bg-surface-1 px-2 py-0.5 text-xs text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent/40"
                                  />
                                );
                              })()
                            : formatCell(v, field)}
                        </td>
                      );
                    })}
                    {showEditorTracking
                      ? EDITOR_TRACKING_COLUMNS.map((col) => (
                          <td
                            key={col.key}
                            className="whitespace-nowrap px-3 py-1 text-muted italic"
                          >
                            {col.format(props[col.key])}
                          </td>
                        ))
                      : null}
                    {showAttachmentsColumn ? (
                      <td className="whitespace-nowrap px-3 py-1">
                        {(() => {
                          const fid = props['_global_id'];
                          if (typeof fid !== 'string' || !fid) {
                            // No stable id on this row -- can't query
                            // attachments. Show a muted dash so the
                            // column doesn't visually break.
                            return <span className="text-muted">-</span>;
                          }
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAttachmentDrawer({ featureId: fid });
                              }}
                              className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[10px] text-ink-1 hover:border-accent/40 hover:bg-surface-2"
                              title="View attachments"
                            >
                              <Paperclip className="h-3 w-3 text-muted" />
                              View
                            </button>
                          );
                        })()}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? (
        onPatchFeature ? (
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px]">
            <span className="text-muted">
              Double-click a cell to edit. Enter to save, Esc to cancel.
            </span>
            {savingCell ? (
              <span className="text-accent">Saving...</span>
            ) : editError ? (
              <span className="text-danger" role="alert">
                {editError}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
            Row-level editing lands when feature services store data in
            PostGIS. For now, edit the dataset by replacing the whole
            FeatureCollection from the feature-service detail page.
          </div>
        )
      ) : null}
      {/* #352 attachment drawer. Shared global state: only one row's
          attachments are visible at a time. Sits at the bottom-right
          of the table so it overlaps the canvas as little as
          possible while staying visible alongside the row that
          opened it. */}
      {attachmentDrawer ? (
        <AttachmentDrawer
          attachments={drawerAttachments}
          onClose={() => setAttachmentDrawer(null)}
        />
      ) : null}
      {calcFieldFor !== null && serverItemId && serverLayerKey ? (
        <CalculateFieldModal
          itemId={serverItemId}
          layerKey={serverLayerKey}
          fieldName={calcFieldFor}
          availableFields={activeFields}
          selectedIds={(() => {
            // The selection set carries client + UUID ids depending
            // on the layer; the calculate-field server endpoint only
            // accepts UUID entity ids.  Filter + cap at 1000 (same
            // bound the selection-extent endpoint uses).
            const UUID_RE =
              /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
            return [...activeSelection]
              .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))
              .slice(0, 1000);
          })()}
          onClose={() => setCalcFieldFor(null)}
          onApplied={() => {
            setCalcFieldFor(null);
            // Force a server-paged refetch so the new values land in
            // the visible rows without the user toggling a filter.
            // The serverPage state key is what useEffect watches; we
            // bump it by clearing and the next render restores from
            // the fetch path.
            setServerPage(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Calculate Field modal (#83).  Right-click on a column header
 * opens this against the chosen column.  The user writes an
 * expression in the same {{field}} grammar as the derived-layer
 * filter/calc-field steps; the server evaluates it per row,
 * returns a 5-row preview on dry-run, and writes one update
 * observation per row on apply.
 *
 * Scoping: "all rows" hits every feature in the sublayer (up to
 * the server cap of 10k); "N selected" passes the current
 * selection's entity ids.  The user picks via the radio toggle.
 *
 * No grouped-undo wire yet (each observation lands as an
 * individual undoable entry); that's the v2 polish on this
 * feature.  Today, if the user makes a mistake, they re-run the
 * calculation with a corrective expression.
 */
/**
 * #108: Export dropdown for the attribute table.  Two formats
 * today (CSV / XLSX) plus a "scope" toggle: by default we export
 * activeFeatures (whatever the table is showing); with a non-empty
 * selection the user gets a second option to export selected
 * rows only.
 *
 * Why "what the table shows" instead of always re-fetching: the
 * table is already filtered / scoped via its own controls (server
 * filter, viewport-only, hide-unselected).  Exporting that exact
 * set means "what you see is what you get", which is the least
 * surprising behavior and avoids a second round-trip for big
 * layers.  Bundle export (parent + related + attachments) is the
 * sibling tracked as #109.
 */
function AttrTableExportMenu({
  features,
  fields,
  layerTitle,
  dataLayerItemId,
  dataLayerLayerKey,
  activeSelection,
  featureKeyAt,
  disabled,
}: {
  features: GeoJSON.Feature[];
  fields: FeatureField[] | null;
  layerTitle: string;
  /** When the active layer is sourced from a v3 data_layer item,
   *  these are populated and the Bundle option becomes available.
   *  External / inline / ArcGIS-REST sources don't support bundles
   *  (no portal-side schema, no attachments, no related tables).
   *  Null in those cases. */
  dataLayerItemId: string | null;
  dataLayerLayerKey: string | null;
  activeSelection: Set<number | string>;
  featureKeyAt: (idx: number) => number | string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasSelection = activeSelection.size > 0;
  const canBundle = !!(dataLayerItemId && dataLayerLayerKey);
  const [bundleOpen, setBundleOpen] = useState(false);
  const [bundleScope, setBundleScope] = useState<'all' | 'selection'>('all');
  const [bundleIncludeRelated, setBundleIncludeRelated] = useState(true);
  const [bundleIncludeAttachments, setBundleIncludeAttachments] = useState(true);
  const [bundleRunning, setBundleRunning] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<string>('');
  const [bundleError, setBundleError] = useState<string | null>(null);

  async function runBundle(): Promise<void> {
    if (!dataLayerItemId || !dataLayerLayerKey) return;
    setBundleError(null);
    setBundleRunning(true);
    setBundleProgress('Loading layer schema…');
    try {
      // Fetch the data_layer item on-demand so the bundle helper
      // can enumerate related tables.  AttributeTable doesn't keep
      // the full data_layer schema in props -- its layers prop has
      // MapLayer entries, not the parent item's sublayer list.
      const itemRes = await fetch(
        `/api/portal/items/${encodeURIComponent(dataLayerItemId)}`,
        { cache: 'no-store' },
      );
      if (!itemRes.ok) {
        throw new Error(`Could not load data_layer schema: ${itemRes.status}`);
      }
      const item = (await itemRes.json()) as {
        data?: {
          layers?: Array<{
            id: string;
            label?: string;
            name?: string;
            fields?: Array<{ name: string; label?: string }>;
            parentLayerId?: string;
          }>;
        };
      };
      const allLayers = (item.data?.layers ?? []).map((l) => ({
        id: l.id,
        label: l.label ?? l.id,
        name: l.name ?? l.id,
        fields: (l.fields ?? []).map((f) => ({
          name: f.name,
          ...(f.label && f.label !== f.name ? { label: f.label } : {}),
        })),
        ...(l.parentLayerId ? { parentLayerId: l.parentLayerId } : {}),
      }));

      // Scope -> featureIdsAllowlist.  For 'all' we pass nothing.
      // For 'selection' we collect the currently-selected feature
      // global ids by walking activeSelection through featureKeyAt.
      let allowlist: Set<string> | undefined;
      if (bundleScope === 'selection') {
        allowlist = new Set<string>();
        for (let i = 0; i < features.length; i += 1) {
          const key = featureKeyAt(i);
          if (activeSelection.has(key)) {
            const f = features[i];
            const id = f?.id;
            if (typeof id === 'string') allowlist.add(id);
            else if (typeof id === 'number') allowlist.add(String(id));
          }
        }
        if (allowlist.size === 0) {
          throw new Error('No selected features to export.');
        }
      }

      const filename = (layerTitle || 'layer')
        .trim()
        .replace(/[^\w.\- ]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'layer';
      const result = await exportBundle({
        itemId: dataLayerItemId,
        layerKey: dataLayerLayerKey,
        filename,
        layers: allLayers,
        includeRelatedTables: bundleIncludeRelated,
        includeAttachments: bundleIncludeAttachments,
        ...(allowlist ? { featureIdsAllowlist: allowlist } : {}),
        onProgress: (msg) => setBundleProgress(msg),
      });
      setBundleProgress(
        `Done -- ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'} · ${result.featureCount} feature${result.featureCount === 1 ? '' : 's'} · ${result.attachmentCount} attachment${result.attachmentCount === 1 ? '' : 's'} · ${(result.bytes / 1024 / 1024).toFixed(1)} MB`,
      );
      setTimeout(() => {
        setBundleOpen(false);
        setBundleRunning(false);
      }, 1500);
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
      setBundleRunning(false);
    }
  }

  function run(format: ExportFormat, onlySelection: boolean): void {
    setOpen(false);
    const source = onlySelection
      ? features.filter((_, i) => activeSelection.has(featureKeyAt(i)))
      : features;
    if (source.length === 0) return;
    const filename = (layerTitle || 'layer')
      .trim()
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'layer';
    // Build options inline so we only set `fields` when we actually
    // have a schema -- exactOptionalPropertyTypes refuses
    // `fields: undefined` because the type declares it as
    // `fields?: T[]` not `fields?: T[] | undefined`.
    const fieldHints = fields?.map((fld) => ({
      name: fld.name,
      ...(fld.label && fld.label !== fld.name ? { label: fld.label } : {}),
    }));
    exportFeatures(
      source.map((f) => ({
        // GeoJSON.Feature can carry an `id` field at the top level;
        // when it's a number cast to string for the exporter's
        // generic id shape.
        ...(f.id !== undefined ? { id: String(f.id) } : {}),
        // attribute-table server mode parks geometry as null (the
        // server-paged path drops geometry to keep response sizes
        // tractable), so just pass through whatever the feature has.
        geometry: f.geometry,
        properties: (f.properties ?? null) as Record<string, unknown> | null,
      })),
      format,
      {
        filename,
        ...(fieldHints ? { fields: fieldHints } : {}),
        // XLSX gets a WKT geometry column for desktop-GIS round-
        // trip; CSV stays text-only by convention.  In server-paged
        // mode geometry will be empty/null, so the column lands as
        // empty strings -- acceptable for v1.
        includeGeometryWkt: format === 'xlsx',
      },
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        title={
          disabled
            ? 'No rows to export'
            : `Export ${features.length} row${features.length === 1 ? '' : 's'}`
        }
      >
        <Download className="h-3.5 w-3.5" />
        Export
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-30"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-8 z-40 w-56 rounded-md border border-border bg-surface-0 py-1 text-xs shadow-lg">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">
              All rows ({features.length})
            </div>
            <button
              type="button"
              onClick={() => run('xlsx', false)}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => run('csv', false)}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              CSV
            </button>
            {hasSelection ? (
              <>
                <div className="my-1 border-t border-border" />
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted">
                  Selected rows ({activeSelection.size})
                </div>
                <button
                  type="button"
                  onClick={() => run('xlsx', true)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  Excel (.xlsx)
                </button>
                <button
                  type="button"
                  onClick={() => run('csv', true)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  CSV
                </button>
              </>
            ) : null}
            {canBundle ? (
              <>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setBundleScope(hasSelection ? 'selection' : 'all');
                    setBundleOpen(true);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  Bundle (.zip) — Excel + related + attachments
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      {bundleOpen && canBundle ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={bundleRunning ? undefined : () => setBundleOpen(false)}
        >
          <div
            className="relative w-full max-w-md rounded-lg bg-surface-0 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-ink-0">
                Bundle export
              </h3>
              <p className="mt-1 text-xs text-muted">
                Pack {layerTitle} (and optionally its related tables +
                attachments) into a single ZIP.
              </p>
            </header>
            <div className="space-y-3 px-4 py-3 text-xs">
              <div>
                <label className="block text-[10px] font-medium uppercase tracking-wide text-muted">
                  Scope
                </label>
                <div className="mt-1 inline-flex rounded-md border border-border bg-surface-2 p-0.5">
                  <button
                    type="button"
                    disabled={bundleRunning}
                    onClick={() => setBundleScope('all')}
                    className={`px-3 py-1 text-[11px] ${
                      bundleScope === 'all'
                        ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                        : 'text-muted'
                    }`}
                  >
                    All ({features.length})
                  </button>
                  <button
                    type="button"
                    disabled={bundleRunning || !hasSelection}
                    onClick={() => setBundleScope('selection')}
                    title={
                      hasSelection
                        ? `Export only the ${activeSelection.size} selected feature(s)`
                        : 'Select features in the table to use this scope'
                    }
                    className={`px-3 py-1 text-[11px] ${
                      bundleScope === 'selection'
                        ? 'rounded bg-surface-1 text-ink-0 shadow-sm'
                        : 'text-muted'
                    } disabled:opacity-50`}
                  >
                    Selected ({activeSelection.size})
                  </button>
                </div>
              </div>
              <label className="flex items-start gap-2 text-ink-1">
                <input
                  type="checkbox"
                  disabled={bundleRunning}
                  checked={bundleIncludeRelated}
                  onChange={(e) =>
                    setBundleIncludeRelated(e.target.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  Include related-table sheets in the workbook (rows that
                  reference an exported parent feature ride along).
                </span>
              </label>
              <label className="flex items-start gap-2 text-ink-1">
                <input
                  type="checkbox"
                  disabled={bundleRunning}
                  checked={bundleIncludeAttachments}
                  onChange={(e) =>
                    setBundleIncludeAttachments(e.target.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  Include feature attachments under{' '}
                  <code>attachments/</code>.
                </span>
              </label>
            </div>
            {bundleProgress || bundleError ? (
              <div
                className={`mx-4 mb-3 rounded-md border px-3 py-2 text-[11px] ${
                  bundleError
                    ? 'border-danger/40 bg-danger/10 text-danger'
                    : 'border-border bg-surface-2 text-ink-1'
                }`}
              >
                {bundleError ?? bundleProgress}
              </div>
            ) : null}
            <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                disabled={bundleRunning}
                onClick={() => setBundleOpen(false)}
                className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                Close
              </button>
              <button
                type="button"
                disabled={bundleRunning}
                onClick={() => void runBundle()}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {bundleRunning ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                {bundleRunning ? 'Building…' : 'Export bundle'}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CalculateFieldModal({
  itemId,
  layerKey,
  fieldName,
  availableFields,
  selectedIds,
  onClose,
  onApplied,
}: {
  itemId: string;
  layerKey: string;
  fieldName: string;
  availableFields: string[];
  /** Filtered (UUID-only, capped at 1000) selection from the table.
   *  Length == 0 disables the "Selected rows" scope option. */
  selectedIds: string[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const selectionCount = selectedIds.length;
  const [expression, setExpression] = useState('');
  const [outputType, setOutputType] = useState<'number' | 'string' | 'boolean'>(
    'number',
  );
  const [scope, setScope] = useState<'all' | 'selection'>(
    selectionCount > 0 ? 'selection' : 'all',
  );
  const [preview, setPreview] = useState<{
    totalRows: number;
    sample: Array<{ id: string; oldValue: unknown; newValue: unknown }>;
    errors: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function insertFieldRef(name: string) {
    const el = inputRef.current;
    const token = `{{${name}}}`;
    if (!el) {
      setExpression((v) => v + token);
      return;
    }
    const start = el.selectionStart ?? expression.length;
    const end = el.selectionEnd ?? expression.length;
    const next = expression.slice(0, start) + token + expression.slice(end);
    setExpression(next);
    requestAnimationFrame(() => {
      el.focus();
      try {
        el.setSelectionRange(start + token.length, start + token.length);
      } catch {
        /* element may be re-rendered */
      }
    });
  }

  async function callServer(dryRun: boolean) {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layerKey}/features/calculate-field`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expression,
            outputName: fieldName,
            outputType,
            scope,
            ...(scope === 'selection' && selectionCount > 0
              ? { selectedIds }
              : {}),
            dryRun,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        try {
          const parsed = JSON.parse(body) as { message?: unknown };
          const msg = Array.isArray(parsed.message)
            ? String(parsed.message[0])
            : typeof parsed.message === 'string'
              ? parsed.message
              : `HTTP ${res.status}`;
          setError(msg);
        } catch {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      const data = (await res.json()) as {
        totalRows: number;
        appliedRows: number;
        sample: Array<{ id: string; oldValue: unknown; newValue: unknown }>;
        errors: number;
      };
      if (dryRun) {
        setPreview({
          totalRows: data.totalRows,
          sample: data.sample,
          errors: data.errors,
        });
      } else {
        onApplied();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-surface-1 shadow-raised">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-3">
          <div>
            <h3 className="text-sm font-medium text-ink-0">
              Calculate Field
            </h3>
            <p className="text-xs text-muted">
              Updates <span className="font-mono text-ink-1">{fieldName}</span>{' '}
              across every row in scope.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-surface-1"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-muted">
                Expression
              </span>
              <select
                value={outputType}
                onChange={(e) =>
                  setOutputType(e.target.value as 'number' | 'string' | 'boolean')
                }
                className="h-7 rounded border border-border bg-surface-1 px-2 text-[11px] focus:border-accent focus:outline-none"
              >
                <option value="number">Number</option>
                <option value="string">String</option>
                <option value="boolean">Boolean</option>
              </select>
            </div>
            <p className="text-[11px] text-muted">
              Reference fields with{' '}
              <code className="rounded bg-surface-2 px-1 font-mono">
                {`{{field}}`}
              </code>
              . Operators: + - * / == != &lt; &gt; AND OR. Functions: upper,
              lower, concat, abs, round, if(cond, a, b).
            </p>
            <div className="flex flex-wrap gap-1">
              {availableFields.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => insertFieldRef(f)}
                  className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-1 px-2 py-0.5 font-mono text-[11px] text-ink-1 hover:bg-surface-2"
                >
                  <span className="text-muted">{'{{'}</span>
                  {f}
                  <span className="text-muted">{'}}'}</span>
                </button>
              ))}
            </div>
            <textarea
              ref={inputRef}
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              rows={3}
              placeholder={
                outputType === 'number'
                  ? '{{acres}} * 0.4047'
                  : outputType === 'string'
                    ? "concat({{first_name}}, ' ', {{last_name}})"
                    : '{{population}} > 1000'
              }
              className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs text-ink-0 focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted">
              Apply to
            </p>
            <div className="flex flex-col gap-1">
              <label className="inline-flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="calc-scope"
                  value="all"
                  checked={scope === 'all'}
                  onChange={() => setScope('all')}
                />
                <span>All rows in this sublayer</span>
              </label>
              <label
                className={`inline-flex items-center gap-2 text-xs ${
                  selectionCount === 0 ? 'opacity-50' : ''
                }`}
              >
                <input
                  type="radio"
                  name="calc-scope"
                  value="selection"
                  checked={scope === 'selection'}
                  onChange={() => setScope('selection')}
                  disabled={selectionCount === 0}
                />
                <span>
                  Selected rows ({selectionCount} feature
                  {selectionCount === 1 ? '' : 's'})
                </span>
              </label>
            </div>
          </div>

          {preview ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs">
              <p className="mb-2 font-medium text-ink-0">
                Preview: {preview.totalRows} row
                {preview.totalRows === 1 ? '' : 's'} would change
                {preview.errors > 0
                  ? ` (${preview.errors} evaluation errors will become null)`
                  : ''}
              </p>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
                    <th className="pb-1 pr-3">Row</th>
                    <th className="pb-1 pr-3">Old</th>
                    <th className="pb-1">New</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row) => (
                    <tr key={row.id} className="font-mono text-[11px]">
                      <td className="pr-3 text-muted">
                        {row.id.slice(0, 8)}
                      </td>
                      <td className="pr-3 text-muted">
                        {formatCellValue(row.oldValue)}
                      </td>
                      <td className="text-ink-0">
                        {formatCellValue(row.newValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {error ? (
            <p className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => callServer(true)}
            disabled={submitting || expression.trim().length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            Preview
          </button>
          <button
            type="button"
            onClick={() => callServer(false)}
            disabled={submitting || expression.trim().length === 0 || preview === null}
            title={
              preview === null
                ? 'Run Preview first to see what will change'
                : 'Apply the calculated values to every row in scope'
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

interface AttributeAttachmentRow {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * AGO-style attachments drawer (#352). Renders thumbnails for image
 * MIME types and labeled file rows for everything else, mirroring
 * the FormView attachments section so the visual shape is
 * consistent across surfaces. Anchored bottom-right so it overlaps
 * the table least; clicking outside or pressing Escape closes it.
 */
function AttachmentDrawer({
  attachments,
  onClose,
}: {
  attachments: AttributeAttachmentRow[] | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label="Attachments"
      className="absolute bottom-3 right-3 z-30 flex max-h-80 w-80 flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-3 py-1.5">
        <Paperclip className="h-3.5 w-3.5 text-muted" />
        <span className="text-xs font-semibold text-ink-0">Attachments</span>
        {attachments && attachments.length > 0 ? (
          <span className="rounded-full bg-violet-100 dark:bg-violet-950 px-1.5 py-0.5 text-[9px] font-normal text-violet-800 dark:text-violet-300">
            {attachments.length}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-1 hover:text-ink-0"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {attachments === null ? (
          <p className="inline-flex items-center gap-1 px-1 py-2 text-xs italic text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : attachments.length === 0 ? (
          <p className="px-1 py-2 text-xs italic text-muted">No attachments</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {attachments.map((a) => (
              <AttachmentDrawerTile key={a.id} attachment={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AttachmentDrawerTile({
  attachment,
}: {
  attachment: AttributeAttachmentRow;
}) {
  const isImage = attachment.mime.startsWith('image/');
  const url = attachment.storageUrl ?? null;
  if (isImage && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={attachment.fileName}
        className="group block overflow-hidden rounded-md border border-border bg-surface-2 hover:border-accent/40"
      >
        <img
          src={url}
          alt={attachment.fileName}
          className="h-24 w-full object-cover"
          loading="lazy"
        />
        <div className="truncate px-1.5 py-1 text-[10px] text-muted group-hover:text-ink-1">
          {attachment.fileName}
        </div>
      </a>
    );
  }
  return (
    <a
      href={url ?? '#'}
      target="_blank"
      rel="noreferrer"
      title={attachment.fileName}
      className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-2 hover:border-accent/40"
    >
      <div className="flex h-10 items-center justify-center rounded bg-surface-1">
        {isImage ? (
          <ImageIcon className="h-5 w-5 text-muted" />
        ) : (
          <FileIcon className="h-5 w-5 text-muted" />
        )}
      </div>
      <div className="truncate text-[10px] text-ink-1" title={attachment.fileName}>
        {attachment.fileName}
      </div>
      <div className="text-[9px] text-muted">
        {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
      </div>
    </a>
  );
}

/**
 * Coerce the user's draft string back to the same JS type the cell
 * originally held. Numbers stay numeric; booleans accept the usual
 * truthy/falsy spellings; objects are JSON-parsed when possible.
 * An empty draft on a non-string column becomes null (so the
 * server can clear that column); on a string column the empty
 * string is preserved (a user might genuinely want '' there).
 */
function coerceDraft(draft: string, original: unknown): unknown {
  const trimmed = draft.trim();
  if (typeof original === 'number') {
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : draft;
  }
  if (typeof original === 'boolean') {
    if (trimmed === '') return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on')
      return true;
    if (
      lower === 'false' ||
      lower === '0' ||
      lower === 'no' ||
      lower === 'off'
    )
      return false;
    return draft;
  }
  if (typeof original === 'object' && original !== null) {
    if (trimmed === '') return null;
    try {
      return JSON.parse(draft);
    } catch {
      return draft;
    }
  }
  // Fallback (string, null, undefined): if the original was
  // non-string and the draft is empty, clear with null; otherwise
  // pass through as a plain string.
  if (trimmed === '' && original !== null && typeof original !== 'string') {
    return null;
  }
  return draft;
}

/** Cheap structural-equality check for the no-op-edit guard. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function formatCell(v: unknown, fieldName?: string): string {
  if (v === null || v === undefined) return '';
  // multi_select values land here as arrays of codes. Render as a
  // human-friendly comma-separated list rather than the raw
  // JSON.stringify "[\"a\",\"b\"]" the object branch below would
  // produce. The full chip-strip with resolved labels is a polish
  // that lives in the cell renderer; this keeps the row readable
  // while the editor handles real codes-to-labels.
  if (Array.isArray(v)) {
    return v
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x))
      .join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  // #355: route user-id-shaped fields through the cached name
  // resolver. Any field whose name matches the known
  // user-tracking columns (#39 / #329) and whose value is a
  // UUID-looking string gets a display name where possible. Falls
  // back to the truncated UUID prefix that getCachedUserName
  // returns until the prefetch flight lands -- the table picks
  // up the resolved name on the next render after that.
  if (
    typeof v === 'string' &&
    fieldName &&
    USER_ID_FIELDS.has(fieldName) &&
    UUID_RE.test(v)
  ) {
    return getCachedUserName(v);
  }
  return String(v);
}

const USER_ID_FIELDS = new Set([
  '_created_by',
  '_edited_by',
  '_submitted_by',
  'submitted_by',
  'created_by',
  'edited_by',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Underscore-prefixed system fields that the default
 * attribute-table view filters out. The four editor-tracking
 * fields (_created_at, _created_by, _edited_at, _edited_by) are
 * surfaced in the formatted "Edit history" toggle when the user
 * wants them. _global_id is a UUID we use internally for PATCH /
 * DELETE keying and has no user-facing meaning, so it's hidden
 * unconditionally; the popup and (later) the field-app surface
 * the same row through more meaningful identifiers.
 */
const HIDDEN_SYSTEM_FIELDS = new Set([
  '_created_at',
  '_created_by',
  '_edited_at',
  '_edited_by',
  '_global_id',
]);

/**
 * Optional columns rendered when the user toggles "Edit history".
 * Sourced from underscore-prefixed properties the API surfaces on
 * every PostGIS-backed feature (#39). When the layer is not backed
 * by PostGIS (raw GeoJSON, ArcGIS service), these cells render
 * empty: harmless, not an error.
 */
const EDITOR_TRACKING_COLUMNS: Array<{
  key: string;
  label: string;
  tooltip: string;
  format: (v: unknown) => string;
}> = [
  {
    key: '_created_by',
    label: 'Created by',
    tooltip: 'User who created the row',
    // Resolved via the module-level user-name cache populated by
    // the metadata probe; falls back to a truncated uuid when the
    // resolver hasn't filled the cache yet (rare; the probe runs
    // at layer load).
    format: (v) => (typeof v === 'string' && v ? getCachedUserName(v) : ''),
  },
  {
    key: '_created_at',
    label: 'Created',
    tooltip: 'Timestamp the row was first inserted',
    format: formatTimestamp,
  },
  {
    key: '_edited_by',
    label: 'Edited by',
    tooltip: 'User who last edited the row',
    format: (v) => (typeof v === 'string' && v ? getCachedUserName(v) : ''),
  },
  {
    key: '_edited_at',
    label: 'Edited',
    tooltip: 'Timestamp of the most recent edit',
    format: formatTimestamp,
  },
];

function formatTimestamp(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return String(v);
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleString();
  } catch {
    return v;
  }
}

/**
 * Bounding box across an arbitrary set of features. Walks every
 * coordinate; safe for small-to-mid datasets (the selection in the
 * attribute table). Returns null for a selection that has no valid
 * geometries.
 */
function bboxOfFeatures(
  features: GeoJSON.Feature[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  function visit(coord: unknown) {
    if (Array.isArray(coord)) {
      if (coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
        const x = coord[0] as number;
        const y = coord[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
      } else {
        for (const c of coord) visit(c);
      }
    }
  }

  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if ('coordinates' in geom) visit(geom.coordinates);
    if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries) {
        if ('coordinates' in g) visit(g.coordinates);
      }
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

/**
 * Heuristic pick for a stable id field. Prefers fields literally named
 * `id`, `fid`, `objectid`, then the first field whose values are
 * unique across the selected feature subset.
 */
/**
 * pickIdField receives a numeric index Set (resolved upstream from
 * the heterogeneous selection keys). Kept as Set<number> on purpose:
 * the caller projects from Set<number | string> down to indexes via
 * `indexForKey()` before calling in.
 */
function pickIdField(
  fields: string[],
  features: GeoJSON.Feature[],
  selection: Set<number>,
): string | null {
  const common = ['id', 'fid', 'objectid', 'OBJECTID', 'FID', 'ID'];
  for (const c of common) {
    if (fields.includes(c)) return c;
  }
  for (const f of fields) {
    const seen = new Set<string>();
    let unique = true;
    for (const i of selection) {
      const v = ((features[i]?.properties ?? {}) as Record<string, unknown>)[f];
      if (v === null || v === undefined) {
        unique = false;
        break;
      }
      const key = String(v);
      if (seen.has(key)) {
        unique = false;
        break;
      }
      seen.add(key);
    }
    if (unique) return f;
  }
  return null;
}
