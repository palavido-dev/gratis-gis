// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  List,
  Loader2,
  Map as MapBaseIcon,
  Save,
  ShieldCheck,
  Table,
} from 'lucide-react';
import type {
  Group,
  ItemShare,
  MapData,
  MapFilterOp,
  MapLayer,
  MapLayerAccess,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_MAP,
} from '@gratis-gis/shared-types';
import { makeEmptyGroupLayer, uniqueGroupTitle } from './group-factory';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from './map-canvas';
import { LayerPanel } from './layer-panel';
import { AddLayerDialog } from './add-layer-dialog';
import { MapSettingsSection } from './map-settings-section';
import { Legend } from './legend';
import { AttributeTable } from './attribute-table';
import { SearchBar } from './search-bar';
import { SelectToolbar, type SelectToolMode } from './select-tool';
import { BuilderShell } from '@/components/builder-shell/builder-shell';
import { Layers as LayersIcon, MessageSquare, PencilLine, Printer, Settings as SettingsIcon } from 'lucide-react';
import { MarkupPanel } from './markup-panel';
import { CommentsPanel } from './comments-panel';
import { PresenceOverlay } from './presence-overlay';
import { PrintThisMapDialog } from './print-this-map-dialog';
import type { DrawingSet } from '@gratis-gis/shared-types';
import type maplibregl from 'maplibre-gl';
import {
  AccessMatrix,
  unresolvedPrincipal,
  type MatrixPrincipal,
} from './access-matrix';
import { discoverLayerMetadata, type LayerMetadata } from './layer-metadata';

interface Props {
  itemId: string;
  /**
   * Item title shown in the BuilderShell top bar. Comes from the
   * parent detail page (`item.title`) so the builder doesn't need a
   * separate fetch.
   */
  itemTitle: string;
  initial: MapData;
  canEdit: boolean;
  /**
   * Basemap items from the org's library (items of type=basemap).
   * Includes the seeded built-ins and any user-authored basemaps.
   * The picker lists these as the sole basemap options; the map
   * references a specific one through `MapData.basemap` (UUID).
   */
  basemaps?: CustomBasemap[];
  /**
   * Pre-resolved geo_boundary item that the map's
   * `defaultExtentBoundaryId` (#53) points at. Server-fetched so
   * the canvas can fit-bounds on first load without a second
   * round-trip. Null when the map either does not reference one
   * or the referenced boundary has been deleted.
   */
  defaultExtentBoundary?:
    | { data: { geometry?: unknown; bbox?: unknown } | null; id: string; title: string }
    | null;
  /**
   * geo_boundary items (id + title) the caller can see, used to back
   * the "Default extent" picker (#31 follow-on to #53). When the
   * picker is set to a boundary, the map persists that id in
   * `MapData.defaultExtentBoundaryId`; the camera fits to it on next
   * load. An empty list collapses the picker to a disabled state.
   */
  geoBoundaries?: Array<{ id: string; title: string }>;
  /**
   * Current signed-in user. The Markup panel (#154) uses this to
   * label new drawing sets ("Matt's markup 2026-05-30") and to
   * decide which drawing sets the viewer can edit (their own,
   * always; any, when `canEdit` is true). Pass null for a public
   * anonymous viewer; the panel disables create / edit in that
   * case.
   */
  currentUser?: { id: string; displayName: string } | null;
}

/**
 * Top-level web map surface. Owns the canonical MapData state; the
 * canvas renders it and the side panels edit it. Save is explicit so
 * a viewer can explore the map without side effects while an owner
 * only persists changes they actually want.
 *
 * Layout: left sidebar with layer panel, right side the map. On narrow
 * viewports the sidebar collapses into a drawer (future): for v2 we
 * use a fixed-width sidebar and let horizontal scroll handle anything
 * below that.
 */
/**
 * Convert a geo_boundary item's geometry / cached bbox into the
 * camera state the MapData seed uses (#53). Returns null when the
 * boundary is missing, has no bbox or geometry, or the values
 * fall outside the WGS84 envelope (we don't try to recover from
 * obviously-bad data here).
 */
function boundaryFitFor(
  boundary:
    | { data: { geometry?: unknown; bbox?: unknown } | null }
    | null
    | undefined,
): { center: [number, number]; zoom: number } | null {
  if (!boundary?.data) return null;
  const bboxRaw = boundary.data.bbox;
  let w: number | null = null;
  let s: number | null = null;
  let e: number | null = null;
  let n: number | null = null;
  if (
    Array.isArray(bboxRaw) &&
    bboxRaw.length === 4 &&
    bboxRaw.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    [w, s, e, n] = bboxRaw as [number, number, number, number];
  }
  if (w === null || s === null || e === null || n === null) return null;
  if (w >= e || s >= n) return null;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  // Approximate zoom from the wider edge (degrees). Roughly:
  // 360deg ~ z=0, halve per zoom level. Clamp to a polite range
  // so we never zoom out past world or all the way down to street.
  const span = Math.max(e - w, n - s);
  const zoom = Math.max(2, Math.min(16, Math.log2(360 / Math.max(span, 0.001)) - 0.5));
  return { center: [cx, cy], zoom };
}

