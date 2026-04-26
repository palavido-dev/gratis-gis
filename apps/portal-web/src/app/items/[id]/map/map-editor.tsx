'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  List,
  Loader2,
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
import { Legend } from './legend';
import { AttributeTable } from './attribute-table';
import { SearchBar } from './search-bar';
import { SelectToolbar, type SelectToolMode } from './select-tool';
import {
  AccessMatrix,
  unresolvedPrincipal,
  type MatrixPrincipal,
} from './access-matrix';
import { discoverLayerMetadata, type LayerMetadata } from './layer-metadata';

interface Props {
  itemId: string;
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
  initial,
  canEdit,
  basemaps = [],
  defaultExtentBoundary = null,
  geoBoundaries = [],
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
      // â†’ v2.2 { combinator: 'all', clauses: [...] }.
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
  const [legendOpen, setLegendOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
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
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});
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

  // Maps layer id â†’ backing item id (null for geojson-url / inline).
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
      const next: Record<string, Set<number>> = {};
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

  /** Current default-extent picker value: the boundary item UUID, or
   *  empty string for "no default extent". */
  const extentPickerValue = map.defaultExtentBoundaryId ?? '';

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

  return (
    <div className="flex flex-col gap-3">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 p-3 shadow-card">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Basemap
          </label>
          <select
            value={pickerValue}
            onChange={(e) => setBasemap(e.target.value)}
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {basemaps.length === 0 ? (
              <option value="">No basemaps available</option>
            ) : null}
            {basemaps.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <span className="hidden text-xs text-muted sm:inline">
            {selectedBasemap?.description ?? ''}
          </span>

          <label className="ml-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
            Default extent
            <select
              value={extentPickerValue}
              onChange={(e) => setDefaultExtentBoundaryId(e.target.value)}
              disabled={geoBoundaries.length === 0}
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
              title={
                geoBoundaries.length === 0
                  ? 'Create a geo_boundary item to use it here'
                  : 'Boundary that frames the map on first load'
              }
            >
              <option value="">{'(use saved camera)'}</option>
              {geoBoundaries.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-2">
            <ToolbarToggle
              Icon={List}
              label="Legend"
              active={legendOpen}
              onClick={() => setLegendOpen((v) => !v)}
            />
            <ToolbarToggle
              Icon={Table}
              label="Attributes"
              active={tableOpen}
              onClick={() => {
              // Toolbar toggle is the unfocused path: clear any
              // per-layer focus so the table defaults to the
              // first-visible queryable layer. (#73)
              setTableFocusLayerId(null);
              setTableOpen((v) => !v);
            }}
            />
            <ToolbarToggle
              Icon={ShieldCheck}
              label="Layer access"
              active={matrixOpen}
              onClick={() => setMatrixOpen((v) => !v)}
            />
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
          </div>
        </div>
      ) : (
        /* Non-edit toolbar still needs the viewer tools. */
        <div className="flex items-center justify-end gap-2">
          <ToolbarToggle
            Icon={List}
            label="Legend"
            active={legendOpen}
            onClick={() => setLegendOpen((v) => !v)}
          />
          <ToolbarToggle
            Icon={Table}
            label="Attributes"
            active={tableOpen}
            onClick={() => {
              // Toolbar toggle is the unfocused path: clear any
              // per-layer focus so the table defaults to the
              // first-visible queryable layer. (#73)
              setTableFocusLayerId(null);
              setTableOpen((v) => !v);
            }}
          />
        </div>
      )}

      <div className="flex h-[600px] overflow-hidden rounded-lg border border-border shadow-card">
        <div className="w-80 shrink-0">
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
              // collection. Metadata is populated as the canvas
              // loads each layer; if it isn't ready yet, the action
              // is a no-op rather than a flicker. (#72)
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
                  visit(
                    (f.geometry as { coordinates: number[][] }).coordinates,
                  );
                }
              }
              if (minX !== Infinity && maxX !== -Infinity) {
                canvasRef.current?.zoomTo([minX, minY, maxX, maxY]);
              }
            }}
            onChange={setLayers}
          />
        </div>
        <div className="relative min-w-0 flex-1 p-2">
          <MapCanvas
            ref={canvasRef}
            map={map}
            basemaps={basemaps}
            onCameraChange={onCameraChange}
            selection={selection}
            selectTool={selectTool}
            onSelectionChange={setSelection}
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
            onClose={() => {
              setTableOpen(false);
              // Clear the focus pick on close so re-opening from
              // the toolbar lands on the default-first-visible.
              setTableFocusLayerId(null);
            }}
            onZoomTo={(bbox) => canvasRef.current?.zoomTo(bbox)}
            onPatchLayer={(layerId, patch) => {
              setLayers(
                map.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
              );
            }}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

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
    </div>
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

function ToolbarToggle({
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
      className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium shadow-card ${
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
