// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  ArrowLeft,
  Bookmark as BookmarkIcon,
  ChartSpline,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Crosshair as CrosshairIcon,
  Download,
  Image as ImageIcon,
  Info as InfoIcon,
  Layers as LayersIcon,
  Lasso,
  ListTree,
  Loader2,
  Locate as LocateIcon,
  Map as MapIcon,
  MoreVertical,
  MousePointer2,
  Palette,
  Pencil,
  Pentagon,
  Plus,
  Printer,
  Wand2,
  Search as SearchIcon,
  Square as SquareIcon,
  Table2 as TableIcon,
  Trash2,
  Type as TypeIcon,
  X as XIcon,
  ZoomIn as ZoomInIcon,
} from 'lucide-react';
import Link from 'next/link';
import maplibregl from 'maplibre-gl';
// Recharts is imported as a namespace so the Chart widget can grab
// the pieces it needs without polluting the top-level import list.
// The bundler keeps the recharts chunk co-located with the chart
// widget's lexical reference; pages that never reach a chart-
// rendering widget don't pull the chunk.
import * as ReactRecharts from 'recharts';
import type {
  CustomAppData,
  CustomWidget,
  CustomWidgetKind,
  Item,
  MapData,
  MapLayer,
  MapLayerStyle,
  PanelAnchor,
  PanelArrangement,
  PrintTemplateData,
  RecipeAction,
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
} from '@gratis-gis/shared-types';
import {
  RecipeRunPanel,
  type HostLayerOption,
} from './recipe-run-panel';
import {
  OsmOverlayLayer,
  type OsmOverlayFeature,
} from './osm-overlay-layer';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { customBasemapToData } from '@/lib/custom-basemap';
import {
  exportFeatures,
  type ExportFeature,
  // Client-side formats only: the Export widget + tool action build
  // files from features already in the browser. GeoParquet (the one
  // server-side format) is not offered on these surfaces.
  type ClientExportFormat,
} from '@/lib/layer-export';
import { BasemapPreview } from '@/components/basemap-preview';
import type { SelectToolMode } from '../map/select-tool';
import { AttributeTable } from '../map/attribute-table';
import { AttributeForm } from '../editor/attribute-form';
import {
  metadataFromFeatureCollection,
  type GeometryFamily,
  type LayerMetadata,
} from '../map/layer-metadata';
import { StyleEditor } from '../map/style-editor';
import { renderIconSvg } from '../map/map-icons';
import { SearchBar } from '../map/search-bar';
import {
  AppBarContext,
  Container,
  RuntimeInfoContext,
} from './themed-containers';
import {
  applyAppTheme,
  applyAppThemeTokens,
  resolveAssetRefSync,
  type AppThemeTokens,
} from '@gratis-gis/shared-types';
import { createPortal } from 'react-dom';
import {
  MapCanvas,
  type MapCanvasHandle,
} from '../map/map-canvas';
import { ElevationProfileTool } from '../map/elevation-profile';
import { resolveDemForBbox } from '@/lib/dem-resolver';

/**
 * Custom Web App runtime client (#341). Renders a designed page's
 * widgets in their grid positions with real, bound implementations:
 *
 *   - Map: MapLibre via the shared MapCanvas, seeded from the
 *     resolved app-level mapData (basemap + viewport + targets).
 *     Each Map widget gets its own state so selections / basemaps
 *     drift independently in multi-map apps.
 *   - LayerList / Legend / BasemapGallery / Search / Print / Select:
 *     bound to a Map widget by id (auto-bound at design time when a
 *     single Map exists, manually picked otherwise). Each reads /
 *     mutates the bound map's state through CustomMapsContext.
 *   - AttributeTable: minimal table over the bound app target's
 *     features. Click a row to highlight on the synced map; full
 *     editing arrives if a future runtime exposes the shared
 *     AttributeTable component plumbing.
 *   - Text: markdown-rendered. Tiny inline parser (bold + italic +
 *     links + lists + headings) keeps the bundle small.
 *
 * Chart is a deferred placeholder; the runtime renders it as a
 * "ships next" tile rather than a broken widget.
 *
 * Architecture:
 *
 *   - Per-map state lives in a Record<mapWidgetId, MapState> at
 *     this client. CustomMapsContext exposes it + an update fn +
 *     a refs map (for fly-to / zoom-to from sibling widgets) so
 *     the widget components stay leaf-y and don't pass state
 *     around manually.
 *   - The server entry (run/page.tsx) pre-resolves the app's
 *     targets, basemaps, and starting MapData; this client is a
 *     dumb consumer.
 */

interface ResolvedAppTarget {
  dataLayerId: string;
  layerKey: string;
  title: string;
  /**
   * Pre-built MapLayer descriptor for this target. Each Map widget
   * starts with all of these in its mapData.layers; LayerList +
   * Legend reflect them.
   */
  mapLayer: MapLayer;
}

interface MapState {
  mapData: MapData;
  selection: Record<string, Set<number | string>>;
  selectTool: SelectToolMode;
}

interface CustomMapsCtx {
  states: Record<string, MapState>;
  update: (
    mapWidgetId: string,
    patch:
      | Partial<MapState>
      | ((cur: MapState) => MapState),
  ) => void;
  registerRef: (mapWidgetId: string, ref: RefObject<MapCanvasHandle>) => void;
  basemaps: CustomBasemap[];
  resolvedTargets: ResolvedAppTarget[];
  /** Fly the bound map's camera to a bbox via the registered ref. */
  flyTo: (
    mapWidgetId: string,
    bbox: [number, number, number, number],
  ) => void;
  /** Refetch one map layer's source after an editing write. */
  refreshMapLayer: (mapWidgetId: string, mapLayerId: string) => void;
  /**
   * #361: jump to one of the app's pages by id. Used by the Button
   * widget's page-link path. Resolves the id to its index and falls
   * through silently if the page was deleted.
   */
  navigateToPage: (pageId: string) => void;
  pages: { id: string; title: string }[];
  /**
   * #361 part 2: live MapLibre Map instances keyed by Map widget id.
   * Populated by MapWidgetRender via MapCanvas's onMapReady callback.
   * Widgets that need direct access (Coordinates: mousemove tracking,
   * Bookmark: imperative flyTo, MyLocation: addSource/addLayer for the
   * marker) read from this map. Falls back to undefined when the
   * widget isn't mounted yet.
   */
  maps: Record<string, maplibregl.Map | null>;
  registerMap: (mapWidgetId: string, map: maplibregl.Map | null) => void;
  /**
   * #89 -- per-map edit-mode claim.  Active Edit-feature widgets
   * push their claimed MapLayer.ids + click handler here; the
   * MapWidgetRender forwards both to MapCanvas so clicks on those
   * layers open the edit form instead of the read-only popup.
   * Null when no Edit widget is active for that map.
   */
  editClaims: Record<
    string,
    {
      layerIds: ReadonlySet<string>;
      onClick: (info: {
        layerId: string;
        featureId: string | number;
        properties: Record<string, unknown>;
        lngLat: { lng: number; lat: number };
      }) => void;
    } | null
  >;
  setEditClaim: (
    mapWidgetId: string,
    claim:
      | {
          layerIds: ReadonlySet<string>;
          onClick: (info: {
            layerId: string;
            featureId: string | number;
            properties: Record<string, unknown>;
            lngLat: { lng: number; lat: number };
          }) => void;
        }
      | null,
  ) => void;
  /**
   * #364: ref to the runtime grid container. Tool-mode popovers
   * with placement='floating' anchor against this so they stay
   * within the runtime even on a scrolling page. May be null until
   * the first render lands.
   */
  runtimeContainerRef: RefObject<HTMLDivElement>;
  /**
   * Per-map popup suppression. Draw-style widgets (elevation
   * profile) set this while the user is placing vertices so map
   * clicks build the line instead of opening feature popups.
   * Same shared-state shape as editClaims: any widget can claim
   * its bound map without prop-drilling through the layout.
   */
  popupSuppressed: Record<string, boolean>;
  setPopupSuppressed: (mapWidgetId: string, on: boolean) => void;
}

const CustomMapsContext = createContext<CustomMapsCtx | null>(null);

/**
 * #87 -- runtime time-travel context.  When `at` is set, every
 * data fetch in the runtime appends `?at=<ISO>` so the engine
 * returns the bitemporal "current truth" as of that moment.
 * Editing widgets (Create / Edit / Delete) read this same context
 * and disable themselves when `at` is non-null, since writing into
 * the past is intentionally rejected by the observation-log
 * engine.  A null `at` means "now" -- the default.
 */
interface AppTimeCtx {
  at: string | null;
  setAt: Dispatch<SetStateAction<string | null>>;
}
const AppTimeContext = createContext<AppTimeCtx>({
  at: null,
  setAt: () => {},
});

/**
 * Read the current app-time as an ISO string, or null if the app
 * is showing "now".  Layer fetches, chart fetches, attribute-table
 * fetches all gate their URL on this -- see appendAtParam.
 */
export function useAppTime(): string | null {
  return useContext(AppTimeContext).at;
}

/**
 * Append `at=<ISO>` to a URL when the app is in time-travel mode.
 * Returns the URL unchanged when `at` is null.  Centralises the
 * URL-building so we don't sprinkle the encoder logic across every
 * fetch site.
 */