export function MapEditor({
  itemId,
  itemTitle,
  initial,
  canEdit,
  basemaps = [],
  defaultExtentBoundary = null,
  geoBoundaries = [],
  currentUser = null,
}: Props) {
  // Hydrate older persisted maps. Each bump in the schema lands a new
  // migrator here; the goal is that any v2.x map still opens cleanly.
  const seed = useMemo<MapData>(() => {
    const layers = (initial.layers ?? []).map((rawLayer) => {
      const l = rawLayer as MapLayer & {
        // Pre-v2.2 shape had a single-clause filter.
        filter?: unknown;
        popup?: Partial<MapLayer['popup']> & { fields?: unknown };
      };

      // Migrate filter: v2.1 single-clause { field, op, value }
      // → v2.2 { combinator: 'all', clauses: [...] }.
      let filter: MapLayer['filter'] = null;
      if (l.filter && typeof l.filter === 'object') {
        const f = l.filter as unknown as Record<string, unknown>;
        if (Array.isArray(f.clauses) && typeof f.combinator === 'string') {
          filter = f as unknown as MapLayer['filter'];
        } else if (typeof f.field === 'string' && typeof f.op === 'string') {
          filter = {
            combinator: 'all',
            clauses: [
              {
                field: String(f.field),
                op: f.op as MapFilterOp,
                value: typeof f.value === 'string' ? f.value : String(f.value ?? ''),
              },
            ],
          };
        }
      }

      // Popup: older maps might be missing `mode` / `bodyTemplate`.
      // Preserve prior picked-fields state; never discard authored content.
      const popupRaw = l.popup ?? {};
      const mode =
        popupRaw.mode === 'picked' || popupRaw.mode === 'template'
          ? popupRaw.mode
          : Array.isArray(popupRaw.fields) && popupRaw.fields.length > 0
            ? 'picked'
            : 'all';
      const popup: MapLayer['popup'] = {
        ...structuredClone(DEFAULT_LAYER_POPUP),
        ...popupRaw,
        mode,
        fields: Array.isArray(popupRaw.fields)
          ? (popupRaw.fields as string[])
          : [],
        bodyTemplate:
          typeof (popupRaw as { bodyTemplate?: unknown }).bodyTemplate === 'string'
            ? ((popupRaw as { bodyTemplate: string }).bodyTemplate)
            : '',
      };

      return {
        ...l,
        renderer: l.renderer ?? structuredClone(DEFAULT_LAYER_RENDERER),
        filter,
        popup,
        interactions: {
          ...structuredClone(DEFAULT_LAYER_INTERACTIONS),
          ...(l.interactions ?? {}),
        },
        labels: hydrateLabels(
          ((l as unknown) as { labels?: Record<string, unknown> }).labels ?? {},
        ),
        search: {
          ...structuredClone(DEFAULT_LAYER_SEARCH),
          ...(((l as unknown) as { search?: Partial<MapLayer['search']> })
            .search ?? {}),
        },
        scale: {
          ...structuredClone(DEFAULT_LAYER_SCALE),
          ...(((l as unknown) as { scale?: Partial<MapLayer['scale']> })
            .scale ?? {}),
        },
        access: {
          ...structuredClone(DEFAULT_LAYER_ACCESS),
          ...(((l as unknown) as { access?: Partial<MapLayer['access']> })
            .access ?? {}),
        },
        style: {
          ...structuredClone(DEFAULT_LAYER_STYLE),
          ...(l.style ?? {}),
          point: {
            ...structuredClone(DEFAULT_LAYER_STYLE.point),
            ...(l.style?.point ?? {}),
          },
        },
        opacity: typeof l.opacity === 'number' ? l.opacity : 1,
        visible: l.visible ?? true,
      } as MapLayer;
    });
    const merged: MapData = {
      ...DEFAULT_MAP,
      ...initial,
      search: {
        ...DEFAULT_MAP.search,
        ...(initial.search ?? {}),
      },
      layers,
    };
    // Default extent reference (#53): if the map points at a
    // geo_boundary, override the seed camera with the boundary's
    // bbox center + an approximate zoom that fits it. This applies
    // every load, which means a viewer who pans away will snap
    // back on next visit: intentional, since the boundary IS
    // the canonical extent for this map. Save (which captures the
    // current camera state) does not clear `defaultExtentBoundaryId`,
    // so the persistent reference still wins on the next load.
    const fit = boundaryFitFor(defaultExtentBoundary);
    if (fit) {
      merged.center = fit.center;
      merged.zoom = fit.zoom;
    }
    return merged;
  }, [initial, defaultExtentBoundary]);
  const [map, setMap] = useState<MapData>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Basemap popover (#74). Mirrors the editor-runtime pattern: an
  // icon button that opens a small menu listing every basemap with
  // an active-tick marker. Replaces the verbose labeled <select> so
  // the map and editor toolbars share the same visual rhythm.
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);
  const basemapMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!basemapMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (basemapMenuRef.current && !basemapMenuRef.current.contains(t)) {
        setBasemapMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [basemapMenuOpen]);
  // Geocoder picker now lives in MapSettingsSection (#74 follow-up).
  // The previous toolbar-icon dropdown was disjointed from the
  // other map-level configuration knobs (view scope, default
  // extent) -- consolidating into one section makes the grouping
  // explicit and gives future map-wide settings (embed config,
  // refresh interval, etc.) an obvious home.
  const [availableGeocoders, setAvailableGeocoders] = useState<
    Array<{ id: string; title: string; kind: 'internal' | 'arcgis' }>
  >([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Pull both geocoding_service items and service items
        // (arcgis_geocode protocol is a service item with a
        // specific data.protocol value). We filter the service
        // items to geocoders client-side because the lite list
        // doesn't return the data blob; the service list is
        // typically small enough that this is fine.
        const [gsRes, svcRes] = await Promise.all([
          fetch('/api/portal/items?type=geocoding_service&lite=1').then((r) =>
            r.ok ? r.json() : [],
          ),
          fetch('/api/portal/items?type=service').then((r) =>
            r.ok ? r.json() : [],
          ),
        ]);
        const gsList = Array.isArray(gsRes) ? gsRes : [];
        const svcList = Array.isArray(svcRes) ? svcRes : [];
        const arcgisGeocoders = svcList.filter((s) => {
          const proto = (s as { data?: { protocol?: unknown } }).data?.protocol;
          return proto === 'arcgis_geocode';
        });
        if (cancelled) return;
        const combined: Array<{
          id: string;
          title: string;
          kind: 'internal' | 'arcgis';
        }> = [
          ...gsList.map((g: { id: string; title: string }) => ({
            id: g.id,
            title: g.title,
            kind: 'internal' as const,
          })),
          ...arcgisGeocoders.map((g: { id: string; title: string }) => ({
            id: g.id,
            title: g.title,
            kind: 'arcgis' as const,
          })),
        ];
        setAvailableGeocoders(combined);
      } catch {
        /* network blip; leave list empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [legendOpen, setLegendOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  // #154: Markup panel + per-map drawing sets. Hydrated from the
  // initial map data so a fresh page-load renders existing
  // drawings on the canvas immediately. The panel manages writes
  // and pushes updates back through `setDrawings`.
  const [markupOpen, setMarkupOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // #159: "Print this map" chooser. Opens a thin dialog that
  // lets the author either pick an existing print template or
  // create a new one pre-bound to this map.
  const [printOpen, setPrintOpen] = useState(false);
  const [drawings, setDrawings] = useState<DrawingSet[]>(
    (initial as MapData & { drawings?: DrawingSet[] }).drawings ?? [],
  );
  // #156: MapLibre instance for presence cursor projection.
  // MapCanvas fires `onMapReady` with the instance on mount and
  // null on teardown.
  const [mapLibre, setMapLibre] = useState<maplibregl.Map | null>(null);
  // #156 follow-up: portal target for the live-presence avatar
  // chips. PresenceOverlay createPortal()'s the chip strip into
  // this node so it lands in the toolbar rather than floating
  // over the canvas. State (not ref) so PresenceOverlay re-renders
  // once the slot mounts.
  const [presenceChipsSlot, setPresenceChipsSlot] = useState<HTMLDivElement | null>(null);
  // Layer id chosen by the per-layer kebab's "Open attribute table"
  // action (#73). Cleared when the table closes so reopening from
  // the toolbar lands on the default-first-visible behavior.
  const [tableFocusLayerId, setTableFocusLayerId] = useState<string | null>(
    null,
  );
  const canvasRef = useRef<MapCanvasHandle | null>(null);

  /**
   * Shared selection state: per-layer set of feature ids. Because
   * every geojson source is added with `generateId: true`, these ids
   * are the same as the feature's array index in the cached
   * FeatureCollection: which is what the attribute table uses for
   * its row selection. That alignment lets one Set serve both the
   * map highlight and the table checkboxes without translation.
   */
  // #318: feature ids may be string (v3 promoteId UUID) or number.
  const [selection, setSelection] = useState<
    Record<string, Set<number | string>>
  >({});
  // Active map-side selection tool. `off` is the default pan +
  // popup-on-click behaviour; the other modes are owned by the
  // MapCanvas and fed here so the SelectToolbar reads live state.
  const [selectTool, setSelectTool] = useState<SelectToolMode>('off');
  // Count selected features across layers so the toolbar can show
  // the live total + clear-button affordance.
  const selectedCount = useMemo(
    () =>
      Object.values(selection).reduce(
        (sum: number, s) => sum + (s as Set<number>).size,
        0,
      ),
    [selection],
  );

  // Access matrix: open state + all the data the modal renders.
  // We lazy-fetch on open so the overhead (a request per backing
  // item) only happens when an author actually opens the matrix.
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [webmapShares, setWebmapShares] = useState<ItemShare[]>([]);
  const [itemShares, setItemShares] = useState<Record<string, ItemShare[]>>({});
  const [groupDirectory, setGroupDirectory] = useState<Record<string, string>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [groupMemberships, setGroupMemberships] = useState<
    Record<string, string[]>
  >({});

  // Maps layer id → backing item id (null for geojson-url / inline).
  // Matrix uses this to know which layers can have item-level gaps.
  //
  // For arcgis-rest sources we NOW carry an optional `sourceItemId`
  // back-reference (set when the layer was added from a portal
  // arcgis_service item via the item picker). When present, that's
  // the backing item the matrix should gate access against: the
  // ArcGIS service is proxied through the portal, and gaps on the
  // arcgis_service item's shares translate to "this principal can
  // see the web map but not this ArcGIS layer's data". Layers added
  // by raw-URL paste still have no backing item id.
  const layerItemIds = useMemo<Record<string, string | null>>(() => {
    const out: Record<string, string | null> = {};
    for (const l of map.layers) {
      if (l.source.kind === 'data-layer') {
        out[l.id] = l.source.itemId;
      } else if (l.source.kind === 'arcgis-rest') {
        out[l.id] = l.source.sourceItemId ?? null;
      } else {
        out[l.id] = null;
      }
    }
    return out;
  }, [map.layers]);

  async function loadMatrixData() {
    // Webmap's own shares: drives the principal column list.
    try {
      const res = await fetch(`/api/portal/items/${itemId}`);
      if (res.ok) {
        const j = (await res.json()) as { shares?: ItemShare[] };
        setWebmapShares(j.shares ?? []);
      }
    } catch {
      /* non-fatal: matrix shows empty principals list */
    }
    // Each distinct backing item: pulls its shares for gap detection.
    const uniqItemIds = Array.from(
      new Set(
        Object.values(layerItemIds).filter(
          (v): v is string => typeof v === 'string',
        ),
      ),
    );
    await Promise.all(
      uniqItemIds.map(async (id) => {
        try {
          const r = await fetch(`/api/portal/items/${id}`);
          if (!r.ok) return;
          const j = (await r.json()) as { shares?: ItemShare[] };
          setItemShares((prev) => ({ ...prev, [id]: j.shares ?? [] }));
        } catch {
          /* non-fatal: cell falls back to "no warning" */
        }
      }),
    );
    // Groups: fetch all groups visible to the current user so the
    // matrix can display names + resolve which groups a user is in.
    try {
      const r = await fetch('/api/portal/groups');
      if (r.ok) {
        const groups = (await r.json()) as Group[];
        const dir: Record<string, string> = {};
        for (const g of groups) dir[g.id] = g.title;
        setGroupDirectory(dir);
      }
    } catch {
      /* non-fatal: groups show as short ids */
    }

    // Users: batch-resolve names + group memberships for every
    // principal on the webmap's share list. One call covers the
    // whole matrix: avoids a per-row fetch during render.
    try {
      // Snapshot webmapShares here; the list was just refreshed at
      // the top of loadMatrixData so whatever's in state now is
      // current.
      const userIds = Array.from(
        new Set(
          (await (async () => {
            const r = await fetch(`/api/portal/items/${itemId}`);
            if (!r.ok) return [] as ItemShare[];
            const j = (await r.json()) as { shares?: ItemShare[] };
            return j.shares ?? [];
          })())
            .filter((s) => s.principalType === 'user')
            .map((s) => s.principalId),
        ),
      );
      if (userIds.length > 0) {
        const r = await fetch(
          `/api/portal/users?ids=${encodeURIComponent(userIds.join(','))}`,
        );
        if (r.ok) {
          const rows = (await r.json()) as Array<{
            id: string;
            username: string;
            fullName: string | null;
            groupIds?: string[];
          }>;
          setUserNames((prev) => {
            const next = { ...prev };
            for (const u of rows) {
              next[u.id] = u.fullName || u.username;
            }
            return next;
          });
          setGroupMemberships((prev) => {
            const next = { ...prev };
            for (const u of rows) {
              next[u.id] = u.groupIds ?? [];
            }
            return next;
          });
        }
      }
    } catch {
      /* non-fatal: users show as short ids, memberships empty */
    }
  }

  // Fire-and-forget load when the matrix opens. Re-runs if the layer
  // list changes while the modal is open so newly-added layers get
  // their item shares fetched.
  useEffect(() => {
    if (!matrixOpen) return;
    void loadMatrixData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrixOpen, itemId]);

  // Deduplicate shares into a principal list. Filters to principals
  // who actually have view-or-better access to the webmap: the
  // matrix exists to narrow their access, not to create new ones.
  const matrixPrincipals = useMemo<MatrixPrincipal[]>(() => {
    return webmapShares.map((s) => {
      const name =
        s.principalType === 'group'
          ? groupDirectory[s.principalId] ?? unresolvedPrincipal(s.principalType, s.principalId).name
          : userNames[s.principalId] ?? unresolvedPrincipal(s.principalType, s.principalId).name;
      return { type: s.principalType, id: s.principalId, name };
    });
  }, [webmapShares, groupDirectory, userNames]);

  function patchLayerAccess(layerId: string, next: MapLayerAccess) {
    setLayers(
      map.layers.map((l) => (l.id === layerId ? { ...l, access: next } : l)),
    );
  }

  async function grantItemAccess(
    bitemId: string,
    p: MatrixPrincipal,
  ): Promise<void> {
    const res = await fetch(`/api/portal/items/${bitemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: p.type,
        principalId: p.id,
        permission: 'view',
      }),
    });
    if (!res.ok) return;
    // Refresh that item's shares so the gap badge disappears.
    try {
      const r = await fetch(`/api/portal/items/${bitemId}`);
      if (r.ok) {
        const j = (await r.json()) as { shares?: ItemShare[] };
        setItemShares((prev) => ({ ...prev, [bitemId]: j.shares ?? [] }));
      }
    } catch {
      /* non-fatal: matrix may show stale state until close/reopen */
    }
  }

  // Drop selection for layers that have been removed so the state
  // doesn't leak references. Only runs when the layer-id set changes.
  const layerIdKey = map.layers.map((l) => l.id).join('|');
  useEffect(() => {
    const known = new Set(map.layers.map((l) => l.id));
    setSelection((prev) => {
      let changed = false;
      const next: Record<string, Set<number | string>> = {};
      for (const [id, set] of Object.entries(prev)) {
        if (known.has(id)) next[id] = set;
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerIdKey]);

  /**
   * Per-layer field + value metadata, populated lazily when a layer is
   * first seen. Used by the filter pick-list and the unique-values
   * renderer. Keyed by layer id; entries live as long as the layer does.
   */
  const [metadata, setMetadata] = useState<Record<string, LayerMetadata>>({});

  // Feature collections per layer, derived from metadata so the
  // attribute table and any future feature consumers don't refetch.
  // This keeps fetch cost to one round-trip per layer source change.
  const featuresByLayer = useMemo(() => {
    const out: Record<string, GeoJSON.FeatureCollection | null> = {};
    for (const [id, md] of Object.entries(metadata)) {
      out[id] = md.featureCollection;
    }
    return out;
  }, [metadata]);
  // AbortControllers per layer so a rapid edit-churn doesn't leave us
  // with in-flight fetches scribbling over newer state.
  const abortsRef = useRef<Record<string, AbortController>>({});

  // Discover metadata for any layer we haven't seen yet. The key here is
  // layer id + a stable hash of the source: if a user swaps the URL in
  // place we need a fresh fetch, not a stale cache.
  const sourceKeys = map.layers.map(
    (l) => `${l.id}|${JSON.stringify(l.source)}`,
  );
  const sourceKeysJoined = sourceKeys.join('\n');
  useEffect(() => {
    const seen = new Set(sourceKeys.map((k) => k.split('|')[0]));
    // Drop metadata for layers that were removed.
    setMetadata((prev) => {
      const next: Record<string, LayerMetadata> = {};
      for (const [id, md] of Object.entries(prev)) {
        if (seen.has(id)) next[id] = md;
      }
      return next;
    });

    for (const layer of map.layers) {
      const existing = metadata[layer.id];
      if (existing && !existing.loading && !existing.error) continue;
      // Cancel any previous fetch for this layer.
      abortsRef.current[layer.id]?.abort();
      const controller = new AbortController();
      abortsRef.current[layer.id] = controller;

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
      discoverLayerMetadata(layer, controller.signal).then((md) => {
        if (controller.signal.aborted) return;
        setMetadata((prev) => ({ ...prev, [layer.id]: md }));
      });
    }
    // Cleanup on unmount: abort all in-flight discoveries.
    return () => {
      for (const c of Object.values(abortsRef.current)) c.abort();
    };
    // We depend on the joined source key so this effect re-runs when a
    // layer is added / removed / has its source swapped. Adding metadata
    // itself would cause infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKeysJoined]);

  function markDirty() {
    setDirty(true);
    setSaved(false);
  }

  /**
   * The picker <select> emits a basemap item UUID; the map stores it
   * directly in `MapData.basemap`. All basemaps (seeded built-ins and
   * user-authored) now live in one flat list.
   */
  function setBasemap(value: string) {
    setMap((m) => ({ ...m, basemap: value }));
    markDirty();
  }

  /**
   * #74: set the map's geocoding source. Pass `null` (or empty
   * string) to fall back to Nominatim. Stored on
   * `map.search.geocoderId` so the search bar can route queries to
   * the picked geocoder instead of the default.
   */
  function setGeocoderId(value: string | null) {
    setMap((m) => {
      const nextSearch = { ...(m.search ?? { enabled: true, geocoding: true }) };
      if (value) {
        nextSearch.geocoderId = value;
      } else {
        delete nextSearch.geocoderId;
      }
      return { ...m, search: nextSearch };
    });
    markDirty();
  }

  /** Value currently shown in the picker: the basemap item UUID. */
  const pickerValue = map.basemap;

  /** Metadata of the selected basemap, used for the description line
   *  and attribution. Undefined when the map still has the empty
   *  sentinel basemap or the referenced item has been deleted. */
  const selectedBasemap = basemaps.find((b) => b.id === map.basemap);

  /**
   * Setter for the default-extent boundary reference (#31). The empty
   * string from the picker means "no default extent" -- we drop the
   * key from MapData rather than persist an empty string so the API
   * payload stays clean. Marks the map dirty so save is enabled.
   */
  function setDefaultExtentBoundaryId(value: string) {
    setMap((m) => {
      if (!value) {
        const next = { ...m };
        delete (next as Partial<MapData>).defaultExtentBoundaryId;
        return next as MapData;
      }
      return { ...m, defaultExtentBoundaryId: value };
    });
    markDirty();
  }

  /**
   * #79: clip-boundary setter. Distinct from defaultExtent: this
   * scopes the data the runtime SHOWS (every layer's read clipped
   * to the polygon), not just the camera. Trust posture explicitly
   * NOT access control: the section's help text spells this out.
   * The current value is read directly from `map.clipBoundaryId`
   * inside MapSettingsSection; no derived value needed here now
   * that the inline picker is gone.
   */
  function setClipBoundaryId(value: string) {
    setMap((m) => {
      if (!value) {
        const next = { ...m };
        delete (next as Partial<MapData>).clipBoundaryId;
        return next as MapData;
      }
      return { ...m, clipBoundaryId: value };
    });
    markDirty();
  }

  function setLayers(next: MapLayer[]) {
    setMap((m) => ({ ...m, layers: next }));
    markDirty();
  }

  function addLayer(layer: MapLayer) {
    setMap((m) => ({ ...m, layers: [layer, ...m.layers] }));
    markDirty();
  }

  /**
   * Create an empty group at the top of the layer list (#70). The
   * factory and title-uniqueness helper live in group-factory.ts so
   * "Add group" from the panel and "Move to new group" from the
   * per-layer kebab share one source of truth.
   */
  function addEmptyGroup() {
    setMap((m) => {
      const title = uniqueGroupTitle(m.layers, 'New group');
      const group = makeEmptyGroupLayer(title);
      return { ...m, layers: [group, ...m.layers] };
    });
    markDirty();
  }

  // Camera changes from user interaction get folded into the canonical
  // state so Save view captures whatever the user is currently looking at.
  const onCameraChange = useCallback(
    (next: Pick<MapData, 'center' | 'zoom' | 'bearing' | 'pitch'>) => {
      setMap((m) => ({ ...m, ...next }));
      if (canEdit) markDirty();
    },
    [canEdit],
  );

  /**
   * Current map viewport bbox, fed downstream to AttributeTable's
   * "Records in map extent" toggle (#115 P13). The MapCanvas fires
   * this on every settled camera move (programmatic or user-driven)
   * so the table can refetch the paged endpoint with the right
   * envelope on pan/zoom. Null until the canvas has rendered once
   * and reported its first bbox.
   */
  const [mapBbox, setMapBbox] = useState<
    [number, number, number, number] | null
  >(null);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: map }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  // Warn before navigating away with unsaved changes. Standard beforeunload
  // contract: set returnValue and return a truthy string.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // BuilderShell top bar right side. Single icon pill for the canvas
  // overlay toggles (basemap menu / legend / attribute table / layer
  // access), followed by a Saved indicator and a Save button when the
  // user has edit rights. Read-only viewers see the pill without the
  // basemap menu (which would imply edit) and access-matrix button,
  // and no Save.
  const canvasTogglePill = (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-1 p-1">
      {canEdit ? (
        <div ref={basemapMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setBasemapMenuOpen((v) => !v)}
            className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
              basemapMenuOpen ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
            }`}
            title={`Basemap${selectedBasemap ? `: ${selectedBasemap.label}` : ''}`}
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
                    const active = pickerValue === b.id;
                    return (
                      <li key={b.id}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setBasemap(b.id);
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
      ) : null}
      <ToolbarIconToggle
        Icon={List}
        label="Legend"
        active={legendOpen}
        onClick={() => setLegendOpen((v) => !v)}
      />
      <ToolbarIconToggle
        Icon={Table}
        label="Attribute table"
        active={tableOpen}
        onClick={() => {
          // Toolbar toggle is the unfocused path: clear any per-layer
          // focus so the table defaults to the first-visible queryable
          // layer. (#73)
          setTableFocusLayerId(null);
          setTableOpen((v) => !v);
        }}
      />
      <ToolbarIconToggle
        Icon={PencilLine}
        label="Markup"
        active={markupOpen}
        onClick={() => setMarkupOpen((v) => !v)}
      />
      <ToolbarIconToggle
        Icon={MessageSquare}
        label="Comments"
        active={commentsOpen}
        onClick={() => setCommentsOpen((v) => !v)}
      />
      <ToolbarIconToggle
        Icon={Printer}
        label="Print this map"
        active={printOpen}
        onClick={() => setPrintOpen((v) => !v)}
      />
      {canEdit ? (
        <ToolbarIconToggle
          Icon={ShieldCheck}
          label="Layer access"
          active={matrixOpen}
          onClick={() => setMatrixOpen((v) => !v)}
        />
      ) : null}
    </div>
  );

  const toolbarRight = (
    <>
      {/* #156 follow-up: live presence avatar chips portal target.
          Sits at the leading edge of the toolbar's right side so
          the chips appear next to the Save / canvas toggles
          instead of floating over the canvas where they used to
          overlap MapLibre's zoom + compass controls. The empty
          container is harmless when nobody else is on the map. */}
      <div ref={setPresenceChipsSlot} className="flex items-center" />
      {canvasTogglePill}
      {canEdit ? (
        <>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save map
          </button>
        </>
      ) : null}
    </>
  );

  // Left panel: layer list. Same component as before; the wrapping
  // 320px fixed-width div goes away because BuilderShell owns the
  // width now (and lets the user resize / pin).
  const leftPanel = (
    <LayerPanel
      layers={map.layers}
      metadata={metadata}
      canEdit={canEdit}
      currentZoom={map.zoom}
      onOpenAdd={() => setAddOpen(true)}
      onAddGroup={addEmptyGroup}
      onOpenAttributeTable={(layerId) => {
        setTableFocusLayerId(layerId ?? null);
        setTableOpen(true);
      }}
      onZoomToLayer={(layerId) => {
        // Compute the bbox from the layer's cached feature
        // collection. Metadata is populated as the canvas loads
        // each layer; if it isn't ready yet, the action is a no-op
        // rather than a flicker. (#72)
        const meta = metadata[layerId];
        const fc = meta?.featureCollection ?? null;
        if (!fc || fc.features.length === 0) return;
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        const visit = (
          coords: number[] | number[][] | number[][][] | number[][][][],
        ) => {
          if (typeof coords[0] === 'number') {
            const c = coords as number[];
            if (typeof c[0] === 'number' && typeof c[1] === 'number') {
              minX = Math.min(minX, c[0]);
              minY = Math.min(minY, c[1]);
              maxX = Math.max(maxX, c[0]);
              maxY = Math.max(maxY, c[1]);
            }
            return;
          }
          for (const inner of coords as Array<unknown>) {
            visit(inner as Parameters<typeof visit>[0]);
          }
        };
        for (const f of fc.features) {
          if (!f.geometry) continue;
          if (
            'coordinates' in f.geometry &&
            Array.isArray((f.geometry as { coordinates: unknown }).coordinates)
          ) {
            visit((f.geometry as { coordinates: number[][] }).coordinates);
          }
        }
        if (minX !== Infinity && maxX !== -Infinity) {
          canvasRef.current?.zoomTo([minX, minY, maxX, maxY]);
        }
      }}
      onChange={setLayers}
    />
  );

  // Right panel: map-level settings (view scope, default extent,
  // search source). Only meaningful when canEdit; viewers see no
  // right panel. BuilderShell handles the unpinned case gracefully
  // (the rail's toggle button hides when there's no content).
  const rightPanel = canEdit ? (
    <MapSettingsSection
      canEdit={canEdit}
      map={map}
      geoBoundaries={geoBoundaries}
      availableGeocoders={availableGeocoders}
      setClipBoundaryId={setClipBoundaryId}
      setDefaultExtentBoundaryId={setDefaultExtentBoundaryId}
      setGeocoderId={setGeocoderId}
    />
  ) : null;

  return (
    <>
      <BuilderShell
        storageKey="builder-shell:map"
        backHref={`/items/${itemId}`}
        title={itemTitle}
        icon={<MapBaseIcon className="h-4 w-4 text-muted" />}
        toolbarRight={toolbarRight}
        leftPanel={leftPanel}
        leftPanelTitle="Layers"
        leftRailIcon={<LayersIcon className="h-4 w-4" />}
        rightPanel={rightPanel}
        rightPanelTitle="Map settings"
        rightRailIcon={<SettingsIcon className="h-4 w-4" />}
      >
        {/* Canvas + overlays. `absolute inset-0` over the BuilderShell
            main slot guarantees the canvas fills regardless of
            flexbox quirks, and gives the overlay components (legend,
            attribute table, search bar, select toolbar) a single
            relative anchor. MapLibre re-sizes when its container
            does, so resizing the BuilderShell panels triggers the
            map to re-fit live. */}
        <div className="absolute inset-0">
          <MapCanvas
            ref={canvasRef}
            map={map}
            basemaps={basemaps}
            onCameraChange={onCameraChange}
            onViewportChange={setMapBbox}
            selection={selection}
            selectTool={selectTool}
            onSelectionChange={setSelection}
            drawings={drawings}
            onMapReady={setMapLibre}
          />
          <SelectToolbar
            mode={selectTool}
            onChange={setSelectTool}
            selectedCount={selectedCount}
            onClearSelection={() => setSelection({})}
          />
          {map.search?.enabled !== false ? (
            <SearchBar
              layers={map.layers}
              featuresByLayer={featuresByLayer}
              geocodingEnabled={map.search?.geocoding !== false}
              {...(map.search?.geocoderId
                ? { geocoderItemId: map.search.geocoderId }
                : {})}
              viewportBbox={mapBbox ?? null}
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
          <Legend
            open={legendOpen}
            layers={map.layers}
            metadata={metadata}
            onClose={() => setLegendOpen(false)}
          />
          <AttributeTable
            open={tableOpen}
            layers={map.layers}
            featuresByLayer={featuresByLayer}
            metadata={metadata}
            canEdit={canEdit}
            selection={selection}
            setSelection={setSelection}
            focusLayerId={tableFocusLayerId}
            mapBbox={mapBbox}
            onClose={() => {
              setTableOpen(false);
              // Clear the focus pick on close so re-opening from the
              // toolbar lands on the default-first-visible.
              setTableFocusLayerId(null);
            }}
            onZoomTo={(bbox) => canvasRef.current?.zoomTo(bbox)}
            onPatchLayer={(layerId, patch) => {
              setLayers(
                map.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
              );
            }}
          />
          {error ? (
            <p
              role="alert"
              className="absolute bottom-2 left-2 rounded-md border border-danger/30 bg-surface-1 px-2 py-1 text-xs text-danger shadow-card"
            >
              {error}
            </p>
          ) : null}
          {/* #154 Markup panel. Floating overlay so it's available
              to viewers (not just editors) without competing for
              the BuilderShell right-panel slot. */}
          <MarkupPanel
            mapId={itemId}
            open={markupOpen}
            onClose={() => setMarkupOpen(false)}
            currentUser={currentUser}
            canEditMap={canEdit}
            mapCenter={map.center}
            onDrawingsChange={setDrawings}
            initialDrawings={drawings}
          />
          {/* #155 Comments panel. Same floating-overlay model as
              the Markup pane so viewers (not just editors) can
              comment without the BuilderShell right-rail slot. */}
          <CommentsPanel
            itemId={itemId}
            open={commentsOpen}
            onClose={() => setCommentsOpen(false)}
            currentUser={currentUser}
            canEditItem={canEdit}
          />
          {/* #156 Live presence overlay. Renders avatar chips at
              top-right of the canvas + per-viewer cursor markers
              that track the map as it pans. Phase 1 uses HTTP
              polling (2 second heartbeat); transport swaps to
              WebSockets in Phase 1.5 without changing the UX. */}
          <PresenceOverlay
            mapId={itemId}
            currentUser={currentUser}
            mapLibre={mapLibre}
            chipsContainer={presenceChipsSlot}
          />
          {/* #159 Print this map chooser. Opens to either
              "use existing template" or "create new pre-bound
              to this map". Print runs through the existing
              print_template designer + Print tool widget. */}
          <PrintThisMapDialog
            open={printOpen}
            onClose={() => setPrintOpen(false)}
            mapId={itemId}
          />
        </div>
      </BuilderShell>

      {/* Modal-style overlays render outside BuilderShell so they sit
          above its z-20 layer. Both already use higher z-index (z-30,
          z-40) and are positioned `fixed inset-0`. */}
      <AddLayerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={addLayer}
      />

      <AccessMatrix
        open={matrixOpen}
        layers={map.layers}
        principals={matrixPrincipals}
        layerItemIds={layerItemIds}
        itemShares={itemShares}
        groupMemberships={groupMemberships}
        onClose={() => setMatrixOpen(false)}
        onPatchAccess={patchLayerAccess}
        onGrantItemAccess={grantItemAccess}
      />
    </>
  );
}

/**
 * Migrate older persisted labels. Pre-v2.5 the shape was
 * `{ field, ... }` with a single field name; v2.5 switched to
 * `{ template, offsetX, offsetY, ... }`. A non-empty `field` wraps
 * into `{{field}}`; missing offsets default to a small positive Y so
 * labels sit below point markers instead of on top of them.
 */
function hydrateLabels(
  raw: Record<string, unknown>,
): MapLayer['labels'] {
  const base = structuredClone(DEFAULT_LAYER_LABELS);
  const merged = { ...base, ...(raw as Partial<MapLayer['labels']>) };
  if (
    typeof (raw as { template?: unknown }).template !== 'string' &&
    typeof (raw as { field?: unknown }).field === 'string' &&
    (raw as { field: string }).field.length > 0
  ) {
    merged.template = `{{${(raw as { field: string }).field}}}`;
  }
  return merged;
}

/**
 * Icon-only toolbar toggle. Used inside the right-side toolbar pill
 * along with the basemap popover to give the map editor the same
 * visual rhythm as the editor / viewer / survey runtimes (#74).
 * Label is preserved as title + aria-label for tooltips and screen
 * readers.
 */
function ToolbarIconToggle({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof List;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className={`inline-flex h-9 w-9 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 ${
        active ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : ''
      }`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