export function appendAtParam(url: string, at: string | null): string {
  if (!at) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}at=${encodeURIComponent(at)}`;
}

function useBoundMap(
  mapWidgetId: string,
): {
  state: MapState | null;
  update: (
    patch: Partial<MapState> | ((cur: MapState) => MapState),
  ) => void;
  basemaps: CustomBasemap[];
  resolvedTargets: ResolvedAppTarget[];
  flyTo: (bbox: [number, number, number, number]) => void;
} {
  const ctx = useContext(CustomMapsContext);
  if (!ctx) {
    throw new Error('useBoundMap called outside CustomMapsContext');
  }
  return {
    state: ctx.states[mapWidgetId] ?? null,
    update: (patch) => ctx.update(mapWidgetId, patch),
    basemaps: ctx.basemaps,
    resolvedTargets: ctx.resolvedTargets,
    flyTo: (bbox) => ctx.flyTo(mapWidgetId, bbox),
  };
}

interface Props {
  itemId: string;
  itemTitle: string;
  app: CustomAppData;
  basemaps: CustomBasemap[];
  baseMapData: MapData;
  /**
   * #363: per-Map-widget MapData when the widget has its own
   * `config.mapId` override. Keyed by widget id. Widgets without an
   * override fall through to baseMapData. The server entry
   * (run/page.tsx) builds this map.
   */
  widgetMapData: Record<string, MapData>;
  resolvedTargets: ResolvedAppTarget[];
  /**
   * #22: theme tokens resolved server-side from the app's
   * themePresetId.  When present, the runtime applies these
   * directly (no client-side fetch needed).  Optional so older
   * call sites without theme plumbing still work; we fall back to
   * the built-in starter resolver in that case.
   */
  themeTokens?: AppThemeTokens['tokens'];
  /**
   * Whether the calling user can manage (own / admin) this app.
   * Computed server-side from /api/users/me + item.ownerId; false
   * for anonymous visitors. Gates the "Back to items" + "Configure"
   * header chrome so a publicly-shared app stays chrome-free for
   * the visitors it was built for. Mirrors the EditorRuntime
   * `canEdit` gate pattern from the viewer runtime.
   */
  canManage?: boolean;
}

export function CustomRuntimeClient({
  itemId,
  itemTitle,
  app,
  basemaps,
  baseMapData,
  widgetMapData,
  resolvedTargets,
  themeTokens,
  canManage = false,
}: Props) {
  // Multi-page support (#342). Track which page is showing; render
  // only that page's widgets, but seed map state from EVERY page so
  // a Map's layer toggles persist when the user switches pages and
  // comes back. Single-page apps skip the tab strip entirely.
  const [activePageIdx, setActivePageIdx] = useState(0);
  // #364: runtime container ref. Tool-mode popovers anchor against
  // this so "fixed" placement docks to the runtime viewport rather
  // than the browser one.
  const runtimeContainerRef = useRef<HTMLDivElement | null>(null);
  // Theme root ref.  Applies CSS custom properties on the app
  // root so descendants reading `var(--app-*)` tokens render with
  // the configured theme.  When themeTokens are passed in
  // (server-resolved via theme items), use them directly via
  // applyAppThemeTokens; otherwise fall back to the built-in
  // starter resolver keyed off themePresetId.
  const themeRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!themeRootRef.current) return;
    if (themeTokens) {
      applyAppThemeTokens(themeRootRef.current, themeTokens);
    } else {
      applyAppTheme(themeRootRef.current, app.themePresetId);
    }
  }, [app.themePresetId, themeTokens]);
  const safePageIdx = Math.min(activePageIdx, app.pages.length - 1);
  const page = app.pages[safePageIdx]!;
  const totalWidgets = app.pages.reduce((n, p) => n + p.widgets.length, 0);
  const usedRows = page.widgets.reduce(
    (n, w) => Math.max(n, w.layout.row + w.layout.rowSpan - 1),
    0,
  );
  const totalRows = Math.max(8, usedRows + 2);

  // Initial per-Map-widget state derived once from the resolved
  // baseMapData. Each Map widget gets a deep-ish copy so divergent
  // basemap / layer-visibility changes don't cross-contaminate. We
  // walk EVERY page so cross-page bindings + page-switch persistence
  // both work without re-initializing state mid-session.
  const [states, setStates] = useState<Record<string, MapState>>(() => {
    const out: Record<string, MapState> = {};
    function visit(widget: CustomWidget) {
      if (widget.kind === 'map') {
        // #363: prefer the per-widget MapData when an override is
        // resolved; fall back to the app-default baseMapData.
        const seed = widgetMapData[widget.id] ?? baseMapData;
        out[widget.id] = {
          mapData: { ...seed, layers: [...(seed.layers ?? [])] },
          selection: {},
          selectTool: 'off',
        };
      }
      // #362: recurse into Tabs containers so nested Map widgets
      // also get state entries.
      if (widget.kind === 'tabs' && widget.config.kind === 'tabs') {
        for (const t of widget.config.tabs) {
          for (const c of t.widgets) visit(c);
        }
      }
    }
    for (const p of app.pages) {
      for (const w of p.widgets) visit(w);
    }
    return out;
  });

  const update = useCallback(
    (
      mapWidgetId: string,
      patch:
        | Partial<MapState>
        | ((cur: MapState) => MapState),
    ) => {
      setStates((cur) => {
        const existing = cur[mapWidgetId];
        if (!existing) return cur;
        const next =
          typeof patch === 'function' ? patch(existing) : { ...existing, ...patch };
        return { ...cur, [mapWidgetId]: next };
      });
    },
    [],
  );

  // Map of widget-id to MapCanvasHandle ref. Each Map widget calls
  // registerRef on mount so other widgets can call zoomTo /
  // flyAndHighlight without prop-drilling.
  const refRegistry = useRef<Record<string, RefObject<MapCanvasHandle>>>({});
  const registerRef = useCallback(
    (id: string, ref: RefObject<MapCanvasHandle>) => {
      refRegistry.current[id] = ref;
    },
    [],
  );

  const flyTo = useCallback(
    (mapWidgetId: string, bbox: [number, number, number, number]) => {
      const ref = refRegistry.current[mapWidgetId];
      ref?.current?.zoomTo(bbox);
    },
    [],
  );

  // Force one MapLayer's source to refetch after an editing widget
  // writes a feature, so the change shows without a page reload.
  const refreshMapLayer = useCallback(
    (mapWidgetId: string, mapLayerId: string) => {
      const ref = refRegistry.current[mapWidgetId];
      ref?.current?.refreshLayerSource(mapLayerId);
    },
    [],
  );

  // #361 part 2: live MapLibre Map instances per Map widget id.
  // MapWidgetRender registers via onMapReady so widgets like
  // Coordinates, Bookmark, and MyLocation can read pointer position,
  // call flyTo, or add temporary marker layers without a refRegistry
  // workaround.
  const [maps, setMaps] = useState<Record<string, maplibregl.Map | null>>({});
  const registerMap = useCallback(
    (id: string, map: maplibregl.Map | null) => {
      setMaps((cur) => {
        // Avoid resetting state when MapCanvas re-renders with the
        // same instance; React would otherwise schedule downstream
        // effects every render.
        if (cur[id] === map) return cur;
        return { ...cur, [id]: map };
      });
    },
    [],
  );

  // #89 -- per-map edit-mode claim.  Edit-feature widgets call
  // setEditClaim when they toggle ON, registering the editable
  // MapLayer.ids and the click handler that should fire instead
  // of MapCanvas's default popup.  MapWidgetRender forwards both
  // to MapCanvas via the editClaimedLayerIds / onEditClaimedClick
  // props (#89 plumbing in map-canvas.tsx).  Storing the claim as
  // shared state means a sibling widget on another page slot can
  // toggle it without prop-drilling through the grid layout.
  const [editClaims, setEditClaims] = useState<
    CustomMapsCtx['editClaims']
  >({});
  const setEditClaim = useCallback<CustomMapsCtx['setEditClaim']>(
    (mapWidgetId, claim) => {
      setEditClaims((cur) => {
        if (cur[mapWidgetId] === claim) return cur;
        return { ...cur, [mapWidgetId]: claim };
      });
    },
    [],
  );

  // Popup suppression claims for draw-style widgets (see the ctx
  // doc comment). Kept as its own record rather than folding into
  // editClaims because the two release at different times.
  const [popupSuppressed, setPopupSuppressedState] = useState<
    Record<string, boolean>
  >({});
  const setPopupSuppressed = useCallback(
    (mapWidgetId: string, on: boolean) => {
      setPopupSuppressedState((cur) => {
        if ((cur[mapWidgetId] ?? false) === on) return cur;
        return { ...cur, [mapWidgetId]: on };
      });
    },
    [],
  );

  // #361: navigate-by-id for the Button widget's page-link path.
  // Pages are passed as a stripped {id, title} list to avoid leaking
  // widget data into the context.
  const navigateToPage = useCallback(
    (pageId: string) => {
      const idx = app.pages.findIndex((p) => p.id === pageId);
      if (idx >= 0) setActivePageIdx(idx);
    },
    [app.pages],
  );
  const pagesForCtx = useMemo(
    () => app.pages.map((p) => ({ id: p.id, title: p.title })),
    [app.pages],
  );

  const ctxValue: CustomMapsCtx = useMemo(
    () => ({
      states,
      update,
      registerRef,
      basemaps,
      resolvedTargets,
      flyTo,
      refreshMapLayer,
      navigateToPage,
      pages: pagesForCtx,
      maps,
      registerMap,
      editClaims,
      setEditClaim,
      runtimeContainerRef,
      popupSuppressed,
      setPopupSuppressed,
    }),
    [
      states,
      update,
      registerRef,
      basemaps,
      resolvedTargets,
      flyTo,
      refreshMapLayer,
      navigateToPage,
      pagesForCtx,
      maps,
      registerMap,
      editClaims,
      setEditClaim,
      popupSuppressed,
      setPopupSuppressed,
    ],
  );

  // #87 -- app-time state.  Initial value read from the URL's
  // `?at=` query so deep-linking to a historical snapshot Just
  // Works.  Future commits add a slider widget that drives this
  // state imperatively.  Null = "now".
  const [appAt, setAppAt] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('at');
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  });
  const appTimeCtx = useMemo(
    () => ({ at: appAt, setAt: setAppAt }),
    [appAt],
  );

  return (
    <AppTimeContext.Provider value={appTimeCtx}>
    <RuntimeInfoContext.Provider value={{ itemTitle }}>
    <CustomMapsContext.Provider value={ctxValue}>
      {/* Viewport-fit container. h-screen (was h-full + min-h) so
          the app's whole vertical extent is exactly the viewport
          height: header + page tabs (when present) + canvas slot
          all distribute within that, and the canvas slot's
          overflow-hidden keeps widgets from pushing the page taller.
          End users see the app fitted to their screen with no
          vertical scroll; widgets that have more content than they
          can show (an attribute table with many rows, a long layer
          list) handle their own internal scrolling. */}
      <div
        ref={themeRootRef}
        // font-family from the theme's --app-font token (falls back to
        // the portal sans for theme items saved before the token
        // existed) so each app carries its theme's typographic voice.
        style={{ fontFamily: 'var(--app-font, var(--font-sans))' }}
        className="flex h-screen flex-col overflow-hidden bg-[hsl(var(--app-surface-0))] text-[hsl(var(--app-ink-0))]"
      >
        {appAt ? (
          // #87 -- time-travel banner.  Lives above the app header so
          // it's unmissable; the user understands they're not seeing
          // "live" data.  Read-only is also a hard rule: write
          // widgets gate on this context and disable themselves, and
          // the engine rejects writes that target past observations
          // independently of the UI.
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--app-warn)/0.4)] bg-[hsl(var(--app-warn)/0.15)] px-4 py-1.5 text-xs text-[hsl(var(--app-warn))]">
            <span>
              Viewing as of{' '}
              <strong>{new Date(appAt).toLocaleString()}</strong>{' '}
              &ndash; read-only
            </span>
            <button
              type="button"
              onClick={() => setAppAt(null)}
              className="rounded-md border border-[hsl(var(--app-warn)/0.5)] bg-[hsl(var(--app-surface-1))] px-2 py-0.5 text-[hsl(var(--app-warn))] hover:bg-[hsl(var(--app-warn)/0.1)]"
            >
              Return to Now
            </button>
          </div>
        ) : null}
        {/* Manage chrome (Back / title / Configure). Renders only for
            users who can manage the item; anonymous and non-owner
            viewers see no chrome bar at all so the app's own
            designed header (top container with logo / title / tools)
            isn't competing with a duplicate runtime title strip. */}
        {canManage ? (
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-4 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/items"
                className="inline-flex items-center gap-1 text-xs text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-0))]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to items
              </Link>
              <span className="text-[hsl(var(--app-muted))]">/</span>
              <span className="truncate text-base font-semibold text-[hsl(var(--app-ink-0))]">
                {itemTitle}
              </span>
            </div>
            <Link
              href={`/items/${itemId}?view=configure`}
              className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 py-1 text-xs font-medium text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
            >
              Configure
            </Link>
          </header>
        ) : null}

        {/* Page tabs (#342). Hidden when the app has only one page so
            single-page apps stay chrome-free. */}
        {app.pages.length > 1 && (
          <nav
            className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3"
            aria-label="App pages"
          >
            {app.pages.map((p, i) => {
              const active = i === safePageIdx;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActivePageIdx(i)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'text-[hsl(var(--app-ink-0))]'
                      : 'text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-1))]'
                  }`}
                >
                  {p.title}
                  {active && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-[hsl(var(--app-ink-0))]"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}

        {/* Viewport-fit canvas (user feedback: apps should fit the
            screen, never scroll vertically). The parent is flex-1
            of a flex-col page (header + nav + this container), so
            its height resolves to "viewport - chrome". No
            overflow-auto -- if a widget's content exceeds its
            allotted grid cell, the widget handles its own internal
            scrolling. */}
        <div
          ref={runtimeContainerRef}
          className="relative flex flex-1 flex-col overflow-hidden bg-[hsl(var(--app-surface-0))]"
        >
          {totalWidgets === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-sm rounded-[var(--app-radius)] border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] p-8 text-center shadow-[var(--app-shadow-card)]">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--app-accent)/0.1)] text-[hsl(var(--app-accent))]">
                  <SquareIcon className="h-6 w-6" />
                </span>
                <h2 className="mt-4 text-base font-semibold text-[hsl(var(--app-ink-0))]">
                  Start building
                </h2>
                <p className="mt-1.5 text-sm text-[hsl(var(--app-muted))]">
                  Add a map, a layer list, and other widgets from the{' '}
                  <Link
                    href={`/items/${itemId}`}
                    className="font-medium text-[hsl(var(--app-accent))] hover:underline"
                  >
                    configuration page
                  </Link>{' '}
                  to build this app.
                </p>
              </div>
            </div>
          ) : (() => {
            // #92 final-mile: partition top-level widgets into
            // CONTAINER slots and CANVAS widgets, based on each
            // container's `position` prop.  Containers with sticky-
            // top / sticky-bottom positions render as top / bottom
            // bars above and below the canvas; dock-left / dock-
            // right render as flex-sibling side panels (so
            // collapsing a dock actually frees up canvas space);
            // overlay-trigger and inline containers pass through
            // to the canvas (overlay-trigger uses absolute
            // positioning to self-place; inline takes its grid
            // cell like any other widget).
            const ordered = sortForOverlapStacking(page.widgets);
            const topBars: CustomWidget[] = [];
            const bottomBars: CustomWidget[] = [];
            const leftDocks: CustomWidget[] = [];
            const rightDocks: CustomWidget[] = [];
            const canvasWidgets: CustomWidget[] = [];
            for (const w of ordered) {
              if (w.kind === 'container' && w.config.kind === 'container') {
                const pos = w.config.position ?? 'inline';
                if (pos === 'sticky-top') topBars.push(w);
                else if (pos === 'sticky-bottom') bottomBars.push(w);
                else if (pos === 'dock-left') leftDocks.push(w);
                else if (pos === 'dock-right') rightDocks.push(w);
                else canvasWidgets.push(w);
              } else {
                canvasWidgets.push(w);
              }
            }
            return (
              <>
                {topBars.map((w) => (
                  <div key={w.id} className="relative shrink-0">
                    {renderWidget(w)}
                  </div>
                ))}
                <div className="relative flex min-h-0 flex-1 items-stretch">
                  {leftDocks.map((w) => (
                    <div key={w.id} className="relative shrink-0">
                      {renderWidget(w)}
                    </div>
                  ))}
                  <div
                    className="relative grid min-h-0 min-w-0 flex-1 p-3"
                    style={{
                // Viewport-fit grid: 48 cols x N rows of 1fr each,
                // where N = the highest row+rowSpan used by any
                // widget. Rows are proportional (not pixel-fixed)
                // so the whole app fills the available viewport
                // height without scrolling. A widget at rowSpan=60
                // in a 64-row grid takes 60/64 = ~94% of the
                // canvas height; the same template on a taller or
                // shorter screen scales proportionally.
                //
                // Trade-off vs. the designer's 12px-row model:
                // the designer canvas is pixel-tall (designer
                // shows authoring affordances, room for the
                // user's eye to plan), but the runtime is
                // viewport-tall (end user sees a coherent app
                // fitted to their screen).
                gridTemplateColumns: 'repeat(192, minmax(0, 1fr))',
                gridTemplateRows: `repeat(${totalRows}, minmax(0, 1fr))`,
                //
                // The earlier 1400px fixed-width experiment was
                // reverted: it broke on narrow viewports (toolbar
                // widgets ended up off-screen) and made map-first
                // layouts feel cramped on wide displays. The new
                // direction is the generic Container widget (with
                // position=sticky-top / dock-left / etc.) that
                // handles its own responsive sizing as a flex
                // sibling of the canvas grid, so the grid itself
                // doesn't need a fixed width to look right.
                //
                // (gridTemplateColumns and gridTemplateRows are
                // declared above this block; this comment block
                // captures the historical context.)
                // #95: gap scaled to match the v4 (192-col / 3px-row)
                // grid resolution.  The legacy 6px gap was sized for
                // a v3 (48-col / 12px-row) grid; at 4x finer
                // resolution it ate a huge fraction of the available
                // space, inflating widget heights by ~2x in the
                // designer.  Scaling the gap by 1/4 keeps the same
                // visual proportions across the bump.
                gap: '1.5px',
              }}
            >
                    {/* Canvas widgets paint via the page grid. Map
                        widgets sit at z-0; tool buttons at z-10;
                        other panels at z-5 (see WidgetSlot). */}
                    {canvasWidgets.map((w) => (
                      <WidgetSlot key={w.id} widget={w} />
                    ))}
                  </div>
                  {rightDocks.map((w) => (
                    <div key={w.id} className="relative shrink-0">
                      {renderWidget(w)}
                    </div>
                  ))}
                </div>
                {bottomBars.map((w) => (
                  <div key={w.id} className="relative shrink-0">
                    {renderWidget(w)}
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      </div>
    </CustomMapsContext.Provider>
    </RuntimeInfoContext.Provider>
    </AppTimeContext.Provider>
  );
}

/**
 * Re-order widgets for runtime rendering so overlapping cells paint
 * in the right z-order. The persisted array order is the AUTHOR's
 * order (which determines selection-cycle, page navigation, etc. in
 * the designer); render order is independent.
 *
 * Rendering rule: Map widgets and Tabs containers paint UNDERNEATH
 * everything else. Without this, a user who drops a couple of
 * toolbar buttons and then adds a Map widget ends up with the Map
 * covering those buttons at runtime because the Map's section comes
 * LATER in DOM source order and CSS Grid paints later items on top.
 *
 * Within each tier we preserve the author's order so two overlapping
 * Map widgets (rare) still stack predictably and two overlapping
 * toolbar buttons (also rare; the designer doesn't auto-collide)
 * keep the author-visible order.
 */
function sortForOverlapStacking(widgets: CustomWidget[]): CustomWidget[] {
  const beneath: CustomWidget[] = [];
  const above: CustomWidget[] = [];
  for (const w of widgets) {
    if (w.kind === 'map' || w.kind === 'tabs') {
      beneath.push(w);
    } else {
      above.push(w);
    }
  }
  return [...beneath, ...above];
}

function WidgetSlot({ widget }: { widget: CustomWidget }) {
  // #364: tool-mode widgets render as a small icon button in the
  // grid cell + a popover panel anchored per panelArrangement.
  // Panel-mode widgets render inline using the existing card chrome.
  const isToolMode = isToolDisplayWidget(widget) && widgetDisplayMode(widget) === 'tool';
  // Stacking. Map and Tabs widgets (the "container" kinds) sit at
  // z-index 0; tool widgets sit at z-index 10; other panel widgets
  // sit at z-index 5. CSS Grid's source-order stacking is unreliable
  // when an overlapping child creates its own stacking context (e.g.
  // MapLibre's WebGL canvas via transform), so explicit z-index +
  // position: relative is needed to keep toolbar buttons above the
  // map when they overlap. The `position: relative` is required for
  // z-index to take effect on grid items.
  const isContainer = widget.kind === 'map' || widget.kind === 'tabs';
  const zIndex = isToolMode ? 10 : isContainer ? 0 : 5;
  return (
    <section
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
        position: 'relative',
        zIndex,
      }}
      className={
        isToolMode
          ? 'flex h-full w-full items-stretch'
          : 'flex h-full w-full flex-col overflow-hidden rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))]'
      }
    >
      {isToolMode ? (
        <ToolWidgetSlot widget={widget} />
      ) : (
        renderWidget(widget)
      )}
    </section>
  );
}

const TOOL_DISPLAY_KINDS: ReadonlySet<CustomWidgetKind> = new Set([
  'layer-list',
  'legend',
  'search',
  'print',
  'select',
  'export',
  'basemap-gallery',
  'bookmark',
  'coordinates',
  'my-location',
  // #261 follow-up: attribute-table now supports tool display mode so
  // authors can drop it onto the toolbar above the map. When
  // displayMode='tool' the runtime renders an icon button that opens
  // the table in a floating panel (anchored bottom-center by default,
  // matching the map item's dock).
  'attribute-table',
]);

function isToolDisplayWidget(widget: CustomWidget): boolean {
  return TOOL_DISPLAY_KINDS.has(widget.kind);
}

function widgetDisplayMode(widget: CustomWidget): 'panel' | 'tool' {
  if (!isToolDisplayWidget(widget)) return 'panel';
  const cfg = widget.config as { displayMode?: 'panel' | 'tool' };
  return cfg.displayMode ?? 'panel';
}

function widgetPanelArrangement(widget: CustomWidget): PanelArrangement {
  const cfg = widget.config as { panelArrangement?: PanelArrangement };
  return cfg.panelArrangement ?? {};
}

const KIND_TOOL_LABEL: Record<string, string> = {
  'layer-list': 'Layers',
  legend: 'Legend',
  search: 'Search',
  print: 'Print',
  select: 'Select',
  export: 'Export',
  'basemap-gallery': 'Basemaps',
  bookmark: 'Bookmarks',
  coordinates: 'Coordinates',
  'my-location': 'My location',
  'attribute-table': 'Attribute table',
};

/**
 * #364: tool-mode wrapper. Renders an icon button in the canvas
 * grid cell. On click, opens a popover positioned per the widget's
 * panelArrangement, using the existing widget renderer for content.
 */
function ToolWidgetSlot({ widget }: { widget: CustomWidget }) {
  const ctx = useContext(CustomMapsContext);
  // When inside an app-bar, render the trigger as a flat header-ink
  // icon link rather than a raised white pill. The white-pill
  // treatment is correct on the canvas but reads as "stuck-on
  // buttons" when stacked on a colored header (the screenshot
  // showed Search/Basemap/Print/AttrTable as cramped white tiles
  // on the green Forest header).
  const inAppBar = useContext(AppBarContext);
  const [open, setOpen] = useState(false);
  // Trigger ref so the popover can anchor itself below the actual
  // button instead of always pinning to the runtime container's
  // top edge. Without this, a tool button inside an app-bar opens
  // a popover that overlaps the bar (anchored at top-right of the
  // runtime, which IS the bar's vertical band).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const Icon = KIND_ICON[widget.kind] ?? SquareIcon;
  const arrangement = widgetPanelArrangement(widget);
  // Author-supplied override takes priority over the kind default
  // so a tool can read "Attributes" instead of "Attribute Table"
  // without changing the widget kind.  Falls through to the kind
  // default when not set.
  const defaultLabel = KIND_TOOL_LABEL[widget.kind] ?? widget.kind;
  const override = arrangement.labelOverride?.trim();
  const label = override && override.length > 0 ? override : defaultLabel;
  const iconOnly = arrangement.labelMode === 'icon-only';

  // Esc closes; click outside closes (handled by ToolPopover via
  // an overlay catcher).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title={label}
        // For in-bar buttons we use inline `style` for the active
        // colors because Tailwind's arbitrary-value JIT was silently
        // failing on `bg-[hsl(var(--app-header-ink))]` in production
        // (cream + sage inversion never rendered, the button
        // appeared invisible on the green header). Inline style
        // sidesteps that entirely. Inactive state stays in classes
        // because the simpler color-only Tailwind utilities work
        // fine for it.
        style={
          inAppBar && open
            ? {
                backgroundColor: 'hsl(var(--app-header-ink))',
                color: 'hsl(var(--app-header-bg))',
              }
            : undefined
        }
        className={
          inAppBar
            ? // Flat header-ink treatment for tools sitting in an
              // app-bar. Idle: 85%-opacity header-ink (cream on
              // green for Forest). Active: INVERTED via inline
              // style above (cream BG, sage ink). The previous
              // attempt used Tailwind arbitrary values for active
              // which the JIT scanner missed at build time.
              `group/tool flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors ${
                open
                  ? ''
                  : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
              }`
            : // Canvas treatment: raised white pill with shadow.
              // This is the right read when the trigger sits on the
              // page grid (surface-0) without surrounding chrome.
              `group/tool flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md border bg-[hsl(var(--app-surface-1))] shadow-sm transition-all ${
                open
                  ? 'border-[hsl(var(--app-ink-0))] text-[hsl(var(--app-ink-0))] ring-2 ring-[hsl(var(--app-ink-0)/0.1)]'
                  : 'border-[hsl(var(--app-border))] text-[hsl(var(--app-ink-1))] hover:-translate-y-0.5 hover:border-[hsl(var(--app-ink-1))] hover:shadow-md'
              }`
        }
      >
        <Icon
          className={`h-5 w-5 transition-transform ${
            open ? 'scale-110' : 'group-hover/tool:scale-105'
          }`}
          strokeWidth={1.75}
        />
        {/* labelMode='icon-only' compresses the button to just the
            icon; the title attribute above keeps discoverability via
            hover tooltip + screen-reader aria-label. */}
        {iconOnly ? null : (
          <span className="text-2xs font-medium leading-none">{label}</span>
        )}
      </button>
      {open && ctx && (
        <ToolPopover
          arrangement={arrangement}
          containerRef={ctx.runtimeContainerRef}
          triggerRef={triggerRef}
          triggerInAppBar={inAppBar}
          title={label}
          icon={Icon}
          onClose={() => setOpen(false)}
        >
          {/* #364: suppress the inner widget's header so we don't
              stack two title bars on top of each other. The
              ToolPopoverHeader carries the title; WidgetFrame
              checks this context and skips its own header. */}
          <SuppressFrameHeaderContext.Provider value={true}>
            <div className="flex h-full min-h-0 flex-col">
              {renderWidget(widget)}
            </div>
          </SuppressFrameHeaderContext.Provider>
        </ToolPopover>
      )}
    </>
  );
}

/**
 * Anchored, animated popover for tool-mode widgets. Positions
 * itself at one of the 9 anchor cells of the runtime container
 * (or browser viewport if placement='fixed'), with optional
 * fade/slide animation on open.
 */
function ToolPopover({
  arrangement,
  containerRef,
  triggerRef,
  triggerInAppBar,
  title,
  icon: Icon,
  onClose,
  children,
}: {
  arrangement: PanelArrangement;
  containerRef: RefObject<HTMLDivElement>;
  /**
   * Trigger button ref. When set, the floating popover anchors
   * below the button (right-aligned to its right edge) instead of
   * pinning to the runtime container's anchor corner. This is what
   * stops a tool button inside an app-bar from opening a popover
   * that overlaps the bar itself.
   */
  triggerRef?: RefObject<HTMLButtonElement>;
  /**
   * When the trigger lives inside an app-bar, the popover wants
   * extra vertical clearance under the bar (so it visually aligns
   * with maplibre zoom controls) and extra horizontal inset on
   * right-anchored placements (so it doesn't bleed into the
   * zoom/compass control cluster). Caller passes this flag down so
   * computePopoverPosition can apply those offsets.
   */
  triggerInAppBar?: boolean;
  title: string;
  icon: typeof MapIcon;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const placement = arrangement.placement ?? 'floating';
  const anchor: PanelAnchor = arrangement.anchor ?? 'top-right';
  const width = arrangement.width ?? 360;
  const height = arrangement.height ?? 480;
  const offsetX = arrangement.offsetX ?? 12;
  const offsetY = arrangement.offsetY ?? 12;
  const animation = arrangement.animation ?? 'fade';

  // Brief delay before applying the "open" class so the CSS
  // transition runs even though we mounted with the panel
  // already in the DOM.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Animate-out on close: flip shown off, wait the transition
  // duration, then call onClose. The parent unmounts us synchronously
  // today, but doing it this way lets a future "close on click
  // outside" path benefit from the same animation.
  function handleClose() {
    setShown(false);
    window.setTimeout(onClose, 160);
  }

  // Click-outside via a transparent backdrop. Lower z-index than
  // the popover itself so the popover stays interactive.
  // When a triggerRef is provided AND placement is floating, anchor
  // the popover to the trigger button's actual rect (drop below the
  // button, align with its right edge by default). This is the path
  // that stops app-bar tools from opening a popover that lands on
  // top of the bar itself. Falls back to the static anchor logic
  // when no trigger is available (or for fixed / docked-bottom).
  const positionStyle = computePopoverPosition({
    anchor,
    width,
    height,
    offsetX,
    offsetY,
    triggerRef: triggerRef ?? null,
    containerRef,
    placement,
    triggerInAppBar: triggerInAppBar ?? false,
  });

  const animationClass =
    animation === 'none'
      ? 'transition-none'
      : animation === 'slide'
        ? `transition-[opacity,transform] duration-200 ease-out ${
            shown
              ? 'translate-y-0 scale-100 opacity-100'
              : '-translate-y-1 scale-95 opacity-0'
          }`
        : `transition-[opacity,transform] duration-150 ease-out ${
            shown ? 'scale-100 opacity-100' : 'scale-[0.97] opacity-0'
          }`;

  // Fixed mode pins to the browser viewport. Floating mode pins to
  // the runtime container so the popover stays inside the app's
  // space even on a scrolling page.
  const positionMode =
    placement === 'fixed'
      ? 'fixed'
      : 'absolute';

  // Docked-bottom: full-width strip along the bottom edge of the
  // runtime container, with a collapse/expand control in the header.
  // Mirrors the map item's attribute-table dock pattern. Anchor /
  // width / offsets are ignored here; only height applies.
  //
  // Portaling: the popover is rendered into the runtime container
  // (via createPortal) so its `position: absolute` resolves to the
  // runtime root rather than the nearest positioned ancestor of the
  // calling ToolWidgetSlot. Without the portal, a tool button
  // living inside an app-bar would have its docked-bottom panel
  // anchor to the BAR's bottom edge (a 48px-tall sliver), not to
  // the bottom of the whole runtime viewport.
  if (placement === 'docked-bottom') {
    const container = containerRef.current ?? null;
    if (!container) return null;
    return createPortal(
      <DockedBottomPopover
        title={title}
        icon={Icon}
        height={arrangement.height ?? 280}
        animationClass={animationClass}
        onClose={handleClose}
      >
        {children}
      </DockedBottomPopover>,
      container,
    );
  }

  // For floating, render relative to the runtime container so the
  // CSS anchors (top/right/bottom/left) line up. We achieve that by
  // creating an overlay div that's `position:absolute inset-0`
  // inside the container, then positioning the popover within it.
  // For fixed, we render directly with position:fixed.
  if (placement === 'fixed') {
    return (
      <>
        <button
          type="button"
          aria-label="Close"
          onClick={handleClose}
          className="fixed inset-0 z-40 cursor-default bg-transparent"
        />
        <div
          role="dialog"
          aria-label={title}
          style={{ ...positionStyle, position: 'fixed', width, height }}
          className={`z-50 flex flex-col overflow-hidden rounded-lg border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[0_10px_40px_-10px_rgba(15,15,16,0.25),_0_2px_8px_-2px_rgba(15,15,16,0.08)] ${animationClass}`}
        >
          <ToolPopoverHeader title={title} icon={Icon} onClose={handleClose} />
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </>
    );
  }

  // Floating: render via portal into the runtime container so the
  // popover's CSS anchors (top/right/bottom/left) line up with the
  // runtime root, regardless of where the calling ToolWidgetSlot
  // sits in the DOM (top-level page grid, inside an app-bar's flex
  // row, inside a dock-panel's column, etc.).
  const container = containerRef.current ?? null;
  if (!container) return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={handleClose}
        // Backdrop sits behind the popover but above page content,
        // catching click-outside without blocking ARIA focus.
        style={{ position: 'absolute', inset: 0 }}
        className="z-40 cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={title}
        style={{
          ...positionStyle,
          position: positionMode,
          width,
          height,
        }}
        className={`z-50 flex flex-col overflow-hidden rounded-lg border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)] ${animationClass}`}
      >
        <ToolPopoverHeader title={title} icon={Icon} onClose={handleClose} />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </>,
    container,
  );
}

function ToolPopoverHeader({
  title,
  icon: Icon,
  onClose,
  collapsed,
  onToggleCollapsed,
}: {
  title: string;
  icon: typeof MapIcon;
  onClose: () => void;
  /** When provided, render a collapse/expand chevron alongside the
   *  close button. Used by the docked-bottom popover so the user can
   *  shrink the panel to a header sliver without dismissing it. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-2">
      <Icon className="h-4 w-4 text-[hsl(var(--app-muted))]" strokeWidth={1.75} />
      <span className="flex-1 truncate text-sm font-semibold text-[hsl(var(--app-ink-0))]">
        {title}
      </span>
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-expanded={!collapsed}
          className="rounded p-1 text-[hsl(var(--app-muted))] transition-colors hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-1))]"
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
          )}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        className="-mr-1 rounded p-1 text-[hsl(var(--app-muted))] transition-colors hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-1))]"
      >
        <XIcon className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </header>
  );
}

/**
 * Docked-bottom popover. Full-width strip along the bottom of the
 * runtime container with a collapse handle in the header. Mirrors
 * the map item's attribute-table dock so attribute-table widgets
 * configured as `placement: 'docked-bottom'` render the same way the
 * user knows from the map viewer.
 *
 * Collapse state is local: an open panel shrinks to a header-only
 * sliver but the inner content stays mounted so per-instance state
 * (query, layer-pick, sort) survives the collapse.
 */
function DockedBottomPopover({
  title,
  icon,
  height,
  animationClass,
  onClose,
  children,
}: {
  title: string;
  icon: typeof MapIcon;
  height: number;
  animationClass: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Header row is approximately 36 px (py-2 + 16px content). When
  // collapsed we render at that height; expanded uses the configured
  // panel height.
  const HEADER_HEIGHT = 36;
  const effectiveHeight = collapsed ? HEADER_HEIGHT : Math.max(HEADER_HEIGHT, height);
  return (
    <div
      role="dialog"
      aria-label={title}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: effectiveHeight,
      }}
      className={`z-50 flex flex-col overflow-hidden border-t border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)] ${animationClass}`}
    >
      <ToolPopoverHeader
        title={title}
        icon={icon}
        onClose={onClose}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />
      {/* Content stays mounted while collapsed (just clipped) so the
          inner state (query strings, scroll position, etc.) doesn't
          reset every time the user toggles. */}
      <div
        className="min-h-0 flex-1 overflow-hidden"
        aria-hidden={collapsed}
        style={collapsed ? { visibility: 'hidden' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Translate a 9-cell anchor + offset into CSS positioning rules.
 * Each anchor corresponds to a corner / edge of the parent.
 * Offsets nudge inward (positive value moves the panel away from
 * the anchored edge).
 */
function computePopoverPosition({
  anchor,
  width,
  height,
  offsetX,
  offsetY,
  triggerRef,
  containerRef,
  placement,
  triggerInAppBar,
}: {
  anchor: PanelAnchor;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  triggerRef?: RefObject<HTMLButtonElement> | null;
  containerRef?: RefObject<HTMLDivElement>;
  placement?: string;
  triggerInAppBar?: boolean;
}): React.CSSProperties {
  // Trigger-anchored path: when we have a trigger button and the
  // popover is floating, position the popover relative to the
  // trigger's bounding box (drop below it, right-aligned to its
  // right edge). This is what we want for AGO-style tool buttons:
  // the menu opens directly under the icon you just clicked, not
  // at a fixed corner of the app shell.
  if (
    triggerRef?.current &&
    containerRef?.current &&
    (placement === 'floating' || placement === undefined)
  ) {
    const trig = triggerRef.current.getBoundingClientRect();
    const cont = containerRef.current.getBoundingClientRect();
    // App-bar triggers want extra vertical breathing room so the
    // popover top sits clearly below the zoom controls (default
    // top: 10 inside the map, controls are ~30px tall). Non-bar
    // triggers stay tight (4px).
    const topGap = triggerInAppBar ? 24 : 4;
    const top = trig.bottom - cont.top + topGap;
    // Default to right-aligning the popover with the trigger button
    // for top-right anchors; left-align for top-left; center for the
    // rest. This keeps the popover visually attached to the button
    // edge the user actually clicked.
    const [, horiz] = anchor.split('-') as [string, string];
    const containerW = cont.width;
    let left: number;
    if (horiz === 'left') {
      left = Math.max(offsetX, trig.left - cont.left);
    } else if (horiz === 'right') {
      // Right-align: for app-bar triggers, anchor the popover's
      // right edge to the runtime container's right edge minus a
      // small inset that clears the maplibre zoom/compass cluster
      // (controls live at ~10px from the canvas right with ~30px
      // width). This way the popover lands in the same horizontal
      // region as the zoom controls regardless of which tool in
      // the bar opened it. For non-bar triggers (canvas tools),
      // keep the trigger-anchored behavior so the popover stays
      // attached to the button the user clicked.
      const desiredRight = triggerInAppBar
        ? containerW - 80
        : trig.right - cont.left;
      left = Math.min(
        Math.max(offsetX, desiredRight - width),
        containerW - width - offsetX,
      );
    } else {
      // Center on trigger's center.
      const center = (trig.left + trig.right) / 2 - cont.left;
      left = Math.min(
        Math.max(offsetX, center - width / 2),
        containerW - width - offsetX,
      );
    }
    // Keep the popover from running off the bottom of the runtime;
    // if the trigger is near the bottom, flip above the trigger.
    const containerH = cont.height;
    if (top + height > containerH - offsetY) {
      const flipped = trig.top - cont.top - height - 4;
      if (flipped >= offsetY) {
        return { top: flipped, left };
      }
    }
    return { top, left };
  }

  // Static-anchor fallback. Used for fixed-placement popovers and
  // for callers that didn't supply a triggerRef (legacy paths).
  const [vert, horiz] = anchor.split('-') as [
    'top' | 'middle' | 'bottom',
    'left' | 'center' | 'right',
  ];
  const style: React.CSSProperties = {};
  if (vert === 'top') style.top = offsetY;
  if (vert === 'bottom') style.bottom = offsetY;
  if (vert === 'middle') {
    style.top = '50%';
    style.transform = (style.transform ?? '') + ' translateY(-50%)';
  }
  if (horiz === 'left') style.left = offsetX;
  if (horiz === 'right') style.right = offsetX;
  if (horiz === 'center') {
    style.left = '50%';
    const t = style.transform ?? '';
    style.transform = (t ? `${t} ` : '') + 'translateX(-50%)';
  }
  // Reference width/height so a future tweak (e.g. clamping to
  // container bounds in the static path too) has them available
  // without changing the signature.
  void width;
  void height;
  return style;
}

function renderWidget(widget: CustomWidget): React.ReactNode {
  switch (widget.kind) {
    case 'map':
      return <MapWidgetRender key={widget.id} widget={widget} />;
    case 'legend':
      return <LegendWidgetRender widget={widget} />;
    case 'layer-list':
      return <LayerListWidgetRender widget={widget} />;
    case 'attribute-table':
      return <AttributeTableWidgetRender widget={widget} />;
    case 'text':
      return <TextWidgetRender widget={widget} />;
    case 'chart':
      return <ChartWidgetRender widget={widget} />;
    case 'search':
      return <SearchWidgetRender widget={widget} />;
    case 'print':
      return <PrintWidgetRender widget={widget} />;
    case 'select':
      return <SelectWidgetRender widget={widget} />;
    case 'export':
      return <ExportWidgetRender widget={widget} />;
    case 'splash':
      return <SplashWidgetRender widget={widget} />;
    case 'basemap-gallery':
      return <BasemapGalleryWidgetRender widget={widget} />;
    case 'image':
      return <ImageWidgetRender widget={widget} />;
    case 'button':
      return <ButtonWidgetRender widget={widget} />;
    case 'tool':
      return <ToolWidgetRender widget={widget} />;
    case 'divider':
      return <DividerWidgetRender widget={widget} />;
    case 'embed':
      return <EmbedWidgetRender widget={widget} />;
    case 'bookmark':
      return <BookmarkWidgetRender widget={widget} />;
    case 'coordinates':
      return <CoordinatesWidgetRender widget={widget} />;
    case 'my-location':
      return <MyLocationWidgetRender widget={widget} />;
    case 'elevation-profile':
      return <ElevationProfileWidgetRender widget={widget} />;
    case 'magic-outline':
      return <MagicOutlineWidgetRender widget={widget} />;
    case 'time-slider':
      return <TimeSliderWidgetRender widget={widget} />;
    case 'create-feature':
      return <CreateFeatureWidgetRender widget={widget} />;
    case 'edit-feature':
      return <EditFeatureWidgetRender widget={widget} />;
    case 'delete-feature':
      return <DeleteFeatureWidgetRender widget={widget} />;
    case 'tabs':
      return <TabsWidgetRender widget={widget} />;
    // #92: generic container.  Renders its children inside a styled
    // region whose chrome (sticky top/bottom bar, side dock,
    // overlay drawer, inline region) is driven entirely by its
    // `position` / `variant` / `layout` / `collapsible` props.
    // Implementation in themed-containers.tsx.
    case 'container':
      return <ContainerWidgetRender widget={widget} />;
    default: {
      const _exhaustive: never = widget.kind;
      void _exhaustive;
      return null;
    }
  }
}

// ---- Map widget ------------------------------------------------------------

function MapWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.kind !== 'map') return null;
  const ctx = useContext(CustomMapsContext);
  // #87 -- read the app-time so the bound MapCanvas threads `at`
  // into every data-layer tile URL + bbox geojson fetch.  Scrubbing
  // the slider triggers a re-render here, MapCanvas's `asOfTime`
  // prop changes, and MapLibre re-fetches tiles tagged with the new
  // timestamp.
  const appAt = useAppTime();
  // #89 -- read the current edit claim for THIS map widget.  When
  // an Edit-feature widget toggles ON, it pushes its claimed layer
  // ids + click callback into ctx.editClaims[widget.id]; we forward
  // both to MapCanvas so clicks on those layers open the edit form
  // instead of the read-only popup.
  const editClaim = ctx?.editClaims[widget.id] ?? null;
  const ref = useRef<MapCanvasHandle | null>(null);
  // Register the ref ONCE on mount so sibling widgets can use it
  // for fly-to. Re-registering on every render is harmless (same
  // ref object) but unnecessary.
  useEffect(() => {
    if (ctx) ctx.registerRef(widget.id, ref as RefObject<MapCanvasHandle>);
  }, [ctx, widget.id]);

  if (!ctx) return null;
  const state = ctx.states[widget.id];
  if (!state) return null;

  return (
    <div className="relative h-full w-full">
      <MapCanvas
        ref={ref}
        map={state.mapData}
        basemaps={ctx.basemaps}
        selection={state.selection}
        selectTool={state.selectTool}
        onCameraChange={(next) =>
          ctx.update(widget.id, (cur) => ({
            ...cur,
            mapData: { ...cur.mapData, ...next },
          }))
        }
        onSelectionChange={(next) =>
          ctx.update(widget.id, (cur) => ({ ...cur, selection: next }))
        }
        // #361 part 2: surface the live MapLibre Map up to the
        // runtime context so sibling widgets (Coordinates, Bookmark,
        // MyLocation) can subscribe to events / addSource / flyTo
        // imperatively without prop-drilling.
        onMapReady={(map) => ctx.registerMap(widget.id, map)}
        suppressPopup={ctx.popupSuppressed[widget.id] ?? false}
        hideNavigationControl={
          widget.config.kind === 'map' && widget.config.showNavigation === false
        }
        asOfTime={appAt}
        {...(editClaim
          ? {
              editClaimedLayerIds: editClaim.layerIds,
              onEditClaimedClick: editClaim.onClick,
            }
          : {})}
      />
    </div>
  );
}

// ---- LayerList widget ------------------------------------------------------

function LayerListWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'layer-list') return null;
  const { state, update, flyTo } = useBoundMap(widget.config.mapWidgetId);
  const allowToggle = widget.config.allowToggle !== false;
  const layers = state?.mapData.layers ?? [];

  // #145: kebab-menu action handlers. All session-scoped: changes
  // never persist back to the underlying map item, which is what
  // the runtime requires for anonymous-viewer support and for the
  // shared-map-item case where one viewer's restyle shouldn't
  // affect everyone else.

  // Zoom to layer extent. For inline FCs we can compute the bbox
  // locally; for other source kinds we'd need a server query, so
  // we silently no-op until that path is wired.
  const onZoomToLayer = useCallback(
    (layer: MapLayer) => {
      if (layer.source.kind !== 'geojson-inline') return;
      const fc = layer.source.geojson as GeoJSON.FeatureCollection | null;
      if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) return;
      const bb = bboxOfFeatures(fc.features);
      if (!bb) return;
      // bboxOfFeatures returns [[w,s],[e,n]]; flyTo expects flat
      // [w,s,e,n]. Unpack accordingly.
      flyTo([bb[0][0], bb[0][1], bb[1][0], bb[1][1]]);
    },
    [flyTo],
  );

  // Remove the layer from the bound map's state. Only allowed for
  // ephemeral layers (geojson-inline today; future arcgis-rest /
  // wms layers added at runtime could also qualify). The kebab UI
  // already hides Remove for non-ephemeral layers; this is a
  // belt-and-suspenders guard.
  const onRemoveLayer = useCallback(
    (id: string) => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.source.kind !== 'geojson-inline') return;
      update((cur) => ({
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: (cur.mapData.layers ?? []).filter((l) => l.id !== id),
        },
      }));
    },
    [layers, update],
  );

  // Session-only style patch. The bound map's mapData is already a
  // React-state copy that never persists back to the underlying map
  // item: ctx.update mutates the in-memory snapshot only. So passing
  // a style patch through update() satisfies the #145 "session-only"
  // constraint by construction -- nothing leaks back to the saved
  // map. A page reload resets the style to whatever the map item
  // ships with, which is the intended behavior.
  const onPatchLayerStyle = useCallback(
    (id: string, style: MapLayerStyle) => {
      update((cur) => ({
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: (cur.mapData.layers ?? []).map((l) =>
            l.id === id ? { ...l, style } : l,
          ),
        },
      }));
    },
    [update],
  );

  // Trigger a client-side download of the layer's features in the
  // chosen format. Currently scoped to inline-FC layers; data-layer
  // / arcgis-rest sources would need a fetch path that we can add
  // when needed.
  const onExportLayer = useCallback(
    (layer: MapLayer, format: ClientExportFormat) => {
      if (layer.source.kind !== 'geojson-inline') return;
      const fc = layer.source.geojson as GeoJSON.FeatureCollection | null;
      if (!fc || !Array.isArray(fc.features)) return;
      // Filename: layer title scrubbed for filesystem safety. Empty
      // results in a short fallback so the user still gets a file.
      const safe =
        layer.title
          .replace(/[^A-Za-z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 80) || 'layer';
      // GeoJSON.Feature['id'] is string | number | undefined; the
      // exporter's ExportFeature uses an optional `id?: string` with
      // exactOptionalPropertyTypes (no undefined values allowed).
      // Conditionally spread the id only when it's a string.
      const normalised: ExportFeature[] = fc.features.map((f) => ({
        ...(typeof f.id === 'string' && f.id ? { id: f.id } : {}),
        geometry: f.geometry,
        properties: f.properties,
      }));
      void exportFeatures(normalised, format, {
        filename: safe,
        // Schema-declared fields don't exist for an inline FC. The
        // exporter falls back to first-seen property iteration order
        // which is the right shape for OSM tag bags.
        includeGeometryWkt: format === 'xlsx',
      });
    },
    [],
  );

  // #112: layer groups (source.kind === 'group') were rendering
  // as siblings of their children instead of as parent rows that
  // contain them.  Build a parent->children index so we can
  // render the tree.  Top-level rows are layers whose groupId is
  // undefined OR whose groupId doesn't resolve to an existing
  // layer (orphans -- the group was deleted -- fall back to top
  // level rather than disappear).
  const layerById = useMemo(() => {
    const m = new Map<string, MapLayer>();
    for (const l of layers) m.set(l.id, l);
    return m;
  }, [layers]);

  const rootLayers = useMemo(
    () =>
      layers.filter((l) => !l.groupId || !layerById.has(l.groupId)),
    [layers, layerById],
  );

  const childrenByParent = useMemo(() => {
    const m = new Map<string, MapLayer[]>();
    for (const l of layers) {
      if (!l.groupId) continue;
      if (!layerById.has(l.groupId)) continue;
      const bucket = m.get(l.groupId) ?? [];
      bucket.push(l);
      m.set(l.groupId, bucket);
    }
    return m;
  }, [layers, layerById]);

  const toggleVisible = useCallback(
    (id: string, next: boolean) => {
      // Cascading toggle: flipping a group OFF hides every
      // descendant; flipping a group ON shows the group itself
      // but does NOT force every child back on (the children
      // remember their own visibility state).  That mirrors how
      // the map item's layer panel behaves and matches what users
      // expect from "turn the whole flood overlay off, then back
      // on" -- the floods don't all suddenly become visible if
      // some were hidden before.
      const affected = new Set<string>([id]);
      if (next === false) {
        // Walk descendants and turn them off too.
        const stack = [id];
        while (stack.length > 0) {
          const parent = stack.pop()!;
          for (const child of childrenByParent.get(parent) ?? []) {
            if (affected.has(child.id)) continue;
            affected.add(child.id);
            stack.push(child.id);
          }
        }
      }
      update((cur) => ({
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: (cur.mapData.layers ?? []).map((x) =>
            affected.has(x.id) ? { ...x, visible: next } : x,
          ),
        },
      }));
    },
    [childrenByParent, update],
  );

  return (
    <WidgetFrame icon={LayersIcon} title="Layers">
      {!state ? (
        <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">No bound map.</p>
      ) : layers.length === 0 ? (
        <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">No layers.</p>
      ) : (
        <ul className="space-y-0.5 p-1.5">
          {rootLayers.map((l) => (
            <LayerListRow
              key={l.id}
              layer={l}
              childrenByParent={childrenByParent}
              allowToggle={allowToggle}
              depth={0}
              onToggle={toggleVisible}
              onZoomToLayer={onZoomToLayer}
              onRemoveLayer={onRemoveLayer}
              onExportLayer={onExportLayer}
              onPatchLayerStyle={onPatchLayerStyle}
            />
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

/**
 * Geometry-aware legend swatch. Picks the dominant paint for the
 * layer from its renderer + style:
 *
 *   - unique-values renderer: tile of the first 2-3 categories'
 *     colors so the legend hints at the categorization.
 *   - class-breaks renderer: tile of the first / mid / last stop
 *     so the swatch reads as a gradient ramp.
 *   - simple renderer + polygon source: filled rectangle in
 *     polygon.fillColor at polygon.fillOpacity, bordered with
 *     polygon.strokeColor at the actual stroke width. Correctly
 *     shows outline-only polygons (e.g. parcels) as hollow.
 *   - simple renderer + line source: horizontal line in
 *     line.color at line.width.
 *   - simple renderer + point source: filled circle in
 *     point.color, bordered with point.strokeColor.
 *
 * Without an explicit geometry hint on MapLayer (the engine knows
 * but doesn't surface it on the MapLayer envelope), we infer from
 * which style branch carries non-default-looking values. For
 * the WV Parcels case (polygon outline-only) the polygon branch
 * is the one with the colors author actually set, so it wins. The
 * helper falls back to a polygon-style swatch for service layers
 * (arcgis-rest, etc.) because most service layers are polygons in
 * the wild and the swatch still reads correctly even if the
 * upstream renderer overrides our local style.
 */
function LegendSwatch({ layer }: { layer: MapLayer }) {
  const r = layer.renderer;
  // Multi-category renderers: render a small palette of stops.
  if (r?.kind === 'unique-values' && r.categories.length > 0) {
    const cats = r.categories.slice(0, 3);
    return (
      <span
        aria-hidden
        className="inline-flex h-3 w-3 shrink-0 overflow-hidden rounded-sm border border-[hsl(var(--app-border))]"
      >
        {cats.map((c, i) => (
          <span
            key={i}
            className="block h-full flex-1"
            style={{ backgroundColor: c.color }}
          />
        ))}
      </span>
    );
  }
  if (r?.kind === 'class-breaks' && r.colors.length >= 2) {
    const stops = [r.colors[0], r.colors[Math.floor(r.colors.length / 2)], r.colors[r.colors.length - 1]];
    return (
      <span
        aria-hidden
        className="inline-flex h-3 w-3 shrink-0 overflow-hidden rounded-sm border border-[hsl(var(--app-border))]"
      >
        {stops.map((c, i) => (
          <span
            key={i}
            className="block h-full flex-1"
            style={{ backgroundColor: c ?? '#999' }}
          />
        ))}
      </span>
    );
  }

  // Simple renderer (or no renderer): pick a swatch from the
  // style branch that has authored values.
  const poly = layer.style?.polygon;
  const line = layer.style?.line;
  const point = layer.style?.point;

  // Polygon-style swatch: filled square at fillOpacity, bordered
  // in strokeColor. Handles outline-only polygons (fillOpacity=0)
  // as a hollow square that reads as "outline only".
  if (poly) {
    const fill = poly.fillColor ?? 'transparent';
    const fillOpacity = typeof poly.fillOpacity === 'number' ? poly.fillOpacity : 1;
    const stroke = poly.strokeColor ?? '#000';
    const borderWidth = Math.max(1, Math.min(2, poly.strokeWidth ?? 1));
    return (
      <span
        aria-hidden
        className="inline-block h-3 w-3 shrink-0 rounded-sm"
        style={{
          backgroundColor: rgbaWithOpacity(fill, fillOpacity),
          border: `${borderWidth}px solid ${stroke}`,
        }}
      />
    );
  }
  if (line) {
    return (
      <span
        aria-hidden
        className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
      >
        <span
          className="block w-full"
          style={{
            height: `${Math.max(1, Math.min(3, line.width ?? 1))}px`,
            backgroundColor: line.color ?? '#000',
          }}
        />
      </span>
    );
  }
  if (point) {
    return (
      <span
        aria-hidden
        className="inline-block h-3 w-3 shrink-0 rounded-full"
        style={{
          backgroundColor: point.color ?? '#6366f1',
          border: `1px solid ${point.strokeColor ?? '#000'}`,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 rounded-sm border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-2))]"
    />
  );
}

/**
 * Composite a fill color + opacity into an rgba/css value the
 * swatch <span> can render as `backgroundColor`. Hex inputs become
 * `rgba(r,g,b,opacity)`; anything else (rgb / hsl / named) gets the
 * opacity composed via CSS `color-mix` so the swatch dims
 * correctly even for inputs we don't hex-parse. Falls back to the
 * raw input on the older browsers that lack color-mix; the swatch
 * will be slightly off in opacity but won't break.
 */
function rgbaWithOpacity(color: string, opacity: number): string {
  if (opacity >= 0.99) return color;
  if (opacity <= 0.01) return 'transparent';
  const hex = color.trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const v = parseInt(m[1]!, 16);
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;
}

/**
 * Recursive row renderer for the LayerList widget.  Groups paint
 * a chevron + title (no swatch); leaves paint a checkbox + swatch
 * + title.  Indentation comes from `depth` so the visual hierarchy
 * matches the data hierarchy.
 *
 * Collapse state lives locally per group (defaultOpen on first
 * render).  We don't persist it: the LayerList is short-lived UI
 * and re-expanding on next open is fine.
 */
function LayerListRow({
  layer,
  childrenByParent,
  allowToggle,
  depth,
  onToggle,
  onZoomToLayer,
  onRemoveLayer,
  onExportLayer,
  onPatchLayerStyle,
}: {
  layer: MapLayer;
  childrenByParent: Map<string, MapLayer[]>;
  allowToggle: boolean;
  depth: number;
  onToggle: (id: string, next: boolean) => void;
  /** #145: kebab-menu action handlers. All session-scoped. */
  onZoomToLayer: (layer: MapLayer) => void;
  onRemoveLayer: (id: string) => void;
  onExportLayer: (layer: MapLayer, format: ClientExportFormat) => void;
  onPatchLayerStyle: (id: string, style: MapLayerStyle) => void;
}) {
  const isGroup = layer.source.kind === 'group';
  const children = isGroup ? childrenByParent.get(layer.id) ?? [] : [];
  const [open, setOpen] = useState(true);
  // px-per-level indent.  10px nests visibly without burning
  // horizontal room in a narrow dock-panel.
  const indent = depth * 10;
  return (
    <li>
      <div
        className="group flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-[hsl(var(--app-surface-2))]"
        style={{ paddingLeft: `${6 + indent}px` }}
      >
        {isGroup ? (
          <button
            type="button"
            aria-label={open ? 'Collapse group' : 'Expand group'}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))]"
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : (
          // Spacer so leaves align with sibling groups' titles.
          <span className="inline-block h-4 w-4 shrink-0" aria-hidden />
        )}
        <input
          type="checkbox"
          checked={layer.visible !== false}
          disabled={!allowToggle}
          onChange={(e) => onToggle(layer.id, e.target.checked)}
          className="h-3 w-3"
        />
        {isGroup ? (
          // Groups don't get a swatch -- they're containers, not a
          // single symbology.  A folder-style spacer keeps the
          // text alignment consistent with leaf rows.
          <span className="inline-block h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <LegendSwatch layer={layer} />
        )}
        <span
          className={`flex-1 truncate ${isGroup ? 'font-medium text-[hsl(var(--app-ink-0))]' : 'text-[hsl(var(--app-ink-1))]'}`}
          title={layer.title}
        >
          {layer.title}
        </span>
        {/* #145: kebab menu. Hidden on groups (no actions make sense
            on a pure UI container) and otherwise appears on row
            hover to keep the panel quiet at rest. */}
        {!isGroup ? (
          <LayerRowKebabMenu
            layer={layer}
            onZoomToLayer={onZoomToLayer}
            onRemoveLayer={onRemoveLayer}
            onExportLayer={onExportLayer}
            onPatchLayerStyle={onPatchLayerStyle}
          />
        ) : null}
      </div>
      {isGroup && open && children.length > 0 ? (
        <ul className="space-y-0.5">
          {children.map((c) => (
            <LayerListRow
              key={c.id}
              layer={c}
              childrenByParent={childrenByParent}
              allowToggle={allowToggle}
              depth={depth + 1}
              onToggle={onToggle}
              onZoomToLayer={onZoomToLayer}
              onRemoveLayer={onRemoveLayer}
              onExportLayer={onExportLayer}
              onPatchLayerStyle={onPatchLayerStyle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * #145: per-row kebab menu in the LayerList. Sits at the trailing
 * edge of each row, fades in on hover so the panel reads quiet at
 * rest. Click opens a small popover at the button's bottom-right.
 *
 * Items (only shown for actions that make sense for the layer's
 * source kind):
 *   - Zoom to layer extent (geojson-inline only for v1; data-layer
 *     extent needs a server query that hasn't been wired here yet)
 *   - Export -> submenu: GeoJSON / CSV / XLSX (inline only)
 *   - Properties (always available; small dialog with source kind,
 *     feature count, visibility, opacity)
 *   - Remove from map (ephemeral layers only; geojson-inline today)
 *
 * Closes on outside click and Escape. The popover is fixed-position
 * relative to the viewport so it doesn't get clipped by the
 * LayerList widget's overflow:hidden.
 */
function LayerRowKebabMenu({
  layer,
  onZoomToLayer,
  onRemoveLayer,
  onExportLayer,
  onPatchLayerStyle,
}: {
  layer: MapLayer;
  onZoomToLayer: (layer: MapLayer) => void;
  onRemoveLayer: (id: string) => void;
  onExportLayer: (layer: MapLayer, format: ClientExportFormat) => void;
  onPatchLayerStyle: (id: string, style: MapLayerStyle) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [symbologyOpen, setSymbologyOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  // Eligibility per-action. Inline FCs get the full set; non-inline
  // (data-layer, arcgis-rest, wms, etc) get Symbology + Properties
  // since those don't need a feature fetch.  Zoom-to-extent and
  // Export for non-inline sources are filed as follow-ups (need a
  // server-side bbox / paginated feature fetch path).
  const isInline = layer.source.kind === 'geojson-inline';
  const canZoom = isInline;
  const canExport = isInline;
  const canRemove = isInline;
  // Symbology is available for every leaf layer regardless of
  // source kind -- StyleEditor is pure (value, onChange) and the
  // session-only contract means the bound map's mapData stays
  // private to this runtime instance.  Group layers are caught at
  // the LayerListRow level (kebab is hidden for groups).
  const canSymbology = true;

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
        setPos(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setPos(null);
      }
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    setPos({ x: rect.right, y: rect.bottom });
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
    setPos(null);
  }

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={openMenu}
        aria-label={`Actions for ${layer.title}`}
        title="More actions"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-[hsl(var(--app-muted))] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[hsl(var(--app-surface-1))] hover:text-[hsl(var(--app-ink-1))]"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {menuOpen && pos ? (
        <div
          role="menu"
          aria-label={`Actions for ${layer.title}`}
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            zIndex: 50,
            // Right-edge align: menu opens to the LEFT of the button
            // so a kebab at the right edge of a narrow LayerList
            // doesn't overflow the viewport.
            transform: 'translateX(-100%)',
          }}
          className="min-w-[180px] overflow-hidden rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] py-1 text-xs shadow-raised"
        >
          {canZoom ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onZoomToLayer(layer);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
            >
              <ZoomInIcon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
              Zoom to layer
            </button>
          ) : null}
          {canExport ? (
            // #145 follow-up: inline the three format choices as
            // top-level menu items instead of a nested submenu.
            // The original submenu was nested inside an
            // overflow:hidden parent (carried over from the
            // folder-row-menu pattern) which clipped the submenu
            // invisibly, so clicking Export "did nothing" from the
            // user's view. Inlining sidesteps the clipping AND
            // saves a click; the menu's still short enough to read
            // cleanly without the grouping.
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onExportLayer(layer, 'geojson');
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
              >
                <Download className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
                Export as GeoJSON
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onExportLayer(layer, 'csv');
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
              >
                <Download className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
                Export as CSV
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onExportLayer(layer, 'xlsx');
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
              >
                <Download className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
                Export as Excel (.xlsx)
              </button>
            </>
          ) : null}
          {canSymbology ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                setSymbologyOpen(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
            >
              <Palette className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
              Symbology...
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              setPropsOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
          >
            <InfoIcon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
            Properties
          </button>
          {canRemove ? (
            <>
              <div className="my-1 border-t border-[hsl(var(--app-border))]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onRemoveLayer(layer.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[hsl(var(--app-danger))] hover:bg-[hsl(var(--app-danger)/0.05)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove from map
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {propsOpen ? (
        <LayerPropertiesDialog
          layer={layer}
          onClose={() => setPropsOpen(false)}
        />
      ) : null}
      {symbologyOpen ? (
        <SessionSymbologyDialog
          layer={layer}
          onPatchStyle={(style) => onPatchLayerStyle(layer.id, style)}
          onClose={() => setSymbologyOpen(false)}
        />
      ) : null}
    </span>
  );
}

/**
 * #145 wave 2: session-only symbology editor.  Wraps the existing
 * StyleEditor in a modal and routes its onChange through the bound
 * map's update() (via onPatchStyle) so every keystroke / color tweak
 * applies to the in-memory snapshot only.  No POST back to the map
 * item.  A page reload resets the style; "Reset" snaps to whatever
 * the layer's style was when the dialog opened so the user can
 * recover from a bad experiment without losing their place.
 *
 * Geometry-family inference: for an inline FeatureCollection we can
 * derive the families synchronously from the features. For other
 * source kinds we pass undefined so StyleEditor shows all three
 * sections (point / line / polygon); harmless when the layer only
 * really uses one but means the user sees more controls than
 * strictly necessary. Could be tightened later by hoisting the
 * AttributeTable widget's metadata into the runtime ctx.
 */
function SessionSymbologyDialog({
  layer,
  onPatchStyle,
  onClose,
}: {
  layer: MapLayer;
  onPatchStyle: (style: MapLayerStyle) => void;
  onClose: () => void;
}) {
  // Snapshot the original style on open so Reset can restore it.
  // structuredClone keeps the snapshot independent of any later
  // mutations; we never want Reset to roll back to a CURRENT value.
  const originalRef = useRef<MapLayerStyle>(structuredClone(layer.style));

  // Geometry families: derive from inline FC when available so
  // StyleEditor only shows the relevant section(s); fall back to
  // "show everything" for opaque source kinds.
  const geometryTypes = useMemo<Set<GeometryFamily> | undefined>(() => {
    if (layer.source.kind === 'geojson-inline') {
      const fc = layer.source.geojson as GeoJSON.FeatureCollection | null;
      if (fc) return metadataFromFeatureCollection(fc).geometryTypes;
    }
    return undefined;
  }, [layer.source]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Symbology for ${layer.title}`}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)]"
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--app-border))] px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[hsl(var(--app-ink-0))]">
              Symbology
            </h3>
            <p className="truncate text-2xs text-[hsl(var(--app-muted))]">{layer.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))]"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <p className="border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-warn)/0.1)] px-4 py-2 text-2xs text-[hsl(var(--app-warn))]">
          Changes apply to this session only. Refresh the page to
          reset to the saved style.
        </p>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <StyleEditor
            value={layer.style}
            onChange={onPatchStyle}
            {...(geometryTypes ? { geometryTypes } : {})}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--app-border))] px-4 py-3">
          <button
            type="button"
            onClick={() => onPatchStyle(structuredClone(originalRef.current))}
            className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[hsl(var(--app-accent))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--app-accent-ink))] shadow-[var(--app-shadow-card)] hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only properties dialog for a runtime layer (#145). Shows
 * the title, source description, feature count when an inline FC
 * is available, current visibility + opacity, and a one-line
 * "session only" disclaimer so the user knows changes from this
 * menu's symbology editor (when it lands) won't leak back to the
 * underlying map item.
 */
function LayerPropertiesDialog({
  layer,
  onClose,
}: {
  layer: MapLayer;
  onClose: () => void;
}) {
  const featureCount =
    layer.source.kind === 'geojson-inline'
      ? (layer.source.geojson as GeoJSON.FeatureCollection | null)?.features
          ?.length ?? 0
      : null;
  const sourceLabel = describeSourceKind(layer.source.kind);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${layer.title} properties`}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-lg border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)]"
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--app-border))] px-4 py-3">
          <h3 className="text-sm font-semibold text-[hsl(var(--app-ink-0))]">
            {layer.title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))]"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-xs">
          <dt className="text-[hsl(var(--app-muted))]">Source</dt>
          <dd className="text-[hsl(var(--app-ink-1))]">{sourceLabel}</dd>
          {featureCount !== null ? (
            <>
              <dt className="text-[hsl(var(--app-muted))]">Features</dt>
              <dd className="text-[hsl(var(--app-ink-1))]">
                {featureCount.toLocaleString()}
              </dd>
            </>
          ) : null}
          <dt className="text-[hsl(var(--app-muted))]">Visible</dt>
          <dd className="text-[hsl(var(--app-ink-1))]">
            {layer.visible === false ? 'No' : 'Yes'}
          </dd>
          <dt className="text-[hsl(var(--app-muted))]">Opacity</dt>
          <dd className="text-[hsl(var(--app-ink-1))]">
            {Math.round(((layer.opacity ?? 1) as number) * 100)}%
          </dd>
        </dl>
        <p className="border-t border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-4 py-2 text-2xs italic text-[hsl(var(--app-muted))]">
          Properties shown here are session-only. Refreshing the
          page resets them.
        </p>
      </div>
    </div>
  );
}

/** Human-readable label for a MapLayerSource['kind']. */
function describeSourceKind(kind: string): string {
  switch (kind) {
    case 'data-layer':
      return 'Portal data layer';
    case 'geojson-inline':
      return 'In-memory features';
    case 'geojson-url':
      return 'GeoJSON URL';
    case 'arcgis-rest':
      return 'ArcGIS REST service';
    case 'wms-service':
      return 'WMS service';
    case 'wfs-service':
      return 'WFS service';
    case 'group':
      return 'Layer group';
    default:
      return kind;
  }
}

// ---- Legend widget ---------------------------------------------------------

function LegendWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'legend') return null;
  const { state } = useBoundMap(widget.config.mapWidgetId);
  return (
    <WidgetFrame icon={ListTree} title="Legend">
      {!state ? (
        <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">No bound map.</p>
      ) : (
        <ul className="space-y-1 p-2">
          {(state.mapData.layers ?? [])
            .filter((l) => l.visible !== false)
            .map((l) => (
              <li
                key={l.id}
                className="flex items-center gap-2 text-xs text-[hsl(var(--app-ink-1))]"
              >
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full border border-[hsl(var(--app-border))]"
                  style={{
                    backgroundColor:
                      l.style?.point?.color ??
                      l.style?.line?.color ??
                      l.style?.polygon?.fillColor ??
                      '#6366f1',
                  }}
                />
                <span className="truncate" title={l.title}>
                  {l.title}
                </span>
              </li>
            ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

// ---- BasemapGallery widget -------------------------------------------------

function BasemapGalleryWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'basemap-gallery') return null;
  const { state, update, basemaps } = useBoundMap(widget.config.mapWidgetId);
  // Bind to a local so the narrowed type carries into the filter closure.
  const explicitIds = widget.config.basemapIds;
  const visibleBasemaps =
    Array.isArray(explicitIds) && explicitIds.length > 0
      ? basemaps.filter((b) => explicitIds.includes(b.id))
      : basemaps;
  const activeId = state?.mapData.basemap ?? '';
  return (
    <WidgetFrame icon={ImageIcon} title="Basemaps">
      {visibleBasemaps.length === 0 ? (
        <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">No basemaps available.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 p-2">
          {visibleBasemaps.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() =>
                  update((cur) => ({
                    ...cur,
                    mapData: { ...cur.mapData, basemap: b.id },
                  }))
                }
                className={`flex w-full flex-col items-stretch gap-1 rounded-md border-2 p-1 text-left text-2xs transition ${
                  activeId === b.id
                    ? 'border-[hsl(var(--app-accent))] bg-[hsl(var(--app-accent)/0.05)]'
                    : 'border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] hover:border-[hsl(var(--app-accent)/0.4)]'
                }`}
                title={b.label}
              >
                {/* #67: always render a live MapLibre preview of
                    the basemap.  The picker exists so users can
                    pick by appearance, which is a different consumer
                    context from the item card; deferring to the
                    item's thumbnailUrl (which #66 made point at the
                    designer-grammar SVG) defeats the whole purpose
                    of the picker.  Live previews are also cheap
                    enough at gallery scale -- a handful of small
                    MapLibre canvases, only mounted while the
                    picker is open. */}
                <div className="h-12 w-full overflow-hidden rounded">
                  <BasemapPreview
                    data={customBasemapToData(b)}
                    ariaLabel={`Preview of ${b.label}`}
                    className="h-full w-full"
                  />
                </div>
                <span className="truncate text-[hsl(var(--app-ink-1))]">{b.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

// ---- Search widget ---------------------------------------------------------

/**
 * Custom Web App search tool. Delegates to the same SearchBar
 * component the map editor uses, so the popover honors every
 * setting the author already configured on the bound map item:
 *
 *   - The map's Search Source (`map.search.geocoderId`) drives
 *     which geocoder runs.  Unset and `search.geocoding === true`
 *     falls back to Nominatim through /api/geocode.
 *     `search.geocoding === false` disables the address half
 *     entirely.
 *   - Each layer's Searchable interaction (`layer.search.enabled`
 *     + `fields` + `labelTemplate`) drives attribute search.
 *     Local layer search runs over the in-memory feature cache;
 *     ArcGIS REST layers are queried server-side; v3 data layers
 *     don't pre-warm in the Custom App runtime (no local cache),
 *     same as the AttributeTable widget.
 *   - The widget's own `geocodingEnabled === false` is treated as
 *     an explicit override that forces geocoding off even when
 *     the map allows it; absent or true inherits the map's
 *     setting.
 *
 * The previous implementation hand-rolled a /api/geocode probe
 * that ignored all of the above (and 404'd in deployments where
 * the route wasn't reachable from the runtime context); using
 * SearchBar fixes the 404 and gives the popover the rich
 * candidate list with grouped sections + keyboard nav.
 */
function SearchWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'search') return null;
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);
  const mapWidgetId = cfg.mapWidgetId;
  const boundMapState = mapWidgetId ? ctx?.states[mapWidgetId] ?? null : null;
  const boundMapInstance = mapWidgetId ? ctx?.maps[mapWidgetId] ?? null : null;

  // Live viewport bbox so a configured geocoder can scope its
  // similarity scan to what the user is looking at.  Same moveend
  // pattern AttributeTableWidget uses; nullable until the map's
  // first idle.
  const [viewportBbox, setViewportBbox] = useState<
    [number, number, number, number] | null
  >(null);
  useEffect(() => {
    if (!boundMapInstance) {
      setViewportBbox(null);
      return;
    }
    const update = () => {
      const b = boundMapInstance.getBounds();
      setViewportBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    update();
    boundMapInstance.on('moveend', update);
    return () => {
      boundMapInstance.off('moveend', update);
    };
  }, [boundMapInstance]);

  // Local feature cache: v3 data layers don't pre-warm in the
  // Custom App runtime, ArcGIS REST layers are queried server-
  // side via SearchBar's searchArcgisLayers path, and the
  // geocoder paths don't read the cache at all.  We DO populate
  // it for `geojson-inline` sources so SearchBar can match against
  // OSM tool-run results (#141) and any other inline layer.
  const featuresByLayer = useMemo<
    Record<string, GeoJSON.FeatureCollection | null>
  >(() => {
    const out: Record<string, GeoJSON.FeatureCollection | null> = {};
    const ls = boundMapState?.mapData.layers ?? [];
    for (const l of ls) {
      if (l.source.kind === 'geojson-inline') {
        const fc = l.source.geojson as GeoJSON.FeatureCollection | null;
        if (
          fc &&
          typeof fc === 'object' &&
          'type' in fc &&
          fc.type === 'FeatureCollection'
        ) {
          out[l.id] = fc;
        }
      }
    }
    return out;
  }, [boundMapState]);

  if (!boundMapState || !mapWidgetId) {
    return (
      <WidgetFrame icon={SearchIcon} title="Search">
        <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">
          Bind to a Map widget to enable.
        </p>
      </WidgetFrame>
    );
  }

  const mapSearch = boundMapState.mapData.search;
  // Widget override beats inheritance only when it's an explicit
  // false; otherwise the map's setting wins (and the map defaults
  // geocoding on).
  const geocodingEnabled =
    cfg.geocodingEnabled !== false && mapSearch?.geocoding !== false;
  const geocoderItemId = mapSearch?.geocoderId;

  return (
    <WidgetFrame icon={SearchIcon} title="Search">
      <div className="p-2">
        <SearchBar
          embedded
          layers={boundMapState.mapData.layers}
          featuresByLayer={featuresByLayer}
          geocodingEnabled={geocodingEnabled}
          {...(geocoderItemId ? { geocoderItemId } : {})}
          viewportBbox={viewportBbox}
          onPick={(r) => {
            if (!ctx) return;
            if (r.bbox) {
              ctx.flyTo(mapWidgetId, r.bbox);
              return;
            }
            if (r.center) {
              // Small box around the center so flyTo gets a real
              // bbox.  Matches what the old probe did for bare
              // lat/lon hits.
              const [lng, lat] = r.center;
              const d = 0.01;
              ctx.flyTo(mapWidgetId, [lng - d, lat - d, lng + d, lat + d]);
            }
          }}
        />
      </div>
    </WidgetFrame>
  );
}

// ---- Print widget ----------------------------------------------------------

/**
 * #101: Print widget.  Renders a template picker + parameter form
 * + recent-result list.  Talks to the server `/print/render`
 * endpoint which produces a PDF for download.  Falls back to the
 * legacy "browser print" button when the user's org has no
 * print_template items accessible (eg fresh org pre-bootstrap, or
 * an admin deleted them all).
 */
function PrintWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'print') return null;
  const { state } = useBoundMap(widget.config.mapWidgetId);
  // #106: live MapLibre handle for the bound map, so onRender can
  // grab a PNG snapshot of what the user is currently looking at
  // and feed it to the print page's map element.  Without this the
  // print page falls back to the v1 "Map (followup)" placeholder
  // because rendering a real MapLibre at print size on a fresh
  // page is its own project (correct basemap, layer styles, idle
  // wait, etc.).  Snapshotting the live map ships an immediate,
  // user-recognizable print today and a higher-res off-screen
  // re-render can land as polish later.
  const printCtx = useContext(CustomMapsContext);
  const liveMapForPrint =
    widget.config.kind === 'print' && widget.config.mapWidgetId
      ? printCtx?.maps?.[widget.config.mapWidgetId] ?? null
      : null;
  type TemplateSummary = {
    id: string;
    title: string;
    description: string | null;
    data: PrintTemplateData;
  };
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [selected, setSelected] = useState<TemplateSummary | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [results, setResults] = useState<
    { url: string; templateTitle: string; createdAt: number }[]
  >([]);

  // Per-app template allowlist.  When the author has configured a
  // specific set in the Print widget's properties, restrict the
  // runtime dropdown to those.  Empty / unset falls back to
  // "every template the user can read" -- useful for orgs that
  // haven't curated yet.
  const configuredIds =
    widget.config.kind === 'print' ? widget.config.templateIds ?? [] : [];
  const configuredKey = configuredIds.join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Two fetch paths:
        //
        //   1. Per-id fetch when the Print widget has an explicit
        //      templateIds allowlist. /api/portal/items/:id is in
        //      the BFF's anonymous-allowlist, so anon viewers of a
        //      public app can resolve each configured template that
        //      itself is access='public'. The previous shape (list
        //      query) 401'd at the BFF for anon, so the WV Parcel
        //      Viewer's Print tool showed no templates and silently
        //      fell back to the browser print dialog.
        //
        //   2. List fetch when no allowlist is configured. Used by
        //      authors / org members who want the dropdown to show
        //      everything they can read. Still 401s for anon, but
        //      an unconfigured Print widget on a public app isn't a
        //      sensible shape -- author should configure the
        //      allowlist if they want anon support.
        const rows: Array<{
          id: string;
          title: string;
          description: string | null;
          data: PrintTemplateData;
        }> = [];
        if (configuredIds.length > 0) {
          const settled = await Promise.allSettled(
            configuredIds.map((id) =>
              fetch(`/api/portal/items/${id}`, { cache: 'no-store' }).then(
                async (r) => {
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  return r.json();
                },
              ),
            ),
          );
          for (const s of settled) {
            if (s.status === 'fulfilled' && s.value) rows.push(s.value);
          }
        } else {
          const res = await fetch(
            '/api/portal/items?type=print_template',
            { cache: 'no-store' },
          );
          if (!res.ok) {
            setTemplates([]);
            return;
          }
          // The items list endpoint returns an array directly (not a
          // wrapped { items: [...] } envelope).  Parsing it as a
          // wrapped object was why the dropdown showed empty even
          // when 5+ templates were seeded.
          const arr = (await res.json()) as typeof rows;
          rows.push(...arr);
        }
        if (cancelled) return;
        let tt: TemplateSummary[] = rows.map((it) => ({
          id: it.id,
          title: it.title,
          description: it.description,
          data: it.data,
        }));
        // Apply the per-app allowlist.  Preserves the author's
        // declared order so the dropdown reads top-down as
        // configured, not in items-list default order.
        if (configuredIds.length > 0) {
          const allowed = new Set(configuredIds);
          const byId = new Map(tt.map((t) => [t.id, t]));
          tt = configuredIds
            .filter((id) => allowed.has(id) && byId.has(id))
            .map((id) => byId.get(id)!)
            .filter(Boolean);
        }
        setTemplates(tt);
        // If only one accessible template, pre-select it.
        if (tt.length === 1) {
          setSelected(tt[0] ?? null);
        }
      } catch {
        if (!cancelled) setTemplates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configuredKey]);

  // Reset parameter values to template defaults whenever the
  // selected template changes.
  useEffect(() => {
    if (!selected) {
      setValues({});
      return;
    }
    const v: Record<string, string> = {};
    for (const p of selected.data.parameters) {
      v[p.id] = p.defaultValue ?? '';
    }
    setValues(v);
  }, [selected]);

  // #101 v1: client-side print page.  Opens a new tab at
  // /print/<templateId>?values=<encoded>&mapWidgetId=<id> that
  // renders the template with the user's values + the current
  // map at its current scale.  The page auto-triggers the
  // browser's Print dialog so the user saves as PDF.  Avoids
  // server-side Playwright dependency for the first cut; a real
  // server-render path with map rasterization is a followup.
  const onRender = useCallback(() => {
    if (!selected) return;
    setRendering(true);
    setRenderError(null);
    try {
      const params = new URLSearchParams();
      params.set('values', JSON.stringify(values));
      const mapWidgetId =
        widget.config.kind === 'print' ? widget.config.mapWidgetId : '';
      if (mapWidgetId) params.set('mapWidgetId', mapWidgetId);

      // #106: capture a PNG snapshot of the bound map's live
      // canvas so the print page can render real map content
      // inside its map element instead of the v1 placeholder.
      // We force a synchronous re-render first (`triggerRepaint`
      // + a microtask wait would be nicer but isn't possible from
      // a sync onClick), then read the canvas.  preserveDrawing-
      // Buffer is now true on MapCanvas (see its init block) so
      // the PNG isn't blank.  Snapshot + the camera state go into
      // sessionStorage keyed by a one-shot token because URL-
      // encoded data URLs blow past most browser URL length caps
      // for anything past a tiny tile.
      if (liveMapForPrint && typeof window !== 'undefined') {
        try {
          const canvas = liveMapForPrint.getCanvas();
          // Trigger one more frame so the snapshot includes any
          // pending paint from a recent pan/zoom that hadn't
          // committed yet.  No-op if already idle.
          liveMapForPrint.triggerRepaint();
          const dataUrl = canvas.toDataURL('image/png');
          const center = liveMapForPrint.getCenter();
          const payload = {
            dataUrl,
            center: [center.lng, center.lat] as [number, number],
            zoom: liveMapForPrint.getZoom(),
            bearing: liveMapForPrint.getBearing(),
            widthPx: canvas.width,
            heightPx: canvas.height,
            capturedAt: Date.now(),
          };
          const token = `print-snap-${selected.id}-${Date.now()}`;
          window.sessionStorage.setItem(token, JSON.stringify(payload));
          params.set('snap', token);
        } catch (snapErr) {
          // Snapshot failed (cross-origin tile, drawing buffer
          // cleared, etc.).  Print page falls back to the
          // placeholder map rather than blocking the print, so
          // the user still gets their template + parameters.
          console.warn('[print] map snapshot failed', snapErr);
        }
      }

      const url = `/print/${selected.id}?${params.toString()}`;
      // IMPORTANT: opening the print tab WITHOUT 'noopener' is
      // deliberate. The HTML spec says a top-level browsing context
      // created with `noopener` gets its own session storage holder
      // disconnected from the opener's, so the snapshot token we
      // just stashed via sessionStorage.setItem above wouldn't be
      // readable from the new tab. With noopener, the print page
      // always rendered "Map preview unavailable (no snapshot
      // captured)" regardless of whether the snapshot succeeded --
      // shipped in #106 but never actually worked end-to-end.
      // The print page is same-origin (/print/<templateId>) and
      // doesn't navigate its opener anywhere, so the usual
      // tabnabbing concern that motivates noopener doesn't apply.
      const opened = window.open(url, '_blank');
      if (!opened) {
        throw new Error(
          'Could not open the print preview window.  Allow popups for this site and try again.',
        );
      }
      setResults((cur) => [
        { url, templateTitle: selected.title, createdAt: Date.now() },
        ...cur,
      ]);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
    } finally {
      setRendering(false);
    }
  }, [selected, values, widget.config, liveMapForPrint]);

  if (templates === null) {
    return (
      <WidgetFrame icon={Printer} title="Print">
        <div className="p-3 text-xs text-[hsl(var(--app-muted))]">Loading templates…</div>
      </WidgetFrame>
    );
  }
  if (templates.length === 0) {
    return (
      <WidgetFrame icon={Printer} title="Print">
        <div className="flex flex-col items-center gap-2 p-3 text-xs text-[hsl(var(--app-muted))]">
          <p>No print templates available.</p>
          <button
            type="button"
            disabled={!state}
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))] disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" />
            Browser print
          </button>
        </div>
      </WidgetFrame>
    );
  }
  return (
    <WidgetFrame icon={Printer} title="Print">
      <div className="flex h-full flex-col gap-2 p-2 text-xs">
        {!selected ? (
          <>
            <div className="font-medium text-[hsl(var(--app-ink-0))]">Templates</div>
            <div className="space-y-1">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t)}
                  className="block w-full rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 py-1.5 text-left text-xs hover:bg-[hsl(var(--app-surface-2))]"
                >
                  <div className="font-medium text-[hsl(var(--app-ink-0))]">{t.title}</div>
                  {t.description ? (
                    <div className="mt-0.5 text-2xs text-[hsl(var(--app-muted))]">
                      {t.description}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-2xs text-[hsl(var(--app-muted))] hover:underline"
              >
                ← Templates
              </button>
              <div className="ml-1 truncate font-medium text-[hsl(var(--app-ink-0))]">
                {selected.title}
              </div>
            </div>
            <div className="space-y-1.5">
              {selected.data.parameters.map((p) => (
                <label key={p.id} className="block text-2xs text-[hsl(var(--app-ink-1))]">
                  {p.label}
                  {p.type === 'longtext' ? (
                    <textarea
                      value={values[p.id] ?? ''}
                      onChange={(e) =>
                        setValues((cur) => ({ ...cur, [p.id]: e.target.value }))
                      }
                      rows={3}
                      className="mt-0.5 w-full rounded border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-1.5 py-1 text-2xs"
                    />
                  ) : p.type === 'dropdown' ? (
                    <select
                      value={values[p.id] ?? ''}
                      onChange={(e) =>
                        setValues((cur) => ({ ...cur, [p.id]: e.target.value }))
                      }
                      className="mt-0.5 h-7 w-full rounded border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-1.5 text-2xs"
                    >
                      {(p.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={
                        p.type === 'number'
                          ? 'number'
                          : p.type === 'date'
                            ? 'date'
                            : 'text'
                      }
                      value={values[p.id] ?? ''}
                      onChange={(e) =>
                        setValues((cur) => ({ ...cur, [p.id]: e.target.value }))
                      }
                      className="mt-0.5 h-7 w-full rounded border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-1.5 text-2xs"
                    />
                  )}
                  {p.description ? (
                    <span className="text-2xs text-[hsl(var(--app-muted))]">{p.description}</span>
                  ) : null}
                </label>
              ))}
            </div>
            <button
              type="button"
              disabled={rendering}
              onClick={onRender}
              className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[hsl(var(--app-accent))] px-3 py-1.5 text-xs font-medium text-white hover:bg-[hsl(var(--app-accent)/0.9)] disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" />
              {rendering ? 'Generating PDF…' : 'Print'}
            </button>
            {renderError ? (
              <div className="rounded border border-[hsl(var(--app-danger)/0.4)] bg-[hsl(var(--app-danger)/0.1)] px-2 py-1 text-2xs text-[hsl(var(--app-danger))]">
                {renderError}
              </div>
            ) : null}
          </>
        )}
        {results.length > 0 ? (
          <div className="mt-2 border-t border-[hsl(var(--app-border))] pt-2">
            <div className="text-2xs font-medium text-[hsl(var(--app-muted))]">Recent prints</div>
            <div className="mt-1 space-y-0.5">
              {results.slice(0, 5).map((r, i) => (
                <a
                  key={i}
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate rounded px-1 py-0.5 text-2xs text-[hsl(var(--app-accent))] hover:underline"
                >
                  {r.templateTitle} · {new Date(r.createdAt).toLocaleTimeString()}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </WidgetFrame>
  );
}

// ---- Select widget ---------------------------------------------------------

// 'off' is the unselected state for the tool; the panel never shows
// it, so type SELECT_MODES with the narrow union the config uses.
type ActiveSelectMode = Exclude<SelectToolMode, 'off'>;

const SELECT_MODES: Array<{
  mode: ActiveSelectMode;
  label: string;
  Icon: typeof MousePointer2;
}> = [
  { mode: 'click', label: 'Click', Icon: MousePointer2 },
  { mode: 'rectangle', label: 'Box', Icon: SquareIcon },
  { mode: 'polygon', label: 'Polygon', Icon: Pentagon },
  { mode: 'lasso', label: 'Lasso', Icon: Lasso },
];

function SelectWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'select') return null;
  const { state, update } = useBoundMap(widget.config.mapWidgetId);
  const allowedModes: Array<ActiveSelectMode> =
    widget.config.modes ?? ['click', 'rectangle', 'polygon', 'lasso'];
  const visible = SELECT_MODES.filter((m) => allowedModes.includes(m.mode));
  const active = state?.selectTool ?? 'off';
  return (
    <WidgetFrame icon={MousePointer2} title="Select">
      <div className="flex flex-wrap items-center gap-1 p-2">
        {visible.map(({ mode, label, Icon }) => (
          <button
            key={mode}
            type="button"
            disabled={!state}
            onClick={() =>
              update((cur) => ({
                ...cur,
                selectTool: cur.selectTool === mode ? 'off' : mode,
              }))
            }
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-2xs font-medium ${
              active === mode
                ? 'border-[hsl(var(--app-accent))] bg-[hsl(var(--app-accent)/0.1)] text-[hsl(var(--app-accent))]'
                : 'border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]'
            } disabled:opacity-50`}
            title={label}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>
    </WidgetFrame>
  );
}

// ---- Export widget (#110) --------------------------------------------------

/**
 * Custom Web App export widget.  Renders as a small popover that
 * picks (a) which of the bound map's target layers to export and
 * (b) the format / scope.  Click "Export" -> the loaded GeoJSON
 * features for that layer get sent through the shared
 * layer-export helper.
 *
 * Layer features are sourced from the live MapLibre instance via
 * `map.querySourceFeatures(...)` when available.  That's enough
 * for any layer whose tiles are currently loaded into the
 * visible+nearby area; what fits on screen + nearby tiles is what
 * the user can sensibly export from a web app.  Bundle export
 * (related tables + attachments + every-row-by-server-fetch) is
 * a separate widget tracked as #109.
 */
function ExportWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'export') return null;
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);
  const boundMap = cfg.mapWidgetId ? ctx?.maps?.[cfg.mapWidgetId] ?? null : null;
  const boundState = cfg.mapWidgetId
    ? ctx?.states?.[cfg.mapWidgetId] ?? null
    : null;
  const resolved = ctx?.resolvedTargets ?? [];
  const [targetIndex, setTargetIndex] = useState<number>(
    cfg.defaultTargetIndex ?? 0,
  );
  const [format, setFormat] = useState<ClientExportFormat>(cfg.defaultFormat ?? 'xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function runExport(scope: 'all' | 'selection'): void {
    setError(null);
    const target = resolved[targetIndex];
    if (!target || !boundMap || !boundState) {
      setError('No bound map / target.');
      return;
    }
    setBusy(true);
    try {
      // Pull features off the live MapLibre source.  For an MVT-
      // backed v3 data_layer, querySourceFeatures returns whatever
      // is currently loaded into the tile cache around the
      // viewport.  This is the same set the LayerList / popups see,
      // so the export matches what the user is looking at.
      const sourceId = target.mapLayer.id;
      const queried = boundMap.querySourceFeatures(sourceId, {
        sourceLayer: target.mapLayer.id,
      });
      // De-dup by feature id (a single feature can land in multiple
      // tiles when it spans tile boundaries).  MVT promoteId puts
      // the canonical id in `id`; fall back to a stringified
      // properties signature when missing.
      const seen = new Set<string>();
      const features: GeoJSON.Feature[] = [];
      for (const f of queried) {
        const key =
          f.id !== undefined ? String(f.id) : JSON.stringify(f.properties);
        if (seen.has(key)) continue;
        seen.add(key);
        features.push(f);
      }
      let working = features;
      if (scope === 'selection') {
        const sel = boundState.selection[target.mapLayer.id];
        if (!sel || sel.size === 0) {
          setError('No features selected on the bound map.');
          setBusy(false);
          return;
        }
        working = features.filter(
          (f) => f.id !== undefined && sel.has(f.id as number | string),
        );
      }
      if (working.length === 0) {
        setError(
          scope === 'selection'
            ? 'Selected features are not in the current viewport.'
            : 'No features in the current viewport.',
        );
        setBusy(false);
        return;
      }
      // MapLayer doesn't carry the field schema in resolvedTargets;
      // that's fetched separately by the AttributeTable widget via
      // /items/<id>/schema.  The exporter falls back to property-
      // key union order when fields aren't passed, which is good
      // enough for the v1 viewport-export workflow.  A future
      // polish can plumb the layer schema through here so column
      // labels match the layer designer's intent.
      exportFeatures(
        working.map((f) => ({
          ...(f.id !== undefined ? { id: String(f.id) } : {}),
          geometry: f.geometry,
          properties: (f.properties ?? null) as Record<string, unknown> | null,
        })),
        format,
        {
          filename: sanitizeExportFilename(target.title),
          includeGeometryWkt: format === 'xlsx',
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const noTargets = resolved.length === 0;
  return (
    <WidgetFrame icon={Download} title="Export">
      <div className="flex flex-col gap-3 p-3 text-xs">
        <label className="block">
          <span className="block text-2xs font-medium uppercase tracking-wide text-[hsl(var(--app-muted))]">
            Layer
          </span>
          <select
            value={targetIndex}
            disabled={noTargets}
            onChange={(e) => setTargetIndex(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-2 py-1 text-sm"
          >
            {resolved.map((t, i) => (
              <option key={`${t.dataLayerId}:${t.layerKey}:${i}`} value={i}>
                {t.title}
              </option>
            ))}
            {noTargets ? (
              <option value={-1}>(no targets configured)</option>
            ) : null}
          </select>
        </label>
        <label className="block">
          <span className="block text-2xs font-medium uppercase tracking-wide text-[hsl(var(--app-muted))]">
            Format
          </span>
          <div className="mt-1 inline-flex rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-2))] p-0.5">
            <button
              type="button"
              onClick={() => setFormat('xlsx')}
              className={`px-2 py-1 text-2xs ${
                format === 'xlsx'
                  ? 'rounded bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))] shadow-sm'
                  : 'text-[hsl(var(--app-muted))]'
              }`}
            >
              Excel
            </button>
            <button
              type="button"
              onClick={() => setFormat('csv')}
              className={`px-2 py-1 text-2xs ${
                format === 'csv'
                  ? 'rounded bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))] shadow-sm'
                  : 'text-[hsl(var(--app-muted))]'
              }`}
            >
              CSV
            </button>
          </div>
        </label>
        {error ? (
          <p className="rounded-md border border-[hsl(var(--app-danger)/0.4)] bg-[hsl(var(--app-danger)/0.1)] px-2 py-1 text-2xs text-[hsl(var(--app-danger))]">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy || noTargets}
            onClick={() => runExport('all')}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[hsl(var(--app-accent))] px-3 text-2xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            Export visible
          </button>
          <button
            type="button"
            disabled={busy || noTargets}
            onClick={() => runExport('selection')}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 text-2xs font-medium text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))] disabled:opacity-50"
          >
            Export selection
          </button>
        </div>
        <p className="text-2xs text-[hsl(var(--app-muted))]">
          Exports the features currently loaded for this layer (the
          map viewport plus its surrounding tile cache).  For a
          full-layer dump including related tables + attachments,
          use the bundle export on the data layer&apos;s detail page.
        </p>
      </div>
    </WidgetFrame>
  );
}

function sanitizeExportFilename(raw: string): string {
  const s = raw.trim().replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  return (s.slice(0, 60) || 'export').replace(/^_+|_+$/g, '');
}

// ---- Splash Screen widget (#111) ------------------------------------------

const SPLASH_PRESET_WIDTHS = { sm: 400, md: 600, lg: 800 } as const;

/**
 * Stable 32-bit hash of a string.  We use this to derive the
 * dismissal storage key so localStorage forgets the dismissal as
 * soon as the splash's content changes -- users who agreed to v1
 * of a disclaimer get re-prompted on v2.  Standard djb2 because
 * it's tiny and good enough for change-detection.
 */
function splashHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function SplashWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'splash') return null;
  const cfg = widget.config;

  // Resolve the modal width.  Custom widths get clamped so a
  // typo'd 5000 doesn't break the layout on every screen size.
  let width: number = SPLASH_PRESET_WIDTHS.md;
  if (cfg.size === 'sm') width = SPLASH_PRESET_WIDTHS.sm;
  else if (cfg.size === 'lg') width = SPLASH_PRESET_WIDTHS.lg;
  else if (cfg.size === 'custom' && typeof cfg.widthPx === 'number') {
    width = Math.max(280, Math.min(1200, Math.round(cfg.widthPx)));
  }

  // Dismissal memory key: includes widget id + a hash of the
  // content so re-authoring the splash forces a re-show for
  // everyone, including users who previously checked "don't
  // show again".  Title + markdown + confirm label is the user-
  // visible surface; tweaks to size or behavior re-use the same
  // key (we want a width change to NOT re-prompt every user).
  const dismissKey = useMemo(() => {
    const content = [
      cfg.title ?? '',
      cfg.markdown ?? '',
      cfg.confirmLabel ?? '',
    ].join('|');
    return `gratis-gis:splash:${widget.id}:${splashHash(content)}`;
  }, [widget.id, cfg.title, cfg.markdown, cfg.confirmLabel]);

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (!cfg.allowDismiss) return true;
    try {
      return window.localStorage.getItem(dismissKey) !== '1';
    } catch {
      return true;
    }
  });
  const [dontShow, setDontShow] = useState<boolean>(false);

  // Re-evaluate when the dismissal key changes (the author re-
  // authored the splash; users with prior dismissals see the
  // new version).
  useEffect(() => {
    if (!cfg.allowDismiss) {
      setOpen(true);
      return;
    }
    try {
      setOpen(window.localStorage.getItem(dismissKey) !== '1');
    } catch {
      setOpen(true);
    }
  }, [dismissKey, cfg.allowDismiss]);

  // Lock body scroll while the splash is open so the user can't
  // scroll the map underneath -- matches how a modal SHOULD
  // behave on a single-page app surface.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Escape closes the modal unless requireConfirm is on.
  useEffect(() => {
    if (!open) return;
    if (cfg.requireConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cfg.requireConfirm]);

  if (!open) return null;

  function confirm(): void {
    if (dontShow && cfg.allowDismiss) {
      try {
        window.localStorage.setItem(dismissKey, '1');
      } catch {
        /* ignore -- private mode / quota; the splash just shows again next visit */
      }
    }
    setOpen(false);
  }

  function onBackdropClick(): void {
    if (cfg.requireConfirm) return;
    setOpen(false);
  }

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="splash-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4 py-8"
      onClick={onBackdropClick}
    >
      <div
        className="relative flex max-h-full flex-col overflow-hidden rounded-lg bg-[hsl(var(--app-surface-0))] shadow-2xl"
        style={{ width: `${width}px`, maxWidth: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with title.  Close-X only when requireConfirm is
            off; otherwise the user must use the confirm button. */}
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-4 py-3">
          <h2
            id="splash-title"
            className="text-sm font-semibold text-[hsl(var(--app-ink-0))]"
          >
            {cfg.title || 'Welcome'}
          </h2>
          {cfg.requireConfirm ? null : (
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="-mr-1 -mt-1 inline-flex h-6 w-6 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))]"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </header>

        <div className="prose-sm flex-1 overflow-auto px-4 py-4 text-sm text-[hsl(var(--app-ink-1))] [&_a]:text-[hsl(var(--app-accent))] [&_a]:underline [&_code]:rounded [&_code]:bg-[hsl(var(--app-surface-2))] [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:ml-5 [&_ul]:list-disc">
          <MarkdownLite text={cfg.markdown ?? ''} />
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-4 py-3">
          {cfg.allowDismiss ? (
            <label className="flex items-center gap-2 text-xs text-[hsl(var(--app-ink-1))]">
              <input
                type="checkbox"
                checked={dontShow}
                onChange={(e) => setDontShow(e.target.checked)}
              />
              Don&rsquo;t show this again
            </label>
          ) : (
            // Empty flex item so the confirm button stays right-
            // aligned even without the checkbox.
            <span />
          )}
          <button
            type="button"
            onClick={confirm}
            className="inline-flex h-8 items-center rounded-md bg-[hsl(var(--app-accent))] px-4 text-sm font-medium text-white hover:opacity-90"
          >
            {cfg.confirmLabel || 'OK'}
          </button>
        </footer>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modal, document.body)
    : modal;
}

// ---- AttributeTable widget -------------------------------------------------

/**
 * Shared shape used by ChartWidgetRender (and previously by the
 * legacy AttributeTableWidgetRender) for its lazy GeoJSON fetch.
 * Phase 2 of the attribute-table swap moved the table off this
 * shape onto the rich AttributeTable, but Chart still consumes it.
 */
interface FetchedFeatures {
  loading: boolean;
  rows: Array<{ id: string | number; props: Record<string, unknown> }>;
  fields: string[];
  error: string | null;
}

/**
 * Custom Web App's attribute-table widget. Phase 2 swaps the previous
 * minimal HTML table for the rich AttributeTable component from the
 * map item, so the panel that opens when the user clicks the
 * attribute-table toolbar button looks and behaves identically to the
 * one in the map editor: layer picker dropdown across all the bound
 * map's queryable layers, text query bar, sort by column,
 * In-extent toggle, Show selected, server-paged mode for v3
 * data_layer sublayers (so the 1.4M-row parcels case stays fast),
 * Zoom-to-selection, "Use as filter".
 *
 * State sourcing:
 *
 *   - When the widget is bound to a Map widget via
 *     `syncWithMapWidgetId`, the table reads the bound map's layers,
 *     selection, and viewport bbox from CustomMapsContext. Clicking a
 *     row mutates the same selection state the map renders, so the
 *     feature highlights, layer access, view scope, and any other
 *     map-level concerns all stay coherent across the two widgets.
 *
 *   - When the widget is unbound (no `syncWithMapWidgetId`), the
 *     table falls back to a single-layer view of the widget's
 *     configured target with local selection state. Useful for
 *     pages that show a table without a paired map. The Zoom-to
 *     control no-ops in this mode (no map to fly).
 *
 * The widget passes `embedded={true}` so AttributeTable fills the
 * ToolPopover content area instead of bottom-docking, and so its own
 * close button is hidden (the popover provides one).
 */
function AttributeTableWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'attribute-table') return null;
  // Pin the narrowed config to a local so the useMemo / useCallback
  // closures below don't re-narrow `widget.config` (TS loses the
  // discriminant inside hook bodies otherwise).
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);
  // #87 -- so the table re-fetches against the bitemporal snapshot
  // when the user scrubs the time slider.
  const appAt = useAppTime();

  const mapWidgetId = cfg.syncWithMapWidgetId;
  const boundMapState = mapWidgetId ? ctx?.states[mapWidgetId] ?? null : null;
  const boundMapInstance = mapWidgetId ? ctx?.maps[mapWidgetId] ?? null : null;

  // Layers shown in the table's layer-picker dropdown. Bound to a
  // map: all the map's layers (the rich AttributeTable filters down
  // to queryable ones internally). Unbound: just the configured
  // target as a synthetic single-layer array.
  const layers = useMemo<MapLayer[]>(() => {
    if (boundMapState?.mapData.layers) return boundMapState.mapData.layers;
    if (!ctx) return [];
    const target = ctx.resolvedTargets[cfg.targetIndex];
    if (!target) return [];
    return [target.mapLayer];
  }, [boundMapState, ctx, cfg.targetIndex]);

  // Selection state. Shared with the bound map when present; the
  // table updates `MapState.selection` via the context's `update`
  // helper so the same Set drives both the table highlights and the
  // map's feature-state. Unbound: local React state.
  const [localSelection, setLocalSelection] = useState<
    Record<string, Set<number | string>>
  >({});
  const selection = boundMapState?.selection ?? localSelection;
  const setSelection: Dispatch<
    SetStateAction<Record<string, Set<number | string>>>
  > = useCallback(
    (update) => {
      if (mapWidgetId && ctx) {
        ctx.update(mapWidgetId, (cur) => ({
          ...cur,
          selection:
            typeof update === 'function'
              ? (update as (
                  s: Record<string, Set<number | string>>,
                ) => Record<string, Set<number | string>>)(cur.selection)
              : update,
        }));
        return;
      }
      setLocalSelection(update);
    },
    [ctx, mapWidgetId],
  );

  // Live map viewport bbox. Drives server-paged mode for v3
  // data_layer sublayers: when present, the table fetches rows in
  // the visible extent instead of materializing every row. Tracked
  // here via moveend so we update only after the pan/zoom settles
  // and don't churn the AttributeTable's fetch on every frame.
  const [mapBbox, setMapBbox] = useState<
    [number, number, number, number] | null
  >(null);
  useEffect(() => {
    if (!boundMapInstance) {
      setMapBbox(null);
      return;
    }
    const update = () => {
      const b = boundMapInstance.getBounds();
      setMapBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    update();
    boundMapInstance.on('moveend', update);
    return () => {
      boundMapInstance.off('moveend', update);
    };
  }, [boundMapInstance]);

  // The configured target picks which layer the picker focuses on
  // first open. Beyond that the user can switch via the dropdown.
  const focusLayerId = useMemo(() => {
    if (!ctx) return null;
    const target = ctx.resolvedTargets[cfg.targetIndex];
    return target?.mapLayer.id ?? null;
  }, [ctx, cfg.targetIndex]);

  // Metadata is normally populated by the map canvas as it loads
  // each layer's features. The Custom App runtime doesn't fetch
  // ahead for v3 data_layers (server-paged mode doesn't need it),
  // but inline FeatureCollections (the OSM tool-run path, #141)
  // need it -- without metadata, AttributeTable shows zero columns
  // even though the rows ARE populated. Walk each geojson-inline
  // layer in-place and build a minimal LayerMetadata; that gives
  // the table its column list, sample properties, and per-field
  // distinct values for filtering. v3 data_layers stay on the
  // server-paged path; arcgis-rest still falls back to the empty
  // metadata behavior (those don't surface in Custom Apps with
  // AttributeTable widgets yet).
  const metadata = useMemo<Record<string, LayerMetadata>>(() => {
    const out: Record<string, LayerMetadata> = {};
    for (const l of layers) {
      if (l.source.kind === 'geojson-inline') {
        const fc = l.source.geojson as GeoJSON.FeatureCollection | null;
        if (fc) out[l.id] = metadataFromFeatureCollection(fc);
      }
    }
    return out;
  }, [layers]);

  // featuresByLayer is the client-side feature cache the non-v3
  // sources rely on. v3 data_layer sublayers server-page by
  // mapBbox automatically and never touch this cache. We DO have
  // to populate it for `geojson-inline` layers though: the OSM
  // tool-run result (#141) lands as a geojson-inline MapLayer
  // with the full FeatureCollection right on the source, and
  // without this projection the AttributeTable widget shows 0
  // rows even though the features render fine on the map.
  // arcgis-rest / geojson-url sources still aren't pre-warmed; if
  // a Custom App ever hosts one of those AND wires it to an
  // AttributeTable, we'll need a fetch here.
  const featuresByLayer = useMemo<
    Record<string, GeoJSON.FeatureCollection | null>
  >(() => {
    const out: Record<string, GeoJSON.FeatureCollection | null> = {};
    for (const l of layers) {
      if (l.source.kind === 'geojson-inline') {
        const fc = l.source.geojson as GeoJSON.FeatureCollection | null;
        if (
          fc &&
          typeof fc === 'object' &&
          'type' in fc &&
          fc.type === 'FeatureCollection'
        ) {
          out[l.id] = fc;
        }
      }
    }
    return out;
  }, [layers]);

  const onZoomTo = useCallback(
    (bbox: [number, number, number, number]) => {
      if (!mapWidgetId || !ctx) return;
      ctx.flyTo(mapWidgetId, bbox);
    },
    [ctx, mapWidgetId],
  );

  const onPatchLayer = useCallback(
    (layerId: string, patch: Partial<MapLayer>) => {
      if (!mapWidgetId || !ctx) return;
      ctx.update(mapWidgetId, (cur) => ({
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: cur.mapData.layers.map((l) =>
            l.id === layerId ? { ...l, ...patch } : l,
          ),
        },
      }));
    },
    [ctx, mapWidgetId],
  );

  // No bound map = no usable table because the rich AttributeTable
  // expects a non-empty layers array. Show a friendly nudge so the
  // author knows what to wire up.
  if (layers.length === 0) {
    return (
      <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">
        Configure the widget&rsquo;s target layer (or bind to a Map
        widget that has layers) to populate the attribute table.
      </p>
    );
  }

  return (
    <AttributeTable
      embedded
      open
      layers={layers}
      featuresByLayer={featuresByLayer}
      metadata={metadata}
      canEdit={false}
      selection={selection}
      setSelection={setSelection}
      onClose={() => {
        /* The ToolPopover owns close; the embedded AttributeTable
           hides its own close button, so this is a no-op stub kept
           for the typed prop. */
      }}
      onZoomTo={onZoomTo}
      onPatchLayer={onPatchLayer}
      focusLayerId={focusLayerId}
      mapBbox={mapBbox}
      asOfTime={appAt}
    />
  );
}

// ---- Text widget -----------------------------------------------------------

const TEXT_PRESET_CLS: Record<string, string> = {
  header: 'text-2xl font-bold text-[hsl(var(--app-ink-0))]',
  subheader: 'text-lg font-semibold text-[hsl(var(--app-ink-0))]',
  body: 'text-sm text-[hsl(var(--app-ink-1))]',
  callout: 'rounded-md bg-[hsl(var(--app-warn)/0.1)] px-3 py-2 text-sm text-[hsl(var(--app-warn))]',
};

function TextWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'text') return null;
  const cls = TEXT_PRESET_CLS[widget.config.preset ?? 'body'] ?? '';
  // flex flex-col justify-center: vertically centers the rendered
  // markdown block inside its slot.  A one-line title in a tall
  // sticky-top app-bar row otherwise stuck to the top, which read
  // as misaligned next to other tools that *are* centered.
  //
  // overflow-hidden (not overflow-auto): the widget cell controls
  // size; when content exceeds the cell the right answer is for the
  // author to resize the widget, not for the runtime to spawn
  // scrollbars on a one-line title.  px-2 py-1 keeps a small
  // padding inside the widget without burning all the slot height
  // when a Text is dropped into a tight sticky-top app-bar slot.
  return (
    <div
      className={`flex h-full w-full flex-col justify-center overflow-hidden px-2 py-1 ${cls}`}
    >
      <MarkdownLite text={widget.config.markdown} />
    </div>
  );
}

/**
 * Tiny inline markdown renderer (#341). Handles paragraphs, **bold**,
 * *italic*, `code`, [text](url), - / * unordered lists, and
 * `# / ## / ###` headings. Anything else renders as plain text.
 * Avoids pulling a 50KB markdown library for a widget that's
 * almost always one paragraph long.
 */
function MarkdownLite({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <>
      {blocks.map((block, i) => {
        const t = block.trim();
        if (!t) return null;
        if (t.startsWith('### ')) {
          return (
            <h3 key={i} className="mb-2 text-base font-semibold text-[hsl(var(--app-ink-0))]">
              {renderInline(t.slice(4))}
            </h3>
          );
        }
        if (t.startsWith('## ')) {
          return (
            <h2 key={i} className="mb-2 text-lg font-bold text-[hsl(var(--app-ink-0))]">
              {renderInline(t.slice(3))}
            </h2>
          );
        }
        if (t.startsWith('# ')) {
          return (
            <h1 key={i} className="mb-2 text-xl font-bold text-[hsl(var(--app-ink-0))]">
              {renderInline(t.slice(2))}
            </h1>
          );
        }
        const lines = t.split('\n');
        if (lines.every((l) => /^[-*]\s/.test(l))) {
          return (
            <ul key={i} className="mb-2 ml-5 list-disc space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(/^[-*]\s/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="mb-2 whitespace-pre-wrap">
            {renderInline(t)}
          </p>
        );
      })}
    </>
  );
}

function renderInline(s: string): React.ReactNode {
  // Order matters: color-span first (HTML pass-through written by
  // the rich-text editor's color picker), then links, then bold,
  // italic, code.  We split on each pattern in a single pass via a
  // regex.  Color is stored as `<span style="color:#RRGGBB">…</span>`
  // -- a tightly-shaped HTML token the markdown serializer round-
  // trips verbatim.  We deliberately match only the exact shape so
  // arbitrary HTML can't leak in through the markdown parser.
  const tokens: React.ReactNode[] = [];
  const re =
    /(<span style="color:\s*(#[0-9a-fA-F]{3,8})">([^<]+)<\/span>)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push(s.slice(last, m.index));
    if (m[1]) {
      // Color span -- recurse into the inner text so bold/italic
      // inside a colored run still renders.
      tokens.push(
        <span key={key++} style={{ color: m[2] }}>
          {renderInline(m[3] ?? '')}
        </span>,
      );
    } else if (m[4]) {
      tokens.push(
        <a
          key={key++}
          href={m[6]}
          target="_blank"
          rel="noreferrer"
          className="text-[hsl(var(--app-accent))] hover:underline"
        >
          {m[5]}
        </a>,
      );
    } else if (m[7]) {
      tokens.push(
        <strong key={key++} className="font-semibold">
          {m[8]}
        </strong>,
      );
    } else if (m[9]) {
      tokens.push(
        <em key={key++} className="italic">
          {m[10]}
        </em>,
      );
    } else if (m[11]) {
      tokens.push(
        <code
          key={key++}
          className="rounded bg-[hsl(var(--app-surface-2))] px-1 py-0.5 font-mono text-[0.95em]"
        >
          {m[12]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push(s.slice(last));
  return <>{tokens}</>;
}

// ---- Chart widget ----------------------------------------------------------

/**
 * Chart widget. Reads features from the bound target layer, applies
 * the configured group-by + aggregate, and renders a single-series
 * bar / line / pie chart via Recharts. Counts work without a value
 * field; sum / avg / min / max require one (the designer's panel
 * already gates this so a misconfigured widget shouldn't reach the
 * runtime, but we double-check and surface a hint when it does).
 *
 * Recharts is dynamically imported via the static module
 * dependency, but mounted inside a ResponsiveContainer so the chart
 * fills its widget cell -- the Custom grid sizes cells in the page
 * layout, then the chart self-sizes within. Tooltip + axis labels
 * come from Recharts defaults; the bundle stays small (~80 KB
 * gzipped, gated to widgets that actually render charts).
 */
function ChartWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'chart') return null;
  const ctx = useContext(CustomMapsContext);
  // #87 -- read app-time so the chart re-fetches against the
  // bitemporal snapshot when the user scrubs back in time.
  const appAt = useAppTime();
  const cfg = widget.config;
  const target = ctx?.resolvedTargets[cfg.targetIndex] ?? null;
  const [data, setData] = useState<FetchedFeatures>({
    loading: true,
    rows: [],
    fields: [],
    error: null,
  });

  useEffect(() => {
    if (!target) {
      setData({ loading: false, rows: [], fields: [], error: 'No target' });
      return;
    }
    let abort = false;
    setData({ loading: true, rows: [], fields: [], error: null });
    void (async () => {
      try {
        const url = appendAtParam(
          `/api/portal/items/${target.dataLayerId}/layers/${target.layerKey}/geojson`,
          appAt,
        );
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fc = (await res.json()) as GeoJSON.FeatureCollection;
        if (abort) return;
        const features = fc.features ?? [];
        const fieldSet = new Set<string>();
        for (const f of features) {
          for (const k of Object.keys(f.properties ?? {})) fieldSet.add(k);
        }
        const fields = Array.from(fieldSet).filter((f) => !f.startsWith('_'));
        setData({
          loading: false,
          rows: features.map((f) => ({
            id: (f.id ?? '') as string | number,
            props: (f.properties ?? {}) as Record<string, unknown>,
          })),
          fields,
          error: null,
        });
      } catch (err) {
        if (abort) return;
        setData({
          loading: false,
          rows: [],
          fields: [],
          error: err instanceof Error ? err.message : 'Fetch failed',
        });
      }
    })();
    return () => {
      abort = true;
    };
  }, [target, appAt]);

  return (
    <WidgetFrame icon={ChevronRight} title="Chart">
      {data.loading ? (
        <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">Loading…</p>
      ) : data.error ? (
        <p className="p-2 text-xs text-[hsl(var(--app-danger))]">{data.error}</p>
      ) : (
        <ChartCanvas rows={data.rows} cfg={cfg} />
      )}
    </WidgetFrame>
  );
}

/**
 * Inner Recharts canvas. Pulls the imports off the package's
 * default surface (the package ships ESM; Next bundles it in the
 * client chunk for this widget). We keep this a separate component
 * so the import boundary lines up with where Recharts actually
 * mounts -- if the chart widget is never used on a page, the chunk
 * never loads.
 */
function ChartCanvas({
  rows,
  cfg,
}: {
  rows: Array<{ id: string | number; props: Record<string, unknown> }>;
  cfg: Extract<CustomWidget['config'], { kind: 'chart' }>;
}) {
  // Aggregate. Group rows by `groupBy` value, then apply `aggregate`
  // per bucket. 'count' is the only aggregate that doesn't need a
  // value field; everything else falls back to count if valueField
  // is missing or non-numeric (the runtime warns inline rather than
  // throwing).
  const aggregated = useMemo(() => {
    const groupBy = cfg.groupBy ?? '';
    const aggregate = cfg.aggregate ?? 'count';
    const valueField = cfg.valueField ?? '';
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      const groupRaw = groupBy ? row.props[groupBy] : '(all)';
      const groupKey =
        groupRaw === undefined || groupRaw === null ? '(missing)' : String(groupRaw);
      const valueRaw =
        aggregate === 'count' ? 1 : valueField ? row.props[valueField] : 1;
      const num =
        typeof valueRaw === 'number' && Number.isFinite(valueRaw)
          ? valueRaw
          : Number(valueRaw);
      const arr = buckets.get(groupKey) ?? [];
      if (Number.isFinite(num)) arr.push(num);
      buckets.set(groupKey, arr);
    }
    const out: Array<{ name: string; value: number }> = [];
    for (const [name, vals] of buckets) {
      if (vals.length === 0) continue;
      let value: number;
      switch (aggregate) {
        case 'count':
          value = vals.length;
          break;
        case 'sum':
          value = vals.reduce((a, b) => a + b, 0);
          break;
        case 'avg':
          value = vals.reduce((a, b) => a + b, 0) / vals.length;
          break;
        case 'min':
          value = Math.min(...vals);
          break;
        case 'max':
          value = Math.max(...vals);
          break;
        default:
          value = vals.length;
      }
      out.push({ name, value });
    }
    // Stable order: bar / pie sort by value desc; line keeps insert
    // order so a numeric x-axis renders monotonically.
    if (cfg.chartType !== 'line') out.sort((a, b) => b.value - a.value);
    return out;
  }, [rows, cfg.groupBy, cfg.aggregate, cfg.valueField, cfg.chartType]);

  if (aggregated.length === 0) {
    return (
      <p className="p-2 text-xs italic text-[hsl(var(--app-muted))]">
        No data to chart. Bind a target with at least one feature
        and pick a group-by field.
      </p>
    );
  }

  return (
    <div className="flex-1 p-2">
      <ChartPlot rows={aggregated} kind={cfg.chartType} />
    </div>
  );
}

/**
 * The actual chart. Lazy-evaluated against Recharts so the import
 * sits inside the function body where bundlers can tree-shake when
 * the runtime never reaches a chart widget. ResponsiveContainer
 * fills its parent (the WidgetFrame's flex-1 wrapper); chart-type
 * switch picks bar / line / pie.
 */
function ChartPlot({
  rows,
  kind,
}: {
  rows: Array<{ name: string; value: number }>;
  kind: 'bar' | 'line' | 'pie';
}) {
  // Imports stay top-level on the file (recharts is ESM, Next
  // bundlers handle it). The components are referenced only inside
  // this leaf so the chunk lands lazily with the chart-bearing
  // pages.
  const Recharts = ReactRecharts;

  // A small palette so pie / bar fills aren't all one color.
  // Hand-picked from Tailwind's default palette so the colors look
  // intentional next to the rest of the portal chrome.
  const palette = [
    '#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626',
    '#0891b2', '#ca8a04', '#0d9488', '#7c3aed', '#e11d48',
  ];

  if (kind === 'pie') {
    return (
      <Recharts.ResponsiveContainer width="100%" height="100%">
        <Recharts.PieChart>
          <Recharts.Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            outerRadius="70%"
          >
            {rows.map((_, i) => (
              <Recharts.Cell key={i} fill={palette[i % palette.length]!} />
            ))}
          </Recharts.Pie>
          <Recharts.Tooltip />
          <Recharts.Legend />
        </Recharts.PieChart>
      </Recharts.ResponsiveContainer>
    );
  }
  if (kind === 'line') {
    return (
      <Recharts.ResponsiveContainer width="100%" height="100%">
        <Recharts.LineChart data={rows}>
          <Recharts.CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <Recharts.XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <Recharts.YAxis tick={{ fontSize: 11 }} />
          <Recharts.Tooltip />
          <Recharts.Line
            type="monotone"
            dataKey="value"
            stroke={palette[0]!}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </Recharts.LineChart>
      </Recharts.ResponsiveContainer>
    );
  }
  // bar (default)
  return (
    <Recharts.ResponsiveContainer width="100%" height="100%">
      <Recharts.BarChart data={rows}>
        <Recharts.CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <Recharts.XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <Recharts.YAxis tick={{ fontSize: 11 }} />
        <Recharts.Tooltip />
        <Recharts.Bar dataKey="value" fill={palette[0]!} />
      </Recharts.BarChart>
    </Recharts.ResponsiveContainer>
  );
}

// ---- Page-element widgets (#361) -------------------------------------------

function ImageWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'image') return null;
  const { asset, url, alt, objectFit, href, openInNewTab } = widget.config;
  // Resolve the image source. New configs use the `asset` AssetRef
  // (file-item id or external URL); legacy configs use the bare
  // `url` field. Resolution priority: asset's cachedUrl ->
  // legacy url. File-item refs whose cachedUrl is missing fall
  // through to the no-image placeholder until the runtime fetches
  // the current storageUrl (filed as follow-up; for now we rely on
  // the designer pre-warming the cache when picking).
  const resolvedUrl = resolveAssetRefSync(asset ?? null) ?? url ?? null;
  if (!resolvedUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[hsl(var(--app-surface-2)/0.4)] text-xs text-[hsl(var(--app-muted))]">
        No image set
      </div>
    );
  }
  // <img> uses object-fit. Wrapper is full bleed; image fills it
  // according to the chosen fit. http(s) only is enforced by the
  // designer; if a malformed URL slips through, the browser shows
  // the broken-image icon and no script runs.
  const imgEl = (
    <img
      src={resolvedUrl}
      alt={alt ?? ''}
      className="h-full w-full"
      style={{ objectFit: objectFit ?? 'contain' }}
    />
  );
  if (href) {
    return (
      <a
        href={href}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noreferrer noopener' : undefined}
        className="block h-full w-full"
      >
        {imgEl}
      </a>
    );
  }
  return <div className="h-full w-full">{imgEl}</div>;
}

function ButtonWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'button') return null;
  const ctx = useContext(CustomMapsContext);
  const { label, variant, linkKind, url, pageId, toolId, openInNewTab } =
    widget.config;
  const v = variant ?? 'primary';
  const className = `inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
    v === 'primary'
      ? 'bg-[hsl(var(--app-accent))] text-white hover:opacity-90'
      : 'border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]'
  }`;
  const text = label || 'Button';
  if ((linkKind ?? 'url') === 'tool') {
    return <ToolButtonRender toolId={toolId} text={text} className={className} />;
  }
  if ((linkKind ?? 'url') === 'page') {
    // Page-link path. Resolves to setActivePageIdx via the runtime
    // context. Renders as a plain button so middle-click / right-
    // click don't behave like an external link.
    return (
      <div className="flex h-full w-full items-center justify-center p-2">
        <button
          type="button"
          disabled={!pageId}
          onClick={() => {
            if (pageId) ctx?.navigateToPage(pageId);
          }}
          className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {text}
        </button>
      </div>
    );
  }
  // External-URL path. Real <a> so the browser handles middle-click,
  // right-click, copy-link, etc.
  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <a
        href={url || '#'}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noreferrer noopener' : undefined}
        aria-disabled={!url}
        onClick={(e) => {
          if (!url) e.preventDefault();
        }}
        className={className}
      >
        {text}
      </a>
    </div>
  );
}

/**
 * #144: first-class Tool widget.  Same underlying behavior as the
 * legacy Button-bound-to-tool path, but with widget-instance-level
 * icon + display variant + label so authors can drop the same
 * Tool into different apps with different presentations.  Wraps
 * the existing ToolButtonRender by computing the rendered className
 * + iconHtml + hideText from the widget config.
 */
function ToolWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'tool') return null;
  const {
    toolId,
    iconName,
    label,
    showLabel,
    display,
    variant,
  } = widget.config;
  const d = display ?? 'toolbar';
  const v = variant ?? 'primary';
  // Detect app-bar context so the Tool widget can wear the SAME
  // chrome as every other in-bar widget (Search, Print, Basemap,
  // AttributeTable).  Without this, the Tool button stuck out as a
  // teal pill on the green header while every neighbor was a flat
  // cream-on-green icon link.  Mirrors the ToolWidgetSlot wrapper
  // a few hundred lines above.
  const inAppBar = useContext(AppBarContext);
  // Three visual modes:
  //  1. Toolbar variant inside an app-bar  -> claim the full slot
  //     height + min-width with a vertical icon-over-label stack,
  //     matching ToolWidgetSlot's in-bar geometry exactly.  Tool
  //     reads as a peer of Search / Print / Basemap.
  //  2. Toolbar variant on the canvas      -> centered teal pill so
  //     the tool identity reads against surface-1 / map chrome
  //     (the teal matches the tool item-type tile on the items
  //     list and the ItemTypeBadge).
  //  3. Standalone variant                 -> primary button shape
  //     with teal fill; secondary uses neutral surface-1 chrome.
  let className: string;
  if (d === 'toolbar' && inAppBar) {
    // Vertical stack matching ToolWidgetSlot's in-bar idle state.
    className = `group/tool flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))] disabled:opacity-50`;
  } else if (d === 'toolbar') {
    className = `inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors bg-teal-500/10 text-teal-700 dark:text-teal-400 hover:bg-teal-500/20`;
  } else {
    className = `inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
      v === 'primary'
        ? 'bg-teal-500/90 text-white hover:bg-teal-500'
        : 'border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]'
    }`;
  }
  const iconHtml = iconName ? renderIconSvg(iconName) : null;
  const hideText = d === 'toolbar' && !showLabel;
  // In-bar tool widgets render edge-to-edge with no outer padding
  // so they fill the full app-bar height (matching ToolWidgetSlot).
  // Canvas + standalone variants keep the centered-with-padding
  // wrapper so the button has breathing room on a surface-1 grid
  // cell.  Icons inherit larger sizing in-bar (h-5/w-5) so the
  // stroke weight matches Search / Print / Basemap.
  return (
    <ToolButtonRender
      toolId={toolId}
      text={label?.trim() || 'Tool'}
      className={className}
      {...(iconHtml ? { iconHtml } : {})}
      hideText={hideText}
      inAppBar={inAppBar}
    />
  );
}

/**
 * #90: Tool-button render path.  Fetches the bound `tool` item by
 * id on mount, falls back to a disabled button if the tool was
 * deleted (or the user no longer has read access).  On click, runs
 * the tool's declared action.  Today's action surface is URL-
 * shaped (open-item, open-url); future actions (run a derived-layer
 * pipeline, trigger a print) plug into the same switch.
 */
function ToolButtonRender({
  toolId,
  text,
  className,
  iconHtml,
  hideText,
  inAppBar,
}: {
  toolId: string | undefined;
  text: string;
  className: string;
  /** #144: optional pre-rendered icon SVG markup. When provided,
   *  rendered alongside (or in place of) the text inside the
   *  button. Pass null/undefined for the legacy text-only Button
   *  rendering. */
  iconHtml?: string | null;
  /** #144: hide the text label entirely (icon-only toolbar
   *  variant). The accessible name still resolves via title +
   *  aria-label from the underlying button.  Default false
   *  keeps the legacy Button rendering. */
  hideText?: boolean;
  /** When true, render edge-to-edge with no outer padding so the
   *  button fills the app-bar slot height, matching how Search /
   *  Print / Basemap claim their slots. Icon sizes up to h-5/w-5
   *  and an optional label sits beneath it (vertical stack). */
  inAppBar?: boolean;
}) {
  type ToolItem = {
    id: string;
    title: string;
    data: {
      action?:
        | { kind: 'open-item'; targetItemId: string; newTab?: boolean; view?: string }
        | { kind: 'open-url'; url: string; newTab?: boolean }
        | {
            kind: 'export-layer';
            targetItemId: string;
            layerKey: string;
            format: 'csv' | 'xlsx';
          }
        | RecipeActionShape
        | RelationalActionShape;
    } | null;
  };
  const ctx = useContext(CustomMapsContext);
  const [tool, setTool] = useState<ToolItem | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'missing'>(
    toolId ? 'loading' : 'missing',
  );
  // Recipe runtime panel.  Opens when the user clicks a tool whose
  // action is a recipe; closes after the runner returns + the host
  // selection has been applied.  Local state lives on the button
  // because each button independently triggers its own run.
  const [recipePanelOpen, setRecipePanelOpen] = useState(false);
  // Active OSM overlay produced by the latest tool run, if any.
  // Reset on a fresh run; stays mounted on the host map until the
  // user dismisses it via the attribution chip's close button or
  // re-runs the tool.
  const [osmOverlay, setOsmOverlay] = useState<{
    id: string;
    /** MapLayer id pushed into every map's state by
     *  pushOsmResultLayerToAllMaps. Used by the chip's dismiss
     *  button to clean up both the layer entry AND the chip in
     *  one click. */
    layerId: string;
    features: OsmOverlayFeature[];
    attribution: string;
    featureCount: number;
    truncated: boolean;
  } | null>(null);
  useEffect(() => {
    if (!toolId) {
      setStatus('missing');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${toolId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setStatus('missing');
          return;
        }
        const body = (await res.json()) as ToolItem;
        if (cancelled) return;
        setTool(body);
        setStatus('ok');
      } catch {
        if (!cancelled) setStatus('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toolId]);

  const runTool = () => {
    const action = tool?.data?.action;
    if (!action) return;
    if (action.kind === 'recipe' || action.kind === 'osm-relational-query') {
      // Both kinds collect parameters in the same panel; the
      // backend dispatches on action.kind once we POST.
      setRecipePanelOpen(true);
      return;
    }
    if (action.kind === 'open-item') {
      const view = action.view ? `?view=${encodeURIComponent(action.view)}` : '';
      const href = `/items/${action.targetItemId}${view}`;
      if (action.newTab) {
        window.open(href, '_blank', 'noopener,noreferrer');
      } else {
        window.location.assign(href);
      }
      return;
    }
    if (action.kind === 'open-url') {
      if (!action.url) return;
      if (action.newTab) {
        window.open(action.url, '_blank', 'noopener,noreferrer');
      } else {
        window.location.assign(action.url);
      }
      return;
    }
    if (action.kind === 'export-layer') {
      // #110 export-layer tool action.  Fetch the bound layer's
      // features over the API (NOT the live MapLibre source) so
      // the export covers the whole layer, not just whatever
      // tiles are currently in the user's viewport cache.  This
      // is what differentiates the tool action from the Export
      // widget: tools are "give me everything", widget is "give
      // me what I'm looking at".
      void (async () => {
        try {
          const res = await fetch(
            `/api/portal/items/${encodeURIComponent(action.targetItemId)}/layers/${encodeURIComponent(action.layerKey)}/features`,
            { cache: 'no-store' },
          );
          if (!res.ok) {
            console.warn('[tool:export-layer] HTTP', res.status);
            return;
          }
          const body = (await res.json()) as
            | { features?: Array<{ id?: string; geometry?: unknown; properties?: Record<string, unknown> | null }> }
            | Array<{ id?: string; geometry?: unknown; properties?: Record<string, unknown> | null }>;
          const rows = Array.isArray(body) ? body : body.features ?? [];
          if (rows.length === 0) {
            console.info('[tool:export-layer] no features');
            return;
          }
          exportFeatures(
            rows.map((f) => ({
              ...(f.id !== undefined ? { id: String(f.id) } : {}),
              geometry: f.geometry,
              properties: (f.properties ?? null) as
                | Record<string, unknown>
                | null,
            })),
            action.format,
            {
              filename: sanitizeExportFilename(tool.title || 'export'),
              includeGeometryWkt: action.format === 'xlsx',
            },
          );
        } catch (err) {
          console.warn('[tool:export-layer] failed', err);
        }
      })();
      return;
    }
  };

  // Resolve the button label: prefer the explicit `text` set on
  // the button widget (so the author can override the tool's name),
  // fall back to the tool's title once we've loaded it.  Loading
  // state keeps the existing text so the runtime doesn't flash a
  // placeholder.
  const visibleText =
    text && text !== 'Button' ? text : tool?.title ?? text;
  const disabled = status !== 'ok' || !tool?.data?.action;

  // In-bar: edge-to-edge wrapper that the button fills with h-full,
  // so the icon-link claims its slot the same way every other
  // toolbar widget does.  Off-bar: centered with breathing room.
  const wrapperClass = inAppBar
    ? 'flex h-full w-full'
    : 'flex h-full w-full items-center justify-center p-2';
  // Bigger icons in-bar to match Search / Print / Basemap stroke
  // weight; smaller in the canvas / standalone pill so the icon
  // doesn't crowd a tight rounded-full container.
  const iconSizeClass = inAppBar
    ? '[&_svg]:h-5 [&_svg]:w-5'
    : '[&_svg]:h-4 [&_svg]:w-4';
  // In-bar labels sit BELOW the icon (vertical stack); off-bar they
  // sit inline next to the icon (horizontal pill).  The container
  // className already supplies flex-col vs row, so the text node
  // just needs the right typography for each mode.
  const labelClass = inAppBar
    ? 'text-2xs font-medium leading-none'
    : '';
  return (
    <div className={wrapperClass}>
      <button
        type="button"
        disabled={disabled}
        onClick={runTool}
        title={
          status === 'missing'
            ? 'Tool no longer available'
            : tool?.title ?? 'Tool'
        }
        aria-label={hideText ? visibleText : undefined}
        className={`${className} ${
          inAppBar ? 'h-full w-full' : ''
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {iconHtml ? (
          <span
            aria-hidden
            dangerouslySetInnerHTML={{ __html: iconHtml }}
            className={iconSizeClass}
          />
        ) : null}
        {!hideText ? (
          <span className={labelClass}>{visibleText}</span>
        ) : null}
      </button>
      {recipePanelOpen &&
      tool &&
      (tool.data?.action?.kind === 'recipe' ||
        tool.data?.action?.kind === 'osm-relational-query') &&
      toolId ? (
        (() => {
          const bbox = firstMapBbox(ctx);
          return (
            <RecipeRunPanel
              toolId={toolId}
              toolTitle={tool.title}
              {...(typeof (tool.data as { hint?: unknown }).hint === 'string'
                ? { toolHint: (tool.data as { hint: string }).hint }
                : {})}
              recipe={
                tool.data.action as
                  | RecipeAction
                  | import('@gratis-gis/shared-types').OsmRelationalQueryAction
              }
              hostLayers={buildHostLayerOptions(ctx)}
              {...(bbox ? { hostBbox: bbox } : {})}
              getDrawMap={() => firstMapInstance(ctx)}
              onClose={() => setRecipePanelOpen(false)}
              onResult={(result) => {
                if (result.output.kind === 'selection') {
                  applyRecipeSelection(ctx, {
                    output: result.output,
                  });
                } else if (result.output.kind === 'osm-relational-result') {
                  // #142: relational query result handler.  Push
                  // three MapLayer entries (anchor, supporting,
                  // buffers) so the user sees the survivors, the
                  // contributing OSM features, and the search
                  // radius rings all on the host map at once.
                  // Camera fits to the anchor's bbox -- the user
                  // came here for the matches, not the buffer
                  // outline.
                  applyRelationalResult({
                    ctx,
                    toolId,
                    toolTitle: tool?.title ?? 'OSM',
                    output: result.output,
                  });
                } else if (result.output.kind === 'osm-features-overlay') {
                  // #141 wave B: push the result as a real MapLayer
                  // into every Map widget's state so the LayerList,
                  // attribute table, popups, and standard styling /
                  // delete controls all pick it up automatically.
                  // The attribution chip stays mounted alongside for
                  // the ODbL credit + Save-as-layer + result count;
                  // it no longer drives the rendering itself.
                  if (ctx && result.output.features.length > 0) {
                    const newLayer = buildOsmResultLayer({
                      toolId,
                      toolTitle: tool?.title ?? 'OSM',
                      ...(result.output.presetLabels &&
                      result.output.presetLabels.length > 0
                        ? { presetLabels: result.output.presetLabels }
                        : {}),
                      features: result.output.features,
                    });
                    pushOsmResultLayerToAllMaps(ctx, newLayer);
                  }
                  setOsmOverlay({
                    // Stable id keyed on the toolId so successive runs
                    // of the same tool replace the prior overlay rather
                    // than stacking; different tools each get their
                    // own overlay slot. Mirrors the layer id used
                    // inside the host MapData so dismiss can clean
                    // both up in one shot.
                    id: `tool-${toolId}`,
                    layerId: `osm-result/${toolId}`,
                    features: result.output.features as OsmOverlayFeature[],
                    attribution: result.output.attribution,
                    featureCount: result.output.featureCount,
                    truncated: result.output.truncated,
                  });
                  // #141 wave A: zoom the host map to the bbox of the
                  // returned features so the user sees where the matches
                  // actually landed. Skips if there are zero results
                  // (the chip's "No matches" state surfaces that case)
                  // or if the map instance isn't available yet.
                  if (result.output.features.length > 0) {
                    const m = firstMapInstance(ctx);
                    if (m) {
                      const bb = bboxOfFeatures(result.output.features);
                      if (bb) {
                        m.fitBounds(bb, {
                          padding: 60,
                          // 60ms shorter than MapLibre's default 1000ms
                          // so the camera arrives shortly after the
                          // overlay appears, not seconds later.
                          duration: 600,
                          // Don't zoom past z17 on a single-point
                          // result; otherwise the user lands at z22+
                          // on a postage-stamp view and loses context.
                          maxZoom: 17,
                        });
                      }
                    }
                  }
                }
              }}
            />
          );
        })()
      ) : null}
      {osmOverlay && ctx ? (
        // #141 wave B: the feature rendering itself now lives in the
        // host MapData.layers via the geojson-inline MapLayer the
        // tool-run handler pushed in. MapCanvas renders it through
        // the standard geojson path so LayerList / Legend /
        // AttributeTable pick it up automatically. The chip remains
        // mounted as a top-of-map summary -- result count, ODbL
        // attribution, Save-as-layer, and a Dismiss that nukes both
        // the chip and the layer in one click.
        <OsmAttributionChip
          attribution={osmOverlay.attribution}
          featureCount={osmOverlay.featureCount}
          truncated={osmOverlay.truncated}
          features={osmOverlay.features}
          onDismiss={() => {
            // Pull the layer out of every map's state so the user
            // doesn't have to also delete it from the LayerList.
            // A LayerList delete still works for the manual path;
            // this is just the chip's one-click cleanup.
            removeLayerFromAllMaps(ctx, osmOverlay.layerId);
            setOsmOverlay(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Bottom-right ODbL attribution chip for the OSM overlay (#OSM).
 * ODbL requires "© OpenStreetMap contributors" on any view that
 * displays OSM-derived features; this chip satisfies the
 * requirement while also giving the user a one-click way to
 * dismiss the overlay.  Fixed-position so it stays put when the
 * map panes scroll.
 */
function OsmAttributionChip({
  attribution,
  featureCount,
  truncated,
  features,
  onDismiss,
}: {
  attribution: string;
  featureCount: number;
  truncated: boolean;
  /** Source features the overlay is currently displaying. Carried
   *  on the chip so the "Save as layer" button can POST them
   *  without re-fetching. */
  features: OsmOverlayFeature[];
  onDismiss: () => void;
}) {
  // #102: save-as-layer state machine. The button cycles through
  // four states: idle (default), saving (POST in-flight), saved
  // (success, shows a link to the new item), error (red text + a
  // retry option). All transient; closing the chip resets everything.
  const [saveState, setSaveState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved'; itemId: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function onSaveClick() {
    if (features.length === 0) return;
    // Prompt for a title. The browser's window.prompt is a
    // deliberate choice: the chip lives on top of the map and a
    // full modal would obscure context. If we later grow the chip
    // into a tray we can replace this with an inline input.
    const defaultTitle = `OSM overlay (${new Date().toLocaleString()})`;
    const title = window.prompt(
      'Save these features as a new data layer. Choose a name:',
      defaultTitle,
    );
    if (!title || title.trim().length === 0) return;
    setSaveState({ kind: 'saving' });
    try {
      const res = await fetch('/api/portal/osm/save-as-data-layer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: `Saved from OSM overlay. ${attribution}`,
          features,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { itemId: string };
      setSaveState({ kind: 'saved', itemId: json.itemId });
    } catch (err) {
      setSaveState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // #141 wave A: zero-result chip variant.  When the query ran
  // successfully but returned no features, surface that explicitly
  // instead of silently showing a "0 features" chip that reads like
  // a normal result.  The amber styling matches the public-testing
  // banner so the visual language is consistent for "heads up, this
  // is informational, not an error."
  if (featureCount === 0) {
    return createPortal(
      // #141 follow-up: chip lives at the top of the map area
      // (top-center) so users notice the result state. Originally
      // bottom-right; testers reported almost missing it.
      <div className="pointer-events-none fixed left-0 right-0 top-20 z-[900] flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[hsl(var(--app-warn)/0.4)] bg-[hsl(var(--app-warn)/0.1)] px-3 py-1.5 text-2xs shadow-raised">
          <span className="font-medium text-[hsl(var(--app-warn))]">
            No matches in this area
          </span>
          <span className="text-[hsl(var(--app-warn))]">·</span>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[hsl(var(--app-warn))] underline hover:text-[hsl(var(--app-warn))]"
          >
            {attribution}
          </a>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-[hsl(var(--app-warn)/0.4)] bg-[hsl(var(--app-warn)/0.15)] px-1.5 text-2xs text-[hsl(var(--app-warn))] hover:bg-[hsl(var(--app-warn)/0.25)]"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    // #141 follow-up: top-center placement so the result chip is
    // immediately visible. Bottom-right was easy to miss.
    <div className="pointer-events-none fixed left-0 right-0 top-20 z-[900] flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0)/0.95)] px-3 py-1.5 text-2xs shadow-raised backdrop-blur">
        <span className="text-[hsl(var(--app-ink-0))]">
          Found {featureCount} OSM feature{featureCount === 1 ? '' : 's'}
          {truncated ? ' (truncated)' : ''}
        </span>
        <span className="text-[hsl(var(--app-muted))]">·</span>
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[hsl(var(--app-muted))] underline hover:text-[hsl(var(--app-ink-1))]"
        >
          {attribution}
        </a>
        {/* #102: save-as-layer affordance. Renders differently per
            state so the user always knows what just happened. */}
        {saveState.kind === 'idle' ? (
          <button
            type="button"
            onClick={onSaveClick}
            className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 text-2xs font-medium text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
            aria-label="Save these features as a data layer"
            title="Save these features as a data layer"
          >
            Save as layer
          </button>
        ) : null}
        {saveState.kind === 'saving' ? (
          <span className="text-[hsl(var(--app-muted))]">Saving…</span>
        ) : null}
        {saveState.kind === 'saved' ? (
          <a
            href={`/items/${saveState.itemId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-[hsl(var(--app-accent)/0.4)] bg-[hsl(var(--app-accent)/0.1)] px-2 text-2xs font-medium text-[hsl(var(--app-accent))] hover:bg-[hsl(var(--app-accent)/0.2)]"
          >
            Saved. Open layer
          </a>
        ) : null}
        {saveState.kind === 'error' ? (
          <>
            <span className="text-[hsl(var(--app-danger))]" title={saveState.message}>
              Save failed
            </span>
            <button
              type="button"
              onClick={() => setSaveState({ kind: 'idle' })}
              className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-1.5 text-2xs text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-1))]"
              aria-label="Retry save"
            >
              Retry
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-1.5 text-2xs text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-1))]"
          aria-label="Dismiss OSM overlay"
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Local typedef for the recipe-action shape the runtime sees on the
 * wire.  Mirrors the shared-types RecipeAction at the fields the
 * runtime panel and the selection applier consume.  Kept narrow so
 * a stale tool with a future field doesn't crash the runtime.
 */
type RecipeActionShape = {
  kind: 'recipe';
  recipeVersion?: number;
  parameters?: unknown[];
  pipeline?: unknown[];
  output?: { kind?: string; targetParameterRef?: string };
  selectionLimit?: number;
};

/**
 * Local typedef for the OSM relational-query action shape on the
 * wire (#142). Mirrors OsmRelationalQueryAction's runtime-visible
 * fields. Kept narrow so a stale tool with a future field doesn't
 * crash the runtime; the backend is the source of truth for the
 * full shape.
 */
type RelationalActionShape = {
  kind: 'osm-relational-query';
  relationalVersion?: number;
  anchorPreset?: string;
  conditions?: Array<{
    preset?: string;
    distance?: { value?: number; unit?: string };
  }>;
  parameters?: unknown[];
  aoiParameterRef?: string;
};

/**
 * Collect host-app layer options for the recipe runtime panel: one
 * entry per resolved app target, augmented with the current
 * selection on that layer (collected across every mounted Map
 * widget) and a sample bbox from one of the maps that hosts it.
 */
function buildHostLayerOptions(
  ctx: CustomMapsCtx | null,
): HostLayerOption[] {
  if (!ctx) return [];
  const layers: HostLayerOption[] = [];
  for (const target of ctx.resolvedTargets) {
    const mapLayerId = target.mapLayer.id;
    // Union the per-map selections for this MapLayer across every
    // Map widget that has it.
    const selected = new Set<string | number>();
    for (const state of Object.values(ctx.states)) {
      const ids = state.selection[mapLayerId];
      if (ids) for (const x of ids) selected.add(x);
    }
    // First map's bbox is sufficient for "use current view"; if
    // there are multiple maps we don't try to merge.
    const mapInstance = Object.values(ctx.maps).find((m) => m) ?? null;
    let mapBbox: [number, number, number, number] | undefined;
    if (mapInstance) {
      const b = mapInstance.getBounds();
      mapBbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }
    layers.push({
      mapLayerId,
      itemId: target.dataLayerId,
      layerKey: target.layerKey,
      title: target.title,
      ...(selected.size > 0 ? { selectedIds: Array.from(selected) } : {}),
      ...(mapBbox ? { mapBbox } : {}),
    });
  }
  return layers;
}

/**
 * Convenience getter for the host's "current view" bbox; first map
 * wins.  Used as a fallback for the recipe panel's runtime-draw UI
 * when the resolvedTarget doesn't carry a per-layer bbox.
 */
function firstMapBbox(
  ctx: CustomMapsCtx | null,
): [number, number, number, number] | null {
  if (!ctx) return null;
  const m = Object.values(ctx.maps).find((x) => x);
  if (!m) return null;
  const b = m.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

/**
 * Convenience getter for the host's first mounted MapLibre instance.
 * The recipe panel's "Draw on map" affordance attaches to this map;
 * a multi-map app could later expose a picker, but for v1 the first
 * map wins (typical apps have exactly one).
 */
function firstMapInstance(
  ctx: CustomMapsCtx | null,
): maplibregl.Map | null {
  if (!ctx) return null;
  return Object.values(ctx.maps).find((x) => x) ?? null;
}

/**
 * #141 wave B: build a MapLayer descriptor for an OSM tool-run
 * result.  The resulting layer uses the `geojson-inline` source
 * kind so MapCanvas renders it through its standard geojson path
 * and LayerList / Legend / AttributeTable pick it up without any
 * special-casing.  Standard delete / toggle / restyle controls
 * therefore work for free.
 *
 * Style defaults to a distinct purple-accent so OSM results read
 * as "not part of the user's own data."  Popup is enabled so a
 * click on a feature opens a standard popup (the popup body
 * resolves whatever field the user later configures; for now the
 * title template falls back to `name`).  The id is stable per
 * toolId so a re-run of the same tool replaces the prior layer
 * rather than stacking duplicates.
 */
function buildOsmResultLayer(args: {
  toolId: string;
  toolTitle: string;
  /** Human-readable preset labels returned by the runner (e.g.
   *  ["School", "Park"]).  Used to title the LayerList entry with
   *  what the user actually searched for, falling back to the tool
   *  title when empty (older runners or recipes with no preset). */
  presetLabels?: readonly string[];
  features: readonly { type: 'Feature'; id: string; properties: Record<string, unknown>; geometry: unknown }[];
}): MapLayer {
  // Deterministic id keyed on toolId so a re-run replaces the
  // prior layer rather than stacking. Caller is responsible for
  // removing this entry from layers[] before pushing the new one
  // when re-running.
  const id = `osm-result/${args.toolId}`;
  const fc = {
    type: 'FeatureCollection' as const,
    features: args.features as unknown as GeoJSON.Feature[],
  };
  const popup: MapLayer['popup'] = {
    ...structuredClone(DEFAULT_LAYER_POPUP),
    enabled: true,
    // Default title template uses the OSM-canonical `name` tag; the
    // popup renderer falls back to the layer title when the field
    // is missing. The picked-mode field list calls out the OSM tags
    // a user is most likely to care about; the popup renderer hides
    // rows whose field is absent from a given feature, so unnamed
    // or address-less features still produce a clean popup.
    mode: 'picked',
    titleTemplate: '{{name}}',
    fields: [
      'name',
      'operator',
      'website',
      'phone',
      'opening_hours',
      'addr:full',
      'addr:street',
      'addr:city',
    ],
  };
  // Purple-ish accent so OSM results read as distinct from
  // PostGIS-backed data layers.  Same color the standalone
  // OsmOverlayLayer used so users who saw OSM results in wave A
  // get a consistent visual identity.
  const OSM_COLOR = '#7c3aed';
  const style: MapLayer['style'] = {
    ...structuredClone(DEFAULT_LAYER_STYLE),
    polygon: {
      ...structuredClone(DEFAULT_LAYER_STYLE.polygon),
      fillColor: OSM_COLOR,
      fillOpacity: 0.2,
      strokeColor: OSM_COLOR,
      strokeWidth: 2,
    },
    line: {
      ...structuredClone(DEFAULT_LAYER_STYLE.line),
      color: OSM_COLOR,
      width: 2,
    },
    point: {
      ...structuredClone(DEFAULT_LAYER_STYLE.point),
      color: OSM_COLOR,
      strokeColor: '#ffffff',
      strokeWidth: 1.5,
      radius: 6,
    },
  };
  // Prefer the OSM category label(s) the user searched for over the
  // generic tool name.  "School, Park (12)" reads cleaner in the
  // LayerList than "Query OSM Features (OSM, 12)" and tells the user
  // what's actually on the map.  Falls back to the tool title when
  // the runner didn't supply labels (older API or no presets matched).
  const labelPart =
    args.presetLabels && args.presetLabels.length > 0
      ? args.presetLabels.join(', ')
      : args.toolTitle;
  return {
    id,
    title: `${labelPart} (${args.features.length})`,
    visible: true,
    opacity: 1,
    source: { kind: 'geojson-inline', geojson: fc },
    style,
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup,
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
}

/**
 * #142: relational query result handler.  Builds three MapLayer
 * entries (anchor, supporting, buffers) and pushes them onto every
 * mounted map, then fits the host map's camera to the anchor's
 * bbox.  Idempotent: re-running the same tool replaces the prior
 * three layers rather than stacking.
 */
function applyRelationalResult(args: {
  ctx: CustomMapsCtx | null;
  toolId: string;
  toolTitle: string;
  output: {
    anchor: {
      preset: string;
      presetLabel: string;
      features: ReadonlyArray<{
        type: 'Feature';
        id: string;
        properties: Record<string, unknown>;
        geometry: unknown;
      }>;
      candidateCount: number;
    };
    conditions: ReadonlyArray<{
      preset: string;
      presetLabel: string;
      distanceMeters: number;
      candidateCount: number;
      /** Per-condition supporting features used by the
       *  bearing-arc viz (#153 follow-up).  Optional so older
       *  API responses still parse. */
      supporting?: ReadonlyArray<{
        type: 'Feature';
        id: string;
        properties: Record<string, unknown>;
        geometry: unknown;
      }>;
    }>;
    supporting: ReadonlyArray<{
      type: 'Feature';
      id: string;
      properties: Record<string, unknown>;
      geometry: unknown;
    }>;
    buffers: ReadonlyArray<{
      type: 'Feature';
      id: string;
      properties: Record<string, unknown>;
      geometry: unknown;
    }>;
    /** Bearing predicates echoed from the action (#153 follow-up).
     *  Empty / missing when no bearings were configured. */
    bearings?: ReadonlyArray<{
      conditionIndex: number;
      bearingDegrees: number;
      toleranceDegrees: number;
    }>;
  };
}): void {
  const { ctx, toolId, toolTitle, output } = args;
  if (!ctx) return;
  // Build a condition-label suffix that titles the result layers
  // with what the user actually queried (e.g. "School near Park
  // and Liquor store").
  const condLabels = output.conditions.map((c) => c.presetLabel);
  const condSuffix = condLabels.length > 0 ? ` near ${condLabels.join(' and ')}` : '';
  // Purple accent on anchors matches the OSM identity from #141 so
  // the user can tell this is OSM data, not a portal data_layer.
  // Buffers fade to a near-transparent purple ring; supporting
  // features pick up amber so the eye distinguishes them from
  // anchors at a glance even though both are OSM-derived.
  const ANCHOR_COLOR = '#7c3aed';
  const BUFFER_COLOR = '#7c3aed';
  const SUPPORTING_COLOR = '#d97706';
  const anchorLayer: MapLayer = {
    id: `osm-relational-anchor/${toolId}`,
    title: `${output.anchor.presetLabel}${condSuffix} (${output.anchor.features.length})`,
    visible: true,
    opacity: 1,
    source: {
      kind: 'geojson-inline',
      geojson: {
        type: 'FeatureCollection',
        features: output.anchor.features as unknown as GeoJSON.Feature[],
      },
    },
    style: {
      ...structuredClone(DEFAULT_LAYER_STYLE),
      polygon: {
        ...structuredClone(DEFAULT_LAYER_STYLE.polygon),
        fillColor: ANCHOR_COLOR,
        fillOpacity: 0.2,
        strokeColor: ANCHOR_COLOR,
        strokeWidth: 2,
      },
      line: {
        ...structuredClone(DEFAULT_LAYER_STYLE.line),
        color: ANCHOR_COLOR,
        width: 2,
      },
      point: {
        ...structuredClone(DEFAULT_LAYER_STYLE.point),
        color: ANCHOR_COLOR,
        strokeColor: '#ffffff',
        strokeWidth: 1.5,
        radius: 7,
      },
    },
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup: {
      ...structuredClone(DEFAULT_LAYER_POPUP),
      enabled: true,
      mode: 'picked',
      titleTemplate: '{{name}}',
      fields: [
        'name',
        'operator',
        'website',
        'phone',
        'opening_hours',
        'addr:full',
        'addr:street',
        'addr:city',
      ],
    },
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
  const supportingLayer: MapLayer = {
    id: `osm-relational-supporting/${toolId}`,
    title: `${toolTitle} supporting features (${output.supporting.length})`,
    visible: true,
    opacity: 1,
    source: {
      kind: 'geojson-inline',
      geojson: {
        type: 'FeatureCollection',
        features: output.supporting as unknown as GeoJSON.Feature[],
      },
    },
    style: {
      ...structuredClone(DEFAULT_LAYER_STYLE),
      polygon: {
        ...structuredClone(DEFAULT_LAYER_STYLE.polygon),
        fillColor: SUPPORTING_COLOR,
        fillOpacity: 0.18,
        strokeColor: SUPPORTING_COLOR,
        strokeWidth: 1.5,
      },
      line: {
        ...structuredClone(DEFAULT_LAYER_STYLE.line),
        color: SUPPORTING_COLOR,
        width: 1.5,
      },
      point: {
        ...structuredClone(DEFAULT_LAYER_STYLE.point),
        color: SUPPORTING_COLOR,
        strokeColor: '#ffffff',
        strokeWidth: 1,
        radius: 5,
      },
    },
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup: {
      ...structuredClone(DEFAULT_LAYER_POPUP),
      enabled: true,
      mode: 'picked',
      titleTemplate: '{{name}}',
      fields: ['name', 'operator', 'addr:full', 'addr:street'],
    },
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
  const buffersLayer: MapLayer = {
    id: `osm-relational-buffers/${toolId}`,
    title: `${toolTitle} search buffers`,
    visible: true,
    opacity: 1,
    source: {
      kind: 'geojson-inline',
      geojson: {
        type: 'FeatureCollection',
        features: output.buffers as unknown as GeoJSON.Feature[],
      },
    },
    style: {
      ...structuredClone(DEFAULT_LAYER_STYLE),
      polygon: {
        ...structuredClone(DEFAULT_LAYER_STYLE.polygon),
        fillColor: BUFFER_COLOR,
        fillOpacity: 0.08,
        strokeColor: BUFFER_COLOR,
        strokeWidth: 1,
      },
    },
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup: structuredClone(DEFAULT_LAYER_POPUP),
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
  // #153 follow-up: bearing arc viz layer.  For each bearing
  // predicate, draw a translucent fan at each per-condition
  // supporting feature pointed in the configured direction.
  // Helps the user see WHY an anchor survived ("this watertower
  // is NW of THIS railroad").  Built as a separate MapLayer so
  // it can be toggled / restyled / removed independently.
  const BEARING_COLOR = '#0ea5e9';
  const arcFeatures = buildBearingArcs(output);
  const bearingsLayer: MapLayer | null =
    arcFeatures.length > 0
      ? {
          id: `osm-relational-bearings/${toolId}`,
          title: `${toolTitle} bearing arcs`,
          visible: true,
          opacity: 1,
          source: {
            kind: 'geojson-inline',
            geojson: {
              type: 'FeatureCollection',
              features: arcFeatures,
            },
          },
          style: {
            ...structuredClone(DEFAULT_LAYER_STYLE),
            polygon: {
              ...structuredClone(DEFAULT_LAYER_STYLE.polygon),
              fillColor: BEARING_COLOR,
              fillOpacity: 0.12,
              strokeColor: BEARING_COLOR,
              strokeWidth: 1,
            },
          },
          renderer: structuredClone(DEFAULT_LAYER_RENDERER),
          popup: structuredClone(DEFAULT_LAYER_POPUP),
          interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
          labels: structuredClone(DEFAULT_LAYER_LABELS),
          search: structuredClone(DEFAULT_LAYER_SEARCH),
          scale: structuredClone(DEFAULT_LAYER_SCALE),
          access: structuredClone(DEFAULT_LAYER_ACCESS),
          filter: null,
        }
      : null;

  // Push in display-stacking order (top of list first under the
  // array[0]=top convention): anchor on top, supporting next,
  // bearing arcs (when present) under those, buffers on the
  // bottom so the rings sit underneath the markers they describe.
  for (const mapWidgetId of Object.keys(ctx.states)) {
    ctx.update(mapWidgetId, (cur) => {
      const prior = cur.mapData.layers ?? [];
      const drop = new Set([
        anchorLayer.id,
        supportingLayer.id,
        buffersLayer.id,
        ...(bearingsLayer ? [bearingsLayer.id] : []),
      ]);
      const withoutPrior = prior.filter((l) => !drop.has(l.id));
      const newLayers = bearingsLayer
        ? [anchorLayer, supportingLayer, bearingsLayer, buffersLayer]
        : [anchorLayer, supportingLayer, buffersLayer];
      return {
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: [...newLayers, ...withoutPrior],
        },
      };
    });
  }
  // Fit camera to the anchor's bbox so the user sees the matches.
  if (output.anchor.features.length > 0) {
    const m = firstMapInstance(ctx);
    if (m) {
      const bb = bboxOfFeatures(
        output.anchor.features as unknown as GeoJSON.Feature[],
      );
      if (bb) {
        m.fitBounds(bb, { padding: 80, duration: 600, maxZoom: 16 });
      }
    }
  }
}

/**
 * Build GeoJSON fan polygons for the bearing-arc viz layer
 * (#153 follow-up).  For each bearing predicate in the result,
 * walk the indicated condition's supporting features and emit one
 * fan polygon per feature.  The fan is rooted at the supporting
 * feature's representative point and opens in the configured
 * compass direction at the condition's distance radius.
 *
 * Compass convention: 0=N, 90=E, 180=S, 270=W.  Vertex math
 * converts each step's bearing into a (lng, lat) offset using
 * the spherical approximation (1deg lat ~ 111 km; 1deg lng
 * ~ 111 km * cos(lat)).  Fine for the visualization at the
 * sub-kilometer radii relational tools typically use.
 */
function buildBearingArcs(output: {
  conditions: ReadonlyArray<{
    distanceMeters: number;
    supporting?: ReadonlyArray<{
      geometry: unknown;
    }>;
  }>;
  bearings?: ReadonlyArray<{
    conditionIndex: number;
    bearingDegrees: number;
    toleranceDegrees: number;
  }>;
}): GeoJSON.Feature[] {
  const bearings = output.bearings ?? [];
  if (bearings.length === 0) return [];
  const arcs: GeoJSON.Feature[] = [];
  const ARC_STEPS = 24; // resolution of the fan edge
  for (const bp of bearings) {
    const cond = output.conditions[bp.conditionIndex];
    if (!cond || !cond.supporting || cond.supporting.length === 0) continue;
    const radius = Math.max(1, cond.distanceMeters);
    const tolerance = Math.max(0, Math.min(180, bp.toleranceDegrees));
    const wanted = ((bp.bearingDegrees % 360) + 360) % 360;
    for (const support of cond.supporting) {
      const center = firstLeafCoord(support.geometry);
      if (!center) continue;
      const ring = buildFanRing(
        center,
        radius,
        wanted - tolerance,
        wanted + tolerance,
        ARC_STEPS,
      );
      arcs.push({
        type: 'Feature',
        properties: {
          bearingDegrees: wanted,
          toleranceDegrees: tolerance,
          radiusMeters: radius,
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return arcs;
}

/**
 * Return the first leaf [lng, lat] from any GeoJSON geometry.
 * Walks nested coordinate arrays.  Used as the representative
 * point for a feature when only one is needed (bearing fan
 * origins, etc.).
 */
function firstLeafCoord(geom: unknown): [number, number] | null {
  if (!geom || typeof geom !== 'object') return null;
  const g = geom as { coordinates?: unknown };
  let cur: unknown = g.coordinates;
  for (let i = 0; i < 6; i++) {
    if (!Array.isArray(cur)) return null;
    if (
      cur.length >= 2 &&
      typeof cur[0] === 'number' &&
      typeof cur[1] === 'number'
    ) {
      return [cur[0] as number, cur[1] as number];
    }
    cur = cur[0];
  }
  return null;
}

/**
 * Compute a closed polygon ring approximating a circular fan
 * (wedge) rooted at `center`, opening between compass bearings
 * `startDeg` and `endDeg` at radius `meters`.  The result is a
 * fan polygon: [center, arc-step-1, arc-step-2, ..., center].
 */
function buildFanRing(
  center: [number, number],
  meters: number,
  startDeg: number,
  endDeg: number,
  steps: number,
): Array<[number, number]> {
  const [lng0, lat0] = center;
  const lat0Rad = (lat0 * Math.PI) / 180;
  const cosLat = Math.cos(lat0Rad);
  const latPerMeter = 1 / 111_000;
  const lngPerMeter = 1 / (111_000 * Math.max(cosLat, 0.0001));
  const ring: Array<[number, number]> = [[lng0, lat0]];
  for (let i = 0; i <= steps; i++) {
    const b = startDeg + ((endDeg - startDeg) * i) / steps;
    const bRad = (b * Math.PI) / 180;
    const dLat = meters * latPerMeter * Math.cos(bRad);
    const dLng = meters * lngPerMeter * Math.sin(bRad);
    ring.push([lng0 + dLng, lat0 + dLat]);
  }
  ring.push([lng0, lat0]);
  return ring;
}

/**
 * Push an OSM result MapLayer into every Map widget's state. If a
 * prior layer with the same id (same toolId) already exists, it
 * gets replaced rather than duplicated. Idempotent.
 */
function pushOsmResultLayerToAllMaps(
  ctx: CustomMapsCtx,
  newLayer: MapLayer,
): void {
  for (const mapWidgetId of Object.keys(ctx.states)) {
    ctx.update(mapWidgetId, (cur) => {
      const existing = cur.mapData.layers ?? [];
      // Drop any prior entry with the same id so a re-run replaces
      // the previous result instead of stacking.
      const withoutPrior = existing.filter((l) => l.id !== newLayer.id);
      // Prepend the result so the just-run tool's output appears at
      // the TOP of the LayerList where the user is looking for it.
      // Under the array[0] = top-of-render-stack convention, this
      // also draws the new layer ON TOP of every existing layer --
      // the result is visible no matter what saved layers the user
      // had loaded underneath.
      return {
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: [newLayer, ...withoutPrior],
        },
      };
    });
  }
}

/**
 * Remove the OSM result MapLayer (matched by id) from every Map
 * widget's state. Used when the user dismisses the attribution
 * chip; clears both the rendered features and the LayerList entry
 * in one shot.
 */
function removeLayerFromAllMaps(
  ctx: CustomMapsCtx,
  layerId: string,
): void {
  for (const mapWidgetId of Object.keys(ctx.states)) {
    ctx.update(mapWidgetId, (cur) => ({
      ...cur,
      mapData: {
        ...cur.mapData,
        layers: (cur.mapData.layers ?? []).filter((l) => l.id !== layerId),
      },
    }));
  }
}

/**
 * Compute a [west, south, east, north] bbox over a feature
 * collection. Walks every coordinate so it works regardless of
 * geometry type (point, line, polygon, multi*).  Returns null
 * when the input is empty or when no geometry yields a real
 * coordinate (defensive: a malformed feature shouldn't crash
 * the fly-to). The result is shaped for maplibregl.Map.fitBounds.
 *
 * Used by #141 (OSM result handling) to zoom the host map to
 * the extent of a recipe's OSM features.
 */
function bboxOfFeatures(
  features: readonly { geometry: unknown }[],
): [[number, number], [number, number]] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  const visit = (coord: unknown): void => {
    if (
      Array.isArray(coord) &&
      coord.length >= 2 &&
      typeof coord[0] === 'number' &&
      typeof coord[1] === 'number'
    ) {
      const x = coord[0];
      const y = coord[1];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        count += 1;
      }
      return;
    }
    if (Array.isArray(coord)) {
      for (const c of coord) visit(c);
    }
  };
  for (const f of features) {
    const g = f.geometry as { coordinates?: unknown } | null | undefined;
    if (g && 'coordinates' in g) visit(g.coordinates);
  }
  if (count === 0) return null;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

/**
 * Apply a recipe runner's selection result to every Map widget
 * that has the target layer.  The result identifies the layer by
 * (itemId, layerKey); we match each MapLayer in each MapState
 * against that and replace its selection slot with the new
 * featureIds set.
 */
function applyRecipeSelection(
  ctx: CustomMapsCtx | null,
  result: { output: { kind: 'selection'; layer: { itemId: string; layerKey?: string }; featureIds: Array<string | number> } },
): void {
  if (!ctx) return;
  const { itemId, layerKey } = result.output.layer;
  for (const [mapWidgetId, state] of Object.entries(ctx.states)) {
    for (const ml of state.mapData.layers) {
      if (ml.source.kind !== 'data-layer') continue;
      if (ml.source.itemId !== itemId) continue;
      if ((ml.source.layerKey ?? undefined) !== (layerKey ?? undefined)) continue;
      // Match -- replace selection on that layer for this map.
      ctx.update(mapWidgetId, (cur) => ({
        ...cur,
        selection: {
          ...cur.selection,
          [ml.id]: new Set(result.output.featureIds),
        },
      }));
    }
  }
}

function DividerWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'divider') return null;
  const { thicknessPx, color, style } = widget.config;
  return (
    <div className="flex h-full w-full items-center px-2">
      <hr
        className="w-full"
        style={{
          borderTop: `${thicknessPx ?? 1}px ${style ?? 'solid'} ${color ?? 'var(--color-border, #e5e7eb)'}`,
          margin: 0,
        }}
      />
    </div>
  );
}

function EmbedWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'embed') return null;
  const { url, title, strict } = widget.config;
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[hsl(var(--app-surface-2)/0.4)] text-xs text-[hsl(var(--app-muted))]">
        No URL set
      </div>
    );
  }
  // Sandbox flags. Default allows scripts + same-origin + popups +
  // forms (typical for embedded dashboards). Strict mode drops
  // same-origin so the embedded site can't read parent storage /
  // cookies, useful for arbitrary third-party URLs.
  const sandbox = strict
    ? 'allow-scripts allow-popups allow-forms'
    : 'allow-scripts allow-same-origin allow-popups allow-forms';
  return (
    <iframe
      src={url}
      title={title ?? url}
      sandbox={sandbox}
      className="h-full w-full border-0"
      loading="lazy"
    />
  );
}

// ---- Mapcentric quick wins (#361 part 2) -----------------------------------

function BookmarkWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'bookmark') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, bookmarks } = widget.config;
  // Mutable in the runtime: authors capture the bound map's current
  // viewport via the "+" button. We hold these ad-hoc captures in
  // local state since the runtime doesn't have a save flow.
  // Hash + timestamp would be redundant -- the design-time list is
  // the source of truth on reload.
  const [adhoc, setAdhoc] = useState<typeof bookmarks>([]);
  const all = useMemo(() => [...bookmarks, ...adhoc], [bookmarks, adhoc]);

  function captureCurrent() {
    const map = ctx?.maps[mapWidgetId];
    if (!map) return;
    const center = map.getCenter();
    setAdhoc((cur) => [
      ...cur,
      {
        id: `bm_${Math.random().toString(36).slice(2, 8)}`,
        name: `Captured ${cur.length + 1}`,
        center: [center.lng, center.lat] as [number, number],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      },
    ]);
  }

  function flyToBookmark(b: (typeof bookmarks)[number]) {
    const map = ctx?.maps[mapWidgetId];
    if (!map) return;
    map.flyTo({
      center: b.center,
      zoom: b.zoom,
      bearing: b.bearing ?? 0,
      pitch: b.pitch ?? 0,
      duration: 800,
    });
  }

  return (
    <WidgetFrame icon={BookmarkIcon} title="Bookmarks">
      {!mapWidgetId ? (
        <p className="p-3 text-xs text-[hsl(var(--app-muted))]">Bind a map widget.</p>
      ) : all.length === 0 && !ctx?.maps[mapWidgetId] ? (
        <p className="p-3 text-xs text-[hsl(var(--app-muted))]">No bookmarks. Map not ready.</p>
      ) : (
        <ul className="flex-1 space-y-1 overflow-auto p-2">
          {all.length === 0 ? (
            <li className="px-2 py-1 text-xs text-[hsl(var(--app-muted))]">
              No bookmarks yet. Capture the current view with the + button.
            </li>
          ) : (
            all.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => flyToBookmark(b)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[hsl(var(--app-ink-1))] transition-colors hover:bg-[hsl(var(--app-surface-2))]"
                >
                  <BookmarkIcon
                    className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]"
                    strokeWidth={1.75}
                  />
                  <span className="truncate">{b.name}</span>
                  <span className="ml-auto font-mono text-2xs text-[hsl(var(--app-muted))]">
                    z{b.zoom.toFixed(1)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {ctx?.maps[mapWidgetId] && (
        <div className="border-t border-[hsl(var(--app-border))] px-2 py-1.5">
          <button
            type="button"
            onClick={captureCurrent}
            className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[hsl(var(--app-border))] px-2 py-1 text-xs text-[hsl(var(--app-muted))] hover:border-[hsl(var(--app-accent)/0.4)] hover:text-[hsl(var(--app-ink-1))]"
            title="Capture the bound map's current viewport"
          >
            + Add current view
          </button>
        </div>
      )}
    </WidgetFrame>
  );
}

/**
 * Elevation profile widget: a toggle that arms the shared
 * ElevationProfileTool against the bound Map widget. The tool's
 * own panel portals into the map container, so this widget's
 * footprint in the layout is just the button. While active it
 * claims popup suppression on the bound map so draw clicks don't
 * open feature popups.
 */
function ElevationProfileWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'elevation-profile') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId } = widget.config;
  const map = ctx?.maps[mapWidgetId] ?? null;
  const terrain = ctx?.states[mapWidgetId]?.mapData.terrain ?? null;
  const [active, setActive] = useState(false);

  // Ref-shadow so the stable resolver reads the live terrain
  // setting without re-registering the tool's map handlers.
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;
  const resolveDem = useCallback(
    (bbox: [number, number, number, number]) =>
      resolveDemForBbox(terrainRef.current, bbox),
    [],
  );

  const setSuppressed = ctx?.setPopupSuppressed;
  useEffect(() => {
    if (!setSuppressed) return;
    setSuppressed(mapWidgetId, active);
    return () => setSuppressed(mapWidgetId, false);
  }, [setSuppressed, mapWidgetId, active]);

  return (
    <>
      <button
        type="button"
        onClick={() => setActive((v) => !v)}
        disabled={!map}
        aria-pressed={active}
        title="Elevation profile"
        style={
          active
            ? {
                backgroundColor: 'hsl(var(--app-header-ink))',
                color: 'hsl(var(--app-header-bg))',
              }
            : undefined
        }
        className={`group/tool flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? ''
            : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
        }`}
      >
        <ChartSpline className="h-5 w-5" strokeWidth={1.75} />
        <span className="text-2xs font-medium leading-none">Profile</span>
      </button>
      <ElevationProfileTool
        map={map}
        open={active}
        onClose={() => setActive(false)}
        resolveDemUrl={resolveDem}
      />
    </>
  );
}

/**
 * Magic outline widget: a toolbar toggle that arms the SAM
 * click-to-outline pipeline against the bound map's imagery. A
 * click traces the thing under the cursor into a polygon and POSTs
 * it to the chosen editable polygon layer, then refetches that
 * layer so the outline appears. Same engine (lib/sam-outline) the
 * standalone editor uses.
 */
function MagicOutlineWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'magic-outline') return null;
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);
  const map = ctx?.maps[cfg.mapWidgetId] ?? null;
  const mut = useMutationTargets({
    mapWidgetId: cfg.mapWidgetId,
    ...(typeof cfg.targetIndex === 'number'
      ? { targetIndex: cfg.targetIndex }
      : {}),
  });
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Live map layers (for finding the imagery to trace from) via a
  // ref so the stable click handler reads the current list.
  const layersRef = useRef(
    ctx?.states[cfg.mapWidgetId]?.mapData.layers ?? [],
  );
  layersRef.current = ctx?.states[cfg.mapWidgetId]?.mapData.layers ?? [];
  const mutRef = useRef(mut);
  mutRef.current = mut;

  // Suppress feature popups while arming clicks.
  const setSuppressed = ctx?.setPopupSuppressed;
  useEffect(() => {
    if (!setSuppressed) return;
    setSuppressed(cfg.mapWidgetId, active);
    return () => setSuppressed(cfg.mapWidgetId, false);
  }, [setSuppressed, cfg.mapWidgetId, active]);

  useEffect(() => {
    if (!map || !active) return;
    const canvas = map.getCanvas();
    const prev = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    let busy = false;
    let cancelled = false;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (busy) return;
      const imagery = layersRef.current.find(
        (l) => l.visible !== false && l.source.kind === 'tile',
      );
      if (!imagery || imagery.source.kind !== 'tile') {
        setStatus('Add an imagery layer to this map to outline from it.');
        window.setTimeout(() => !cancelled && setStatus(null), 3500);
        return;
      }
      const target = mutRef.current?.targets[0];
      if (!target) {
        setStatus('No editable polygon layer set. Add one in the app settings.');
        window.setTimeout(() => !cancelled && setStatus(null), 3500);
        return;
      }
      busy = true;
      setStatus('Outlining...');
      void import('@/lib/sam-outline')
        .then((mod) =>
          mod.outlineAt(
            (imagery.source as { itemId: string }).itemId,
            e.lngLat.lng,
            e.lngLat.lat,
            map.getZoom(),
            (m) => !cancelled && setStatus(m),
          ),
        )
        .then(async ({ ring }) => {
          if (cancelled) return;
          setStatus('Saving...');
          const res = await fetch(
            `/api/portal/items/${target.dataLayerId}/layers/${encodeURIComponent(
              target.layerKey,
            )}/features`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                features: [
                  {
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties: {},
                  },
                ],
              }),
            },
          );
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(text || `HTTP ${res.status}`);
          }
          if (cancelled) return;
          setStatus('Outline added.');
          ctx?.refreshMapLayer(cfg.mapWidgetId, target.mapLayer.id);
          window.setTimeout(() => !cancelled && setStatus(null), 2000);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setStatus(
            err instanceof Error
              ? err.message
              : 'The outline tool hit a problem.',
          );
          window.setTimeout(() => !cancelled && setStatus(null), 4000);
        })
        .finally(() => {
          busy = false;
        });
    };
    map.on('click', onClick);
    return () => {
      cancelled = true;
      map.off('click', onClick);
      canvas.style.cursor = prev;
    };
  }, [map, active, cfg.mapWidgetId, ctx]);

  const container = map?.getContainer() ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => setActive((v) => !v)}
        disabled={!map}
        aria-pressed={active}
        title="Magic outline"
        // Match the app-bar tool chrome (Search / Select / etc.):
        // icon over label, header-ink idle, inverted when active
        // (inline style dodges the JIT arbitrary-value miss).
        style={
          active
            ? {
                backgroundColor: 'hsl(var(--app-header-ink))',
                color: 'hsl(var(--app-header-bg))',
              }
            : undefined
        }
        className={`group/tool flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? ''
            : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
        }`}
      >
        <Wand2 className="h-5 w-5" strokeWidth={1.75} />
        <span className="text-2xs font-medium leading-none">
          Magic outline
        </span>
      </button>
      {active && container
        ? createPortal(
            <div
              role="status"
              className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-[hsl(var(--app-surface-0)/0.95)] px-4 py-1.5 text-xs font-medium text-[hsl(var(--app-ink-1))] shadow-lg backdrop-blur"
            >
              {status ?? 'Click a building or field to outline it.'}
            </div>,
            container,
          )
        : null}
    </>
  );
}

function CoordinatesWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'coordinates') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, format, precision, showZoom } = widget.config;
  const map = ctx?.maps[mapWidgetId] ?? null;
  const fmt = format ?? 'dd';
  const prec = precision ?? (fmt === 'dd' ? 5 : 0);
  const [pos, setPos] = useState<{ lng: number; lat: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!map) {
      setPos(null);
      setZoom(null);
      return;
    }
    setZoom(map.getZoom());
    const onMove = (e: maplibregl.MapMouseEvent) => {
      setPos({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    const onLeave = () => setPos(null);
    const onZoomEnd = () => setZoom(map.getZoom());
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('zoomend', onZoomEnd);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('zoomend', onZoomEnd);
    };
  }, [map]);

  function formatDms(deg: number, isLat: boolean): string {
    const hemi = isLat ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const minFloat = (abs - d) * 60;
    const m = Math.floor(minFloat);
    const sFloat = (minFloat - m) * 60;
    const s = sFloat.toFixed(prec);
    return `${d}° ${m}' ${s}" ${hemi}`;
  }

  const display = !map
    ? 'Bind a map widget'
    : !pos
      ? 'Move cursor over the bound map'
      : fmt === 'dms'
        ? `${formatDms(pos.lat, true)}  ${formatDms(pos.lng, false)}`
        : `${pos.lat.toFixed(prec)}, ${pos.lng.toFixed(prec)}`;

  return (
    <WidgetFrame icon={CrosshairIcon} title="Coordinates">
      <div className="flex flex-1 items-center gap-2 px-3 py-2 font-mono text-xs">
        <span className="flex-1 truncate text-[hsl(var(--app-ink-1))]">{display}</span>
        {showZoom && zoom !== null && (
          <span className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-2))] px-1.5 py-0.5 text-2xs text-[hsl(var(--app-muted))]">
            z {zoom.toFixed(2)}
          </span>
        )}
      </div>
    </WidgetFrame>
  );
}

function MyLocationWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'my-location') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, zoomLevel, keepMarker } = widget.config;
  const map = ctx?.maps[mapWidgetId] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceId = `mylocation-${widget.id}`;
  const layerId = `mylocation-layer-${widget.id}`;

  // Clean up the marker source/layer when the widget unmounts so we
  // don't leak across page switches in multi-page apps.
  useEffect(() => {
    return () => {
      if (!map) return;
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        /* map already torn down */
      }
    };
  }, [map, sourceId, layerId]);

  function dropMarker(lng: number, lat: number) {
    if (!map) return;
    // Add or update a single-point GeoJSON source + a styled circle
    // layer. Two sub-layers (a translucent halo + a solid dot) read
    // visually like a "current location" pin without needing a
    // sprite atlas.
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {},
        },
      ],
    };
    const existing = map.getSource(sourceId) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(data);
    } else {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${layerId}-halo`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': 14,
          'circle-color': '#3b82f6',
          'circle-opacity': 0.18,
          'circle-stroke-width': 0,
        },
      });
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': 6,
          'circle-color': '#3b82f6',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }

  function clearMarker() {
    if (!map) return;
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getLayer(`${layerId}-halo`)) map.removeLayer(`${layerId}-halo`);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch {
      /* layer already gone */
    }
  }

  function locate() {
    setError(null);
    if (!map) {
      setError('Bind a map widget.');
      return;
    }
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not available in this browser.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        const { longitude, latitude } = pos.coords;
        map.flyTo({
          center: [longitude, latitude],
          zoom: zoomLevel ?? 14,
          duration: 800,
        });
        dropMarker(longitude, latitude);
        if (!keepMarker) {
          // Remove after the fly animation settles + a short read
          // window so the user sees the pin land before it fades.
          window.setTimeout(clearMarker, 4000);
        }
      },
      (err) => {
        setBusy(false);
        setError(err.message || 'Could not get location.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <WidgetFrame icon={LocateIcon} title="My Location">
      <div className="flex flex-1 flex-col items-stretch justify-center gap-1.5 p-3">
        <button
          type="button"
          onClick={locate}
          disabled={busy || !map}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[hsl(var(--app-accent))] px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LocateIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {busy ? 'Locating...' : 'Show my location'}
        </button>
        {error ? (
          <p className="text-xs text-[hsl(var(--app-danger))]">{error}</p>
        ) : !map ? (
          <p className="text-xs text-[hsl(var(--app-muted))]">Bind a map widget to enable.</p>
        ) : null}
      </div>
    </WidgetFrame>
  );
}

// ---- Tabs container (#362) -------------------------------------------------

function TabsWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'tabs') return null;
  const tabs = widget.config.tabs;
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, tabs.length - 1);
  const active = tabs[safeIdx];
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {tabs.length > 0 && (
        <nav
          className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2"
          aria-label="Tabs"
        >
          {tabs.map((t, i) => {
            const isActive = i === safeIdx;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveIdx(i)}
                aria-current={isActive ? 'true' : undefined}
                className={`relative px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-[hsl(var(--app-ink-0))]'
                    : 'text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-1))]'
                }`}
              >
                {t.title}
                {isActive && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-[hsl(var(--app-ink-0))]"
                  />
                )}
              </button>
            );
          })}
        </nav>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {active && active.widgets.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-[hsl(var(--app-muted))]">
            (Empty tab)
          </div>
        ) : (
          active &&
          active.widgets.map((c) => (
            <div
              key={c.id}
              className="overflow-hidden rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))]"
              style={{
                // Min-height proportional to the widget's intended
                // row span so a Map keeps real estate while a
                // Coordinates widget stays compact.
                minHeight: Math.max(64, c.layout.rowSpan * 24),
              }}
            >
              {renderWidget(c)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Themed-app containers (#22) ----------------------------------

/**
 * Render a child widget inside a container. Tool-mode children
 * render through ToolWidgetSlot (icon button + popover with the
 * widget's panel content inside) so the Search widget inside an
 * app-bar appears as a search icon button, not as a full inline
 * search input. Panel-mode children fall through to the standard
 * renderer.
 *
 * Without this dispatch, every container child rendered via
 * `renderWidget(widget)` which always picks the widget's full
 * panel UI. Result: an app-bar holding Search + Basemap +
 * AttributeTable rendered all three's full content inline,
 * blowing the bar's height and ignoring the author's tool-mode
 * config. The container thus needs to honor displayMode the same
 * way the top-level WidgetSlot does.
 */
function renderWidgetInContainer(widget: CustomWidget): React.ReactNode {
  if (isToolDisplayWidget(widget) && widgetDisplayMode(widget) === 'tool') {
    return <ToolWidgetSlot widget={widget} />;
  }
  // Suppress the inner widget's WidgetFrame header when rendered
  // inside a container. The container (foldable-group, dock-panel,
  // slideout) provides its own labeling, so the widget's
  // self-titled card chrome would double up (the screenshot showed
  // "Layers" twice: once as the foldable-group title and again as
  // the LayerList's own WidgetFrame title).
  return (
    <SuppressFrameHeaderContext.Provider value={true}>
      {renderWidget(widget)}
    </SuppressFrameHeaderContext.Provider>
  );
}

// ---- Feature-mutation widgets (#69 / #70 / #71, #89 pivot) ------------------

/**
 * Shared scaffolding for the three feature-mutation widgets after
 * the #89 pivot to the field-runtime-style multi-layer pattern.
 *
 * The three widgets bind to a Map widget by id and operate over
 * EVERY editable target in that map by default.  Configs still
 * support the legacy `targetIndex` for back-compat (single-target
 * binding), but the modern shape omits it -- one widget per app
 * regardless of how many editable layers the bound map has.
 *
 * Create renders a templates palette (one entry per editable
 * target) and on pick enters create-mode for that specific target.
 * Edit is a mode toggle: when ON, the runtime intercepts feature
 * clicks on the bound map's editable layers via the
 * editClaimedLayerIds plumbing in MapCanvas and opens the edit
 * form against whichever layer the clicked feature belongs to.
 * Delete operates against the bound map's selection state, which
 * is keyed per-layer, so it dispatches DELETEs against the right
 * (data_layer, layer) pair per selected feature.
 *
 * All three honor AppTimeContext: when `at` is non-null, the
 * widgets render disabled with a tooltip.  The engine rejects
 * past-target writes defensively, so this is UX clarity, not a
 * security boundary.
 *
 * Schema for the AttributeForm is fetched on-demand from the
 * source data_layer's /items endpoint.  Cached per (dataLayerId,
 * layerKey) by useLayerSchema so a re-open doesn't refetch.
 */
type WriteBusyState =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'error'; message: string };

/**
 * Resolved info for one editable target inside a bound map.  Used
 * to build templates pickers, edit-click handlers, and per-target
 * delete dispatch.  We carry the MapLayer reference so widgets can
 * pull the layer's `renderer` (for color swatches in the templates
 * palette) and `id` (for selection / editClaim keying).
 */
interface MutationTarget {
  index: number;
  dataLayerId: string;
  layerKey: string;
  title: string;
  mapLayer: MapLayer;
}

/**
 * Hook that resolves every editable target inside the widget's
 * bound map.  Drops table-only sublayers (geometry passes through
 * the map's MapLayer set; tables have no MapLayer entry).  When
 * the config carries a legacy `targetIndex`, the result is
 * filtered to that single target so existing recipes don't change
 * behavior.
 *
 * Returns null when the bound map isn't yet ready (still mounting)
 * or no resolved targets exist (misconfigured app).  The widgets
 * render a friendly placeholder in that case.
 */
function useMutationTargets(args: {
  mapWidgetId: string;
  targetIndex?: number;
}): {
  targets: MutationTarget[];
  mapInstance: maplibregl.Map | null;
  selectionByLayerId: Record<string, Set<number | string>>;
  flyTo: (bbox: [number, number, number, number]) => void;
  setEditClaim: CustomMapsCtx['setEditClaim'];
} | null {
  const ctx = useContext(CustomMapsContext);
  if (!ctx) return null;
  const mapWidgetIdResolved = args.mapWidgetId || null;
  const boundState = mapWidgetIdResolved
    ? ctx.states[mapWidgetIdResolved] ?? null
    : null;
  const mapInstance = mapWidgetIdResolved
    ? ctx.maps[mapWidgetIdResolved] ?? null
    : null;
  if (!boundState) {
    return {
      targets: [],
      mapInstance,
      selectionByLayerId: {},
      flyTo: () => {},
      setEditClaim: ctx.setEditClaim,
    };
  }
  // Build the list of targets from resolvedTargets, filtering to
  // those whose MapLayer.id exists on the bound map (an author can
  // hide a target from a Map widget; hidden targets are not
  // editable here).
  const layerIds = new Set(boundState.mapData.layers.map((l) => l.id));
  let pool: MutationTarget[] = ctx.resolvedTargets
    .map((t, index) => ({
      index,
      dataLayerId: t.dataLayerId,
      layerKey: t.layerKey,
      title: t.title,
      mapLayer: t.mapLayer,
    }))
    .filter((t) => layerIds.has(t.mapLayer.id));
  if (typeof args.targetIndex === 'number') {
    pool = pool.filter((t) => t.index === args.targetIndex);
  }
  return {
    targets: pool,
    mapInstance,
    selectionByLayerId: boundState.selection,
    flyTo: (bbox) => {
      if (mapWidgetIdResolved) ctx.flyTo(mapWidgetIdResolved, bbox);
    },
    setEditClaim: ctx.setEditClaim,
  };
}

/**
 * Fetch the target layer's FeatureField schema on demand.  The
 * /items/:id endpoint returns the full data_layer payload; we
 * walk its `layers[]` to find the entry matching layerKey.  Cached
 * by useState so the form doesn't refetch on every keystroke.
 */
function useLayerSchema(dataLayerId: string, layerKey: string): {
  fields: import('@gratis-gis/shared-types').FeatureField[];
  geometryType: string | null;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    fields: import('@gratis-gis/shared-types').FeatureField[];
    geometryType: string | null;
    loading: boolean;
    error: string | null;
  }>({ fields: [], geometryType: null, loading: true, error: null });
  useEffect(() => {
    if (!dataLayerId) {
      setState({
        fields: [],
        geometryType: null,
        loading: false,
        error: null,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`/api/portal/items/${dataLayerId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((it: Item) => {
        if (cancelled) return;
        const data = it.data as
          | {
              layers?: Array<{
                id?: string;
                fields?: import('@gratis-gis/shared-types').FeatureField[];
                geometryType?: string;
              }>;
            }
          | null;
        const match = data?.layers?.find((l) => l.id === layerKey);
        setState({
          fields: match?.fields ?? [],
          geometryType: match?.geometryType ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          fields: [],
          geometryType: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Failed to load schema',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [dataLayerId, layerKey]);
  return state;
}

/**
 * Pick a fallback color for a target's templates-palette swatch
 * when the layer's renderer doesn't provide one.  Mirrors the
 * field-runtime helper of the same name: stable-hash the layer id
 * into one of a small palette so two layers in the same map don't
 * collide on the same swatch by accident.
 */
function pickFallbackColorForLayer(mapLayer: MapLayer): string {
  const palette = [
    '#2563eb',
    '#7c3aed',
    '#db2777',
    '#dc2626',
    '#ea580c',
    '#d97706',
    '#65a30d',
    '#0891b2',
  ];
  let h = 0;
  for (let i = 0; i < mapLayer.id.length; i++) {
    h = (h * 31 + mapLayer.id.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length]!;
}

/**
 * Pull the dominant fill / line color out of a MapLayer's renderer
 * so the templates palette swatch matches what the user sees on
 * the map.  Falls through to pickFallbackColorForLayer for renderers
 * we can't quickly summarize (class-breaks, unique-values where we
 * don't want to pick one category over another).
 */
function colorFromRenderer(mapLayer: MapLayer): string {
  const r = mapLayer.renderer;
  if (r?.kind === 'simple' || !r) {
    const s = mapLayer.style;
    // The MapLayerStyle doesn't tell us which sub-style is "the"
    // one for a layer (the renderer paints all three based on the
    // feature's geometry), so prefer point.color when present, then
    // polygon.fillColor, then line.color.  Any of these is a
    // reasonable swatch on the templates palette.
    return (
      s?.point?.color ||
      s?.polygon?.fillColor ||
      s?.line?.color ||
      pickFallbackColorForLayer(mapLayer)
    );
  }
  return pickFallbackColorForLayer(mapLayer);
}

/**
 * Create-feature widget (#69 / #89 pivot).  Renders a single
 * "Add feature" button.  When clicked, opens an inline templates
 * palette listing every editable target in the bound map with a
 * colored swatch from each layer's renderer.  Clicking a template
 * enters create mode for that specific target.  For point-geometry
 * layers, the user then clicks once on the bound map to place the
 * new feature; for table-only layers, the form submits directly.
 */
function CreateFeatureWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'create-feature') return null;
  const cfg = widget.config;
  const appAt = useAppTime();
  const mut = useMutationTargets({
    mapWidgetId: cfg.mapWidgetId,
    ...(typeof cfg.targetIndex === 'number'
      ? { targetIndex: cfg.targetIndex }
      : {}),
  });
  // Three-phase state: 'closed' (button only), 'picking' (templates
  // palette open), 'placing' (a template was picked; collect geom
  // + attrs).  The picking phase is skipped when there's only one
  // editable target -- jump straight to placing for that target.
  const [phase, setPhase] = useState<
    | { kind: 'closed' }
    | { kind: 'picking' }
    | { kind: 'placing'; target: MutationTarget; point: [number, number] | null }
  >({ kind: 'closed' });
  const [busy, setBusy] = useState<WriteBusyState>({ state: 'idle' });

  const inTimeTravel = appAt !== null;
  const targets = mut?.targets ?? [];

  // Resolve the schema for whichever target is in "placing" phase.
  // useLayerSchema short-circuits when ids are empty, so it's safe
  // to call unconditionally from the top of the component.
  const placingTarget = phase.kind === 'placing' ? phase.target : null;
  const schema = useLayerSchema(
    placingTarget?.dataLayerId ?? '',
    placingTarget?.layerKey ?? '',
  );
  const needsGeometry =
    placingTarget !== null &&
    !!schema.geometryType &&
    schema.geometryType !== 'none';
  const isPointLayer =
    schema.geometryType === 'point' || schema.geometryType === 'Point';

  // Click-to-place handler.  Only attached during the placing phase
  // for a point-geometry target whose location hasn't been picked
  // yet.  Cursor flip to crosshair signals to the user that the map
  // is now waiting for a click.
  useEffect(() => {
    if (phase.kind !== 'placing') return;
    if (!needsGeometry) return;
    if (phase.point) return;
    if (!mut?.mapInstance) return;
    const map = mut.mapInstance;
    map.getCanvas().style.cursor = 'crosshair';
    const onClick = (e: maplibregl.MapMouseEvent) => {
      setPhase((p) =>
        p.kind === 'placing'
          ? { ...p, point: [e.lngLat.lng, e.lngLat.lat] }
          : p,
      );
      map.getCanvas().style.cursor = '';
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
      map.getCanvas().style.cursor = '';
    };
  }, [phase, needsGeometry, mut?.mapInstance]);

  async function submit(values: Record<string, unknown>) {
    if (phase.kind !== 'placing') return;
    const target = phase.target;
    setBusy({ state: 'submitting' });
    try {
      const geometry =
        needsGeometry && phase.point
          ? { type: 'Point', coordinates: phase.point }
          : null;
      const body = {
        features: [
          {
            ...(geometry ? { geometry } : {}),
            properties: values,
          },
        ],
      };
      const res = await fetch(
        `/api/portal/items/${target.dataLayerId}/layers/${encodeURIComponent(
          target.layerKey,
        )}/features`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      setBusy({ state: 'idle' });
      setPhase({ kind: 'closed' });
    } catch (e) {
      setBusy({
        state: 'error',
        message: e instanceof Error ? e.message : 'Submit failed',
      });
    }
  }

  if (!mut || targets.length === 0) {
    return (
      <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">
        {cfg.mapWidgetId
          ? 'No editable target layers in the bound map.'
          : 'Bind this widget to a Map widget.'}
      </p>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 p-2">
      <button
        type="button"
        disabled={inTimeTravel}
        onClick={() => {
          // One target = no need to show the palette; jump straight
          // to placing for that target.  This matches the single-
          // editable-layer case the legacy config also handled.
          if (targets.length === 1) {
            setPhase({ kind: 'placing', target: targets[0]!, point: null });
          } else {
            setPhase((p) =>
              p.kind === 'closed' ? { kind: 'picking' } : { kind: 'closed' },
            );
          }
          setBusy({ state: 'idle' });
        }}
        className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 py-1 text-xs font-medium text-[hsl(var(--app-ink-0))] hover:bg-[hsl(var(--app-surface-2))] disabled:cursor-not-allowed disabled:opacity-50"
        title={
          inTimeTravel
            ? 'Editing is disabled while viewing a past snapshot. Reset the time slider to enable.'
            : undefined
        }
      >
        <Plus className="h-3.5 w-3.5" />
        {cfg.label || 'Add feature'}
      </button>
      {phase.kind === 'picking' ? (
        <div className="flex-1 overflow-auto rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))]">
          <p className="border-b border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-[hsl(var(--app-muted))]">
            Pick a layer to add to
          </p>
          <ul>
            {targets.map((t) => (
              <li key={`${t.dataLayerId}:${t.layerKey}`}>
                <button
                  type="button"
                  onClick={() =>
                    setPhase({ kind: 'placing', target: t, point: null })
                  }
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-[hsl(var(--app-surface-1))]"
                >
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 rounded-sm border border-[hsl(var(--app-border))]"
                    style={{ backgroundColor: colorFromRenderer(t.mapLayer) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[hsl(var(--app-ink-0))]">
                    {t.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-1.5">
            <button
              type="button"
              onClick={() => setPhase({ kind: 'closed' })}
              className="text-2xs text-[hsl(var(--app-muted))] hover:text-[hsl(var(--app-ink-0))]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : phase.kind === 'placing' ? (
        <div className="flex-1 overflow-auto rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))]">
          {schema.loading ? (
            <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">Loading schema…</p>
          ) : schema.error ? (
            <p className="p-3 text-xs text-[hsl(var(--app-danger))]">{schema.error}</p>
          ) : needsGeometry && !phase.point ? (
            <div className="space-y-2 p-3 text-xs text-[hsl(var(--app-ink-1))]">
              <p>
                Adding to <strong>{phase.target.title}</strong>.
              </p>
              <p>
                <strong>Step 1:</strong> click on the map to place the
                new {schema.geometryType?.toLowerCase()}.
              </p>
              {!isPointLayer ? (
                <p className="text-[hsl(var(--app-muted))]">
                  (Note: only single-point placement is supported in
                  this first cut; multi-vertex sketching for lines /
                  polygons is queued as a follow-up.)
                </p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPhase(
                      targets.length === 1
                        ? { kind: 'closed' }
                        : { kind: 'picking' },
                    )
                  }
                  className="rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 py-1 text-xs hover:bg-[hsl(var(--app-surface-2))]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <AttributeForm
              fields={schema.fields}
              editableFieldNames={null}
              layerTitle={phase.target.title}
              submitting={busy.state === 'submitting'}
              errorMessage={
                busy.state === 'error' ? busy.message : null
              }
              onCancel={() => {
                setPhase({ kind: 'closed' });
                setBusy({ state: 'idle' });
              }}
              onSubmit={submit}
              submitLabel="Create"
              title="New feature"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Edit-feature widget (#70 / #89 pivot).  Renders a mode toggle:
 * when ON, every editable target in the bound map is "claimed"
 * via CustomMapsContext.setEditClaim, which threads through to
 * MapCanvas's `editClaimedLayerIds` so feature clicks on those
 * layers open the edit form instead of the read-only popup.
 * Match the feature -> target by MapLayer.id (the same id
 * MapCanvas uses for popups + selection).
 *
 * When the user clicks an editable feature, the form opens
 * pre-filled with the feature's current attrs (fetched via the
 * /features-page lookup -- the click handler already gives us the
 * tile-side properties, but those can be partial for MVT, so we
 * refetch the canonical row).  Submit issues a PATCH; the bound
 * map's MVT source invalidates on the next viewport settle.
 */
function EditFeatureWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'edit-feature') return null;
  const cfg = widget.config;
  const appAt = useAppTime();
  const mut = useMutationTargets({
    mapWidgetId: cfg.mapWidgetId,
    ...(typeof cfg.targetIndex === 'number'
      ? { targetIndex: cfg.targetIndex }
      : {}),
  });
  const [active, setActive] = useState(false);
  const [editing, setEditing] = useState<{
    target: MutationTarget;
    featureId: string;
    properties: Record<string, unknown>;
  } | null>(null);
  const [busy, setBusy] = useState<WriteBusyState>({ state: 'idle' });

  const inTimeTravel = appAt !== null;
  // Pre-compute the set of editable MapLayer.ids so the claim ref
  // can stay stable as long as the bound map's target set doesn't
  // change.  Without useMemo the Set identity flips every render
  // and MapCanvas would rebuild its handlers needlessly.
  const editableLayerIds = useMemo(
    () => new Set((mut?.targets ?? []).map((t) => t.mapLayer.id)),
    [mut?.targets],
  );
  const targetsByLayerId = useMemo(() => {
    const out = new Map<string, MutationTarget>();
    for (const t of mut?.targets ?? []) out.set(t.mapLayer.id, t);
    return out;
  }, [mut?.targets]);

  // Schema for whichever target is in editing state.
  const schema = useLayerSchema(
    editing?.target.dataLayerId ?? '',
    editing?.target.layerKey ?? '',
  );

  // Register / unregister the edit claim with the runtime as the
  // toggle flips.  The click callback opens the editing dialog
  // pre-filled with a feature lookup (in case the tile-side props
  // are partial -- MVT tiles strip non-trivial properties for size).
  useEffect(() => {
    if (!mut || !active) return;
    const setEditClaim = mut.setEditClaim;
    setEditClaim(cfg.mapWidgetId, {
      layerIds: editableLayerIds,
      onClick: (info) => {
        const target = targetsByLayerId.get(info.layerId);
        if (!target) return;
        // Refetch the canonical feature so the form is filled with
        // the full row (the tile-side properties can be partial).
        const fid = String(info.featureId);
        fetch(
          `/api/portal/items/${target.dataLayerId}/layers/${encodeURIComponent(
            target.layerKey,
          )}/features/${encodeURIComponent(fid)}`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((row: { properties?: Record<string, unknown> } | null) => {
            setEditing({
              target,
              featureId: fid,
              properties: row?.properties ?? info.properties,
            });
            setBusy({ state: 'idle' });
          })
          .catch(() => {
            setEditing({
              target,
              featureId: fid,
              properties: info.properties,
            });
            setBusy({ state: 'idle' });
          });
      },
    });
    return () => {
      setEditClaim(cfg.mapWidgetId, null);
    };
  }, [
    mut,
    active,
    cfg.mapWidgetId,
    editableLayerIds,
    targetsByLayerId,
  ]);

  async function submit(values: Record<string, unknown>) {
    if (!editing) return;
    setBusy({ state: 'submitting' });
    try {
      const res = await fetch(
        `/api/portal/items/${editing.target.dataLayerId}/layers/${encodeURIComponent(
          editing.target.layerKey,
        )}/features/${encodeURIComponent(editing.featureId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: values }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      setBusy({ state: 'idle' });
      setEditing(null);
    } catch (e) {
      setBusy({
        state: 'error',
        message: e instanceof Error ? e.message : 'Update failed',
      });
    }
  }

  if (!mut || mut.targets.length === 0) {
    return (
      <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">
        {cfg.mapWidgetId
          ? 'No editable target layers in the bound map.'
          : 'Bind this widget to a Map widget.'}
      </p>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 p-2">
      <button
        type="button"
        disabled={inTimeTravel}
        onClick={() => setActive((a) => !a)}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
          active
            ? 'border-[hsl(var(--app-accent))] bg-[hsl(var(--app-accent))] text-white hover:bg-[hsl(var(--app-accent)/0.9)]'
            : 'border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))] hover:bg-[hsl(var(--app-surface-2))]'
        }`}
        title={
          inTimeTravel
            ? 'Editing is disabled while viewing a past snapshot.'
            : active
              ? 'Click an editable feature on the map to edit it. Click here again to exit edit mode.'
              : 'Enter edit mode, then click any editable feature on the map.'
        }
      >
        <Pencil className="h-3.5 w-3.5" />
        {cfg.label || 'Edit feature'}
        {active ? <span className="text-2xs">(active)</span> : null}
      </button>
      {active && !editing ? (
        <p className="rounded-md border border-[hsl(var(--app-accent)/0.5)] bg-[hsl(var(--app-accent)/0.1)] p-2 text-2xs text-[hsl(var(--app-ink-1))]">
          Click any editable feature on the map.
        </p>
      ) : null}
      {editing ? (
        <div className="flex-1 overflow-auto rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))]">
          {schema.loading ? (
            <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">Loading schema…</p>
          ) : schema.error ? (
            <p className="p-3 text-xs text-[hsl(var(--app-danger))]">{schema.error}</p>
          ) : (
            <AttributeForm
              fields={schema.fields}
              editableFieldNames={null}
              initial={editing.properties}
              layerTitle={editing.target.title}
              submitting={busy.state === 'submitting'}
              errorMessage={busy.state === 'error' ? busy.message : null}
              onCancel={() => {
                setEditing(null);
                setBusy({ state: 'idle' });
              }}
              onSubmit={submit}
              submitLabel="Update"
              title="Edit feature"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Delete-feature widget (#71 / #89 pivot).  Reads the bound map's
 * selection state (which is keyed per MapLayer.id) and dispatches
 * DELETEs against the right (data_layer, layer) pair for each
 * selected feature.  Selections can span multiple editable
 * targets; the widget shows a per-layer breakdown in the confirm
 * dialog so the user knows exactly what's about to disappear.
 *
 * The engine writes 'delete' observations rather than truly
 * removing rows, so a delete is reversible via the #87 time slider:
 * scrub back to a moment before the delete and the rows return.
 * The confirm dialog mentions this so the user isn't surprised.
 */
function DeleteFeatureWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'delete-feature') return null;
  const cfg = widget.config;
  const appAt = useAppTime();
  const mut = useMutationTargets({
    mapWidgetId: cfg.mapWidgetId,
    ...(typeof cfg.targetIndex === 'number'
      ? { targetIndex: cfg.targetIndex }
      : {}),
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<WriteBusyState>({ state: 'idle' });

  const inTimeTravel = appAt !== null;
  // Build per-target selection lists from the bound map's
  // selectionByLayerId.  Filter to selections on layers the widget
  // covers (so a stray selection on a non-editable layer doesn't
  // count toward the total).
  const perTarget = useMemo(() => {
    const out: Array<{
      target: MutationTarget;
      ids: Array<string | number>;
    }> = [];
    for (const t of mut?.targets ?? []) {
      const set = mut?.selectionByLayerId[t.mapLayer.id];
      if (!set || set.size === 0) continue;
      out.push({ target: t, ids: Array.from(set) });
    }
    return out;
  }, [mut?.targets, mut?.selectionByLayerId]);
  const totalSelected = perTarget.reduce((n, p) => n + p.ids.length, 0);

  async function doDelete() {
    setBusy({ state: 'submitting' });
    try {
      // Sequential per (target, feature) -- bulk delete is a
      // follow-up.  ~ms each, so dozens of features finish in
      // under a second.
      for (const { target, ids } of perTarget) {
        for (const id of ids) {
          const res = await fetch(
            `/api/portal/items/${target.dataLayerId}/layers/${encodeURIComponent(
              target.layerKey,
            )}/features/${encodeURIComponent(String(id))}`,
            { method: 'DELETE' },
          );
          if (!res.ok && res.status !== 204) {
            const text = await res.text().catch(() => '');
            throw new Error(
              `HTTP ${res.status} on ${target.title}${text ? `: ${text}` : ''}`,
            );
          }
        }
      }
      setBusy({ state: 'idle' });
      setConfirming(false);
    } catch (e) {
      setBusy({
        state: 'error',
        message: e instanceof Error ? e.message : 'Delete failed',
      });
    }
  }

  if (!mut || mut.targets.length === 0) {
    return (
      <p className="p-3 text-xs italic text-[hsl(var(--app-muted))]">
        {cfg.mapWidgetId
          ? 'No editable target layers in the bound map.'
          : 'Bind this widget to a Map widget.'}
      </p>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 p-2">
      <button
        type="button"
        disabled={inTimeTravel || totalSelected === 0}
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-2 py-1 text-xs font-medium text-[hsl(var(--app-ink-0))] hover:bg-[hsl(var(--app-danger)/0.1)] hover:text-[hsl(var(--app-danger))] disabled:cursor-not-allowed disabled:opacity-50"
        title={
          inTimeTravel
            ? 'Editing is disabled while viewing a past snapshot.'
            : totalSelected === 0
              ? 'Select feature(s) on the bound map first.'
              : undefined
        }
      >
        <Trash2 className="h-3.5 w-3.5" />
        {cfg.label || 'Delete feature'}
        {totalSelected > 0 ? (
          <span className="text-[hsl(var(--app-muted))]">({totalSelected})</span>
        ) : null}
      </button>
      {confirming ? (
        <div className="space-y-2 rounded-md border border-[hsl(var(--app-danger)/0.4)] bg-[hsl(var(--app-danger)/0.1)] p-3 text-xs text-[hsl(var(--app-danger))]">
          <p>
            Delete <strong>{totalSelected}</strong> feature
            {totalSelected === 1 ? '' : 's'}?
          </p>
          <ul className="space-y-0.5 pl-3 text-2xs">
            {perTarget.map(({ target, ids }) => (
              <li key={target.mapLayer.id}>
                <strong>{target.title}</strong>: {ids.length}
              </li>
            ))}
          </ul>
          <p className="text-2xs text-[hsl(var(--app-danger))]">
            This is recorded as a delete observation; read the layer
            "as of" a moment before this action to recover.
          </p>
          {busy.state === 'error' ? (
            <p className="text-[hsl(var(--app-danger))]">{busy.message}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy.state === 'submitting'}
              onClick={doDelete}
              className="rounded-md bg-[hsl(var(--app-danger))] px-3 py-1 text-xs font-medium text-white hover:bg-[hsl(var(--app-danger)/0.8)] disabled:opacity-50"
            >
              {busy.state === 'submitting' ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              disabled={busy.state === 'submitting'}
              onClick={() => {
                setConfirming(false);
                setBusy({ state: 'idle' });
              }}
              className="rounded-md border border-[hsl(var(--app-danger)/0.4)] bg-[hsl(var(--app-surface-1))] px-3 py-1 text-xs text-[hsl(var(--app-danger))] hover:bg-[hsl(var(--app-danger)/0.15)] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- Time-slider widget (#87) ----------------------------------------------

/**
 * Time-slider widget runtime.  Drives AppTimeContext.  Authors
 * configure mode (slider vs. calendar), date bounds, and a step.
 * The widget itself is unbound (no map binding) -- every Map,
 * Chart, and AttributeTable widget on the page reads the same
 * context value, so scrubbing the slider re-fetches all of them
 * against the bitemporal source at that moment.
 *
 * Two modes:
 *   - 'date' (default): a horizontal range slider that maps a 0..N
 *     position to a date in [minDate, maxDate] at the chosen step.
 *     The slider's far-right position publishes null = "now" so a
 *     full forward scrub returns to live data.
 *   - 'calendar': a single date input.  No scrub, just snap-to-day.
 *     Clear button next to the input resets to null.
 */
function TimeSliderWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'time-slider') return null;
  const cfg = widget.config;
  const { at, setAt } = useContext(AppTimeContext);
  // #57: animated playback. The runtime tracks play / pause and a
  // multiplier; when playing, an interval advances the slider by
  // one `stepDays` step each tick. Tick rate is 1 second per step
  // at 1x speed, halved at 2x, quartered at 5x, and so on. Reaching
  // the max date loops back to min unless `loop === false`, in
  // which case playback pauses.
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  // The animation effect mutates `at` via setAt; we read the
  // bounds from the resolved cfg + max/min computed below. Re-
  // creating the interval on each play / speed / bound change is
  // fine: setInterval cleanup runs the moment any dep changes.
  const playableCfg = cfg.playable !== false; // default true

  // Resolve the date bounds.  maxDate defaults to today; minDate
  // defaults to one year before today.  Both are local YYYY-MM-DD
  // strings the date input accepts as-is.
  const todayIso = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);
  const minDate = cfg.minDate || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  const maxDate = cfg.maxDate || todayIso;
  const stepDays = Math.max(1, Math.floor(cfg.stepDays ?? 1));
  const label = cfg.label || 'Time';
  const mode = cfg.mode ?? 'date';

  // For the slider, convert the current `at` (ISO timestamp or null)
  // back into a YYYY-MM-DD so the slider thumb sits at the right
  // position.  Null = "now" = max position.
  const currentDateStr = at
    ? (() => {
        const d = new Date(at);
        if (isNaN(d.getTime())) return maxDate;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })()
    : maxDate;

  // Convert a YYYY-MM-DD picker value to the ISO `at` value we
  // publish.  Anchored at 23:59:59 local so a "March 5" pick reads
  // what the world looked like at end-of-day, matching the wizard's
  // preview convention.  If the picked date equals maxDate, we
  // publish null instead of a timestamp so the runtime drops back
  // to current truth (the most common reset action).
  function publish(yyyymmdd: string) {
    if (!yyyymmdd) {
      setAt(null);
      return;
    }
    if (yyyymmdd === maxDate) {
      setAt(null);
      return;
    }
    const d = new Date(`${yyyymmdd}T23:59:59`);
    if (isNaN(d.getTime())) {
      setAt(null);
      return;
    }
    setAt(d.toISOString());
  }

  // For the slider: compute the slider's 0..N range as days between
  // min and max, snapped to stepDays.  The slider's value is the
  // day-offset; we convert to a YYYY-MM-DD via minDate + offset.
  const minMs = new Date(`${minDate}T00:00:00`).getTime();
  const maxMs = new Date(`${maxDate}T00:00:00`).getTime();
  const totalDays = Math.max(
    0,
    Math.round((maxMs - minMs) / (24 * 60 * 60 * 1000)),
  );
  const sliderMax = Math.max(1, Math.floor(totalDays / stepDays));
  const currentMs = new Date(`${currentDateStr}T00:00:00`).getTime();
  const currentDayOffset = Math.max(
    0,
    Math.round((currentMs - minMs) / (24 * 60 * 60 * 1000)),
  );
  const sliderValue = Math.min(
    sliderMax,
    Math.max(0, Math.floor(currentDayOffset / stepDays)),
  );

  function onSliderChange(newValue: number) {
    const offsetDays = newValue * stepDays;
    const d = new Date(minMs);
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    publish(`${y}-${m}-${day}`);
  }

  // #57: playback effect. When `playing` is true, an interval
  // advances the slider one step every (1000 / speed) ms. Reaching
  // the max position loops back to 0 (or pauses if endBehavior ===
  // 'pause'). Pausing the user (setPlaying(false)) cancels the
  // interval; changing speed, bounds, or step recreates it so the
  // new cadence takes effect immediately.
  const speedOptions = useMemo(() => {
    const raw = cfg.speedOptions ?? [1, 2, 5, 10];
    return raw
      .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
      .map((n) => Math.min(1000, Math.max(0.25, n)));
  }, [cfg.speedOptions]);
  const endBehavior = cfg.endBehavior ?? 'loop';
  useEffect(() => {
    if (!playing) return;
    if (mode === 'calendar') return; // calendar mode has nothing to animate
    if (sliderMax <= 0) return;
    const intervalMs = Math.max(50, Math.floor(1000 / speed));
    const handle = setInterval(() => {
      // Compute the next slider position from the current `at`
      // (read fresh each tick via closure on `sliderValue` would
      // capture stale values; we instead derive from `at` via
      // the same convention the slider uses). The setAt call
      // publishes ISO; the next tick reads the publish via the
      // re-render's closure on `at` and `sliderValue`.
      const next = sliderValue + 1;
      if (next > sliderMax) {
        if (endBehavior === 'loop') {
          onSliderChange(0);
        } else {
          setPlaying(false);
        }
        return;
      }
      onSliderChange(next);
    }, intervalMs);
    return () => clearInterval(handle);
    // sliderValue + setAt are intentionally inside the closure
    // each effect re-run; cfg / mode / sliderMax / endBehavior /
    // speed are the dep set that should restart the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, sliderMax, mode, endBehavior, sliderValue]);

  return (
    <div className="flex h-full w-full items-center gap-3 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-2 text-xs">
      <Clock className="h-4 w-4 shrink-0 text-[hsl(var(--app-muted))]" />
      <span className="shrink-0 font-medium text-[hsl(var(--app-ink-1))]">{label}:</span>
      {mode === 'calendar' ? (
        <>
          <input
            type="date"
            value={currentDateStr}
            min={minDate}
            max={maxDate}
            onChange={(e) => publish(e.target.value)}
            className="h-7 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-2 text-xs text-[hsl(var(--app-ink-0))] focus:border-[hsl(var(--app-accent))] focus:outline-none"
          />
          {at ? (
            <button
              type="button"
              onClick={() => setAt(null)}
              className="text-[hsl(var(--app-accent))] hover:underline"
            >
              Now
            </button>
          ) : (
            <span className="text-[hsl(var(--app-muted))]">(showing current)</span>
          )}
        </>
      ) : (
        <>
          {playableCfg ? (
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] text-[hsl(var(--app-ink-1))] hover:bg-[hsl(var(--app-surface-2))]"
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause' : 'Play'}
            >
              {/* Inline play / pause glyphs to avoid extra icon
                  imports. The current icon stable is lucide; both
                  Play and Pause are there, but keeping triangles
                  small + filled here is lighter than wiring up a
                  conditional import. */}
              {playing ? (
                <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
                  <rect x="3" y="3" width="3" height="10" fill="currentColor" />
                  <rect x="10" y="3" width="3" height="10" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
                  <path d="M4 3l9 5-9 5z" fill="currentColor" />
                </svg>
              )}
            </button>
          ) : null}
          <span className="shrink-0 tabular-nums text-[hsl(var(--app-muted))]">{minDate}</span>
          <input
            type="range"
            value={sliderValue}
            min={0}
            max={sliderMax}
            step={1}
            onChange={(e) => onSliderChange(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label={label}
          />
          <span className="shrink-0 tabular-nums text-[hsl(var(--app-muted))]">{maxDate}</span>
          <span className="shrink-0 min-w-[5.5rem] text-right font-medium tabular-nums text-[hsl(var(--app-ink-0))]">
            {at ? currentDateStr : 'Now'}
          </span>
          {playableCfg && speedOptions.length > 1 ? (
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="shrink-0 h-6 rounded-md border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-0))] px-1 text-xs text-[hsl(var(--app-ink-1))] focus:border-[hsl(var(--app-accent))] focus:outline-none"
              aria-label="Playback speed"
              title="Playback speed"
            >
              {speedOptions.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          ) : null}
          {at ? (
            <button
              type="button"
              onClick={() => setAt(null)}
              className="shrink-0 text-[hsl(var(--app-accent))] hover:underline"
            >
              Reset
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Render wrapper for the generic Container widget.  Delegates to
 * the Container component in themed-containers.tsx, passing the
 * tool-aware child renderer so the same widget kind renders as an
 * icon button inside a sticky-top container but as a full inline
 * card when placed on the page grid.
 */
function ContainerWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'container') return null;
  return (
    <Container
      config={widget.config}
      renderChild={renderWidgetInContainer}
    />
  );
}

// ---- Shared frame ----------------------------------------------------------

/**
 * When true, WidgetFrame skips its own header. Used when a widget
 * is rendered inside a ToolPopover (#364) so the popover's own
 * header doesn't stack with the widget's. Defaults to false so
 * panel-mode widgets keep their existing chrome.
 */
const SuppressFrameHeaderContext = createContext<boolean>(false);

function WidgetFrame({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof MapIcon;
  title: string;
  children: React.ReactNode;
}) {
  const suppressHeader = useContext(SuppressFrameHeaderContext);
  return (
    <>
      {!suppressHeader && (
        <header className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-3 py-2 text-xs">
          <Icon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" strokeWidth={1.75} />
          <span className="font-medium text-[hsl(var(--app-ink-0))]">{title}</span>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {children}
      </div>
    </>
  );
}

// Keep a kind icon registry just for static/lookup; not currently
// used by the renderer above but parallels the designer's
// PALETTE_TILES so a future "WidgetFrame defaults to kind icon"
// refactor stays cheap.
export const KIND_ICON: Record<CustomWidgetKind, typeof MapIcon> = {
  map: MapIcon,
  legend: ListTree,
  'layer-list': LayersIcon,
  'attribute-table': TableIcon,
  text: TypeIcon,
  chart: ChevronRight,
  search: SearchIcon,
  print: Printer,
  select: MousePointer2,
  // #110 Export widget: download icon to match the attribute-
  // table's Export menu and the data_layer detail page's Export
  // dropdown.  Discoverable at a glance to anyone who's used Esri
  // / VertiGIS where Export sits next to Print on the toolbar.
  export: Download,
  // #111 Splash widget: not really a toolbar tool, but we need a
  // KIND_ICON entry for the designer palette tile.  Window-with-
  // text icon would be ideal; using SquareIcon as a neutral
  // placeholder.
  splash: SquareIcon,
  'basemap-gallery': ImageIcon,
  // #361 page-element kinds. The icons mirror the designer's
  // PALETTE_TILES so a future WidgetFrame.kindIcon defaults stay
  // consistent.
  image: ImageIcon,
  button: ChevronRight,
  // #144: first-class Tool widget.
  tool: Wand2,
  divider: ChevronRight,
  embed: ChevronRight,
  // #361 part 2 mapcentric kinds.
  bookmark: BookmarkIcon,
  'elevation-profile': ChartSpline,
  'magic-outline': Wand2,
  coordinates: CrosshairIcon,
  'my-location': LocateIcon,
  // #87 time-slider.
  'time-slider': Clock,
  // #69 / #70 / #71 feature-mutation widgets.
  'create-feature': Plus,
  'edit-feature': Pencil,
  'delete-feature': Trash2,
  // #362 layout container.
  tabs: ChevronRight,
  // #92 generic container. Icon mirrors the designer's palette tile;
  // runtime renders containers through their own component so this
  // is only used as a lookup fallback.
  container: SquareIcon,
};
