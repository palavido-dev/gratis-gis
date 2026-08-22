// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AlertTriangle,
  BarChart3,
  Gauge,
  Bookmark as BookmarkIcon,
  ChartSpline as ChartSplineIcon,
  Clock,
  ChevronLeft,
  ChevronRight,
  Code as CodeIcon,
  Crosshair as CrosshairIcon,
  Download,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Layers as LayersIcon,
  LayoutGrid,
  ListTree,
  Locate as LocateIcon,
  Loader2,
  Map as MapIcon,
  MessageSquare,
  Minus as MinusIcon,
  MoreVertical,
  MousePointer2,
  MousePointerClick,
  Pencil,
  Plus,
  Printer,
  Search,
  Settings,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Type as TypeIcon,
  Wand2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AppDataSource,
  BasemapData,
  ChartReferenceLine,
  CustomAppData,
  CustomLayout,
  CustomPage,
  CustomWidget,
  CustomWidgetKind,
  Item,
  MapData,
  MapLayer,
  PanelAnchor,
  PanelArrangement,
  ViewerTarget,
  WebAppData,
} from '@gratis-gis/shared-types';
import {
  APP_THEMES,
  customTargetLayerId,
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  applyAppTheme,
  applyAppThemeTokens,
  migrateCustomAppData,
  newSourceId,
} from '@gratis-gis/shared-types';
import type { AppThemePresetId, AssetRef } from '@gratis-gis/shared-types';
import { AssetPicker } from '@/components/asset-picker';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas } from '../map/map-canvas';
import { PickMapDialog } from '../editor/pick-map-dialog';
import { useConfirm } from '@/components/dialog-provider';
import { BuilderShell } from '@/components/builder-shell/builder-shell';
import { Container } from './themed-containers';
import {
  DESIGN_TIME_KINDS,
  DesignTimeWidgetPreview,
} from './runtime-client';

/** The target shape the runtime renderers read. Mirrors the runtime's
 *  ResolvedAppTarget; kept local so the designer does not import a
 *  type that only exists to describe runtime internals. */
/**
 * A patch where an explicit `undefined` means "unset this key".
 *
 * `Partial<T>` cannot express that under exactOptionalPropertyTypes:
 * an optional key accepts absence, not an undefined value. Restating
 * each key as `| undefined` gives callers a way to say "clear it"
 * that survives the type checker, and the appliers below delete
 * rather than store the undefined.
 */
type Unsettable<T> = { [K in keyof T]?: T[K] | undefined };
type AppPatch = Unsettable<CustomAppData>;
type SourcePatch = Unsettable<AppDataSource>;

/** Apply an Unsettable patch, deleting the keys set to undefined. */
function applyPatch<T extends object>(base: T, patch: Unsettable<T>): T {
  const next = { ...base, ...patch } as T;
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (patch[key] === undefined) delete next[key];
  }
  return next;
}

interface ResolvedTargetLite {
  /** Id of the AppDataSource this came from; the binding key. */
  sourceId: string;
  dataLayerId: string;
  layerKey: string;
  title: string;
  mapLayer: MapLayer;
}
import { ToolPicker } from './tool-picker';
import { MAP_ICONS, MAP_ICON_CATEGORIES, renderIconSvg } from '../map/map-icons';

/**
 * #22: summary of one theme item, served from the parent server
 * page so the right-rail picker can render without a client-side
 * fetch.  The id is what gets persisted on CustomAppData.themePresetId
 * for a user-saved theme; seedKind handles back-compat with apps
 * that still reference the starter kind ('default' | 'forest' | ...).
 */
export interface ThemeItemSummary {
  id: string;
  title: string;
  description: string;
  seedKind: string | null;
  /** Token bundle for live-preview application. */
  tokens?: Record<string, string>;
  /** Display swatch color (hsl() string). */
  swatch: string;
}

interface Props {
  itemId: string;
  /**
   * Item title for the BuilderShell top bar. Pass-through from the
   * parent detail page (`item.title`).
   */
  itemTitle: string;
  initial: CustomAppData;
  canEdit: boolean;
  /**
   * #22: theme catalog the picker iterates.  Includes the five
   * built-in starters seeded per org plus any themes the user has
   * saved or had shared with them.  Defaults to an empty array
   * for callers that haven't been updated; in that case the picker
   * falls back to the in-process starter list.
   */
  themeItems?: Array<{
    id: string;
    title: string;
    description: string;
    seedKind: string | null;
    data: { swatch?: string; tokens?: Record<string, string> };
  }>;
}

/**
 * Custom Web App designer (#261 / #337). Three-pane layout:
 *
 *   - LEFT rail: widget palette (drag tiles onto the canvas) plus
 *     a pages list at the bottom.
 *   - CENTER: 12-column grid canvas. Widgets render as styled
 *     placeholder cards with their bound config summarized; click
 *     to select. (Live Map preview lands in Slice 7.)
 *   - RIGHT rail: properties panel. With nothing selected, shows
 *     app + page-level settings (default map, targets, page title).
 *     With a widget selected, swaps to that widget's layout +
 *     per-kind config (Slice 3).
 *
 * Drag-drop placement uses native HTML5 DnD with an "x-widget-kind"
 * MIME type the canvas reads on drop, mirroring the form designer's
 * "x-question-type" idiom so authors who learned the form designer
 * find this one familiar (#337). Reposition + resize land in #338;
 * for now the right-rail properties panel exposes col / row /
 * colSpan / rowSpan as numeric inputs as a transitional UX.
 *
 * Render fidelity: Slice 1 ships with placeholder widget cards.
 * Slice 7 (#343) swaps in a real (small) MapLibre instance for the
 * Map widget so the canvas matches what the runtime renders. For
 * everything else, real renders are reserved for the runtime
 * (#341); the designer's job is layout + binding.
 */
export function CustomAppDetail({
  itemId,
  itemTitle,
  initial,
  canEdit,
  themeItems = [],
}: Props) {
  // #357: migrate any v1 (12-col / 48px-row) app to the new v2 grid
  // (24-col / 24px-row) on load so the rest of the designer can
  // assume v2 coordinates. Idempotent: v2 input passes through
  // unchanged. The migrated app is dirty-on-first-save which is
  // intentional (a single re-save persists the v2 layout).
  const [app, setApp] = useState<CustomAppData>(() =>
    migrateCustomAppData(initial),
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The PickMapDialog is reused for both the app-default map and the
  // per-Map-widget override (#357 follow-up). Tagged scope lets one
  // dialog instance write to the right slot.
  const [pickingMap, setPickingMap] = useState<
    null | { scope: 'app' } | { scope: 'widget'; widgetId: string }
  >(null);
  // Multi-page support (#342). The home page is always pages[0]; if
  // the user deletes pages or reorders, activePageIdx clamps. Per-
  // page selection is reset on page switch so the right rail doesn't
  // try to render properties for a widget that lives on another page.
  const [activePageIdx, setActivePageIdxRaw] = useState(0);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  // #362: per-tabs-widget active tab index. UI state, not persisted
  // (tabs widget itself doesn't track which tab is "open"; it's a
  // viewer concern). Drop routing reads from this so dropping a
  // widget onto a Tabs container goes into the visible tab.
  const [activeTabIdxByWidget, setActiveTabIdxByWidget] = useState<
    Record<string, number>
  >({});
  const setActiveTabIdx = useCallback((widgetId: string, idx: number) => {
    setActiveTabIdxByWidget((cur) => ({ ...cur, [widgetId]: idx }));
  }, []);
  const setActivePageIdx = useCallback((idx: number) => {
    setActivePageIdxRaw(idx);
    setSelectedWidgetId(null);
  }, []);

  // Resolved referenced map title (optional). Same lazy-fetch as the
  // previous detail page.
  const [mapTitle, setMapTitle] = useState<string | null>(null);
  // Preview-time MapData composed from the referenced map (basemap +
  // viewport + non-target layers), feeding the live MapLibre preview
  // in Map widgets on the canvas (#343). Targets are intentionally
  // not resolved here -- the runtime does the per-target geojson
  // fetch; the designer just needs a "this is what your map will
  // look like" frame.
  const [previewMapData, setPreviewMapData] = useState<MapData | null>(null);
  // Org's basemap library, resolved into the CustomBasemap shape
  // MapCanvas consumes. Stays empty until the fetch completes; the
  // preview falls back to MapCanvas's inline OSM raster style in
  // that interim window.
  const [previewBasemaps, setPreviewBasemaps] = useState<CustomBasemap[]>([]);
  // Canvas widgets render live (see DesignTimeWidgetPreview), which
  // needs BOTH halves of the lookup a widget does: the sources it
  // binds to by id, and those sources resolved into the runtime's
  // shape. Passing only the resolved half is what made every
  // indicator on a correctly configured app render "No layer bound"
  // in red, so they travel together and are declared together.
  const appSources = useMemo(() => app.sources ?? [], [app.sources]);
  const resolvedTargets = useResolvedTargets(appSources);
  // #363: per-Map-widget MapData when the widget has its own
  // config.mapId override. Without this the canvas preview shows
  // the app default for EVERY map widget, ignoring overrides.
  const [widgetMapData, setWidgetMapData] = useState<
    Record<string, MapData>
  >({});
  // Resolved titles for widget-level map overrides, keyed by mapId
  // (not widget id) so two Map widgets pointing at the same map
  // share one entry. Used by MapWidgetConfig so the source field
  // shows the map's title instead of a truncated UUID.
  const [mapTitlesById, setMapTitlesById] = useState<
    Record<string, string>
  >({});
  // Stable join of every Map widget's id+mapId so the effect
  // re-runs only when the override-set actually changes (not on
  // every render or on unrelated widget edits).
  const widgetMapIdsKey = useMemo(() => {
    const pairs: string[] = [];
    for (const p of app.pages) {
      for (const w of p.widgets) {
        if (w.kind === 'map' && w.config.kind === 'map' && w.config.mapId) {
          pairs.push(`${w.id}:${w.config.mapId}`);
        }
      }
    }
    return pairs.sort().join('|');
  }, [app.pages]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Collect unique map ids: app default + every widget
        // override. A Set keeps duplicates from re-fetching.
        const uniqueMapIds = new Set<string>();
        if (app.mapId) uniqueMapIds.add(app.mapId);
        for (const p of app.pages) {
          for (const w of p.widgets) {
            if (
              w.kind === 'map' &&
              w.config.kind === 'map' &&
              w.config.mapId
            ) {
              uniqueMapIds.add(w.config.mapId);
            }
          }
        }
        const [mapsRes, ...mapResponses] = await Promise.all([
          // full=1: preview basemaps are built from each row's data
          // payload, which the list now strips by default.
          fetch('/api/portal/items?type=basemap&full=1'),
          ...Array.from(uniqueMapIds).map((id) =>
            fetch(`/api/portal/items/${id}`),
          ),
        ]);
        if (cancelled) return;
        if (mapsRes.ok) {
          const items = (await mapsRes.json()) as Array<Item<BasemapData>>;
          const built = items
            .map(basemapItemToCustomBasemap)
            .filter((b): b is CustomBasemap => b !== null);
          if (!cancelled) setPreviewBasemaps(built);
        }
        const dataById = new Map<string, { data: MapData; title: string }>();
        for (const res of mapResponses) {
          if (!res.ok) continue;
          const item = (await res.json()) as Item<MapData>;
          if (item.data) {
            dataById.set(item.id, { data: item.data, title: item.title });
          }
        }
        if (cancelled) return;
        // App-default first.
        if (app.mapId && dataById.has(app.mapId)) {
          const entry = dataById.get(app.mapId)!;
          setMapTitle(entry.title);
          setPreviewMapData(entry.data);
        } else {
          setMapTitle(null);
          setPreviewMapData(null);
        }
        // Per-widget override map.
        const widgetMap: Record<string, MapData> = {};
        for (const p of app.pages) {
          for (const w of p.widgets) {
            if (
              w.kind === 'map' &&
              w.config.kind === 'map' &&
              w.config.mapId &&
              dataById.has(w.config.mapId)
            ) {
              widgetMap[w.id] = dataById.get(w.config.mapId)!.data;
            }
          }
        }
        setWidgetMapData(widgetMap);
        // Title-by-id surface so MapWidgetConfig can render the map
        // title instead of the raw UUID. Includes the app default's
        // entry too so a single lookup works for both scopes.
        const titles: Record<string, string> = {};
        for (const [id, entry] of dataById.entries()) {
          titles[id] = entry.title;
        }
        setMapTitlesById(titles);
      } catch {
        /* silent: preview fall through to default basemap */
      }
    })();
    return () => {
      cancelled = true;
    };
    // widgetMapIdsKey covers every widget-level mapId change; app.mapId
    // for the app-default change. Both are needed because the effect
    // also reacts to mapId-only changes on the same widget set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.mapId, widgetMapIdsKey]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const data: WebAppData = {
        version: 1,
        template: 'custom',
        config: { template: 'custom', custom: app },
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`save failed: ${res.status} ${txt}`);
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }, [app, itemId]);

  // #22: "Save as template" creates a new app_template item with
  // the current blueprint, owned by the requesting user, default
  // access private (the author can re-share via the standard share
  // dialog on the new item).  We open the new template in a new
  // tab so the author doesn't lose context of the app they're
  // editing.  The blueprint is stored exactly as-is; the
  // instantiation path in the wizard (stampBlueprint) rewrites
  // widget ids on each new app stamped from this template.
  const [savingAsTemplate, setSavingAsTemplate] = useState(false);
  const onSaveAsTemplate = useCallback(async () => {
    setSavingAsTemplate(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'app_template',
          title: `${itemTitle} (template)`,
          description: `Saved from ${itemTitle}`,
          tags: ['user-saved'],
          data: app,
          access: 'private',
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`save-as-template failed: ${res.status} ${txt}`);
      }
      const body = (await res.json()) as { id: string };
      window.open(`/items/${body.id}`, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save-as-template failed');
    } finally {
      setSavingAsTemplate(false);
    }
  }, [app, itemTitle]);

  const updateApp = useCallback((patch: AppPatch) => {
    // An explicit undefined means "unset this", not "leave it alone".
    // The alternative, sending `{}` to mean "clear", quietly could
    // not clear at all: auto-refresh could be switched on and never
    // off again.
    setApp((cur) => applyPatch(cur, patch));
    setDirty(true);
  }, []);

  // #22: build the picker option list from themeItems (server-
  // loaded) with a fall-through to the in-process starter list so
  // an org without seeded themes still sees something.  Sort
  // builtins first (matched by seedKind), then user-saved themes
  // alphabetically.
  const themeOptions = useMemo(() => {
    if (themeItems.length === 0) {
      // Fallback to the legacy hardcoded starters.  This is the
      // "auth-sync seeder hasn't run yet for this org" path.
      return APP_THEME_OPTIONS.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        swatch: o.swatch,
        seedKind: o.id,
      }));
    }
    const byStarterOrder: Record<string, number> = {
      default: 0,
      slate: 1,
      aurora: 2,
      forest: 3,
      paper: 4,
    };
    return [...themeItems]
      .sort((a, b) => {
        const aBuiltin = a.seedKind !== null;
        const bBuiltin = b.seedKind !== null;
        if (aBuiltin && bBuiltin) {
          return (
            (byStarterOrder[a.seedKind!] ?? 99) -
            (byStarterOrder[b.seedKind!] ?? 99)
          );
        }
        if (aBuiltin) return -1;
        if (bBuiltin) return 1;
        return a.title.localeCompare(b.title);
      })
      .map((t) => ({
        id: t.id,
        label: t.title,
        description: t.description,
        swatch:
          t.data?.swatch ??
          (t.seedKind &&
            APP_THEME_OPTIONS.find((o) => o.id === t.seedKind)?.swatch) ??
          'hsl(210 40% 96%)',
        seedKind: t.seedKind,
      }));
  }, [themeItems]);

  // #22: resolved tokens for the currently-selected theme.  Used
  // by the canvas live-preview effect so a swap in the picker
  // updates the canvas chrome immediately (same code path the
  // runtime uses at view time).  Falls back to undefined when the
  // selected theme doesn't have its tokens loaded; the canvas
  // then leans on the in-process starter resolver.
  const resolvedThemeTokens = useMemo(() => {
    const id = app.themePresetId;
    if (!id) return undefined;
    const match = themeItems.find(
      (t) => t.id === id || t.seedKind === id,
    );
    const tokens = match?.data?.tokens;
    if (tokens && typeof tokens === 'object') return tokens;
    return undefined;
  }, [app.themePresetId, themeItems]);

  // #22: capture the currently-applied theme tokens and stamp them
  // as a new `theme` item.  Reads from the live CSS variables on
  // the document root rather than the source tokens object so an
  // author who customized via the older theme.accent / theme.bg
  // block also captures those overrides.  Opens the new theme
  // item in a new tab.
  const [savingAsTheme, setSavingAsTheme] = useState(false);
  const onSaveAsTheme = useCallback(async () => {
    setSavingAsTheme(true);
    setError(null);
    try {
      // Read the swatch from the active selection so the new
      // theme's picker preview matches what the author was looking
      // at.  Falls back to the starter swatch when present.
      const activeOpt = themeOptions.find(
        (o) =>
          o.id === app.themePresetId || o.seedKind === app.themePresetId,
      );
      const swatch = activeOpt?.swatch ?? 'hsl(210 40% 96%)';
      const tokensSource =
        resolvedThemeTokens ??
        (app.themePresetId &&
          APP_THEMES[app.themePresetId as AppThemePresetId]?.tokens) ??
        APP_THEMES.default.tokens;
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'theme',
          title: `${itemTitle} theme`,
          description: `Saved from ${itemTitle}`,
          tags: ['user-saved'],
          data: { version: 1, swatch, tokens: tokensSource },
          access: 'private',
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`save-as-theme failed: ${res.status} ${txt}`);
      }
      const body = (await res.json()) as { id: string };
      window.open(`/items/${body.id}`, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save-as-theme failed');
    } finally {
      setSavingAsTheme(false);
    }
  }, [
    app.themePresetId,
    itemTitle,
    resolvedThemeTokens,
    themeOptions,
  ]);
  void savingAsTheme;

  const updatePage = useCallback(
    (idx: number, patch: Partial<CustomPage>) => {
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
      }));
      setDirty(true);
    },
    [],
  );

  const updateWidget = useCallback(
    (widgetId: string, patch: Partial<CustomWidget>) => {
      // #22 WYSIWYG: walks containers + tabs so a patch applied
      // against a nested child id lands on the right node in the
      // tree instead of falling through to a no-op against the
      // page-level array.
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) =>
          i !== activePageIdx
            ? p
            : {
                ...p,
                widgets: updateWidgetDeep(
                  p.widgets,
                  widgetId,
                  (w) => ({ ...w, ...patch }) as CustomWidget,
                ),
              },
        ),
      }));
      setDirty(true);
    },
    [activePageIdx],
  );

  const removeWidget = useCallback(
    (widgetId: string) => {
      // Same deep walker: deleting a nested child (e.g. removing
      // a Print tool from inside an app-bar) targets the right
      // tree node.
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) =>
          i !== activePageIdx
            ? p
            : { ...p, widgets: removeWidgetDeep(p.widgets, widgetId) },
        ),
      }));
      setSelectedWidgetId(null);
      setDirty(true);
    },
    [activePageIdx],
  );

  const addWidgetAt = useCallback(
    (
      kind: CustomWidgetKind,
      col: number,
      row: number,
      // #98: the Canvas resolves a drop-target container via DOM
      // hit-test (works for both in-grid and partitioned-out-of-grid
      // containers) and passes the id here.  Non-null means
      // "drop into this container's children"; null means "use
      // col/row for page-level placement".  Reorder/reparent of
      // existing widgets goes through moveWidget, not this path.
      targetParentId: string | null = null,
      // #99: in-container layout (col/row in 1..192 axis space)
      // computed from the cursor position inside the target
      // container's rect.  Applied to the new child so it lands at
      // the drop spot instead of the placeholder origin.  Ignored
      // when targetParentId is null.
      targetLayout: CustomLayout | null = null,
    ) => {
      const layout: CustomLayout = {
        ...defaultLayoutForKind(kind),
        col: clampCol(col),
        row: Math.max(1, Math.round(row)),
      };
      const widget = stampWidget(kind, layout);
      let routedToTab = false;
      setApp((cur) => {
        const page = cur.pages[activePageIdx];
        if (!page) return cur;

        // #98: container routing now comes from the canvas's DOM
        // hit-test (which sees the rendered layout, including
        // partitioned sticky/dock slots that aren't in the grid).
        // Falls back to null for drops that didn't land on any
        // container; we still run the tabs hit-test below for the
        // older grid-coord-based tabs routing path.
        const hostContainer = targetParentId
          ? findContainerById(page.widgets, targetParentId)
          : null;
        if (hostContainer) {
          // #99: use the canvas-computed in-container layout when
          // available, else fall back to the placeholder origin.
          // For row-layout sticky/inline containers, the renderer
          // maps col -> left percentage so the child lands at the
          // drop position; for column-layout / dock containers the
          // value is harmless extra data.
          const childLayout = targetLayout
            ? targetLayout
            : { ...defaultLayoutForKind(kind), col: 1, row: 1 };
          const childWidget = stampWidget(kind, childLayout);
          const onlyMap =
            page.widgets.filter((w) => w.kind === 'map').length === 1
              ? page.widgets.find((w) => w.kind === 'map')
              : null;
          const childBound =
            onlyMap && WIDGETS_BIND_MAP_ID.has(childWidget.kind)
              ? autoBindMapWidgetId(childWidget, onlyMap.id)
              : childWidget;
          routedToTab = true;
          return {
            ...cur,
            pages: cur.pages.map((p, i) =>
              i !== activePageIdx
                ? p
                : {
                    ...p,
                    widgets: appendChildToContainer(
                      p.widgets,
                      hostContainer.id,
                      childBound,
                    ),
                  },
            ),
          };
        }

        // #362: tabs-container drop routing. If the drop point
        // (col, row) lands inside a Tabs widget's bounds, route the
        // new widget into that tab's nested widgets array instead
        // of the page-level array. Active tab is tracked by widget
        // id in activeTabIdxByWidget; defaults to 0.
        const hostTabs = findTabsHostAt(page.widgets, col, row);
        if (hostTabs && hostTabs.config.kind === 'tabs') {
          const tabIdx = activeTabIdxByWidget[hostTabs.id] ?? 0;
          const safeIdx = Math.min(tabIdx, hostTabs.config.tabs.length - 1);
          // Drop a "child" stamp at (1, 1) so layout coords are
          // consistent inside the tab. The runtime ignores col/row
          // for nested widgets and stacks them anyway, but the
          // values still feed rowSpan-derived min-height.
          const childLayout = { ...defaultLayoutForKind(kind), col: 1, row: 1 };
          const childWidget = stampWidget(kind, childLayout);
          // Auto-bind nested map-followers to the host page's
          // single Map widget (parent-page scope).
          const onlyMap =
            page.widgets.filter((w) => w.kind === 'map').length === 1
              ? page.widgets.find((w) => w.kind === 'map')
              : null;
          const childBound =
            onlyMap && WIDGETS_BIND_MAP_ID.has(childWidget.kind)
              ? autoBindMapWidgetId(childWidget, onlyMap.id)
              : childWidget;
          routedToTab = true;
          return {
            ...cur,
            pages: cur.pages.map((p, i) =>
              i !== activePageIdx
                ? p
                : {
                    ...p,
                    widgets: p.widgets.map((w) =>
                      w.id !== hostTabs.id || w.config.kind !== 'tabs'
                        ? w
                        : {
                            ...w,
                            config: {
                              ...w.config,
                              tabs: w.config.tabs.map((t, ti) =>
                                ti !== safeIdx
                                  ? t
                                  : {
                                      ...t,
                                      widgets: [...t.widgets, childBound],
                                    },
                              ),
                            },
                          },
                    ),
                  },
            ),
          };
        }

        // #339: auto-bind a newly-dropped map-following widget to
        // the only Map widget already on the page. Saves the user
        // a manual mapWidgetId pick in the common case (one Map on
        // the canvas + a Legend / LayerList / Search / Print /
        // Select / BasemapGallery dropped alongside it). When there
        // are zero or multiple Map widgets we leave mapWidgetId
        // unset; the user picks via the properties panel.
        const onlyMap =
          page.widgets.filter((w) => w.kind === 'map').length === 1
            ? page.widgets.find((w) => w.kind === 'map')
            : null;
        const widgetWithBinding =
          onlyMap && WIDGETS_BIND_MAP_ID.has(widget.kind)
            ? autoBindMapWidgetId(widget, onlyMap.id)
            : widget;
        return {
          ...cur,
          pages: cur.pages.map((p, i) =>
            i !== activePageIdx
              ? p
              : { ...p, widgets: [...p.widgets, widgetWithBinding] },
          ),
        };
      });
      // Select the new widget so the right rail shows it. For tab-
      // routed drops, select the freshly-added child id; the parent
      // tabs widget stays the click target on canvas.
      setSelectedWidgetId(routedToTab ? null : widget.id);
      setDirty(true);
    },
    [activePageIdx, activeTabIdxByWidget],
  );

  // ---- Page CRUD (#342) -----------------------------------------------------

  const addPage = useCallback(() => {
    setApp((cur) => {
      const usedTitles = new Set(cur.pages.map((p) => p.title));
      let n = cur.pages.length + 1;
      let title = `Page ${n}`;
      while (usedTitles.has(title)) {
        n += 1;
        title = `Page ${n}`;
      }
      const newPage: CustomPage = {
        id: `page-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        title,
        widgets: [],
      };
      return { ...cur, pages: [...cur.pages, newPage] };
    });
    setDirty(true);
    // Switch to the freshly added page so the user can start dropping
    // widgets onto it without an extra click. The new page lands at
    // index `app.pages.length` (current length, before this update).
    setActivePageIdx(app.pages.length);
  }, [app.pages.length, setActivePageIdx]);

  const renamePage = useCallback((idx: number, title: string) => {
    setApp((cur) => ({
      ...cur,
      pages: cur.pages.map((p, i) => (i === idx ? { ...p, title } : p)),
    }));
    setDirty(true);
  }, []);

  const removePage = useCallback(
    (idx: number) => {
      setApp((cur) => {
        if (cur.pages.length <= 1) return cur; // home page is sticky
        return { ...cur, pages: cur.pages.filter((_, i) => i !== idx) };
      });
      setDirty(true);
      // Re-clamp active page index after the removal. If the active
      // page was the removed one, fall back to the previous page.
      setActivePageIdxRaw((cur) => {
        if (cur < idx) return cur;
        if (cur === idx) return Math.max(0, idx - 1);
        return cur - 1;
      });
      setSelectedWidgetId(null);
    },
    [],
  );

  const movePage = useCallback(
    (from: number, to: number) => {
      setApp((cur) => {
        if (from === to || from < 0 || to < 0) return cur;
        if (from >= cur.pages.length || to >= cur.pages.length) return cur;
        const next = cur.pages.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { ...cur, pages: next };
      });
      setDirty(true);
      // Keep the active page following its widget set across the move.
      setActivePageIdxRaw((cur) => {
        if (cur === from) return to;
        if (from < cur && cur <= to) return cur - 1;
        if (to <= cur && cur < from) return cur + 1;
        return cur;
      });
    },
    [],
  );

  const activePage = app.pages[activePageIdx] ?? app.pages[0]!;

  // Map data keyed by MAP WIDGET id, for the whole page.
  //
  // A legend or layer list names the map widget it follows, which is
  // a different widget from itself, so a per-card value cannot answer
  // it: the lookup has to be able to reach any map on the page. Each
  // entry prefers that widget's own map override and falls back to
  // the app default, which is the same precedence the canvas already
  // uses to draw the Map widget.
  const previewStatesByMapWidget = useMemo<Record<string, MapData>>(() => {
    const out: Record<string, MapData> = {};
    const walk = (list: CustomWidget[]) => {
      for (const w of list) {
        if (w.kind === 'map') {
          const md = widgetMapData[w.id] ?? previewMapData;
          if (md) out[w.id] = md;
        }
        // Containers nest, and a map inside a tab is still a map the
        // legend beside it can follow.
        const kids = (w as { children?: CustomWidget[] }).children;
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(activePage?.widgets ?? []);
    return out;
  }, [activePage?.widgets, widgetMapData, previewMapData]);
  // #22 WYSIWYG: deep-find the selected widget so clicking a tool
  // icon inside an app-bar (or any nested child) resolves to the
  // child's config in the right-rail properties panel.  The legacy
  // top-level `find` only saw page-level widgets.
  const selectedWidget = selectedWidgetId
    ? findContainerById(activePage.widgets, selectedWidgetId)
    : null;

  // BuilderShell top-bar right side. Saved indicator + Save button +
  // Open link to the runtime. Page/widget counts surface as a small
  // muted line just below the title so the user gets a quick context
  // chip without it occupying button-style real estate.
  const toolbarRight = (
    <>
      {error && (
        <span className="inline-flex items-center gap-1 text-xs text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </span>
      )}
      {saved && (
        <span className="text-xs font-medium text-success">Saved</span>
      )}
      <button
        type="button"
        disabled={!canEdit || !dirty || saving}
        onClick={onSave}
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Save
      </button>
      <button
        type="button"
        disabled={!canEdit || savingAsTemplate}
        onClick={onSaveAsTemplate}
        title="Save the current blueprint as a reusable app_template item"
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {savingAsTemplate && <Loader2 className="h-4 w-4 animate-spin" />}
        Save as template
      </button>
      <a
        href={`/items/${itemId}/custom/run`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
      >
        <Eye className="h-4 w-4" />
        Open
        <ExternalLink className="h-3 w-3" />
      </a>
    </>
  );

  // Title shown next to the back arrow. Slim version: title +
  // a comma-separated context (pages / widgets) appended visually.
  // We keep this in the title string itself so it fits the BuilderShell
  // top bar's truncate-on-overflow behavior.
  const titleSummary = `${itemTitle} · ${app.pages.length} page${
    app.pages.length === 1 ? '' : 's'
  } · ${activePage.widgets.length} widget${
    activePage.widgets.length === 1 ? '' : 's'
  }`;

  // Right-panel content is selection-dependent. Either a widget's
  // own properties panel (when one is selected) or the app-level
  // properties (default map, targets, page title, etc.).
  const rightPanelContent = selectedWidget ? (
    <WidgetProperties
      widget={selectedWidget}
      canEdit={canEdit}
      pageWidgets={activePage.widgets}
      appPages={app.pages}
      appTargets={app.sources ?? []}
      appMapId={app.mapId}
      appMapTitle={mapTitle}
      mapTitlesById={mapTitlesById}
      onChange={(patch) => updateWidget(selectedWidget.id, patch)}
      onChangeConfig={(configPatch) =>
        updateWidget(selectedWidget.id, {
          config: {
            ...selectedWidget.config,
            ...configPatch,
          } as CustomWidget['config'],
        })
      }
      onPickWidgetMap={() =>
        setPickingMap({ scope: 'widget', widgetId: selectedWidget.id })
      }
      onRemove={() => removeWidget(selectedWidget.id)}
    />
  ) : (
    <AppProperties
      app={app}
      page={activePage}
      mapTitle={mapTitle}
      canEdit={canEdit}
      themeOptions={themeOptions}
      onUpdateApp={updateApp}
      onUpdatePage={(patch) => updatePage(activePageIdx, patch)}
      onClearMap={() => {
        setApp((cur) => {
          const { mapId: _drop, ...rest } = cur;
          void _drop;
          return rest;
        });
        setDirty(true);
      }}
      onPickMap={() => setPickingMap({ scope: 'app' })}
      onSaveAsTheme={onSaveAsTheme}
    />
  );

  return (
    <>
      <BuilderShell
        storageKey="builder-shell:web-app-custom"
        backHref="/items"
        title={titleSummary}
        icon={<Sparkles className="h-4 w-4 text-warn" strokeWidth={1.75} />}
        toolbarRight={toolbarRight}
        leftPanel={<Palette canEdit={canEdit} />}
        leftPanelTitle="Widgets"
        leftRailIcon={<LayoutGrid className="h-4 w-4" />}
        rightPanel={rightPanelContent}
        rightPanelTitle="Configuration"
        rightRailIcon={<Settings className="h-4 w-4" />}
      >
        {/* Canvas + page-tab strip. PageTabs sits above Canvas; both
            live inside an absolute-inset wrapper so the canvas grid
            takes the full BuilderShell main slot height as the user
            resizes panels. */}
        <div className="absolute inset-0 flex flex-col gap-2 p-2">
          <PageTabs
            pages={app.pages}
            activeIdx={activePageIdx}
            canEdit={canEdit}
            onSelect={setActivePageIdx}
            onAdd={addPage}
            onRename={renamePage}
            onRemove={removePage}
            onMove={movePage}
          />
          {/* min-h-0 flex-1 + flex flex-col so the Canvas's h-full
              child resolves correctly (the parent here needs to be
              a flex container so the Canvas root can fill via
              flex-distribution; height:100% on a non-flex parent
              that has flex-distributed height can fall back to
              auto-sizing in some browsers). */}
          <div className="flex min-h-0 flex-1 flex-col">
            <Canvas
              widgets={activePage.widgets}
              selectedId={selectedWidgetId}
              canEdit={canEdit}
              previewMapData={previewMapData}
              previewBasemaps={previewBasemaps}
              resolvedTargets={resolvedTargets}
              sources={appSources}
              previewStatesByMapWidget={previewStatesByMapWidget}
              widgetMapData={widgetMapData}
              activeTabIdxByWidget={activeTabIdxByWidget}
              themePresetId={app.themePresetId}
              themeTokens={resolvedThemeTokens}
              itemTitle={itemTitle}
              onSetActiveTabIdx={setActiveTabIdx}
              onSelect={setSelectedWidgetId}
              onCanvasDrop={(kind, col, row, targetParentId, targetLayout) =>
                addWidgetAt(kind, col, row, targetParentId, targetLayout)
              }
              onWidgetLayout={(id, layout) => updateWidget(id, { layout })}
              onWidgetMove={(id, targetParentId, targetIndex, pageLayout) => {
                setApp((cur) => ({
                  ...cur,
                  pages: cur.pages.map((p, i) =>
                    i !== activePageIdx
                      ? p
                      : {
                          ...p,
                          widgets: moveWidgetInTree(
                            p.widgets,
                            id,
                            targetParentId,
                            targetIndex,
                            pageLayout,
                          ),
                        },
                  ),
                }));
                setDirty(true);
              }}
            />
          </div>
        </div>
      </BuilderShell>

      {/* PickMapDialog renders outside BuilderShell so its own
          fixed-position modal z-index sits above the shell (z-20). */}
      <PickMapDialog
        open={pickingMap !== null}
        onPick={(picked) => {
          if (pickingMap?.scope === 'widget') {
            // Per-widget override path: write to widget.config.mapId.
            const wid = pickingMap.widgetId;
            const widget = activePage.widgets.find((w) => w.id === wid);
            if (widget && widget.kind === 'map') {
              updateWidget(wid, {
                config: {
                  ...widget.config,
                  mapId: picked.id,
                } as CustomWidget['config'],
              });
            }
          } else {
            // App-default path (or null fallthrough): write to app.mapId.
            updateApp({ mapId: picked.id });
          }
          setPickingMap(null);
        }}
        onClose={() => setPickingMap(null)}
      />
    </>
  );
}

// ---- Live Map preview helpers (#343) ---------------------------------------

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas consumes.
 * Mirrors the same helper that lives in run/page.tsx (and survey +
 * viewer); kept duplicated for now because the four call sites read
 * from different fetch shapes (server-side vs. client-side). Promote
 * to a shared util when a fifth caller appears.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}

/**
 * Tiny read-only MapLibre preview tile shown inside a Map widget on
 * the designer canvas. Mirrors what the runtime renders for that
 * widget but with all interaction suppressed -- the user is editing
 * layout, not exploring the map. Camera state lives in local
 * useState so MapCanvas's onCameraChange has somewhere to land
 * without bubbling back up into CustomAppData.
 *
 * Frozen during a gesture to avoid MapLibre re-rendering on every
 * mousemove tick; we render a static placeholder so the drag stays
 * smooth.
 */
function MapWidgetPreview({
  baseMapData,
  basemaps,
  frozen,
}: {
  baseMapData: MapData | null;
  basemaps: CustomBasemap[];
  frozen: boolean;
}) {
  // MapCanvas mutates camera through the controlled prop; we hold
  // it locally so panning + zooming inside the preview tile stays
  // contained.
  const [previewMap, setPreviewMap] = useState<MapData | null>(baseMapData);
  useEffect(() => {
    setPreviewMap(baseMapData);
  }, [baseMapData]);
  if (!previewMap) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        Pick a Map in the right rail to preview
      </div>
    );
  }
  if (frozen) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        Resizing...
      </div>
    );
  }
  return (
    <div className="pointer-events-none h-full w-full">
      <MapCanvas
        map={previewMap}
        basemaps={basemaps}
        selection={EMPTY_SELECTION}
        selectTool="off"
        suppressPopup
        hideNavigationControl
        onCameraChange={(c) => setPreviewMap((cur) => (cur ? { ...cur, ...c } : cur))}
        onSelectionChange={() => {}}
      />
    </div>
  );
}

const EMPTY_SELECTION: Record<string, Set<number | string>> = {};

// ---- Palette ---------------------------------------------------------------

/**
 * Widget categories. Mirrors Experience Builder's six-bucket
 * taxonomy (Mapcentric, Datacentric, Page element, Menu and tool,
 * Layout, Section) but trimmed to the three buckets we have today.
 * Future widgets (#361) drop into the existing buckets or grow new
 * ones (Layout when Row / Column / Grid land).
 *
 * `map` here means "binds to or feeds a Map widget" (basemap, layer
 * toggles, search, print, etc.). `data` means "reads from an app
 * target" (Attribute Table, Chart). `page` is static layout content
 * (Text today; Image / Button / Divider / Embed land in #361).
 */
type PaletteCategory = 'map' | 'data' | 'page' | 'layout';

const PALETTE_CATEGORIES: Array<{
  id: PaletteCategory;
  label: string;
  hint: string;
}> = [
  {
    id: 'map',
    label: 'Map widgets',
    hint: 'Drive or follow a map',
  },
  {
    id: 'data',
    label: 'Data widgets',
    hint: 'Read from an app target',
  },
  {
    id: 'page',
    label: 'Page elements',
    hint: 'Static layout content',
  },
  {
    id: 'layout',
    label: 'Layout',
    hint: 'Containers that hold other widgets',
  },
];

/**
 * Theme preset list rendered in the right-rail App settings panel.
 * Keep in sync with the AppThemePresetId union in shared-types;
 * adding a new preset there means adding an entry here so it
 * shows up in the picker.
 */
const APP_THEME_OPTIONS: Array<{
  id: AppThemePresetId;
  label: string;
  description: string;
  swatch: string;
}> = [
  {
    id: 'default',
    label: 'Default',
    description: 'Portal-matching neutral palette.',
    swatch: 'hsl(210 40% 96%)',
  },
  {
    id: 'slate',
    label: 'Slate',
    description: 'Cool gray + indigo. Technical.',
    swatch: 'hsl(217 33% 17%)',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Off-white + teal. Generous spacing.',
    swatch: 'hsl(180 30% 95%)',
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Cream + forest green. Field-ready.',
    swatch: 'hsl(45 33% 95%)',
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'High-contrast print-style. Reports, public maps.',
    swatch: 'hsl(0 0% 99%)',
  },
];

const PALETTE_TILES: Array<{
  kind: CustomWidgetKind;
  label: string;
  Icon: LucideIcon;
  hint: string;
  category: PaletteCategory;
}> = [
  // -- Map widgets -----------------------------------------------
  {
    kind: 'map',
    label: 'Map',
    Icon: MapIcon,
    hint: 'The main map canvas',
    category: 'map',
  },
  {
    kind: 'layer-list',
    label: 'Layers',
    Icon: LayersIcon,
    hint: 'Layer toggles + ordering for a map',
    category: 'map',
  },
  {
    kind: 'legend',
    label: 'Legend',
    Icon: ListTree,
    hint: 'Symbology of visible layers',
    category: 'map',
  },
  {
    kind: 'basemap-gallery',
    label: 'Basemaps',
    Icon: ImageIcon,
    hint: 'Tile grid to switch basemaps on a map',
    category: 'map',
  },
  {
    kind: 'print',
    label: 'Print',
    Icon: Printer,
    hint: 'Print the bound map',
    category: 'map',
  },
  {
    kind: 'export',
    label: 'Export',
    Icon: Download,
    hint: 'Export visible features to CSV / Excel',
    category: 'map',
  },
  {
    kind: 'splash',
    label: 'Splash',
    Icon: MessageSquare,
    hint: 'Modal shown on app load with welcome text or disclaimer',
    category: 'page',
  },
  {
    kind: 'bookmark',
    label: 'Bookmark',
    Icon: BookmarkIcon,
    hint: 'Saved viewports as fly-to buttons',
    category: 'map',
  },
  {
    kind: 'coordinates',
    label: 'Coordinates',
    Icon: CrosshairIcon,
    hint: 'Live cursor lat/lon on the bound map',
    category: 'map',
  },
  {
    kind: 'my-location',
    label: 'My Location',
    Icon: LocateIcon,
    hint: 'Fly to the browser geolocation',
    category: 'map',
  },
  {
    kind: 'elevation-profile',
    label: 'Elevation Profile',
    Icon: ChartSplineIcon,
    hint: 'Draw a line, chart the ground height along it',
    category: 'map',
  },
  {
    kind: 'magic-outline',
    label: 'Magic Outline',
    Icon: Wand2,
    hint: 'Click imagery to trace a shape into an editable layer',
    category: 'map',
  },
  // -- Data widgets ----------------------------------------------
  {
    kind: 'search',
    label: 'Search',
    Icon: Search,
    hint: 'Address + attribute search bar',
    category: 'data',
  },
  {
    kind: 'select',
    label: 'Select',
    Icon: MousePointer2,
    hint: 'Selection-mode buttons (click / box / lasso)',
    category: 'data',
  },
  {
    kind: 'attribute-table',
    label: 'Attribute Table',
    Icon: Table2,
    hint: 'Rows from one of the app targets',
    category: 'data',
  },
  {
    kind: 'chart',
    label: 'Chart',
    Icon: BarChart3,
    hint: 'Bar / line / pie over a target',
    category: 'data',
  },
  {
    kind: 'indicator',
    label: 'Indicator',
    Icon: Gauge,
    hint: 'One big number from a target layer',
    category: 'data',
  },
  {
    kind: 'time-slider',
    label: 'Time slider',
    Icon: Clock,
    hint: 'Scrub every layer back to a past date (#87)',
    category: 'data',
  },
  {
    kind: 'create-feature',
    label: 'Add feature',
    Icon: Plus,
    hint: 'Click-to-add a new feature on a target layer (#69)',
    category: 'data',
  },
  {
    kind: 'edit-feature',
    label: 'Edit feature',
    Icon: Pencil,
    hint: 'Edit the selected feature on a target layer (#70)',
    category: 'data',
  },
  {
    kind: 'delete-feature',
    label: 'Delete feature',
    Icon: Trash2,
    hint: 'Delete the selected feature(s) from a target layer (#71)',
    category: 'data',
  },
  // -- Page elements ---------------------------------------------
  {
    kind: 'text',
    label: 'Text',
    Icon: TypeIcon,
    hint: 'Headings, intros, attributions',
    category: 'page',
  },
  {
    kind: 'image',
    label: 'Image',
    Icon: ImageIcon,
    hint: 'Static image from a URL',
    category: 'page',
  },
  {
    kind: 'button',
    label: 'Button',
    Icon: MousePointerClick,
    hint: 'Link to another page or external URL',
    category: 'page',
  },
  {
    kind: 'tool',
    label: 'Tool',
    Icon: Wand2,
    hint: 'Run a Tool item (Select By Location, OSM Query, etc.)',
    category: 'data',
  },
  {
    kind: 'divider',
    label: 'Divider',
    Icon: MinusIcon,
    hint: 'Horizontal rule between sections',
    category: 'page',
  },
  {
    kind: 'embed',
    label: 'Embed',
    Icon: CodeIcon,
    hint: 'iframe a video, dashboard, or form',
    category: 'page',
  },
  // -- Layout containers ----------------------------------------
  {
    kind: 'tabs',
    label: 'Tabs',
    Icon: LayoutGrid,
    hint: 'Container with multiple tabs of widgets',
    category: 'layout',
  },
  // Themed-app containers. These hold OTHER widgets and render
  // them inside opinionated themed chrome. Templates use these for
  // the chrome; freeform authors drop them to build the same
  // shapes themselves.
  {
    kind: 'container',
    label: 'Container',
    Icon: Square,
    hint: 'Generic layout region: drop widgets inside; chrome (sticky bar, side dock, drawer) is configurable.',
    category: 'layout',
  },
];

function Palette({ canEdit }: { canEdit: boolean }) {
  // Bucket once at module scope so we don't refilter every render.
  // Each category renders as its own subsection with a small header
  // so authors can scan by purpose ("I need a thing that talks to
  // the map" vs. "I need a static text block").
  const grouped = PALETTE_CATEGORIES.map((cat) => ({
    ...cat,
    tiles: PALETTE_TILES.filter((t) => t.category === cat.id),
  })).filter((g) => g.tiles.length > 0);

  // Palette renders inside BuilderShell's leftPanel slot, which
  // already provides the panel header (title "Widgets") and the
  // scroll container. We only need the categorized tile list here.
  return (
    <div className="flex flex-col pb-2">
      <p className="border-b border-border bg-surface-2 px-3 py-1.5 text-2xs text-muted">
        {canEdit ? 'Drag a widget onto the canvas' : 'Read only'}
      </p>
      {grouped.map((group) => (
        <div key={group.id} className="border-b border-border last:border-0">
          <div className="px-3 pb-1 pt-3">
            <p className="text-xs font-medium text-ink-1">{group.label}</p>
          </div>
          <div className="flex flex-col">
            {group.tiles.map((tile) => (
              <PaletteTile key={tile.kind} {...tile} canEdit={canEdit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Maps a widget kind to the help-doc control id (`data-help` value)
 * for that widget's palette tile.  When the user picks a palette
 * tile in help-drawer pick-a-control mode, the matching widget doc
 * opens.  Kinds not in this map render with no `data-help`.
 *
 * Keep the right-hand value in sync with the `controls:` block of
 * the relevant doc under `content/help/web-apps/widgets/`.
 */
const WIDGET_HELP_BINDING: Partial<Record<CustomWidgetKind, string>> = {
  'layer-list': 'widget-layer-list-toggle',
  legend: 'widget-legend-toggle',
  'basemap-gallery': 'widget-basemap-gallery-toggle',
  print: 'widget-print-toggle',
  export: 'widget-export-toggle',
  splash: 'widget-splash-toggle',
  search: 'widget-search-toggle',
  'attribute-table': 'widget-attribute-table-toggle',
  chart: 'widget-chart-toggle',
};

function PaletteTile({
  kind,
  label,
  Icon,
  hint,
  canEdit,
}: {
  kind: CustomWidgetKind;
  label: string;
  Icon: LucideIcon;
  hint: string;
  canEdit: boolean;
}) {
  const helpId = WIDGET_HELP_BINDING[kind];
  return (
    <button
      type="button"
      // data-help wires the tile to its widget doc so picking the
      // tile in help-drawer pick-mode opens "Splash widget", etc.
      // Tiles without a published doc render without the attribute.
      {...(helpId ? { 'data-help': helpId } : {})}
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-widget-kind', kind);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={hint}
      disabled={!canEdit}
      className="group flex w-full cursor-grab items-center gap-2.5 px-3 py-2 text-left text-sm text-ink-1 transition-colors hover:bg-surface-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted group-hover:text-ink-1" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---- PageTabs (#342) -------------------------------------------------------

/**
 * Horizontal tab strip above the canvas. One tab per page; click to
 * switch. The active tab gets inline rename + delete + reorder
 * affordances. Adding a page is a "+" button at the end.
 *
 * Single-page mode: tabs strip still renders so the user discovers
 * the affordance, but there's nothing to delete and reorder is a
 * no-op.
 *
 * Drag-to-reorder is deferred; for now reorder is left/right arrow
 * buttons on the active tab (matches the form designer's question
 * reorder UX).
 */
function PageTabs({
  pages,
  activeIdx,
  canEdit,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onMove,
}: {
  pages: CustomPage[];
  activeIdx: number;
  canEdit: boolean;
  onSelect: (idx: number) => void;
  onAdd: () => void;
  onRename: (idx: number, title: string) => void;
  onRemove: (idx: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const confirm = useConfirm();

  function commitRename() {
    if (renamingIdx === null) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length > 0 && trimmed !== pages[renamingIdx]!.title) {
      onRename(renamingIdx, trimmed);
    }
    setRenamingIdx(null);
    setRenameDraft('');
  }

  return (
    <div className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-border bg-surface-1 px-2">
      {pages.map((p, i) => {
        const isActive = i === activeIdx;
        const isRenaming = renamingIdx === i;
        return (
          <div
            key={p.id}
            className={`group relative flex items-center gap-1 px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'text-ink-0'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingIdx(null);
                    setRenameDraft('');
                  }
                }}
                className="w-32 border-none bg-transparent p-0 text-sm font-medium text-ink-0 focus:outline-none focus:ring-0"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(i)}
                onDoubleClick={() => {
                  if (!canEdit) return;
                  setRenamingIdx(i);
                  setRenameDraft(p.title);
                }}
                title={canEdit ? 'Click to switch, double-click to rename' : ''}
                className="font-medium"
              >
                {p.title}
              </button>
            )}
            {isActive && canEdit && !isRenaming && (
              <span className="inline-flex items-center gap-0 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="Move left"
                  disabled={i === 0}
                  onClick={() => onMove(i, i - 1)}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title="Move right"
                  disabled={i === pages.length - 1}
                  onClick={() => onMove(i, i + 1)}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title="Rename"
                  onClick={() => {
                    setRenamingIdx(i);
                    setRenameDraft(p.title);
                  }}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title={
                    pages.length === 1
                      ? 'A custom app must have at least one page.'
                      : p.widgets.length > 0
                        ? `Delete page (${p.widgets.length} widget${p.widgets.length === 1 ? '' : 's'} on it)`
                        : 'Delete page'
                  }
                  disabled={pages.length === 1}
                  onClick={async () => {
                    if (pages.length === 1) return;
                    if (p.widgets.length > 0) {
                      const ok = await confirm({
                        title: 'Delete page?',
                        message: `Delete "${p.title}" and its ${p.widgets.length} widget${p.widgets.length === 1 ? '' : 's'}? This cannot be undone.`,
                        variant: 'danger',
                        confirmLabel: 'Delete page',
                      });
                      if (!ok) return;
                    }
                    onRemove(i);
                  }}
                  className="rounded p-0.5 text-muted hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </span>
            )}
            {/* Active-tab underline. -bottom-px aligns it with the
                wrapper's border-b so the indicator visually replaces
                the divider for the active tab. */}
            {isActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-ink-0"
              />
            )}
          </div>
        );
      })}
      {canEdit && (
        <button
          type="button"
          onClick={onAdd}
          title="Add page"
          className="ml-1 inline-flex items-center gap-1 px-2 py-2 text-sm text-muted transition-colors hover:text-ink-1"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          Page
        </button>
      )}
    </div>
  );
}

// ---- Canvas -----------------------------------------------------------------

// Doubled grid resolution. Each schema bump halves the cell size:
//   v1 (12-col + 48px row) -> v2 (24-col + 24px row, #357)
//   v2 (24-col + 24px row) -> v3 (48-col + 12px row, user feedback
//   on tool-button snap being too coarse).
// Existing apps are migrated on load via migrateCustomAppData.
// #95: v4 grid resolution.  Quadrupled vs. v3 (was 48 cols / 12px
// rows) so the snap stops are 4x finer.  Lets authors size and
// position widgets with much less "snapped two cells off where I
// wanted" friction.  The v3→v4 migration in shared-types
// multiplies legacy widget col/row/colSpan/rowSpan by 4 so the
// physical layout stays identical across the bump.  GAP_PX is
// scaled by the same factor so a widget spanning N tracks renders
// at the same physical size as it did at v3 (Item span =
// N * track + (N-1) * gap; if both terms scale 1/4 the total
// stays put).
const ROW_HEIGHT_PX = 3;
const GRID_COLS = 192;
const GAP_PX = 1.5;
/**
 * Floor for the canvas's working width. On viewports narrower than
 * this the designer pane scrolls horizontally instead of squeezing
 * the 48-column grid into a sliver. The earlier 1400px fixed-width
 * experiment was reverted (broke narrow viewports + made wide
 * displays cramped); the new model is responsive container widgets
 * inside a flexible grid, so the grid's min-width is just a
 * scrollability floor, not a layout cap.
 */
const CANVAS_MIN_WIDTH_PX = 1200;

/**
 * Active drag-or-resize gesture state. The canvas owns one of these
 * at a time (or null) -- one global gesture is enough since both
 * resize and reposition live on the same selected widget.
 *
 *   - kind 'move': the widget body is being dragged. mousemove
 *     updates col + row on the snap grid; mouseup commits the
 *     final layout.
 *   - kind 'resize-br' / 'resize-r' / 'resize-b': the user
 *     mouse-downed on a corner / edge handle. The corresponding
 *     dimension(s) update on mousemove.
 *
 * Drag threshold: gesture has to move >= 4px before we mutate
 * layout. That keeps a plain click from accidentally bumping
 * a widget by 0,0 (which still triggers a save dirty bit and
 * looks confusing in the UI).
 */
interface ActiveGesture {
  /**
   * Drag flavor.  'move' is the layout-position drag; the rest are
   * resize handles named after which corner / edge is being pulled
   * (t/r/b/l for edges, tl/tr/bl/br for corners).  Edge handles
   * adjust the corresponding span (and position, for top / left
   * which leave the opposite edge anchored).  Corners combine an
   * edge horizontal + edge vertical (#97).
   */
  kind:
    | 'move'
    | 'resize-t'
    | 'resize-r'
    | 'resize-b'
    | 'resize-l'
    | 'resize-tl'
    | 'resize-tr'
    | 'resize-br'
    | 'resize-bl';
  widgetId: string;
  startX: number;
  startY: number;
  startLayout: CustomLayout;
  /**
   * #96: container the widget currently lives inside (null when the
   * widget is a top-level page widget).  Carried so the mouseup
   * handler can decide whether the gesture is a fine-grid layout
   * change (move within page level), a reorder (move within same
   * container), or a reparent (move across container boundaries).
   */
  srcParentId: string | null;
  /**
   * #99: cursor's offset from the widget's top-left corner at the
   * moment of mousedown.  When the in-container child drag handler
   * positions the widget via free-position layout coords, we
   * subtract this offset from the cursor so the widget's grabbed
   * point (not its top-left corner) tracks under the cursor.
   * Captured in pixels; combined with the container's rect to map
   * back to layout col/row.
   */
  grabOffsetX: number;
  grabOffsetY: number;
  /**
   * #99: widget's pixel size at the moment of mousedown.  The
   * free-position anchoring in FlowContainer renders a child at
   * `left: P%; transform: translateX(-P%)` so the P%-anchor of the
   * child lines up with the P%-anchor of the container.  The drag
   * math has to invert that, which requires the child's pixel width
   * (and height for column-layout): the available travel for the
   * child's grabbed point is (containerWidth - widgetWidth), and
   * the cursor's position within that range maps linearly to
   * P in 0..100.
   */
  widgetWidth: number;
  widgetHeight: number;
}

const DRAG_THRESHOLD_PX = 4;

function Canvas({
  widgets,
  selectedId,
  canEdit,
  previewMapData,
  previewBasemaps,
  resolvedTargets,
  sources,
  previewStatesByMapWidget,
  widgetMapData,
  activeTabIdxByWidget,
  themePresetId,
  themeTokens,
  itemTitle,
  onSetActiveTabIdx,
  onSelect,
  onCanvasDrop,
  onWidgetLayout,
  onWidgetMove,
}: {
  widgets: CustomWidget[];
  selectedId: string | null;
  canEdit: boolean;
  previewMapData: MapData | null;
  previewBasemaps: CustomBasemap[];
  /** Targets resolved to the runtime's shape so canvas widgets can
   *  render live rather than as placeholders. */
  resolvedTargets: ResolvedTargetLite[];
  /** Forwarded to each widget's live preview; see WidgetCard. */
  sources: AppDataSource[];
  /** Map data by MAP WIDGET id, so a legend can reach the map it
   *  follows rather than only its own card's value. */
  previewStatesByMapWidget: Record<string, MapData>;
  widgetMapData: Record<string, MapData>;
  activeTabIdxByWidget: Record<string, number>;
  /**
   * Theme preset to apply at the canvas root (CSS variables). Lets
   * the in-canvas widgets render with the same theme they'd use at
   * runtime so the designer preview is WYSIWYG across theme changes.
   */
  themePresetId: string | undefined;
  /**
   * #22: explicit token bundle for the currently-selected theme,
   * resolved upstream against the org's theme items.  When set,
   * the canvas applies these directly via applyAppThemeTokens.
   * Falls back to the in-process starter resolver when undefined.
   */
  themeTokens: Record<string, string> | undefined;
  /**
   * #22 WYSIWYG: item title used as the fallback for app-bar
   * children that don't have their own title set.  Passed
   * straight through to WidgetCard which threads it into the
   * inline themed-containers render.
   */
  itemTitle: string;
  onSetActiveTabIdx: (widgetId: string, idx: number) => void;
  onSelect: (id: string | null) => void;
  onCanvasDrop: (
    kind: CustomWidgetKind,
    col: number,
    row: number,
    // #98: container the canvas's DOM hit-test routed the drop into,
    // or null if the cursor landed on the page-level grid.
    targetParentId: string | null,
    // #99: when targetParentId is non-null, this is the in-container
    // layout (col/row in 1..192 axis space) computed from the cursor's
    // position inside the target container's rect.  The handler
    // applies it to the new child so the drop lands where the user
    // released, instead of at the placeholder origin.
    targetLayout: CustomLayout | null,
  ) => void;
  onWidgetLayout: (id: string, layout: CustomLayout) => void;
  /**
   * #96: reparent / reorder a widget.  Called on mouseup when the
   * move gesture crossed a parent boundary OR reordered within the
   * same container.  `targetParentId === null` means "land at the
   * page level"; non-null means "drop inside this container".
   * `pageLayout` is the new grid coords when targetParentId is
   * null (so a widget pulled out of a container gets a sensible
   * position); ignored when targetParentId is non-null.
   */
  onWidgetMove: (
    id: string,
    targetParentId: string | null,
    targetIndex: number,
    pageLayout: CustomLayout | null,
  ) => void;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // #98: separate ref for the inner CSS grid (a child of the canvas
  // wrapper).  Used for accurate col/row arithmetic when the cursor
  // is over the grid surface; the wrapper ref still owns drop +
  // dragover events for the whole canvas pane including the flex-
  // sibling slots that sticky/dock containers live in.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [gesture, setGesture] = useState<ActiveGesture | null>(null);
  // #53 WYSIWYG: drag-from-palette drop-target indicator.  When
  // a palette tile is hovered over a container's footprint, we
  // light up that container with an outline so the user knows
  // the drop will route into the container's children (vs.
  // landing as a page-level widget).  Cleared on dragleave +
  // drop.  Computed in onDragOver via the same findContainerHostAt
  // helper the drop handler uses, so what the user sees == what
  // they'll get.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Theme root for live preview of theme tokens.  Same dual-path
  // behaviour as the runtime: use the upstream-resolved tokens
  // when present (user-saved or built-in theme item), else fall
  // back to the in-process starter resolver keyed off themePresetId.
  const themeRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!themeRootRef.current) return;
    if (themeTokens) {
      applyAppThemeTokens(themeRootRef.current, themeTokens);
    } else {
      applyAppTheme(themeRootRef.current, themePresetId);
    }
  }, [themePresetId, themeTokens]);

  // Compute the canvas's grid extent from the widgets' bottom-most
  // row so dropping a widget below the current content extends the
  // canvas naturally. Always at least 12 rows so a fresh app has
  // room to drop into.  #98: partitioned containers are excluded
  // because their grid layout is ignored at render time -- counting
  // their (often arbitrary, e.g. 16 or 240) rowSpan would inflate
  // the grid height for no visual reason.
  const minRows = 12;
  const usedRows = widgets.reduce(
    (n, w) =>
      isPartitionedContainer(w)
        ? n
        : Math.max(n, w.layout.row + w.layout.rowSpan - 1),
    0,
  );
  const totalRows = Math.max(minRows, usedRows + 4);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!canEdit) return;
    if (!e.dataTransfer.types.includes('text/x-widget-kind')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // #98: DOM hit-test against [data-widget-id] elements so the
    // routing decision works for both in-grid containers (inline,
    // overlay-trigger) and partitioned containers (sticky-top /
    // sticky-bottom / dock-left / dock-right) without two coordinate
    // systems to reconcile.
    const host = findContainerHostAtClient(
      canvasRef.current,
      widgets,
      e.clientX,
      e.clientY,
    );
    setDropTargetId((cur) => (cur === (host?.id ?? null) ? cur : host?.id ?? null));
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear when the cursor leaves the canvas root, not when
    // it crosses between child elements inside the canvas.  Without
    // the relatedTarget check, the highlight would flicker every
    // time the cursor passed over a widget child.
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    setDropTargetId(null);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    setDropTargetId(null);
    if (!canEdit) return;
    const kind = e.dataTransfer.getData('text/x-widget-kind');
    if (!kind) return;
    e.preventDefault();
    // #98: grid coords are computed from the inner grid div's rect
    // (not the canvas wrapper, which now contains flex-sibling slots
    // for sticky/dock containers).  Clamp so a drop landing OUTSIDE
    // the grid (e.g. over a left-dock slot) still produces a sensible
    // page-level position -- the upstream addWidgetAt also runs the
    // DOM hit-test and routes into a container when one is under the
    // cursor, so the (col,row) here is just the fallback.
    const rect = gridRef.current?.getBoundingClientRect();
    let col = 1;
    let row = 1;
    if (rect) {
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const y = Math.max(0, e.clientY - rect.top);
      const colWidth = rect.width / GRID_COLS;
      col = Math.max(1, Math.min(GRID_COLS, Math.floor(x / colWidth) + 1));
      row = Math.max(1, Math.floor(y / ROW_HEIGHT_PX) + 1);
    }
    // #98: same DOM hit-test used by the dragover highlight, so the
    // routing decision is consistent with what the user just saw.
    const host = findContainerHostAtClient(
      canvasRef.current,
      widgets,
      e.clientX,
      e.clientY,
    );
    // #99: when dropping into a container, also compute the in-
    // container layout so the new child lands where the cursor was.
    let targetLayout: CustomLayout | null = null;
    if (host) {
      const targetEl = canvasRef.current?.querySelector(
        `[data-widget-id="${host.id}"]`,
      ) as HTMLElement | null;
      if (targetEl) {
        const tr = targetEl.getBoundingClientRect();
        const xPct = Math.max(
          0,
          Math.min(1, (e.clientX - tr.left) / Math.max(1, tr.width)),
        );
        const yPct = Math.max(
          0,
          Math.min(1, (e.clientY - tr.top) / Math.max(1, tr.height)),
        );
        targetLayout = {
          col: Math.max(1, Math.min(192, Math.round(xPct * 191) + 1)),
          row: Math.max(1, Math.min(192, Math.round(yPct * 191) + 1)),
          colSpan: 1,
          rowSpan: 1,
        };
      }
    }
    onCanvasDrop(kind as CustomWidgetKind, col, row, host?.id ?? null, targetLayout);
  }

  // Begin a gesture. Called from WidgetCard's mousedown handler
  // (move) and from the resize handles (resize-*). We capture the
  // start point + the widget's starting layout + the widget's
  // current parent container (#96) so mousemove can compute deltas
  // and mouseup can decide between fine-grid move, reorder within
  // the current container, or reparent across containers.
  const beginGesture = useCallback(
    (
      kind: ActiveGesture['kind'],
      widget: CustomWidget,
      srcParentId: string | null,
      e: ReactMouseEvent<HTMLElement>,
    ) => {
      if (!canEdit) return;
      e.stopPropagation();
      // #99: capture grab-offset so in-container drags translate the
      // widget under the cursor without snapping its left edge to
      // the cursor.  The element we want is the widget root itself
      // -- find it by data-widget-id under the canvas so we don't
      // rely on currentTarget (which may be a resize-handle button
      // for resize gestures).
      const widgetEl = canvasRef.current?.querySelector(
        `[data-widget-id="${widget.id}"], [data-child-id="${widget.id}"]`,
      ) as HTMLElement | null;
      const rect = widgetEl?.getBoundingClientRect();
      const grabOffsetX = rect ? e.clientX - rect.left : 0;
      const grabOffsetY = rect ? e.clientY - rect.top : 0;
      const widgetWidth = rect?.width ?? 0;
      const widgetHeight = rect?.height ?? 0;
      setGesture({
        kind,
        widgetId: widget.id,
        startX: e.clientX,
        startY: e.clientY,
        startLayout: widget.layout,
        srcParentId,
        grabOffsetX,
        grabOffsetY,
        widgetWidth,
        widgetHeight,
      });
    },
    [canEdit],
  );

  // Window-level mousemove + mouseup while a gesture is active.
  // We attach to window so the gesture survives the cursor leaving
  // the widget bounds (a normal pattern for drag UX -- letting
  // the cursor jump out of the widget shouldn't cancel the drag).
  useEffect(() => {
    if (!gesture) return;
    // Bind a local non-null alias so TS narrows cleanly inside the
    // closures below; the effect body's null guard above is what
    // actually keeps us safe at runtime.
    const g = gesture;
    function pxPerCol(): number {
      // #98: track px-per-col against the INNER grid (not the canvas
      // wrapper), since the wrapper now contains flex siblings for
      // sticky/dock containers and is wider than the grid itself.
      const rect = gridRef.current?.getBoundingClientRect();
      return rect ? rect.width / GRID_COLS : 100;
    }
    /** Cursor coords -> canvas-relative grid coords (col, row).
     *  Clamps to the grid bounds so a cursor over a sticky / dock
     *  slot (outside the inner grid div) still produces a valid
     *  page-level placement when the gesture demands one. */
    function cursorToGrid(e: MouseEvent): { col: number; row: number } {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return { col: 1, row: 1 };
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const y = Math.max(0, e.clientY - rect.top);
      const colWidth = rect.width / GRID_COLS;
      const col = Math.max(1, Math.min(GRID_COLS, Math.floor(x / colWidth) + 1));
      const row = Math.max(1, Math.floor(y / ROW_HEIGHT_PX) + 1);
      return { col, row };
    }
    /**
     * Compute the insertion index inside a container based on the
     * cursor position vs. existing children's bounding rects.  For
     * a row-layout container, slot picked by cursor X; for column-
     * layout, by cursor Y.  Children that match `excludeId` (the
     * widget currently being dragged) are skipped so a reorder
     * doesn't count its own slot.
     */
    function indexInContainer(
      containerId: string,
      e: MouseEvent,
      excludeId: string,
    ): number {
      const containerEl = canvasRef.current?.querySelector(
        `[data-widget-id="${containerId}"]`,
      ) as HTMLElement | null;
      if (!containerEl) return 0;
      const children = Array.from(
        containerEl.querySelectorAll('[data-child-id]'),
      ) as HTMLElement[];
      const relevant = children.filter(
        (c) => c.getAttribute('data-child-id') !== excludeId,
      );
      if (relevant.length === 0) return 0;
      // Detect layout direction by the children's center spread:
      // wider horizontal range than vertical → row, else column.
      const rects = relevant.map((c) => c.getBoundingClientRect());
      const xs = rects.map((r) => r.left + r.width / 2);
      const ys = rects.map((r) => r.top + r.height / 2);
      const xSpread = Math.max(...xs) - Math.min(...xs);
      const ySpread = Math.max(...ys) - Math.min(...ys);
      const isRow = xSpread >= ySpread;
      const cursor = isRow ? e.clientX : e.clientY;
      const centers = isRow ? xs : ys;
      // Insertion index: first center > cursor; else after last.
      for (let i = 0; i < centers.length; i++) {
        if (cursor < centers[i]!) return i;
      }
      return relevant.length;
    }
    function onMove(e: MouseEvent) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      // #96: track hovered container for drop-target highlight on
      // every move kind.  The mouseup handler reads the cursor's
      // final position; this just keeps the visual indicator in
      // sync during the drag.
      if (g.kind === 'move') {
        // #98: DOM hit-test (same one the drop handler uses) so the
        // highlight tracks containers regardless of whether they're
        // inside the grid or in a partitioned flex slot.
        const host = findContainerHostAtClient(
          canvasRef.current,
          widgets,
          e.clientX,
          e.clientY,
        );
        const targetId = host && host.id !== g.widgetId ? host.id : null;
        setDropTargetId((cur) => (cur === targetId ? cur : targetId));
      }
      const colDelta = Math.round(dx / pxPerCol());
      const rowDelta = Math.round(dy / ROW_HEIGHT_PX);
      const start = g.startLayout;
      const next: CustomLayout = { ...start };
      if (g.kind === 'move') {
        if (g.srcParentId !== null) {
          // #99: in-container child drag.  Only flow-positioned
          // parents (inline / sticky-top / sticky-bottom -- the ones
          // rendered by FlowContainer) participate in the free-
          // position model.  Dock and overlay parents still use the
          // old index-reorder-on-mouseup path because their
          // renderers stack children with dividers, not absolute
          // coords.
          const parent = findWidgetWithParent(widgets, g.srcParentId);
          const parentCfg = parent?.widget.config;
          const isFlowParent =
            parentCfg?.kind === 'container' &&
            (parentCfg.position === undefined ||
              parentCfg.position === 'inline' ||
              parentCfg.position === 'sticky-top' ||
              parentCfg.position === 'sticky-bottom');
          if (!isFlowParent) return;
          // Compute the cursor's position WITHIN the parent
          // container's rect and map it to a col / row in the
          // 1..192 space the renderer uses.
          const parentEl = canvasRef.current?.querySelector(
            `[data-widget-id="${g.srcParentId}"]`,
          ) as HTMLElement | null;
          if (!parentEl) return;
          const prect = parentEl.getBoundingClientRect();
          // #99: invert the FlowContainer's anchoring math.  The
          // renderer places a child at `left: P%; translateX(-P%)`,
          // so the child's left edge ends up at
          //   leftPx = (P/100) * (containerWidth - widgetWidth)
          // and the child's grabbed point ends up at
          //   leftPx + grabOffsetX.
          //
          // Solving for P given cursor X (where we want the grabbed
          // point):
          //   P = (cursorX - containerLeft - grabOffsetX)
          //       / (containerWidth - widgetWidth)
          //   col = round(P * 191) + 1
          //
          // The denominator is the actual travel available for the
          // grabbed point; clamping to [0,1] keeps the child inside
          // the container at both extremes.  Same idea on the Y
          // axis for column-layout containers.
          const travelX = Math.max(1, prect.width - g.widgetWidth);
          const travelY = Math.max(1, prect.height - g.widgetHeight);
          const xRatio = (e.clientX - prect.left - g.grabOffsetX) / travelX;
          const yRatio = (e.clientY - prect.top - g.grabOffsetY) / travelY;
          const xClamp = Math.max(0, Math.min(1, xRatio));
          const yClamp = Math.max(0, Math.min(1, yRatio));
          next.col = Math.max(1, Math.min(192, Math.round(xClamp * 191) + 1));
          next.row = Math.max(1, Math.min(192, Math.round(yClamp * 191) + 1));
          onWidgetLayout(g.widgetId, next);
          return;
        }
        next.col = clampCol(start.col + colDelta);
        next.row = Math.max(1, start.row + rowDelta);
        // Clamp colSpan when the move pushed the right edge past
        // the grid -- otherwise the widget would overflow the
        // canvas after a rightward drag.
        next.colSpan = Math.min(start.colSpan, GRID_COLS - next.col + 1);
      } else {
        // #97: 8-direction resize.  Right/bottom edges and the
        // bottom-right corner expand the existing span.  Top/left
        // edges and the top corners ALSO shift the widget's
        // origin so the opposite edge stays anchored -- e.g.
        // dragging the top handle DOWN should move the top edge
        // down (row += delta) and shrink the rowSpan to match
        // (rowSpan -= delta) so the bottom stays put.
        const right =
          g.kind === 'resize-r' ||
          g.kind === 'resize-tr' ||
          g.kind === 'resize-br';
        const bottom =
          g.kind === 'resize-b' ||
          g.kind === 'resize-br' ||
          g.kind === 'resize-bl';
        const left =
          g.kind === 'resize-l' ||
          g.kind === 'resize-tl' ||
          g.kind === 'resize-bl';
        const top =
          g.kind === 'resize-t' ||
          g.kind === 'resize-tl' ||
          g.kind === 'resize-tr';
        if (right) {
          next.colSpan = Math.max(
            1,
            Math.min(GRID_COLS - start.col + 1, start.colSpan + colDelta),
          );
        }
        if (bottom) {
          next.rowSpan = Math.max(1, start.rowSpan + rowDelta);
        }
        if (left) {
          // Clamp the row-leading delta so we never push past the
          // left edge OR collapse the colSpan to zero.
          const maxColDelta = start.colSpan - 1;
          const minColDelta = -(start.col - 1);
          const cd = Math.max(minColDelta, Math.min(maxColDelta, colDelta));
          next.col = start.col + cd;
          next.colSpan = start.colSpan - cd;
        }
        if (top) {
          const maxRowDelta = start.rowSpan - 1;
          const minRowDelta = -(start.row - 1);
          const rd = Math.max(minRowDelta, Math.min(maxRowDelta, rowDelta));
          next.row = start.row + rd;
          next.rowSpan = start.rowSpan - rd;
        }
      }
      onWidgetLayout(g.widgetId, next);
    }
    function onUp(e: MouseEvent) {
      // #96: on release of a move gesture, decide whether the
      // gesture crossed a parent boundary (reparent), reordered
      // within the same container, or was a pure top-level grid
      // move (already applied live by onMove).
      if (g.kind === 'move') {
        const { col, row } = cursorToGrid(e);
        // #98: same DOM hit-test as the dragover handler so the
        // mouseup decision matches the live drop-target highlight.
        const host = findContainerHostAtClient(
          canvasRef.current,
          widgets,
          e.clientX,
          e.clientY,
        );
        // Don't let a container drop INTO itself.
        let targetParentId =
          host && host.id !== g.widgetId ? host.id : null;
        // #99: extracting a child out to page level requires the
        // cursor to actually land INSIDE the canvas grid (the dot-
        // grid area).  Without this guard, a tiny brush past the
        // bottom of a 56px-tall sticky-top bar reparents the tool
        // to the grid -- mouseup just barely outside the source
        // container with target=null was treated as "extract to
        // page level" and produced the "tools fell off the bar"
        // bug.  Now, if the user is dragging an in-container child
        // and releases outside both the source AND the inner grid,
        // we snap back to the source (target = srcParentId, so
        // no reparent path fires).
        if (
          g.srcParentId !== null &&
          targetParentId === null &&
          gridRef.current
        ) {
          const gridRect = gridRef.current.getBoundingClientRect();
          const overGrid =
            e.clientX >= gridRect.left &&
            e.clientX <= gridRect.right &&
            e.clientY >= gridRect.top &&
            e.clientY <= gridRect.bottom;
          if (!overGrid) targetParentId = g.srcParentId;
        }
        if (targetParentId !== g.srcParentId) {
          // Reparent.
          //
          // Page level → container:  compute the child's in-container
          // col/row from the cursor pos within the new container rect
          // so it lands where the user dropped it (#99), not at the
          // placeholder origin.
          //
          // Container → page level:  adopt the cursor's grid coords
          // for the new top-level layout.
          //
          // Container → other container:  same in-container coord
          // computation; the targetIndex is still passed in case a
          // future container variant (eg a tabs-inside-container)
          // wants ordered append semantics.
          const targetIndex =
            targetParentId === null
              ? widgets.length
              : indexInContainer(targetParentId, e, g.widgetId);
          let pageLayout: CustomLayout | null = null;
          if (targetParentId === null) {
            pageLayout = {
              col: clampCol(col),
              row: Math.max(1, row),
              colSpan: g.startLayout.colSpan,
              rowSpan: g.startLayout.rowSpan,
            };
          } else {
            // #99: compute the destination col/row from the cursor
            // position inside the target container's rect.  The
            // child will render at that spot in the free-position
            // FlowContainer.
            const targetEl = canvasRef.current?.querySelector(
              `[data-widget-id="${targetParentId}"]`,
            ) as HTMLElement | null;
            if (targetEl) {
              const tr = targetEl.getBoundingClientRect();
              // #99: same anchoring inversion the in-container
              // drag uses (see onMove).  Without it a tool dropped
              // near the right edge of a target container would
              // land at col=192 and then render with its left edge
              // at the right edge of the container, overflowing.
              const travelX = Math.max(1, tr.width - g.widgetWidth);
              const travelY = Math.max(1, tr.height - g.widgetHeight);
              const xRatio = (e.clientX - tr.left - g.grabOffsetX) / travelX;
              const yRatio = (e.clientY - tr.top - g.grabOffsetY) / travelY;
              const xClamp = Math.max(0, Math.min(1, xRatio));
              const yClamp = Math.max(0, Math.min(1, yRatio));
              pageLayout = {
                col: Math.max(1, Math.min(192, Math.round(xClamp * 191) + 1)),
                row: Math.max(1, Math.min(192, Math.round(yClamp * 191) + 1)),
                colSpan: 1,
                rowSpan: 1,
              };
            }
          }
          onWidgetMove(g.widgetId, targetParentId, targetIndex, pageLayout);
        } else if (targetParentId !== null) {
          // Same-container move.  For flow-positioned parents (the
          // free-position FlowContainer ones), onMove already wrote
          // the new col/row live -- nothing extra to do.  For dock /
          // overlay parents (DockContainer / OverlayContainer, which
          // stack children with dividers and ignore layout.col),
          // fall back to the legacy index-reorder so the user can
          // still rearrange children in those containers via drag.
          const parent = findWidgetWithParent(widgets, targetParentId);
          const parentCfg = parent?.widget.config;
          const isFlowParent =
            parentCfg?.kind === 'container' &&
            (parentCfg.position === undefined ||
              parentCfg.position === 'inline' ||
              parentCfg.position === 'sticky-top' ||
              parentCfg.position === 'sticky-bottom');
          if (!isFlowParent) {
            const targetIndex = indexInContainer(
              targetParentId,
              e,
              g.widgetId,
            );
            onWidgetMove(g.widgetId, targetParentId, targetIndex, null);
          }
        }
        // targetParentId === null && srcParentId === null: pure
        // page-level grid move; onMove already applied it.
      }
      setDropTargetId(null);
      setGesture(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [gesture, onWidgetLayout, onWidgetMove, widgets]);

  // #98: partition top-level widgets the same way the runtime does
  // (apps/portal-web/.../runtime-client.tsx ~L651): sticky / dock
  // containers become flex siblings of the grid, NOT grid items.
  // Inline + overlay-trigger containers + all non-container widgets
  // stay in the grid.  This is the architectural fix for the
  // designer-vs-runtime height mismatch on sticky containers: by
  // taking them out of the grid the designer no longer honors their
  // (often arbitrary) rowSpan and instead lets them content-size,
  // exactly like the runtime does.
  const stickyTops: CustomWidget[] = [];
  const stickyBottoms: CustomWidget[] = [];
  const leftDocks: CustomWidget[] = [];
  const rightDocks: CustomWidget[] = [];
  const canvasWidgets: CustomWidget[] = [];
  for (const w of widgets) {
    if (isPartitionedContainer(w) && w.config.kind === 'container') {
      const pos = w.config.position ?? 'inline';
      if (pos === 'sticky-top') stickyTops.push(w);
      else if (pos === 'sticky-bottom') stickyBottoms.push(w);
      else if (pos === 'dock-left') leftDocks.push(w);
      else if (pos === 'dock-right') rightDocks.push(w);
      continue;
    }
    canvasWidgets.push(w);
  }
  // Stacking order for canvasWidgets: map + tabs underneath, every
  // other widget (overlay-trigger, inline containers, tools) on top.
  // Same trick the runtime applies so a template with a full-canvas
  // map doesn't paint over its inline / overlay siblings.
  const orderedCanvas = [
    ...canvasWidgets.filter((w) => w.kind === 'map' || w.kind === 'tabs'),
    ...canvasWidgets.filter((w) => w.kind !== 'map' && w.kind !== 'tabs'),
  ];

  const renderWidget = (w: CustomWidget, inGrid: boolean) => (
    <WidgetCard
      key={w.id}
      widget={w}
      inGrid={inGrid}
      selected={w.id === selectedId}
      canEdit={canEdit}
      gesturing={Boolean(gesture && gesture.widgetId === w.id)}
      anyGesture={gesture !== null}
      isDropTarget={w.id === dropTargetId}
      // #363: prefer the widget's own map override if one is
      // resolved, else fall through to the app default.
      previewMapData={widgetMapData[w.id] ?? previewMapData}
      previewBasemaps={previewBasemaps}
      resolvedTargets={resolvedTargets}
      sources={sources}
      previewStatesByMapWidget={previewStatesByMapWidget}
      activeTabIdx={activeTabIdxByWidget[w.id] ?? 0}
      itemTitle={itemTitle}
      selectedChildId={selectedId}
      onSelectChild={onSelect}
      onSetActiveTabIdx={(idx) => onSetActiveTabIdx(w.id, idx)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(w.id);
      }}
      onMoveStart={(e) => beginGesture('move', w, null, e)}
      onChildMoveStart={(child, parentId, e) =>
        beginGesture('move', child, parentId, e)
      }
      onResizeStart={(handle, e) =>
        beginGesture(`resize-${handle}` as ActiveGesture['kind'], w, null, e)
      }
    />
  );

  return (
    <div
      ref={themeRootRef}
      // h-full + w-full instead of `flex-1` because the parent is a
      // plain div, not a flex container — flex-1 would do nothing and
      // the Canvas would size to its inner grid's minHeight, growing
      // past the BuilderShell main slot and breaking the inner
      // overflow-auto scroll. User-reported: "can't get to the bottom
      // of the canvas, no way to scroll if it goes off screen."
      // Theme font applied so the designer preview matches the runtime.
      style={{ fontFamily: 'var(--app-font, var(--font-sans))' }}
      className="relative flex h-full w-full overflow-hidden rounded-lg border border-border bg-[hsl(var(--app-surface-0))]"
    >
      <div
        ref={canvasRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => onSelect(null)}
        // #98: flex column layout so sticky / dock containers can
        // render as content-sized flex siblings of the inner grid.
        // The outer scroll only kicks in when the COMBINED stack
        // exceeds the canvas pane (rare; the grid carries its own
        // min-height); inside the middle flex row, the grid wrapper
        // gets its own scroll so a tall map-first layout still pans
        // without pushing the dock + sticky chrome off-screen.
        className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-[hsl(var(--app-surface-0))]"
      >
        {/* Sticky-top flex slot.  Content-sized, painted above the
            grid.  Multiple sticky-tops stack in author order. */}
        {stickyTops.map((w) => renderWidget(w, false))}

        {/* Middle flex row: left docks, scrollable grid surface,
            right docks.  Min-h-0 so children can shrink when the
            canvas pane is short (without it the grid's intrinsic
            min-height pushes the parent past the viewport). */}
        <div className="flex min-h-0 flex-1 items-stretch">
          {leftDocks.map((w) => renderWidget(w, false))}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(0,0,0,0.06)_1px,transparent_0)] bg-[length:24px_24px] p-4">
            {/* The actual grid.  CSS Grid makes the placement math
                cheap: each widget's gridColumn / gridRow line up
                with the schema's col/row + spans, no manual
                translation.  Min-width keeps the canvas usable on
                narrow viewports (matches Experience Builder +
                Webflow's "fixed canvas with horizontal scroll"
                pattern); on wider viewports the grid expands to
                fill the canvas pane. */}
            <div
              ref={gridRef}
              className="grid w-full"
              style={{
                gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
                gridAutoRows: `${ROW_HEIGHT_PX}px`,
                minWidth: `${CANVAS_MIN_WIDTH_PX}px`,
                minHeight: `${totalRows * ROW_HEIGHT_PX}px`,
                gap: `${GAP_PX}px`,
              }}
            >
              {orderedCanvas.map((w) => renderWidget(w, true))}
              {orderedCanvas.length === 0 && stickyTops.length === 0 &&
                stickyBottoms.length === 0 && leftDocks.length === 0 &&
                rightDocks.length === 0 && (
                  <div
                    className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface-1/60 p-8 text-center"
                    style={{ gridColumn: '1 / -1', gridRow: '1 / span 12' }}
                  >
                    <Square className="h-5 w-5 text-muted" strokeWidth={1.5} />
                    <p className="text-sm font-medium text-ink-0">Empty canvas</p>
                    <p className="text-xs text-muted">
                      Drag a widget from the left rail to get started.
                    </p>
                  </div>
                )}
            </div>
          </div>
          {rightDocks.map((w) => renderWidget(w, false))}
        </div>

        {/* Sticky-bottom flex slot.  Same shape as sticky-top. */}
        {stickyBottoms.map((w) => renderWidget(w, false))}
      </div>
    </div>
  );
}

// ---- Widget card on canvas (placeholder render) ----------------------------

function WidgetCard({
  widget,
  inGrid,
  selected,
  canEdit,
  gesturing,
  anyGesture,
  isDropTarget,
  previewMapData,
  previewBasemaps,
  resolvedTargets,
  sources,
  previewStatesByMapWidget,
  activeTabIdx,
  itemTitle,
  selectedChildId,
  onSelectChild,
  onSetActiveTabIdx,
  onClick,
  onMoveStart,
  onResizeStart,
  onChildMoveStart,
}: {
  widget: CustomWidget;
  /**
   * #98: true when this card lives inside the canvas CSS grid (so it
   * carries gridColumn / gridRow + supports the full move + 8-way
   * resize gesture).  False when it lives in a partitioned flex slot
   * (sticky-top / sticky-bottom / dock-left / dock-right) -- those
   * containers are anchored by their position prop, not by the grid,
   * so they don't apply grid styles and don't expose body-drag or
   * resize handles.
   */
  inGrid: boolean;
  selected: boolean;
  canEdit: boolean;
  gesturing: boolean;
  anyGesture: boolean;
  /**
   * #53: true when a palette tile is currently being dragged
   * over this widget AND it's a container that will host the
   * dropped child.  Renders an outline ring so the user sees
   * which container the drop will route into.
   */
  isDropTarget: boolean;
  previewMapData: MapData | null;
  previewBasemaps: CustomBasemap[];
  /** Targets resolved to the runtime's shape so canvas widgets can
   *  render live rather than as placeholders. */
  resolvedTargets: ResolvedTargetLite[];
  /** The app's sources. A widget resolves its data in two steps and
   *  the resolved list is only the second; without these every
   *  canvas widget reports itself unbound. */
  sources: AppDataSource[];
  /** Map data by map widget id; see Canvas. */
  previewStatesByMapWidget: Record<string, MapData>;
  activeTabIdx: number;
  /**
   * #22 WYSIWYG: forwarded to inline-rendered children of container
   * widgets (app-bar children get the item title as their fallback
   * title for the live preview, same as the runtime does).
   */
  itemTitle: string;
  /** Selection mirror for nested children inside containers. */
  selectedChildId: string | null;
  /** Click handler for a nested child; bubbles up to the page. */
  onSelectChild: (childId: string) => void;
  onSetActiveTabIdx: (idx: number) => void;
  onClick: (e: React.MouseEvent) => void;
  onMoveStart: (e: ReactMouseEvent<HTMLElement>) => void;
  onResizeStart: (
    handle: 't' | 'r' | 'b' | 'l' | 'tl' | 'tr' | 'br' | 'bl',
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
  /** #96: mousedown on a container child begins a reorder/reparent
   *  gesture.  Forwarded down through ContainerInDesigner so any
   *  depth of nesting can begin a drag. */
  onChildMoveStart: (
    child: CustomWidget,
    parentId: string,
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  const label = tile?.label ?? widget.kind;
  const summary = summarizeWidget(widget);
  // #22 WYSIWYG: containers render the actual runtime themed-
  // container component inside the card so the designer matches
  // what the live app will look like.  We branch out before the
  // standard title-bar + placeholder layout below.
  const isContainer = THEMED_CONTAINER_KINDS.has(widget.kind);
  if (isContainer) {
    // #98: partitioned containers (sticky-top / sticky-bottom /
    // dock-left / dock-right) live in flex slots OUTSIDE the canvas
    // grid.  They size themselves via position / widthPx / content,
    // not via gridColumn / gridRow, and can't be dragged around the
    // canvas as units (their position is set via the property
    // editor, not by free placement).  Children inside them are
    // still draggable for reorder / reparent / extract.  In-grid
    // containers (inline + overlay-trigger) keep the original
    // grid-coord + body-drag behavior.
    const partitioned = !inGrid;
    const gridStyle: React.CSSProperties = inGrid
      ? {
          gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
          gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
        }
      : {};
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onMouseDown={canEdit && !partitioned ? onMoveStart : undefined}
        data-widget-id={widget.id}
        style={{
          ...gridStyle,
          cursor: canEdit && !partitioned
            ? gesturing
              ? 'grabbing'
              : 'grab'
            : 'default',
        }}
        // #95 (grid path) / #98 (partitioned path):
        //
        // GRID PATH (in-grid containers): min-h-0 / min-w-0 suppress
        // CSS Grid's default `min-height: auto` on grid items, which
        // would otherwise expand the row track when the item's
        // content (e.g. the FlowContainer's icon row) is taller than
        // the fixed `gridAutoRows` track.  Without these the container
        // could balloon vs. its grid-defined size.  overflow-hidden
        // on its own isn't enough -- the row track itself has to be
        // told it can shrink below auto.
        //
        // PARTITIONED PATH (out-of-grid containers): no fill /
        // sizing constraints.  Mirror the runtime's wrapper exactly
        // (`relative shrink-0`); the Container child takes its size
        // from its own content (sticky-top/bottom) or its widthPx
        // prop (dock-left/right).  This is the architectural fix for
        // the designer-vs-runtime height mismatch -- the designer
        // now content-sizes sticky chrome the same way runtime does.
        className={`group ${
          partitioned
            ? 'relative shrink-0 rounded-md transition-shadow'
            : 'relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md transition-shadow'
        } ${
          isDropTarget
            ? 'shadow-[0_0_0_3px_var(--color-accent,_#2563eb)]'
            : selected
              ? 'shadow-[0_0_0_2px_var(--color-ink-0,_#0f0f10)]'
              : 'shadow-[0_0_0_1px_var(--color-border,_#e5e7eb)] hover:shadow-[0_0_0_1px_var(--color-ink-1,_#374151)]'
        } ${gesturing ? 'opacity-90' : ''}`}
      >
        <ContainerInDesigner
          widget={widget}
          itemTitle={itemTitle}
          selectedChildId={selectedChildId}
          onSelectChild={onSelectChild}
          onChildMoveStart={onChildMoveStart}
        />
        {/* Drop-target badge.  Visible only while a palette tile
            is being dragged over this container.  Tells the user
            what's about to happen ("Drop here to add to App bar")
            so the routing into children isn't a mystery. */}
        {isDropTarget && canEdit ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent/10">
            <span className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink shadow-md">
              Drop into {label}
            </span>
          </div>
        ) : null}
        {/* #98: resize handles only on in-grid containers.  Sticky /
            dock containers are sized by position + widthPx + content,
            not by grid coords, so canvas-resize would be misleading
            (changing rowSpan does nothing in the runtime).  Width /
            height for those flows through the property editor. */}
        {selected && canEdit && !partitioned && (
          <ResizeHandles onResizeStart={onResizeStart} />
        )}
      </div>
    );
  }
  // #343: live MapLibre preview for Map widgets. We freeze the
  // preview during ANY canvas gesture (not just the one on this
  // widget) so a drag of a sibling widget doesn't cause MapLibre to
  // re-render mid-frame and stutter.
  const showLivePreview = widget.kind === 'map' && previewMapData !== null;
  // #364: tool-mode rendering. Map-following widgets default to
  // 'tool' mode where they render as a small icon-only card on the
  // canvas (matching how they'll appear at runtime as a tool button).
  // Legacy 'panel' mode keeps the full-card layout.
  const isToolMode = effectiveDisplayMode(widget) === 'tool';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      // mousedown on the body starts a move gesture. The Canvas
      // tracks deltas globally; until the cursor moves past the
      // drag threshold, the click handler still fires for a plain
      // selection. (#338)
      onMouseDown={canEdit ? onMoveStart : undefined}
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
        cursor: canEdit ? (gesturing ? 'grabbing' : 'grab') : 'default',
      }}
      className={`group relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md bg-surface-1 text-left transition-shadow ${
        selected
          ? 'shadow-[0_0_0_2px_var(--color-ink-0,_#0f0f10)]'
          : 'shadow-[0_0_0_1px_var(--color-border,_#e5e7eb)] hover:shadow-[0_0_0_1px_var(--color-ink-1,_#374151)]'
      } ${gesturing ? 'opacity-90' : ''}`}
    >
      {isToolMode ? (
        // #364: tool-mode card. Compact icon + tiny label, no
        // title bar / summary chrome. Mirrors the runtime tool
        // button so the canvas matches what authors will publish.
        // labelMode='icon-only' drops the caption (matching the
        // runtime), letting the button be sized at just the icon's
        // worth of space.
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 p-1"
          title={`${label} (tool)${summary ? ` · ${summary}` : ''}`}
        >
          <Icon className="h-5 w-5 text-ink-1" strokeWidth={1.75} />
          {(() => {
            const cfg = widget.config as { panelArrangement?: { labelMode?: string } };
            const iconOnly = cfg.panelArrangement?.labelMode === 'icon-only';
            return iconOnly ? null : (
              <span className="truncate text-2xs font-medium text-muted">
                {label}
              </span>
            );
          })()}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-xs">
            <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
            <span className="font-medium text-ink-0">{label}</span>
            {summary && (
              <span className="ml-auto truncate text-muted" title={summary}>
                {summary}
              </span>
            )}
          </div>
      {showLivePreview ? (
        <div className="relative flex flex-1 overflow-hidden">
          <MapWidgetPreview
            baseMapData={previewMapData}
            basemaps={previewBasemaps}
            frozen={anyGesture}
          />
        </div>
      ) : widget.config.kind === 'image' && widget.config.url ? (
        // Live preview for the Image widget when a URL is set. No
        // sandboxing concerns -- it's a read-only <img>.
        <div className="relative flex flex-1 overflow-hidden bg-surface-2/40">
          <img
            src={widget.config.url}
            alt={widget.config.alt ?? ''}
            className="pointer-events-none h-full w-full"
            style={{ objectFit: widget.config.objectFit ?? 'contain' }}
          />
        </div>
      ) : widget.config.kind === 'divider' ? (
        // Live preview for the Divider widget. Mirrors the runtime.
        <div className="flex flex-1 items-center px-2">
          <hr
            className="w-full"
            style={{
              borderTop: `${widget.config.thicknessPx ?? 1}px ${widget.config.style ?? 'solid'} ${widget.config.color ?? 'var(--color-border, #e5e7eb)'}`,
              margin: 0,
            }}
          />
        </div>
      ) : widget.config.kind === 'button' ? (
        // Live preview for the Button widget.
        <div className="flex flex-1 items-center justify-center p-2">
          <span
            className={`pointer-events-none inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium ${
              (widget.config.variant ?? 'primary') === 'primary'
                ? 'bg-accent text-white'
                : 'border border-border bg-surface-1 text-ink-1'
            }`}
          >
            {widget.config.label || 'Button'}
          </span>
        </div>
      ) : widget.config.kind === 'tool' ? (
        // #144: live preview for the Tool widget. Render in the
        // shape the runtime will use so the author sees what
        // they're going to ship -- toolbar variant is icon-only
        // round; standalone is icon + label.
        <ToolWidgetCanvasPreview config={widget.config} />
      ) : widget.config.kind === 'tabs' ? (
        // #362: tabs container live preview. Renders a real tab
        // strip + content area so authors see what the runtime will
        // produce while they're laying it out.
        <TabsWidgetCanvas
          widget={widget}
          activeTabIdx={activeTabIdx}
          onSetActiveTabIdx={onSetActiveTabIdx}
        />
      ) : widget.config.kind === 'text' ? (
        // Live preview for the Text widget.  Same MarkdownLite
        // renderer the runtime uses, so the designer canvas shows
        // exactly the body / heading / muted styling the live app
        // will apply.  Without this the canvas defaulted to the
        // generic "Drag content here" placeholder and authors had
        // to open the runtime to see whether their text rendered
        // the way they expected.
        <TextWidgetCanvas widget={widget} />
      ) : widget.config.kind === 'splash' ? (
        // #111: splash renders nothing on the runtime canvas (it's
        // a portal-rendered modal on app load), so the designer
        // canvas just shows a small placeholder card with the
        // splash's title so the author can confirm it's wired up.
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-2 p-2 text-center">
          <MessageSquare className="h-4 w-4 text-muted" />
          <span className="text-2xs font-medium uppercase tracking-wide text-muted">
            Splash
          </span>
          <span className="text-2xs text-ink-1">
            {widget.config.title?.trim() || '(no title)'}
          </span>
        </div>
      ) : DESIGN_TIME_KINDS.has(widget.kind) ? (
        // Live widget, rendered by the runtime's own component. The
        // wrapper turns off pointer events so a drag still grabs the
        // card rather than a chart tooltip, and clips overflow so a
        // wide table cannot push the card's own bounds around.
        <div className="pointer-events-none relative flex min-h-0 flex-1 overflow-hidden">
          <DesignTimeWidgetPreview
            widget={widget}
            resolvedTargets={resolvedTargets}
            sources={sources}
            mapDataByWidget={previewStatesByMapWidget}
            basemaps={previewBasemaps}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-3 text-xs text-muted">
          {widgetPlaceholderText(
            widget.kind,
            label,
            resolvedTargets.length > 0,
          )}
        </div>
      )}
        </>
      )}
      {/* Resize handles -- only visible when the widget is selected
          AND the user can edit. Three handles cover the common cases
          (right edge for width, bottom edge for height, bottom-right
          corner for both). 8-handle resize can come if anyone
          actually misses it. Each handle stops propagation so the
          mousedown doesn't fall through to the body's move gesture. */}
      {selected && canEdit && <ResizeHandles onResizeStart={onResizeStart} />}
    </div>
  );
}

/**
 * #97: full 8-direction resize-handle ring rendered inside a
 * selected WidgetCard.  Four edges and four corners; each stops
 * propagation on mousedown so the gesture doesn't fall through
 * to the card's move-on-grab handler.  Each handle's cursor (ew /
 * ns / nwse / nesw) matches the direction the user can drag.
 */
function ResizeHandles({
  onResizeStart,
}: {
  onResizeStart: (
    handle: 't' | 'r' | 'b' | 'l' | 'tl' | 'tr' | 'br' | 'bl',
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
}) {
  const edgeBase =
    'absolute z-20 bg-accent/60 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-90 rounded-full';
  const cornerBase =
    'absolute z-20 h-3 w-3 bg-accent opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-90';
  const handle = (
    h: 't' | 'r' | 'b' | 'l' | 'tl' | 'tr' | 'br' | 'bl',
    label: string,
    className: string,
  ) => (
    <button
      key={h}
      type="button"
      aria-label={label}
      onMouseDown={(e) => {
        e.stopPropagation();
        onResizeStart(h, e);
      }}
      className={className}
    />
  );
  return (
    <>
      {handle(
        't',
        'Resize top',
        `${edgeBase} top-0 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-ns-resize`,
      )}
      {handle(
        'r',
        'Resize right',
        `${edgeBase} right-0 top-1/2 h-8 w-1.5 -translate-y-1/2 cursor-ew-resize`,
      )}
      {handle(
        'b',
        'Resize bottom',
        `${edgeBase} bottom-0 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-ns-resize`,
      )}
      {handle(
        'l',
        'Resize left',
        `${edgeBase} left-0 top-1/2 h-8 w-1.5 -translate-y-1/2 cursor-ew-resize`,
      )}
      {handle(
        'tl',
        'Resize top-left',
        `${cornerBase} top-0 left-0 rounded-br-sm cursor-nwse-resize`,
      )}
      {handle(
        'tr',
        'Resize top-right',
        `${cornerBase} top-0 right-0 rounded-bl-sm cursor-nesw-resize`,
      )}
      {handle(
        'br',
        'Resize bottom-right',
        `${cornerBase} bottom-0 right-0 rounded-tl-sm cursor-nwse-resize`,
      )}
      {handle(
        'bl',
        'Resize bottom-left',
        `${cornerBase} bottom-0 left-0 rounded-tr-sm cursor-nesw-resize`,
      )}
    </>
  );
}

/**
 * Mid-card preview text for each widget kind. Just a hint so the
 * canvas doesn't render a wall of "X content" -- real renders are
 * in the runtime (#341) and (for Map) the in-designer preview
 * (#343). This is purely cosmetic.
 */
function widgetPlaceholderText(
  kind: CustomWidgetKind,
  label: string,
  hasTargets = false,
): string {
  switch (kind) {
    case 'map':
      // A map widget draws the app's layers whether or not it also
      // references a saved map. Saying "no map referenced" on a
      // dashboard that has layers is simply false: the map renders
      // fine when the app runs, and the author is left hunting for a
      // problem that is not there.
      return hasTargets
        ? 'Draws this app’s layers. Reference a saved map in the right rail to preview it here.'
        : 'No layers yet. Add one in the right rail.';
    case 'search':
      return 'Address + attribute search';
    case 'print':
      return 'Click to print';
    case 'select':
      return 'Click / box / polygon / lasso';
    case 'export':
      return 'Export visible features';
    case 'splash':
      return 'Welcome / disclaimer modal on app load';
    case 'basemap-gallery':
      return 'Tiles of available basemaps';
    case 'image':
      return 'Paste an image URL in the right rail';
    case 'button':
      return 'Configure label + link in the right rail';
    case 'tool':
      return 'Pick a tool + icon in the right rail';
    case 'divider':
      return 'Horizontal rule';
    case 'embed':
      return 'Paste an iframe URL in the right rail';
    case 'bookmark':
      return 'Saved viewports (bound to a map)';
    case 'coordinates':
      return 'Live cursor lat/lon';
    case 'my-location':
      return 'Show my location';
    case 'elevation-profile':
      return 'Draw a line, chart the ground height';
    case 'magic-outline':
      return 'Click imagery, trace a shape into a layer';
    case 'time-slider':
      return 'Scrub the app to a past date';
    case 'create-feature':
      return 'Add a feature to a target layer';
    case 'edit-feature':
      return 'Edit the selected feature';
    case 'delete-feature':
      return 'Delete the selected feature(s)';
    case 'tabs':
      return 'Tab strip with nested widgets';
    default:
      return `${label} content`;
  }
}

function summarizeWidget(w: CustomWidget): string {
  switch (w.config.kind) {
    case 'map':
      // "no map bound" read as a fault on every dashboard, which
      // never references a saved map and does not need to: the widget
      // draws the app's own layers. Only the reference is optional
      // here, so only the reference is what this reports.
      return w.config.mapId
        ? `saved map: ${w.config.mapId.slice(0, 8)}`
        : 'app layers';
    case 'legend':
    case 'layer-list':
    case 'search':
    case 'print':
    case 'select':
    case 'export':
    case 'basemap-gallery':
      return w.config.mapWidgetId
        ? `→ ${w.config.mapWidgetId.slice(0, 6)}`
        : 'pick a map widget';
    case 'attribute-table':
      return `target #${w.config.targetIndex}`;
    case 'text':
      return w.config.preset ?? 'body';
    case 'chart':
      return `${
        w.config.chartType === 'bar-horizontal'
          ? 'horizontal bar'
          : w.config.chartType
      } of #${w.config.targetIndex}`;
    case 'indicator':
      return w.config.aggregate === 'count'
        ? `count of #${w.config.targetIndex}`
        : `${w.config.aggregate} ${w.config.valueField ?? '(pick a field)'}`;
    case 'image':
      return w.config.url ? 'image set' : 'no url';
    case 'button':
      return w.config.label || 'no label';
    case 'tool':
      return w.config.toolId
        ? `→ ${w.config.toolId.slice(0, 6)}`
        : 'pick a tool';
    case 'divider':
      return w.config.style ?? 'solid';
    case 'embed':
      return w.config.url ? 'url set' : 'no url';
    case 'bookmark':
    case 'coordinates':
    case 'my-location':
    case 'elevation-profile':
    case 'magic-outline':
      return w.config.mapWidgetId
        ? `→ ${w.config.mapWidgetId.slice(0, 6)}`
        : 'pick a map widget';
    case 'time-slider':
      return w.config.mode === 'calendar' ? 'calendar' : 'slider';
    case 'create-feature':
    case 'edit-feature':
    case 'delete-feature':
      return w.config.mapWidgetId
        ? `target #${w.config.targetIndex}`
        : 'pick a map widget';
    case 'tabs': {
      const n = w.config.tabs.length;
      const totalChildren = w.config.tabs.reduce(
        (acc, t) => acc + t.widgets.length,
        0,
      );
      return `${n} tab${n === 1 ? '' : 's'} · ${totalChildren} widget${totalChildren === 1 ? '' : 's'}`;
    }
    case 'splash':
      return w.config.title?.trim() || 'no title';
    default:
      return '';
  }
}

// ---- Editable-layer (target) helpers ---------------------------------------

/**
 * One candidate editable layer discovered inside a map: a v3
 * data_layer sublayer that a map layer points at.
 */
interface TargetCandidate {
  dataLayerId: string;
  layerKey: string;
  title: string;
  geometryType: string | null;
}

/**
 * Read a map item's layers and return the v3 data_layer sublayers
 * they reference, which are exactly the things an app can make
 * editable. Non-data layers (imagery, terrain, ArcGIS, OSM) carry
 * no editable features and are skipped.
 */
async function discoverMapTargets(mapId: string): Promise<TargetCandidate[]> {
  const res = await fetch(`/api/portal/items/${mapId}`);
  if (!res.ok) return [];
  const item = (await res.json()) as {
    data?: { layers?: Array<{ title?: string; source?: unknown }> };
  };
  const layers = item.data?.layers ?? [];
  const out: TargetCandidate[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    const src = layer.source as
      | { kind?: string; itemId?: string; layerKey?: string }
      | undefined;
    if (src?.kind !== 'data-layer' || !src.itemId || !src.layerKey) continue;
    const key = `${src.itemId}:${src.layerKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      dataLayerId: src.itemId,
      layerKey: src.layerKey,
      title: layer.title || 'Layer',
      geometryType: null,
    });
  }
  return out;
}

/**
 * Friendly name for a target row: the sublayer's label from its
 * data_layer item, cached across renders. Falls back to the raw
 * ids while loading or if the item is gone.
 */
function TargetLabel({
  dataLayerId,
  layerKey,
}: {
  dataLayerId: string;
  layerKey: string;
}) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${dataLayerId}`);
        if (!res.ok || cancelled) return;
        const item = (await res.json()) as {
          title?: string;
          data?: { layers?: Array<{ id?: string; label?: string }> };
        };
        const sub = item.data?.layers?.find((l) => l.id === layerKey);
        if (!cancelled) {
          setLabel(sub?.label ? `${item.title} · ${sub.label}` : item.title ?? null);
        }
      } catch {
        /* keep the fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataLayerId, layerKey]);
  return <>{label ?? `${dataLayerId.slice(0, 8)} / ${layerKey}`}</>;
}

/**
 * "Add editable layer" control: lists the data layers in the app's
 * map that aren't already editable, one click adds one. This is the
 * discoverable replacement for the old "add via the Map widget in
 * Slice 3" note that had no actual button (#191).
 */
function AddTargetControl({
  mapId,
  existing,
  onAdd,
}: {
  mapId: string | undefined;
  existing: ViewerTarget[];
  onAdd: (t: ViewerTarget) => void;
}) {
  const [candidates, setCandidates] = useState<TargetCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!mapId) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    void discoverMapTargets(mapId)
      .then((c) => setCandidates(c))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [mapId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!mapId) {
    return (
      <p className="rounded-md border border-dashed border-border px-2 py-2 text-2xs text-muted">
        Pick a map above first; its layers become the editable
        layers you can choose from.
      </p>
    );
  }

  const taken = new Set(existing.map((t) => `${t.dataLayerId}:${t.layerKey}`));
  const available = (candidates ?? []).filter(
    (c) => !taken.has(`${c.dataLayerId}:${c.layerKey}`),
  );

  if (loading && candidates === null) {
    return (
      <p className="px-1 py-1 text-2xs text-muted">Reading the map's layers...</p>
    );
  }

  if (available.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-2 py-2 text-2xs text-muted">
        {existing.length > 0
          ? 'Every data layer in the map is already editable here.'
          : "The map has no editable data layers yet. Add one to the map (the map builder's Add layer > New tab creates an empty one)."}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {available.map((c) => (
        <button
          key={`${c.dataLayerId}:${c.layerKey}`}
          type="button"
          onClick={() => onAdd({ dataLayerId: c.dataLayerId, layerKey: c.layerKey })}
          className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-left text-2xs text-ink-1 hover:border-accent/40 hover:bg-surface-2"
        >
          <Plus className="h-3 w-3 text-accent" />
          <span className="flex-1 truncate">{c.title}</span>
          <span className="text-muted">make editable</span>
        </button>
      ))}
    </div>
  );
}

// ---- Properties panel ------------------------------------------------------

function AppProperties({
  app,
  page,
  mapTitle,
  canEdit,
  themeOptions,
  onUpdateApp,
  onUpdatePage,
  onClearMap,
  onPickMap,
  onSaveAsTheme,
}: {
  app: CustomAppData;
  page: CustomPage;
  mapTitle: string | null;
  canEdit: boolean;
  /**
   * #22: themes the picker renders.  Order = built-in starters
   * first (matched via seedKind on the seeded items), then user-
   * saved themes alphabetically.  Empty array drops the picker
   * to a hint asking the user to ask their admin to restore
   * starter themes.
   */
  themeOptions: Array<{
    id: string;
    label: string;
    description: string;
    swatch: string;
    /** Stable starter id when this option is a seeded starter. */
    seedKind: string | null;
  }>;
  onUpdateApp: (patch: AppPatch) => void;
  onUpdatePage: (patch: Partial<CustomPage>) => void;
  onClearMap: () => void;
  onPickMap: () => void;
  onSaveAsTheme: () => void;
}) {
  const sources = app.sources ?? [];
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-ink-0">Page</p>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <Field label="Title">
          <input
            value={page.title}
            disabled={!canEdit}
            onChange={(e) => onUpdatePage({ title: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm focus:border-ink-1 focus:outline-none focus:ring-0"
          />
        </Field>
      </div>
      <div className="border-y border-border px-4 py-3">
        <p className="text-sm font-medium text-ink-0">App settings</p>
      </div>
      <div className="space-y-4 p-4 text-sm">
        {/* Header bar. An app opened from a link, embedded, or left
            on a wall display carries no other context: the browser
            tab title is not visible and the portal chrome is hidden
            for the audience. */}
        <Field
          label="Header title"
          hint="Shown across the top of the app. Blank uses the item's title."
        >
          <input
            value={app.header?.title ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onUpdateApp({
                header: patchHeader(app.header, 'title', e.target.value),
              })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm focus:border-ink-1 focus:outline-none focus:ring-0"
          />
        </Field>
        <Field
          label="Header subtitle"
          hint="Optional second line: scope, as-of date, who publishes it."
        >
          <input
            value={app.header?.subtitle ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onUpdateApp({
                header: patchHeader(app.header, 'subtitle', e.target.value),
              })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm focus:border-ink-1 focus:outline-none focus:ring-0"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            checked={app.header?.show !== false}
            disabled={!canEdit}
            onChange={(e) =>
              onUpdateApp({
                header: { ...(app.header ?? {}), show: e.target.checked },
              })
            }
          />
          Show the header bar
        </label>
        {/* Auto-refresh had no control at all: the dashboard starters
            set it and nobody else could. */}
        <Field
          label="Refresh data every"
          hint="Seconds. 0 means never; anything under 15 is raised to 15. Pauses while the page is in a background tab."
        >
          <input
            type="number"
            min={0}
            max={86400}
            value={app.refreshSeconds ?? 0}
            disabled={!canEdit}
            onChange={(e) => {
              const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
              onUpdateApp({
                refreshSeconds: n > 0 ? n : undefined,
              });
            }}
            className="w-28 rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm focus:border-ink-1 focus:outline-none focus:ring-0"
          />
        </Field>
        {/* Theme preset picker. Sets CSS variables at the app root
            (designer Canvas + runtime container) so every widget
            inside picks up the preset's color / typography /
            density tokens. Live preview: changing the dropdown
            restyles the canvas immediately. */}
        <Field
          label="Theme"
          hint="Visual preset applied to every widget inside the app. Pick from your org's catalog or save the current look as a new theme."
        >
          {themeOptions.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-surface-1 px-2 py-1.5 text-xs text-muted">
              No theme items in your org yet. Ask an admin to restore
              starter themes via Admin &rarr; Housekeeping.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5">
              {themeOptions.map((opt) => {
                // Match either by the user-saved item id or by the
                // starter kind (back-compat with apps saved before
                // themes became items).
                const active =
                  app.themePresetId === opt.id ||
                  (opt.seedKind !== null && app.themePresetId === opt.seedKind);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!canEdit}
                    onClick={() =>
                      onUpdateApp({
                        themePresetId: (opt.seedKind ?? opt.id) as never,
                      })
                    }
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-md border bg-surface-1 px-2 py-1.5 text-left transition-colors ${
                      active
                        ? 'border-accent ring-2 ring-accent/30'
                        : 'border-border hover:bg-surface-2'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span
                      className="h-4 w-4 shrink-0 rounded-sm border border-border"
                      style={{ background: opt.swatch }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-ink-0">
                        {opt.label}
                      </p>
                      {opt.description ? (
                        <p className="truncate text-2xs text-muted">
                          {opt.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            disabled={!canEdit}
            onClick={onSaveAsTheme}
            className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-1 px-2 py-1.5 text-xs text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Save current theme as new theme item
          </button>
        </Field>

        <Field
          label="Default map"
          hint="Map widgets that don't set their own use this for basemap + viewport."
        >
          {app.mapId ? (
            <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1">
              <MapIcon className="h-3.5 w-3.5 text-success" />
              <span className="flex-1 truncate text-ink-1">
                {mapTitle ?? app.mapId.slice(0, 8)}
              </span>
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={onPickMap}
                    className="text-2xs text-accent hover:underline"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={onClearMap}
                    className="text-muted hover:text-danger"
                    aria-label="Remove map"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              onClick={onPickMap}
              className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-2/30 px-2 text-2xs text-muted hover:border-accent/40 hover:text-ink-1 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              Pick a map
            </button>
          )}
        </Field>
        {/* Layers, and what reading each one means. Removing one no
            longer shifts anything: widgets bind to a source's id, so
            the ones bound to the others are untouched and the ones
            bound to this one say their layer is gone rather than
            quietly answering about a neighbour. */}
        <Field
          label="Layers"
          hint="What this app reads. Widgets pick one of these, and each carries its own scope."
        >
          {sources.length > 0 ? (
            <ul className="mb-2 space-y-2">
              {sources.map((src) => (
                <SourceRow
                  key={src.id}
                  source={src}
                  siblings={sources.filter((o) => o.id !== src.id)}
                  mapWidgets={(page.widgets ?? []).filter(
                    (w) => w.kind === 'map',
                  )}
                  canEdit={canEdit}
                  onChange={(patch) => {
                    const next = sources.map((o) =>
                      o.id === src.id ? applyPatch(o, patch) : o,
                    );
                    onUpdateApp({
                      sources: next,
                      targets: next.map((o) => o.layer),
                    });
                  }}
                  onRemove={() => {
                    const next = sources.filter((o) => o.id !== src.id);
                    onUpdateApp({
                      sources: next,
                      targets: next.map((o) => o.layer),
                    });
                  }}
                />
              ))}
            </ul>
          ) : null}
          {canEdit ? (
            <AddTargetControl
              mapId={app.mapId}
              existing={sources.map((src) => src.layer)}
              onAdd={(t) => {
                // A new source on a dashboard follows the page's map
                // by default. That is the whole reason scope moved
                // here: the author is choosing a layer for a
                // dashboard, and "answer for what is on the map" is
                // what they meant. Any other app leaves it unset.
                const mapWidget =
                  app.blueprint === 'dashboard'
                    ? (page.widgets ?? []).find((w) => w.kind === 'map')
                    : undefined;
                const next: AppDataSource = {
                  id: newSourceId(),
                  layer: t,
                  ...(mapWidget ? { followMapWidgetId: mapWidget.id } : {}),
                };
                onUpdateApp({
                  sources: [...sources, next],
                  targets: [...sources.map((o) => o.layer), t],
                });
              }}
            />
          ) : sources.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted">
              No layers yet.
            </div>
          ) : null}
        </Field>
      </div>
    </div>
  );
}

/**
 * One data source in the app's Layers panel: its name, and what
 * reading it means.
 *
 * Scope is edited here rather than on each widget because a source
 * serves many widgets, and the alternative asks the author to make
 * the same decision once per tile and get it identical every time.
 */
function SourceRow({
  source,
  siblings,
  mapWidgets,
  canEdit,
  onChange,
  onRemove,
}: {
  source: AppDataSource;
  siblings: AppDataSource[];
  mapWidgets: CustomWidget[];
  canEdit: boolean;
  onChange: (patch: SourcePatch) => void;
  onRemove: () => void;
}) {
  const myFields = useTargetFields(source.layer);
  const parent = siblings.find((o) => o.id === source.via?.sourceId);
  const parentFields = useTargetFields(parent?.layer);
  return (
    <li className="rounded-md border border-border bg-surface-2 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <LayersIcon className="h-3.5 w-3.5 shrink-0 text-info" />
        <input
          type="text"
          value={source.label ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChange({ label: e.target.value || undefined })}
          placeholder={source.layer.layerKey}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-2xs text-ink-0 hover:border-border focus:border-ink-1 focus:outline-none"
          aria-label="Layer name"
        />
        {canEdit && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 text-muted hover:text-danger"
            aria-label="Remove layer"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 pl-5">
        <span className="shrink-0 text-2xs text-muted">Shows</span>
        <select
          value={source.via ? '@via' : (source.followMapWidgetId ?? '')}
          disabled={!canEdit}
          onChange={(e) => {
            if (e.target.value === '@via') {
              const first = siblings[0];
              if (!first) return;
              onChange({
                followMapWidgetId: undefined,
                via: {
                  sourceId: first.id,
                  parentField: '',
                  myField: '',
                },
              });
              return;
            }
            onChange({
              via: undefined,
              followMapWidgetId: e.target.value || undefined,
            });
          }}
          className="min-w-0 flex-1 rounded border border-border bg-surface-1 px-1 py-0.5 text-2xs"
        >
          <option value="">every record</option>
          {mapWidgets.map((w) => (
            <option key={w.id} value={w.id}>
              only what is on Map · {w.id.slice(2, 10)}
            </option>
          ))}
          {siblings.length > 0 ? (
            <option value="@via">only rows linked to another layer</option>
          ) : null}
        </select>
      </div>
      {/* The relate. This is what lets a table with no geometry
          follow a map: it has no location of its own, but its parent
          does, so it is in view when its parent is. Whatever narrows
          the parent narrows this too, with nothing else declared. */}
      {source.via ? (
        <div className="mt-1 space-y-1 rounded border border-border bg-surface-1 px-1.5 py-1 pl-5">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-2xs text-muted">Linked to</span>
            <select
              value={source.via.sourceId}
              disabled={!canEdit}
              onChange={(e) =>
                onChange({
                  via: { ...source.via!, sourceId: e.target.value },
                })
              }
              className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-1 py-0.5 text-2xs"
            >
              {siblings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label?.trim() || o.layer.layerKey}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-2xs text-muted">matching</span>
            <select
              value={source.via.myField}
              disabled={!canEdit || myFields.loading}
              onChange={(e) =>
                onChange({
                  via: { ...source.via!, myField: e.target.value },
                })
              }
              className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-1 py-0.5 text-2xs"
            >
              <option value="">(pick a field)</option>
              {myFields.fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
            <span className="shrink-0 text-2xs text-muted">to</span>
            <select
              value={source.via.parentField}
              disabled={!canEdit || parentFields.loading}
              onChange={(e) =>
                onChange({
                  via: { ...source.via!, parentField: e.target.value },
                })
              }
              className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-1 py-0.5 text-2xs"
            >
              <option value="">(pick a field)</option>
              {parentFields.fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          {!source.via.myField || !source.via.parentField ? (
            <p className="text-2xs text-warn">
              Pick both fields, or this layer shows nothing.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function WidgetProperties({
  widget,
  canEdit,
  pageWidgets,
  appPages,
  appTargets,
  appMapId,
  appMapTitle,
  mapTitlesById,
  onChange,
  onChangeConfig,
  onPickWidgetMap,
  onRemove,
}: {
  widget: CustomWidget;
  canEdit: boolean;
  pageWidgets: CustomWidget[];
  appPages: CustomPage[];
  appTargets: AppDataSource[];
  appMapId: string | undefined;
  appMapTitle: string | null;
  mapTitlesById: Record<string, string>;
  onChange: (patch: Partial<CustomWidget>) => void;
  onChangeConfig: (configPatch: Record<string, unknown>) => void;
  onPickWidgetMap: () => void;
  onRemove: () => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
        <span className="text-sm font-medium text-ink-0">
          {tile?.label ?? widget.kind}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
              title="Remove widget"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          <MoreVertical className="h-4 w-4 text-muted" strokeWidth={1.75} />
        </span>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-sm font-medium text-ink-0">Layout</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Column">
            <NumberInput
              value={widget.layout.col}
              min={1}
              max={GRID_COLS}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: {
                    ...widget.layout,
                    col: clampCol(v),
                    colSpan: Math.min(
                      widget.layout.colSpan,
                      GRID_COLS - clampCol(v) + 1,
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Row">
            <NumberInput
              value={widget.layout.row}
              min={1}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: { ...widget.layout, row: Math.max(1, v) },
                })
              }
            />
          </Field>
          <Field label="Width">
            <NumberInput
              value={widget.layout.colSpan}
              min={1}
              max={GRID_COLS}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: {
                    ...widget.layout,
                    colSpan: Math.max(
                      1,
                      Math.min(v, GRID_COLS - widget.layout.col + 1),
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Height">
            <NumberInput
              value={widget.layout.rowSpan}
              min={1}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: { ...widget.layout, rowSpan: Math.max(1, v) },
                })
              }
            />
          </Field>
        </div>
        <p className="text-xs leading-snug text-muted">
          Drag the widget on the canvas to move; drag the right,
          bottom, or corner handles to resize. Or enter cells here.
        </p>
        <label className="flex items-start gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={widget.allowMaximize === true}
            disabled={!canEdit}
            onChange={(e) => onChange({ allowMaximize: e.target.checked })}
          />
          <span>
            Let viewers expand this panel
            <span className="mt-0.5 block text-muted">
              Adds a button that grows the panel to fill the page.
              Worth it for tables, charts, and maps that run out of
              room in a tile; not for a single number or a toolbar
              button.
            </span>
          </span>
        </label>
        <div className="-mx-4 border-t border-border" />
        <p className="text-sm font-medium text-ink-0">Configuration</p>
        <WidgetConfigForm
          widget={widget}
          canEdit={canEdit}
          pageWidgets={pageWidgets}
          appPages={appPages}
          appTargets={appTargets}
          appMapId={appMapId}
          appMapTitle={appMapTitle}
          mapTitlesById={mapTitlesById}
          onChangeConfig={onChangeConfig}
          onPickWidgetMap={onPickWidgetMap}
        />
        {TOOL_MODE_KINDS.has(widget.kind) && (
          <ToolModeSection
            config={
              widget.config as {
                displayMode?: 'panel' | 'tool';
                panelArrangement?: PanelArrangement;
              }
            }
            canEdit={canEdit}
            defaultLabel={
              PALETTE_TILES.find((t) => t.kind === widget.kind)?.label ?? widget.kind
            }
            onChangeConfig={onChangeConfig}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Per-kind configuration form rendered inside the widget properties
 * panel (#339). Each branch renders the controls relevant to that
 * widget's CustomWidgetConfig shape:
 *
 *   - Map: optional override for the app-level default map; toggle
 *     for the navigation buttons (zoom +/-/home/locate)
 *   - Legend / LayerList / Search / Print / Select / BasemapGallery:
 *     pick which Map widget on this page they bind to. The picker
 *     surfaces every Map widget with a friendly id; auto-bind on
 *     drop already wires the "only one Map" case (#339 helper), so
 *     this form only matters for the "two or more Maps" case or for
 *     fixing a stale binding after deletion / rename.
 *   - AttributeTable: which target index in the app's targets list
 *     this table renders + optional sync to a Map widget so row
 *     selection highlights features
 *   - Text: a markdown body + presentational preset (header / body /
 *     callout)
 *   - Chart: deferred -- the runtime renderer ships with chart last
 *
 * Form layout: tiny fields in muted labels so the panel stays
 * compact. Inputs disabled when canEdit=false (sharee / read-only
 * viewer of the configuration page).
 */
function WidgetConfigForm({
  widget,
  canEdit,
  pageWidgets,
  appPages,
  appTargets,
  appMapId,
  appMapTitle,
  mapTitlesById,
  onChangeConfig,
  onPickWidgetMap,
}: {
  widget: CustomWidget;
  canEdit: boolean;
  pageWidgets: CustomWidget[];
  appPages: CustomPage[];
  appTargets: AppDataSource[];
  appMapId: string | undefined;
  appMapTitle: string | null;
  mapTitlesById: Record<string, string>;
  onChangeConfig: (configPatch: Record<string, unknown>) => void;
  onPickWidgetMap: () => void;
}) {
  // List of map widgets on this page, used by every map-following
  // kind below to pick a binding.
  const mapWidgets = pageWidgets.filter((w) => w.kind === 'map');
  switch (widget.config.kind) {
    case 'map':
      return (
        <MapWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          appMapId={appMapId}
          appMapTitle={appMapTitle}
          // #363: resolved title for the per-widget override mapId,
          // if one was fetched. Falls back to the UUID stub when the
          // fetch hasn't completed yet (or the map has been deleted).
          widgetMapTitle={
            widget.config.mapId
              ? mapTitlesById[widget.config.mapId] ?? null
              : null
          }
          appTargetCount={appTargets.length}
          onChangeConfig={onChangeConfig}
          onPickMap={onPickWidgetMap}
        />
      );
    case 'print':
      return (
        <MapBindingPicker
          mapWidgetId={widget.config.mapWidgetId}
          mapWidgets={mapWidgets}
          canEdit={canEdit}
          onChange={(mapWidgetId) => onChangeConfig({ mapWidgetId })}
          extra={
            <PrintTemplatePickerField
              selectedIds={widget.config.templateIds ?? []}
              canEdit={canEdit}
              onChange={(ids) =>
                onChangeConfig({
                  templateIds: ids.length > 0 ? ids : undefined,
                })
              }
            />
          }
        />
      );
    case 'legend':
    case 'layer-list':
    case 'search':
    case 'select':
    case 'export':
    case 'basemap-gallery':
      return (
        <MapBindingPicker
          mapWidgetId={widget.config.mapWidgetId}
          mapWidgets={mapWidgets}
          canEdit={canEdit}
          onChange={(mapWidgetId) => onChangeConfig({ mapWidgetId })}
          extra={
            widget.config.kind === 'legend' ? (
              <Field label="Title">
                <input
                  type="text"
                  value={widget.config.title ?? ''}
                  disabled={!canEdit}
                  placeholder="e.g. Construction era"
                  onChange={(e) =>
                    onChangeConfig({
                      title: e.target.value.trim() ? e.target.value : undefined,
                    })
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                />
                <p className="mt-1 text-2xs text-muted">
                  What the colours are showing, in your words. Left
                  blank, the panel is just headed &ldquo;Legend&rdquo;.
                </p>
              </Field>
            ) : widget.config.kind === 'layer-list' ? (
              <Field label="Allow toggling layers">
                <select
                  value={widget.config.allowToggle === false ? 'no' : 'yes'}
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChangeConfig({
                      allowToggle: e.target.value === 'yes',
                    })
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                >
                  <option value="yes">Yes</option>
                  <option value="no">No (read-only)</option>
                </select>
              </Field>
            ) : widget.config.kind === 'search' ? (
              <Field label="Address geocoding">
                <select
                  value={
                    widget.config.geocodingEnabled === false ? 'no' : 'yes'
                  }
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChangeConfig({
                      geocodingEnabled: e.target.value === 'yes',
                    })
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                >
                  <option value="yes">Address + attribute search</option>
                  <option value="no">Attribute search only</option>
                </select>
              </Field>
            ) : null
          }
        />
      );
    case 'attribute-table':
      return (
        <div className="space-y-3">
          <Field
            label="Target layer"
            hint={
              appTargets.length === 0
                ? 'No targets defined on the app yet. Add one via the Map widget.'
                : 'The layer this table renders rows from.'
            }
          >
            <select
              value={widget.config.targetIndex}
              disabled={!canEdit || appTargets.length === 0}
              onChange={(e) =>
                onChangeConfig({ targetIndex: Number(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              {appTargets.length === 0 ? (
                <option value={0}>(no targets)</option>
              ) : (
                appTargets.map((src, i) => (
                  <option key={src.id} value={i}>
                    {src.label?.trim() || src.layer.layerKey}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field
            label="Sync selection with map"
            hint="Optional. When set, clicking a row highlights that feature on the chosen map."
          >
            <select
              value={widget.config.syncWithMapWidgetId ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({
                  syncWithMapWidgetId: e.target.value || undefined,
                })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="">None</option>
              {mapWidgets.map((m) => (
                <option key={m.id} value={m.id}>
                  Map · {m.id.slice(2, 10)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max rows">
            <NumberInput
              value={widget.config.maxRows ?? 200}
              min={10}
              max={5000}
              disabled={!canEdit}
              onChange={(v) =>
                onChangeConfig({ maxRows: Math.max(10, Math.min(5000, v)) })
              }
            />
          </Field>
        </div>
      );
    case 'text':
      return (
        <div className="space-y-3">
          <Field label="Preset">
            <select
              value={widget.config.preset ?? 'body'}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({
                  preset: e.target.value as
                    | 'header'
                    | 'subheader'
                    | 'body'
                    | 'callout',
                })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="header">Header</option>
              <option value="subheader">Subheader</option>
              <option value="body">Body</option>
              <option value="callout">Callout</option>
            </select>
          </Field>
          <Field label="Content" hint="Type your text, use the toolbar to style.">
            <RichTextEditor
              value={widget.config.markdown}
              disabled={!canEdit}
              onChange={(v) => onChangeConfig({ markdown: v })}
            />
          </Field>
        </div>
      );
    case 'chart':
      return (
        <ChartWidgetConfigEditor
          config={widget.config}
          canEdit={canEdit}
          appTargets={appTargets}
          mapWidgets={mapWidgets}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'indicator':
      return (
        <IndicatorWidgetConfigEditor
          config={widget.config}
          canEdit={canEdit}
          appTargets={appTargets}
          mapWidgets={mapWidgets}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'image':
      return (
        <ImageWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'splash':
      return (
        <SplashWidgetConfigForm
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'button':
      return (
        <ButtonWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          pages={appPages}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'tool':
      return (
        <ToolWidgetConfigForm
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'divider':
      return (
        <DividerWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'embed':
      return (
        <EmbedWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'bookmark':
      return (
        <BookmarkWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          mapWidgets={mapWidgets}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'coordinates':
      return (
        <>
          <MapBindingPicker
            mapWidgetId={widget.config.mapWidgetId}
            mapWidgets={mapWidgets}
            canEdit={canEdit}
            onChange={(next) => onChangeConfig({ mapWidgetId: next })}
          />
          <CoordinatesWidgetConfigBody
            config={widget.config}
            canEdit={canEdit}
            onChangeConfig={onChangeConfig}
          />
        </>
      );
    case 'my-location':
      return (
        <>
          <MapBindingPicker
            mapWidgetId={widget.config.mapWidgetId}
            mapWidgets={mapWidgets}
            canEdit={canEdit}
            onChange={(next) => onChangeConfig({ mapWidgetId: next })}
          />
          <MyLocationWidgetConfigBody
            config={widget.config}
            canEdit={canEdit}
            onChangeConfig={onChangeConfig}
          />
        </>
      );
    case 'elevation-profile':
      return (
        <>
          <MapBindingPicker
            mapWidgetId={widget.config.mapWidgetId}
            mapWidgets={mapWidgets}
            canEdit={canEdit}
            onChange={(next) => onChangeConfig({ mapWidgetId: next })}
          />
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={widget.config.showLabel ?? false}
              onChange={(e) =>
                onChangeConfig({ showLabel: e.target.checked })
              }
            />
            Show label next to the icon
          </label>
          <p className="text-xs leading-snug text-muted">
            Viewers draw a line on the bound map and get a chart of
            the ground height along it, read from the map&apos;s
            elevation layer (or any elevation layer covering the
            line).
          </p>
        </>
      );
    case 'magic-outline':
      return (
        <>
          <MapBindingPicker
            mapWidgetId={widget.config.mapWidgetId}
            mapWidgets={mapWidgets}
            canEdit={canEdit}
            onChange={(next) => onChangeConfig({ mapWidgetId: next })}
          />
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={widget.config.showLabel ?? false}
              onChange={(e) =>
                onChangeConfig({ showLabel: e.target.checked })
              }
            />
            Show label next to the icon
          </label>
          <p className="text-xs leading-snug text-muted">
            Viewers click a building, pond, or lot on the map&apos;s
            imagery; its outline is traced and saved to an editable
            layer. When the app has more than one editable layer the
            tool shows a &quot;Save to&quot; picker so a user can
            digitize several feature types into their own layers in
            one session, plus a Natural-to-Squared slider. Needs an
            imagery layer and at least one editable layer (set under
            the app&apos;s Editable layers).
          </p>
        </>
      );
    case 'time-slider':
      return (
        <TimeSliderWidgetConfigEditor
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'create-feature':
    case 'edit-feature':
    case 'delete-feature':
      return (
        <FeatureMutationWidgetConfigEditor
          config={widget.config}
          canEdit={canEdit}
          mapWidgets={mapWidgets}
          appTargets={appTargets}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'tabs':
      return (
        <TabsWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    // Themed-app containers. Each kind gets its own chrome editor
    // (title, variant, side, widthPx, etc.) plus a shared children
    // list with add/remove/reorder so authors can edit templated
    // apps without dropping into Advanced JSON mode.
    case 'container':
      return (
        <ContainerConfigEditor
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    default: {
      const _exhaustive: never = widget.config;
      void _exhaustive;
      return null;
    }
  }
}

function MapWidgetConfig({
  config,
  canEdit,
  appMapId,
  appMapTitle,
  widgetMapTitle,
  appTargetCount,
  onChangeConfig,
  onPickMap,
}: {
  config: { kind: 'map'; mapId?: string; showNavigation?: boolean };
  canEdit: boolean;
  appMapId: string | undefined;
  appMapTitle: string | null;
  /** #363: resolved title for the per-widget override mapId, or
   *  null when the fetch is in flight / the map has been deleted. */
  widgetMapTitle: string | null;
  appTargetCount: number;
  onChangeConfig: (patch: Record<string, unknown>) => void;
  onPickMap: () => void;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Map source"
        hint="Per-widget override. Leave empty to inherit the app's default map."
      >
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1">
          <MapIcon className="h-3.5 w-3.5 text-success" />
          <span className="flex-1 truncate text-ink-1">
            {config.mapId ? (
              widgetMapTitle ? (
                <span>{widgetMapTitle}</span>
              ) : (
                <span className="font-mono text-2xs">
                  {config.mapId.slice(0, 12)}...
                </span>
              )
            ) : appMapId ? (
              <>
                <span className="text-muted">app default ·</span>{' '}
                {appMapTitle ?? appMapId.slice(0, 8)}
              </>
            ) : (
              <span className="text-muted">none</span>
            )}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={onPickMap}
              className="text-2xs font-medium text-accent hover:underline"
              title={config.mapId ? 'Change override' : 'Pick a map override'}
            >
              {config.mapId ? 'Change' : 'Pick'}
            </button>
          )}
          {canEdit && config.mapId && (
            <button
              type="button"
              onClick={() => onChangeConfig({ mapId: undefined })}
              className="text-muted hover:text-danger"
              title="Use app default"
              aria-label="Reset to app default"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </Field>
      <Field label="Navigation buttons">
        <select
          value={config.showNavigation === false ? 'no' : 'yes'}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({ showNavigation: e.target.value === 'yes' })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="yes">Show zoom + home + locate</option>
          <option value="no">Hide</option>
        </select>
      </Field>
      <p className="rounded-md border border-dashed border-border bg-surface-2/40 px-2 py-2 text-2xs text-muted">
        {appTargetCount === 0
          ? 'No targets on the app yet. The runtime will render the map with just the basemap until targets are added.'
          : `${appTargetCount} target layer${appTargetCount === 1 ? '' : 's'} on the app -- this map renders all of them by default.`}
      </p>
    </div>
  );
}

// ---- Page-element widget config editors (#361) -----------------------------

function ImageWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: {
    kind: 'image';
    asset?: AssetRef;
    url?: string;
    alt?: string;
    objectFit?: 'contain' | 'cover' | 'fill' | 'none';
    href?: string;
    openInNewTab?: boolean;
  };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  // The Image widget previously stored a bare `url`. New saves
  // store `asset` (AssetRef) instead so the system knows whether
  // the source is a portal File item (governed, can detect
  // dependencies on delete, can refresh bytes without re-saving the
  // app) or an external URL. Existing configs that only have `url`
  // get promoted to an external-url AssetRef when the author edits;
  // the runtime still falls back to `url` for un-promoted legacy
  // configs so we don't break shipped apps.
  const currentAsset: AssetRef | null =
    config.asset ??
    (config.url ? { kind: 'external-url', url: config.url } : null);
  return (
    <div className="space-y-3">
      <AssetPicker
        value={currentAsset}
        onChange={(next) => {
          if (!next) {
            // Clearing clears both fields so a legacy `url` doesn't
            // stick around shadowing the cleared state.
            onChangeConfig({ asset: undefined, url: undefined });
            return;
          }
          // Stamp the new asset and clear the legacy `url` field so
          // there's a single source of truth going forward.
          onChangeConfig({ asset: next, url: undefined });
        }}
        acceptMimePrefixes={['image/']}
        disabled={!canEdit}
        label="Image source"
        hint="Pick from your portal files, paste a URL, or upload a new one (uploads become File items so they're governed)."
      />
      <Field
        label="Alt text"
        hint="Describe the image for screen readers. Leave blank if decorative."
      >
        <input
          type="text"
          value={config.alt ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ alt: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Fit">
        <select
          value={config.objectFit ?? 'contain'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ objectFit: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="contain">Contain (letterbox)</option>
          <option value="cover">Cover (crop)</option>
          <option value="fill">Fill (stretch)</option>
          <option value="none">None (actual size)</option>
        </select>
      </Field>
      <Field
        label="Click target (optional)"
        hint="When set, the image becomes a link."
      >
        <input
          type="url"
          value={config.href ?? ''}
          disabled={!canEdit}
          placeholder="https://..."
          onChange={(e) => onChangeConfig({ href: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      {config.href ? (
        <label className="flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={config.openInNewTab ?? false}
            onChange={(e) => onChangeConfig({ openInNewTab: e.target.checked })}
          />
          Open in a new tab
        </label>
      ) : null}
    </div>
  );
}

/**
 * #111 Splash Screen widget config.  Reuses the RichTextEditor +
 * markdown round-trip from the Text widget for the body.  Sizing
 * is preset-or-custom; dismissal and required-confirm are simple
 * toggles.
 */
function SplashWidgetConfigForm({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: {
    kind: 'splash';
    title: string;
    markdown: string;
    size?: 'sm' | 'md' | 'lg' | 'custom';
    widthPx?: number;
    confirmLabel?: string;
    allowDismiss?: boolean;
    requireConfirm?: boolean;
  };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Title">
        <input
          type="text"
          value={config.title ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ title: e.target.value })}
          placeholder="Welcome"
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field
        label="Body"
        hint="Use the toolbar to add bold, italics, headings, lists, links, and color.  Visible to the user as the modal body."
      >
        <RichTextEditor
          value={config.markdown ?? ''}
          disabled={!canEdit}
          onChange={(v) => onChangeConfig({ markdown: v })}
        />
      </Field>
      <Field label="Confirm button label">
        <input
          type="text"
          value={config.confirmLabel ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ confirmLabel: e.target.value })}
          placeholder="OK"
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Size">
        <select
          value={config.size ?? 'md'}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({
              size: e.target.value as 'sm' | 'md' | 'lg' | 'custom',
            })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="sm">Small (400px)</option>
          <option value="md">Medium (600px)</option>
          <option value="lg">Large (800px)</option>
          <option value="custom">Custom…</option>
        </select>
      </Field>
      {config.size === 'custom' ? (
        <Field
          label="Custom width (px)"
          hint="Clamped at 280-1200px on render so the modal stays usable on phones."
        >
          <input
            type="number"
            min={280}
            max={1200}
            step={20}
            value={config.widthPx ?? 600}
            disabled={!canEdit}
            onChange={(e) => onChangeConfig({ widthPx: Number(e.target.value) })}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
          />
        </Field>
      ) : null}
      <label className="flex items-start gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.allowDismiss ?? false}
          onChange={(e) =>
            onChangeConfig({ allowDismiss: e.target.checked })
          }
          className="mt-0.5"
        />
        <span>
          Show <strong>&ldquo;Don&rsquo;t show this again&rdquo;</strong>{' '}
          checkbox.  When checked at confirm time, the splash is
          remembered as dismissed (via localStorage) and skipped on
          subsequent visits.  Editing the splash content resets the
          dismissal for everyone.
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.requireConfirm ?? false}
          onChange={(e) =>
            onChangeConfig({ requireConfirm: e.target.checked })
          }
          className="mt-0.5"
        />
        <span>
          <strong>Require confirmation.</strong>  When on, the modal
          has no close-X, escape does nothing, and clicking outside
          doesn&rsquo;t dismiss.  The user must click the confirm
          button.  Use for terms / disclaimers.
        </span>
      </label>
    </div>
  );
}

function ButtonWidgetConfig({
  config,
  canEdit,
  pages,
  onChangeConfig,
}: {
  config: {
    kind: 'button';
    label: string;
    linkKind?: 'url' | 'page' | 'tool';
    url?: string;
    pageId?: string;
    toolId?: string;
    variant?: 'primary' | 'secondary';
    openInNewTab?: boolean;
  };
  canEdit: boolean;
  pages: CustomPage[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const linkKind = config.linkKind ?? 'url';
  return (
    <div className="space-y-3">
      <Field label="Label">
        <input
          type="text"
          value={config.label ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ label: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Variant">
        <select
          value={config.variant ?? 'primary'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ variant: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="primary">Primary (filled)</option>
          <option value="secondary">Secondary (outline)</option>
        </select>
      </Field>
      <Field label="Links to">
        <select
          value={linkKind}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ linkKind: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="url">External URL</option>
          <option value="page">Page in this app</option>
          <option value="tool">Run a tool</option>
        </select>
      </Field>
      {linkKind === 'url' ? (
        <>
          <Field label="URL">
            <input
              type="url"
              value={config.url ?? ''}
              disabled={!canEdit}
              placeholder="https://..."
              onChange={(e) => onChangeConfig({ url: e.target.value })}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={config.openInNewTab ?? false}
              onChange={(e) => onChangeConfig({ openInNewTab: e.target.checked })}
            />
            Open in a new tab
          </label>
        </>
      ) : linkKind === 'page' ? (
        <Field label="Page">
          <select
            value={config.pageId ?? ''}
            disabled={!canEdit || pages.length === 0}
            onChange={(e) => onChangeConfig({ pageId: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
          >
            <option value="">Pick a page</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        // #90: real tool picker -- combobox over accessible tool
        // items + "+ New tool" inline modal for stamping out a
        // starter recipe without leaving the app designer.
        <Field label="Tool">
          <ToolPicker
            selectedId={config.toolId ?? ''}
            canEdit={canEdit}
            onSelect={(id) => onChangeConfig({ toolId: id })}
          />
        </Field>
      )}
    </div>
  );
}

/**
 * #144: Tool widget config form. Pick a tool, an icon, and the
 * display variant. Icon belongs on the widget instance (NOT on
 * the underlying Tool item) so the same tool can render with
 * different icons / labels in different apps.
 */
function ToolWidgetConfigForm({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: {
    kind: 'tool';
    toolId?: string;
    iconName?: string;
    label?: string;
    showLabel?: boolean;
    display?: 'toolbar' | 'standalone';
    variant?: 'primary' | 'secondary';
  };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const display = config.display ?? 'toolbar';
  return (
    <div className="space-y-3">
      <Field label="Tool">
        <ToolPicker
          selectedId={config.toolId ?? ''}
          canEdit={canEdit}
          onSelect={(id) => onChangeConfig({ toolId: id })}
        />
      </Field>
      <Field label="Icon">
        <ToolIconPicker
          value={config.iconName ?? ''}
          canEdit={canEdit}
          onChange={(iconName) => onChangeConfig({ iconName })}
        />
      </Field>
      <Field
        label="Label (optional)"
        hint="Defaults to the tool's title when blank."
      >
        <input
          type="text"
          value={config.label ?? ''}
          disabled={!canEdit}
          placeholder="(use tool title)"
          onChange={(e) => onChangeConfig({ label: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Display">
        <select
          value={display}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ display: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="toolbar">Toolbar (icon only)</option>
          <option value="standalone">Standalone (icon + label)</option>
        </select>
      </Field>
      {display === 'toolbar' ? (
        <label className="flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={config.showLabel ?? false}
            onChange={(e) => onChangeConfig({ showLabel: e.target.checked })}
          />
          Show label next to icon
        </label>
      ) : (
        <Field label="Variant">
          <select
            value={config.variant ?? 'primary'}
            disabled={!canEdit}
            onChange={(e) => onChangeConfig({ variant: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
          >
            <option value="primary">Primary (filled)</option>
            <option value="secondary">Secondary (outline)</option>
          </select>
        </Field>
      )}
    </div>
  );
}

/**
 * #144: lucide-icon picker for the Tool widget. Curated grid
 * grouped by category (same set as the layer symbol picker), with
 * an "(no icon)" option that falls through to the runtime's
 * default wand glyph. Closes on outside click + Escape.
 */
function ToolIconPicker({
  value,
  canEdit,
  onChange,
}: {
  value: string;
  canEdit: boolean;
  onChange: (iconName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const selectedLabel = value ? MAP_ICONS[value]?.label ?? value : 'No icon';

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-1 px-2 py-1 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-ink-1">
          {value && MAP_ICONS[value] ? (
            <span
              aria-hidden
              dangerouslySetInnerHTML={{
                __html: renderIconSvg(value) ?? '',
              }}
              className="[&_svg]:h-4 [&_svg]:w-4"
            />
          ) : (
            <Wand2 className="h-4 w-4 text-muted" />
          )}
        </span>
        <span className="flex-1 truncate text-left text-ink-1">
          {selectedLabel}
        </span>
        <ChevronRight className="h-3 w-3 rotate-90 text-muted" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-surface-1 p-2 shadow-raised">
          <button
            type="button"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className={`mb-2 flex w-full items-center gap-2 rounded px-2 py-1 text-xs ${
              !value ? 'bg-accent/10 text-accent' : 'text-ink-1 hover:bg-surface-2'
            }`}
          >
            <Wand2 className="h-3.5 w-3.5" />
            No icon (use default wand)
          </button>
          {MAP_ICON_CATEGORIES.map((cat) => {
            const inCat = Object.entries(MAP_ICONS).filter(
              ([, v]) => v.category === cat,
            );
            if (inCat.length === 0) return null;
            return (
              <div key={cat} className="mb-2">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  {cat.replace(/-/g, ' ')}
                </p>
                <div className="grid grid-cols-6 gap-1">
                  {inCat.map(([name, icon]) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        onChange(name);
                        setOpen(false);
                      }}
                      title={icon.label}
                      aria-label={icon.label}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded ${
                        value === name
                          ? 'bg-accent/15 text-accent ring-1 ring-accent'
                          : 'text-ink-1 hover:bg-surface-2'
                      }`}
                    >
                      <span
                        aria-hidden
                        dangerouslySetInnerHTML={{
                          __html: renderIconSvg(name) ?? '',
                        }}
                        className="[&_svg]:h-4 [&_svg]:w-4"
                      />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * #144: live designer-canvas preview for the Tool widget. Same
 * visual treatment the runtime will produce, scaled to the
 * widget's bounding box.
 */
function ToolWidgetCanvasPreview({
  config,
}: {
  config: {
    kind: 'tool';
    toolId?: string;
    iconName?: string;
    label?: string;
    showLabel?: boolean;
    display?: 'toolbar' | 'standalone';
    variant?: 'primary' | 'secondary';
  };
}) {
  const display = config.display ?? 'toolbar';
  const iconHtml = config.iconName ? renderIconSvg(config.iconName) : null;
  const label = config.label?.trim() || 'Tool';
  if (display === 'standalone') {
    const v = config.variant ?? 'primary';
    return (
      <div className="flex flex-1 items-center justify-center p-2">
        <span
          className={`pointer-events-none inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium ${
            v === 'primary'
              ? 'bg-teal-500/90 text-white'
              : 'border border-border bg-surface-1 text-ink-1'
          }`}
        >
          {iconHtml ? (
            <span
              aria-hidden
              dangerouslySetInnerHTML={{ __html: iconHtml }}
              className="[&_svg]:h-3.5 [&_svg]:w-3.5"
            />
          ) : (
            <Wand2 className="h-3.5 w-3.5" />
          )}
          <span>{label}</span>
        </span>
      </div>
    );
  }
  // toolbar variant: icon-only round button (showLabel adds text inline).
  // Teal palette matches the tool item-type tile used on the items list
  // and the ItemTypeBadge, keeping the tool's visual identity coherent
  // across surfaces.
  return (
    <div className="flex flex-1 items-center justify-center p-2">
      <span
        className="pointer-events-none inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-teal-500/10 px-2 text-teal-700 dark:text-teal-400"
        style={{ minWidth: '2rem' }}
      >
        {iconHtml ? (
          <span
            aria-hidden
            dangerouslySetInnerHTML={{ __html: iconHtml }}
            className="[&_svg]:h-4 [&_svg]:w-4"
          />
        ) : (
          <Wand2 className="h-4 w-4" />
        )}
        {config.showLabel ? (
          <span className="text-xs font-medium">{label}</span>
        ) : null}
      </span>
    </div>
  );
}

function DividerWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'divider'; thicknessPx?: number; color?: string; style?: 'solid' | 'dashed' | 'dotted' };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Style">
        <select
          value={config.style ?? 'solid'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ style: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
      </Field>
      <Field label="Thickness (px)">
        <NumberInput
          value={config.thicknessPx ?? 1}
          min={1}
          max={8}
          disabled={!canEdit}
          onChange={(v) => onChangeConfig({ thicknessPx: v })}
        />
      </Field>
      <Field label="Color (CSS)" hint="Hex, rgb, or any CSS color. Leave blank to inherit border color.">
        <input
          type="text"
          value={config.color ?? ''}
          disabled={!canEdit}
          placeholder="#e5e7eb"
          onChange={(e) => onChangeConfig({ color: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
    </div>
  );
}

function EmbedWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'embed'; url?: string; title?: string; strict?: boolean };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="URL" hint="https only. Some sites refuse to be iframed (X-Frame-Options); test in the runtime.">
        <input
          type="url"
          value={config.url ?? ''}
          disabled={!canEdit}
          placeholder="https://..."
          onChange={(e) => onChangeConfig({ url: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Title" hint="Used for assistive tech. Defaults to the URL when blank.">
        <input
          type="text"
          value={config.title ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ title: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.strict ?? false}
          onChange={(e) => onChangeConfig({ strict: e.target.checked })}
        />
        Strict sandbox (recommended for untrusted URLs)
      </label>
    </div>
  );
}

// ---- Mapcentric quick-win widget config editors (#361 part 2) -----------

function BookmarkWidgetConfig({
  config,
  canEdit,
  mapWidgets,
  onChangeConfig,
}: {
  config: {
    kind: 'bookmark';
    mapWidgetId: string;
    bookmarks: Array<{
      id: string;
      name: string;
      center: [number, number];
      zoom: number;
      bearing?: number;
      pitch?: number;
    }>;
  };
  canEdit: boolean;
  mapWidgets: CustomWidget[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  function update(idx: number, patch: Partial<(typeof config.bookmarks)[number]>) {
    const next = config.bookmarks.map((b, i) =>
      i === idx ? { ...b, ...patch } : b,
    );
    onChangeConfig({ bookmarks: next });
  }
  function remove(idx: number) {
    onChangeConfig({
      bookmarks: config.bookmarks.filter((_, i) => i !== idx),
    });
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= config.bookmarks.length) return;
    const next = config.bookmarks.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(j, 0, moved!);
    onChangeConfig({ bookmarks: next });
  }
  function add() {
    // Empty placeholder coordinates; the runtime "Save current view"
    // button captures the bound map's actual viewport. Authors who
    // want to author by hand can edit the values inline.
    const next = [
      ...config.bookmarks,
      {
        id: `bm_${Math.random().toString(36).slice(2, 8)}`,
        name: `Bookmark ${config.bookmarks.length + 1}`,
        center: [0, 0] as [number, number],
        zoom: 2,
      },
    ];
    onChangeConfig({ bookmarks: next });
  }
  return (
    <div className="space-y-3">
      <MapBindingPicker
        mapWidgetId={config.mapWidgetId}
        mapWidgets={mapWidgets}
        canEdit={canEdit}
        onChange={(next) => onChangeConfig({ mapWidgetId: next })}
      />
      <Field label="Bookmarks" hint="At runtime each row becomes a fly-to button on the bound map.">
        <div className="space-y-1.5">
          {config.bookmarks.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted">
              No bookmarks yet. Add one to capture a viewport.
            </p>
          ) : (
            config.bookmarks.map((b, i) => (
              <div
                key={b.id}
                className="rounded-md border border-border bg-surface-1 p-2"
              >
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={b.name}
                    disabled={!canEdit}
                    onChange={(e) => update(i, { name: e.target.value })}
                    className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
                  />
                  <button
                    type="button"
                    title="Move up"
                    disabled={!canEdit || i === 0}
                    onClick={() => move(i, -1)}
                    className="rounded p-1 text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5 rotate-90" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={!canEdit || i === config.bookmarks.length - 1}
                    onClick={() => move(i, 1)}
                    className="rounded p-1 text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5 -rotate-90" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    disabled={!canEdit}
                    onClick={() => remove(i)}
                    className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                  <label className="text-2xs text-muted">
                    lng
                    <input
                      type="number"
                      step="0.000001"
                      value={b.center[0]}
                      disabled={!canEdit}
                      onChange={(e) =>
                        update(i, {
                          center: [Number(e.target.value), b.center[1]] as [number, number],
                        })
                      }
                      className="mt-0.5 w-full rounded border border-border bg-surface-1 px-1.5 py-0.5 text-xs text-ink-1 focus:border-ink-1 focus:outline-none"
                    />
                  </label>
                  <label className="text-2xs text-muted">
                    lat
                    <input
                      type="number"
                      step="0.000001"
                      value={b.center[1]}
                      disabled={!canEdit}
                      onChange={(e) =>
                        update(i, {
                          center: [b.center[0], Number(e.target.value)] as [number, number],
                        })
                      }
                      className="mt-0.5 w-full rounded border border-border bg-surface-1 px-1.5 py-0.5 text-xs text-ink-1 focus:border-ink-1 focus:outline-none"
                    />
                  </label>
                  <label className="text-2xs text-muted">
                    zoom
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      max={22}
                      value={b.zoom}
                      disabled={!canEdit}
                      onChange={(e) => update(i, { zoom: Number(e.target.value) })}
                      className="mt-0.5 w-full rounded border border-border bg-surface-1 px-1.5 py-0.5 text-xs text-ink-1 focus:border-ink-1 focus:outline-none"
                    />
                  </label>
                </div>
              </div>
            ))
          )}
          {canEdit && (
            <button
              type="button"
              onClick={add}
              className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs font-medium text-muted hover:border-accent/40 hover:text-ink-1"
            >
              <Plus className="h-3 w-3" strokeWidth={1.75} />
              Add bookmark
            </button>
          )}
        </div>
      </Field>
      <p className="text-xs leading-snug text-muted">
        Tip: open the runtime, pan and zoom the bound map to where you
        want, then click the "+" button on the bookmark widget to
        capture that view automatically.
      </p>
    </div>
  );
}

function CoordinatesWidgetConfigBody({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'coordinates'; format?: 'dd' | 'dms'; precision?: number; showZoom?: boolean };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const fmt = config.format ?? 'dd';
  return (
    <div className="space-y-3">
      <Field label="Format">
        <select
          value={fmt}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ format: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="dd">Decimal degrees (45.12345, -78.54321)</option>
          <option value="dms">Degrees, minutes, seconds (45° 7' 24" N)</option>
        </select>
      </Field>
      <Field label="Precision" hint={fmt === 'dd' ? 'Decimal places, 0-7.' : 'Whole-second precision typical; 0 omits seconds.'}>
        <NumberInput
          value={config.precision ?? (fmt === 'dd' ? 5 : 0)}
          min={0}
          max={fmt === 'dd' ? 7 : 3}
          disabled={!canEdit}
          onChange={(v) => onChangeConfig({ precision: v })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.showZoom ?? false}
          onChange={(e) => onChangeConfig({ showZoom: e.target.checked })}
        />
        Show zoom level chip
      </label>
    </div>
  );
}

function MyLocationWidgetConfigBody({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'my-location'; zoomLevel?: number; keepMarker?: boolean };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Zoom on locate" hint="0 (world) to 22 (street). 14 is town-scale.">
        <NumberInput
          value={config.zoomLevel ?? 14}
          min={0}
          max={22}
          disabled={!canEdit}
          onChange={(v) => onChangeConfig({ zoomLevel: v })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.keepMarker ?? true}
          onChange={(e) => onChangeConfig({ keepMarker: e.target.checked })}
        />
        Leave marker on the map after locating
      </label>
    </div>
  );
}

/**
 * Properties editor for the feature-mutation widgets (#69 / #70 /
 * #71).  All three share the same shape: bind to a Map widget,
 * pick a target layer, optional label override.  We render one
 * editor that covers all three rather than duplicating per-kind.
 */
function FeatureMutationWidgetConfigEditor({
  config,
  canEdit,
  mapWidgets,
  appTargets,
  onChangeConfig,
}: {
  config: {
    kind: 'create-feature' | 'edit-feature' | 'delete-feature';
    mapWidgetId: string;
    targetIndex?: number;
    label?: string;
  };
  canEdit: boolean;
  mapWidgets: CustomWidget[];
  appTargets: AppDataSource[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  // #89 pivot: `targetIndex` is now optional.  When omitted (the
  // recommended modern shape), the widget covers every editable
  // target in the bound map -- it builds a templates palette /
  // listens for clicks across all of them.  When set, the legacy
  // single-target behavior kicks in.
  const sentinel = -1;
  const currentValue =
    typeof config.targetIndex === 'number' ? config.targetIndex : sentinel;
  return (
    <div className="space-y-3">
      <MapBindingPicker
        mapWidgetId={config.mapWidgetId}
        mapWidgets={mapWidgets}
        canEdit={canEdit}
        onChange={(mapWidgetId) => onChangeConfig({ mapWidgetId })}
      />
      <Field
        label="Target layer"
        hint='Defaults to "All editable targets in the bound map" -- the recommended shape since one widget handles every editable layer. Pin to a single target only when the legacy single-binding behavior is wanted.'
      >
        <select
          value={currentValue}
          disabled={!canEdit || appTargets.length === 0}
          onChange={(e) => {
            const n = Number(e.target.value);
            // The sentinel -1 means "all targets"; we encode that as
            // targetIndex: undefined on the saved config so the
            // type stays clean.  Patching with `undefined` is a real
            // delete here: the WidgetConfigForm wrapper does
            // `{...current, ...patch}` and undefined overwrites the
            // stored value.
            onChangeConfig({ targetIndex: n === sentinel ? undefined : n });
          }}
          className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        >
          <option value={sentinel}>
            All editable targets (recommended)
          </option>
          {appTargets.map((src, i) => (
            <option key={src.id} value={i}>
              {`Only ${src.label?.trim() || src.layer.layerKey}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Button label" hint="Shown on the toolbar / panel header.">
        <input
          type="text"
          value={config.label ?? ''}
          maxLength={40}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ label: e.target.value })}
          placeholder={
            config.kind === 'create-feature'
              ? 'Add feature'
              : config.kind === 'edit-feature'
                ? 'Edit feature'
                : 'Delete feature'
          }
          className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        />
      </Field>
    </div>
  );
}

/**
 * Properties editor for the #87 time-slider widget.  Authors set
 * mode (slider vs. calendar), bounds, step, and the visible label.
 * The widget itself drives the app-wide AppTimeContext, so there is
 * no map binding to configure -- every Map / Chart / Table widget
 * on the page picks up the chosen `at` automatically.
 */
function TimeSliderWidgetConfigEditor({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: {
    kind: 'time-slider';
    mode?: 'date' | 'calendar';
    minDate?: string;
    maxDate?: string;
    stepDays?: number;
    label?: string;
    // #57: animated playback options.
    playable?: boolean;
    endBehavior?: 'loop' | 'pause';
    speedOptions?: number[];
  };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Display mode" hint="Slider for scrubbing through a range. Calendar for a single-pick date.">
        <select
          value={config.mode ?? 'date'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ mode: e.target.value })}
          className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        >
          <option value="date">Slider + date input</option>
          <option value="calendar">Calendar picker</option>
        </select>
      </Field>
      <Field label="Label" hint="Shown next to the slider. Default 'Time'.">
        <input
          type="text"
          value={config.label ?? ''}
          maxLength={40}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ label: e.target.value })}
          placeholder="Time"
          className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        />
      </Field>
      <Field label="Earliest date" hint="YYYY-MM-DD. Defaults to one year before today.">
        <input
          type="date"
          value={config.minDate ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ minDate: e.target.value })}
          className="h-9 rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        />
      </Field>
      <Field label="Latest date" hint="YYYY-MM-DD. Defaults to today.">
        <input
          type="date"
          value={config.maxDate ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ maxDate: e.target.value })}
          className="h-9 rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
        />
      </Field>
      {config.mode !== 'calendar' ? (
        <Field label="Step (days)" hint="Slider increment. 1 is daily, 7 is weekly, 30 is monthly.">
          <NumberInput
            value={config.stepDays ?? 1}
            min={1}
            max={365}
            disabled={!canEdit}
            onChange={(v) => onChangeConfig({ stepDays: v })}
          />
        </Field>
      ) : null}
      {config.mode !== 'calendar' ? (
        <Field
          label="Animated playback"
          hint="Show a play / pause button and a speed selector so viewers can scrub through the range automatically."
        >
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={config.playable !== false}
              disabled={!canEdit}
              onChange={(e) => onChangeConfig({ playable: e.target.checked })}
            />
            <span>Show play / pause + speed controls</span>
          </label>
        </Field>
      ) : null}
      {config.mode !== 'calendar' && config.playable !== false ? (
        <Field
          label="At end of range"
          hint="What playback does when it reaches the latest date."
        >
          <select
            value={config.endBehavior ?? 'loop'}
            disabled={!canEdit}
            onChange={(e) =>
              onChangeConfig({
                endBehavior: e.target.value === 'pause' ? 'pause' : 'loop',
              })
            }
            className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
          >
            <option value="loop">Loop back to start</option>
            <option value="pause">Pause at the end</option>
          </select>
        </Field>
      ) : null}
    </div>
  );
}

// ---- Themed container canvas preview (#22 WYSIWYG) -----------------------

/**
 * Render a themed container (app-bar / dock-panel / slideout /
 * foldable-group) inside the designer canvas using the same
 * runtime themed-containers components the live app uses.  This
 * is the EB-style WYSIWYG path: the canvas chrome matches what
 * users will see at runtime, and clicking a child selects it
 * (vs. opening its popover, which the runtime would do).
 *
 * The `renderChildInDesigner` callback supplied to each container
 * produces a clickable representation of the child:
 *   - container children (foldable-group inside dock-panel) recurse
 *   - tool-mode widgets (Search, Basemaps, etc.) render as a labeled
 *     icon button matching the runtime in-bar styling
 *   - panel-mode widgets (LayerList, etc.) render a compact summary
 *
 * Selection: clicking a child invokes onSelectChild(child.id) which
 * the page maps back to selectedWidgetId via a deep-find so the
 * right-rail properties panel shows the child's config.
 */
function ContainerInDesigner({
  widget,
  itemTitle: _itemTitle,
  selectedChildId,
  onSelectChild,
  onChildMoveStart,
}: {
  widget: CustomWidget;
  itemTitle: string;
  selectedChildId: string | null;
  onSelectChild: (childId: string) => void;
  /**
   * #96: callback the canvas wires up so a mousedown on any child
   * begins a drag gesture (for reorder within this container, or
   * reparent across containers, or extraction onto the page).
   * Threaded recursively into nested ContainerInDesigner instances
   * so a tool inside a foldable group inside a dock works too.
   */
  onChildMoveStart: (
    child: CustomWidget,
    parentId: string,
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
}) {
  void _itemTitle;
  const renderChild = (child: CustomWidget): React.ReactNode => (
    <DesignerChild
      child={child}
      parentId={widget.id}
      isSelected={selectedChildId === child.id}
      onSelect={onSelectChild}
      itemTitle={_itemTitle}
      onChildMoveStart={onChildMoveStart}
    />
  );

  if (widget.config.kind !== 'container') return null;
  return (
    <Container config={widget.config} renderChild={renderChild} />
  );
}

/**
 * One child inside a designer container.  Renders a click-to-
 * select representation of the child widget that matches the
 * runtime visually (icon + label for tools; container chrome for
 * nested containers; small placeholder card for content widgets).
 *
 * #96: mousedown on the child body begins a drag gesture so the
 * author can reorder children within their container OR drag the
 * child OUT of the container onto the page (the canvas's
 * gesture-track mousemove + mouseup decide which kind of move
 * actually happened based on where the cursor lands).
 */
function DesignerChild({
  child,
  parentId,
  isSelected,
  onSelect,
  itemTitle,
  onChildMoveStart,
}: {
  child: CustomWidget;
  /** Id of the container this child lives inside.  Threaded into
   *  the begin-gesture call so the canvas knows the source parent. */
  parentId: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  itemTitle: string;
  onChildMoveStart: (
    child: CustomWidget,
    parentId: string,
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === child.kind);
  const Icon = tile?.Icon ?? Square;
  // Same default-vs-override resolution the runtime does so the
  // designer canvas matches what the live tool button will show.
  const defaultLabel = tile?.label ?? child.kind;
  const labelOverride = (
    child.config as { panelArrangement?: { labelOverride?: string } }
  ).panelArrangement?.labelOverride?.trim();
  const label =
    labelOverride && labelOverride.length > 0 ? labelOverride : defaultLabel;

  // Nested containers (foldable-group inside dock-panel, or any
  // other container that ends up here) recurse via the same
  // ContainerInDesigner so the WYSIWYG goes all the way down.
  if (THEMED_CONTAINER_KINDS.has(child.kind)) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(child.id);
        }}
        onMouseDown={(e) => onChildMoveStart(child, parentId, e)}
        data-child-id={child.id}
        className={`relative cursor-pointer ${
          isSelected ? 'outline outline-2 outline-accent' : ''
        }`}
      >
        <ContainerInDesigner
          widget={child}
          itemTitle={itemTitle}
          selectedChildId={null}
          onSelectChild={onSelect}
          onChildMoveStart={onChildMoveStart}
        />
      </div>
    );
  }

  // Text widget rendered inside a container (sticky-top app-bar,
  // dock panel, menu, etc.) gets a dedicated render path so the
  // designer canvas shows the actual rendered text instead of the
  // generic "T" icon + "Text" caption.  Same MarkdownLite-style
  // renderer the canvas-grid + runtime uses.  Click still selects
  // the widget (so the right rail flips to its properties);
  // mousedown still begins the drag-gesture for reordering.
  if (child.kind === 'text' && child.config.kind === 'text') {
    const presetCls = TEXT_PRESET_CLS_DESIGNER[child.config.preset ?? 'body'] ?? '';
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(child.id);
        }}
        onMouseDown={
          onChildMoveStart
            ? (e) => onChildMoveStart(child, parentId, e)
            : undefined
        }
        data-child-id={child.id}
        title={label}
        className={`group/designer-child flex h-full max-w-[260px] cursor-grab items-center justify-center overflow-hidden rounded-md px-2 py-1 transition-colors active:cursor-grabbing ${
          isSelected
            ? 'outline outline-2 outline-[hsl(var(--app-header-ink))]'
            : ''
        }`}
      >
        <div className={`overflow-hidden ${presetCls}`}>
          {child.config.markdown.trim().length === 0 ? (
            <span className="text-2xs italic text-[hsl(var(--app-header-ink)/0.6)]">
              (empty)
            </span>
          ) : (
            <DesignerMarkdownLite text={child.config.markdown} />
          )}
        </div>
      </div>
    );
  }

  // Tool widgets and other content widgets render as a small
  // labeled icon button.  Mirrors the runtime in-bar visual so
  // the canvas reads as the live app, just without active state.
  // Use a div instead of <button> so we can attach mousedown for
  // the drag-gesture without conflicting with the browser's
  // default form-button mouse handling.
  //
  // Respect the same labelMode='icon-only' setting the runtime
  // uses (panelArrangement.labelMode).  Without this, the canvas
  // looked label-on while the runtime rendered icon-only -- broke
  // the WYSIWYG promise for that specific switch.
  const childCfg = child.config as { panelArrangement?: { labelMode?: string } };
  const iconOnly = childCfg.panelArrangement?.labelMode === 'icon-only';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(child.id);
      }}
      onMouseDown={
        onChildMoveStart
          ? (e) => onChildMoveStart(child, parentId, e)
          : undefined
      }
      data-child-id={child.id}
      title={label}
      // Drop the min-w-[64px] floor when icon-only: a 64-px-wide
      // icon-only button still reads as labeled because the empty
      // pill takes the same horizontal space.  Without the floor,
      // icon-only tools collapse to ~32 px (icon + side padding)
      // which is what the runtime shows.
      className={`group/designer-child flex h-full ${iconOnly ? '' : 'min-w-[64px]'} cursor-grab flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors active:cursor-grabbing ${
        isSelected
          ? 'bg-[hsl(var(--app-header-ink))] text-[hsl(var(--app-header-bg))]'
          : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
      }`}
    >
      <Icon className="h-5 w-5" strokeWidth={1.75} />
      {iconOnly ? null : (
        <span className="text-2xs font-medium leading-none">{label}</span>
      )}
    </div>
  );
}

// ---- Print template picker --------------------------------------

/**
 * Multi-select picker for the Print widget's per-app template
 * allowlist (#101 followup).  Fetches every print_template item
 * the user can read, then renders a checkbox list keyed by id.
 * Empty selection means "let the runtime show everything the user
 * has read access to."  Non-empty means "restrict to these N
 * templates" -- the runtime intersects this with read access at
 * print time so revoked shares drop out automatically.
 */
function PrintTemplatePickerField({
  selectedIds,
  canEdit,
  onChange,
}: {
  selectedIds: string[];
  canEdit: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [available, setAvailable] = useState<
    Array<{ id: string; title: string }> | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portal/items?type=print_template', {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setAvailable([]);
          return;
        }
        const rows = (await res.json()) as Array<{
          id: string;
          title: string;
        }>;
        if (!cancelled) setAvailable(rows.map((r) => ({ id: r.id, title: r.title })));
      } catch {
        if (!cancelled) setAvailable([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(id: string) {
    if (!canEdit) return;
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  }

  return (
    <Field
      label="Templates"
      hint="Pick which print templates this app exposes. Leave all unchecked to expose every print template the user can read."
    >
      {available === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : available.length === 0 ? (
        <p className="text-xs text-muted">
          No print templates available. Create one via the wizard
          first.
        </p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-0 p-1.5">
          {available.map((t) => {
            const checked = selectedIds.includes(t.id);
            return (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={() => toggle(t.id)}
                  className="h-3 w-3"
                />
                <span className="truncate text-ink-1">{t.title}</span>
              </label>
            );
          })}
        </div>
      )}
    </Field>
  );
}

// ---- Text widget canvas preview ---------------------------------

/**
 * Designer-canvas preview for the Text widget.  Renders the same
 * markdown content the runtime renders, with the same preset class
 * mapping, so authors see exactly how the text will look in the
 * live app while they edit.  Without this the canvas defaulted to
 * the generic "Drag content here" placeholder for text widgets.
 */
function TextWidgetCanvas({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'text') return null;
  const preset = widget.config.preset ?? 'body';
  const presetCls = TEXT_PRESET_CLS_DESIGNER[preset] ?? '';
  // flex flex-col justify-center + overflow-hidden + compact
  // padding: matches the runtime's TextWidgetRender exactly so the
  // designer previews what the live app will show, including
  // vertical centering of one-line titles inside tall slots.
  return (
    <div
      className={`flex h-full w-full flex-col justify-center overflow-hidden px-2 py-1 ${presetCls}`}
    >
      {widget.config.markdown.trim().length === 0 ? (
        <span className="text-xs italic text-muted">
          (empty -- edit content in the properties panel)
        </span>
      ) : (
        <DesignerMarkdownLite text={widget.config.markdown} />
      )}
    </div>
  );
}

/**
 * Designer-side mirror of the runtime's preset class map.  Lifted
 * here from runtime-client.tsx so the designer doesn't depend on
 * runtime internals; both stay in sync because they're trivial
 * one-line mappings (header / subheader / body / callout each take
 * one Tailwind class string).
 */
const TEXT_PRESET_CLS_DESIGNER: Record<string, string> = {
  header: 'text-2xl font-bold text-ink-0',
  subheader: 'text-base font-semibold text-ink-1',
  body: 'text-sm text-ink-1',
  callout:
    'rounded-md border border-accent/30 bg-accent/5 text-sm text-ink-1',
};

/**
 * Tiny markdown renderer used by the designer canvas preview.
 * Mirrors the runtime's MarkdownLite parser (headers + paragraphs +
 * unordered lists + bold/italic/code/links inline).  Kept in the
 * designer module so a text-widget edit reflects in the canvas
 * without a round-trip through the runtime module's import graph.
 */
function DesignerMarkdownLite({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <>
      {blocks.map((block, i) => {
        const t = block.trim();
        if (!t) return null;
        if (t.startsWith('### ')) {
          return (
            <h3 key={i} className="mb-2 text-base font-semibold text-ink-0">
              {renderInlineMd(t.slice(4))}
            </h3>
          );
        }
        if (t.startsWith('## ')) {
          return (
            <h2 key={i} className="mb-2 text-lg font-bold text-ink-0">
              {renderInlineMd(t.slice(3))}
            </h2>
          );
        }
        if (t.startsWith('# ')) {
          return (
            <h1 key={i} className="mb-2 text-xl font-bold text-ink-0">
              {renderInlineMd(t.slice(2))}
            </h1>
          );
        }
        const lines = t.split('\n');
        if (lines.every((l) => /^[-*]\s/.test(l))) {
          return (
            <ul key={i} className="mb-2 ml-5 list-disc space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInlineMd(l.replace(/^[-*]\s/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="mb-2 whitespace-pre-wrap">
            {renderInlineMd(t)}
          </p>
        );
      })}
    </>
  );
}

function renderInlineMd(s: string): React.ReactNode {
  // Designer mirror of the runtime renderInline.  Color span first
  // so a <span style="color:#xxx">...</span> emitted by the rich-
  // text editor's color picker survives round-trip and previews
  // correctly on the canvas.  See the runtime renderInline comment
  // for the threat-model reasoning behind the tight regex shape.
  const tokens: React.ReactNode[] = [];
  const re =
    /(<span style="color:\s*(#[0-9a-fA-F]{3,8})">([^<]+)<\/span>)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push(s.slice(last, m.index));
    if (m[1]) {
      tokens.push(
        <span key={key++} style={{ color: m[2] }}>
          {renderInlineMd(m[3] ?? '')}
        </span>,
      );
    } else if (m[4]) {
      tokens.push(
        <a
          key={key++}
          href={m[6]}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
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
          className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.95em]"
        >
          {m[12]}
        </code>,
      );
    }
    last = re.lastIndex;
  }
  if (last < s.length) tokens.push(s.slice(last));
  return tokens;
}

// ---- Rich text editor ---------------------------------------------------

/**
 * True WYSIWYG editor for the Text widget.  Renders an editable DOM
 * region (contenteditable) so what the author sees IS what the
 * runtime will render.  Toolbar buttons call into the editor's own
 * formatting commands (bold, italic, inline code, h1/h2/h3, lists,
 * links) -- no markdown syntax ever appears in the editor surface.
 *
 * Storage stays as markdown so existing text widgets render
 * unchanged.  We serialize the contenteditable DOM to markdown on
 * every change (`htmlToMarkdown`) and deserialize back to HTML for
 * the initial paint (`markdownToHtml`).  Both helpers cover the
 * same MarkdownLite subset the runtime supports: paragraphs,
 * headings (h1/h2/h3), bold, italic, inline code, links, and
 * unordered lists.  Anything outside that subset is dropped on
 * the round-trip (eg pasted HTML tables collapse to paragraphs).
 *
 * Trade-off acknowledged: this uses `document.execCommand` for
 * formatting, which the spec marks deprecated but every browser
 * still implements.  It is the simplest contenteditable path that
 * doesn't bring in a full editor framework.  If we hit real
 * limitations (collaborative editing, nested formatting bugs,
 * advanced shortcuts), the followup is to swap in TipTap.
 */
function RichTextEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Track whether the current focused editor matches the props
  // value so external updates (eg widget switch, undo) re-sync the
  // DOM, but the user's in-flight typing isn't clobbered by every
  // round-trip serialization.
  //
  // Initialize to `null` (sentinel meaning "no value has been
  // committed yet") so the FIRST effect run always paints the
  // initial markdown into the contenteditable.  The earlier
  // `useRef(value)` initializer made the first comparison
  // `value === value` (always true), so the effect skipped the
  // innerHTML write -- the editor opened blank no matter what was
  // saved.  Reported as "text disappears on reload".
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value === lastEmittedRef.current) return;
    // External value changed (eg another widget selected, or
    // initial paint).  Replace DOM content without sending an
    // input event back.
    el.innerHTML = markdownToHtml(value);
    lastEmittedRef.current = value;
  }, [value]);

  function emit(): void {
    const el = editorRef.current;
    if (!el) return;
    const md = htmlToMarkdown(el);
    if (md !== lastEmittedRef.current) {
      lastEmittedRef.current = md;
      onChange(md);
    }
  }

  function exec(cmd: string, arg?: string): void {
    if (disabled) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    // execCommand is deprecated but still works in every browser.
    // Wrapped in a try/catch so older browsers that throw on
    // unsupported commands degrade quietly.
    try {
      document.execCommand(cmd, false, arg);
    } catch {
      /* ignore */
    }
    emit();
  }

  // Track the selection just before the user clicks a toolbar
  // control that takes focus away (the color input opens a native
  // picker which steals focus on some platforms).  We capture the
  // selection on pointerdown -- BEFORE the click commits and the
  // contenteditable loses focus to the input -- and re-apply it
  // when the picker fires onChange.
  const savedRangeRef = useRef<Range | null>(null);
  function rememberSelection(): void {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }

  /**
   * Apply a foreground color to the current selection.  Three-step
   * dance because the native `<input type="color">` opens an OS-level
   * picker that steals focus from the contenteditable, collapsing
   * the selection.  We must:
   *   (1) focus the editor BEFORE restoring the range, because
   *       `Selection.addRange` is silently ignored if the document
   *       has no active editable element;
   *   (2) restore the saved range AFTER focus, so the caret lands
   *       on the user's original selection rather than wherever
   *       focus defaulted (usually end of editor);
   *   (3) toggle styleWithCSS so foreColor emits
   *       `<span style="color:...">` (the markdown round-trip
   *       shape) rather than legacy `<font color="...">`.
   *
   * Earlier draft called focus() inside the helper but restored
   * the range OUTSIDE it (in the onChange handler) which meant
   * focus() was wiping the just-restored range before execCommand
   * ran.  Result: foreColor either no-op'd (no selection) or
   * colored the wrong text.  Now both steps happen here in order.
   */
  function applyColor(color: string): void {
    if (disabled) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const r = savedRangeRef.current;
    if (r) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    try {
      document.execCommand('styleWithCSS', false, 'true');
      document.execCommand('foreColor', false, color);
    } catch {
      /* ignore */
    }
    // Re-capture the (now color-applied) selection so a follow-up
    // color tweak from the same picker session lands on the same
    // text.  Otherwise the second drag-emit would target the
    // pre-color range that no longer maps cleanly to DOM nodes
    // (the foreColor execCommand inserted a span; the boundary
    // text nodes were split).
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
    emit();
  }

  function insertLink(): void {
    if (disabled) return;
    const url = window.prompt('Link URL', 'https://');
    if (!url) return;
    exec('createLink', url);
  }

  function clearFormat(): void {
    exec('removeFormat');
  }

  const btn =
    'inline-flex h-7 items-center justify-center rounded border border-border bg-surface-0 px-2 text-2xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50';

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('bold')}
          title="Bold"
          className={`${btn} font-bold`}
        >
          B
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('italic')}
          title="Italic"
          className={`${btn} italic`}
        >
          I
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            // execCommand has no 'code' verb; wrap selection in a
            // <code> element manually.  Same idea as a contenteditable
            // editor library's `toggleMark('code')`.
            const el = editorRef.current;
            if (!el) return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            if (range.collapsed) return;
            const code = document.createElement('code');
            try {
              range.surroundContents(code);
            } catch {
              /* ignore -- selection spans incompatible boundaries */
            }
            emit();
          }}
          title="Inline code"
          className={`${btn} font-mono`}
        >
          {'</>'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('formatBlock', 'h1')}
          title="Heading 1"
          className={btn}
        >
          H1
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('formatBlock', 'h2')}
          title="Heading 2"
          className={btn}
        >
          H2
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('formatBlock', 'h3')}
          title="Heading 3"
          className={btn}
        >
          H3
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('formatBlock', 'p')}
          title="Paragraph"
          className={btn}
        >
          ¶
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exec('insertUnorderedList')}
          title="Bulleted list"
          className={btn}
        >
          • List
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={insertLink}
          title="Insert link"
          className={btn}
        >
          🔗 Link
        </button>
        <label
          className={`${btn} cursor-pointer gap-1 ${disabled ? 'pointer-events-none' : ''}`}
          title="Text color"
          // Save the editor's current selection on pointerdown
          // (before the color input takes focus).  When the user
          // picks a color the change handler restores it.
          onPointerDown={rememberSelection}
        >
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-sm border border-border"
            style={{ background: 'linear-gradient(135deg,#ef4444 0%,#f59e0b 25%,#10b981 50%,#3b82f6 75%,#a855f7 100%)' }}
          />
          A
          <input
            type="color"
            disabled={disabled}
            // visually hidden but reachable -- the label proxies
            // the click so the user sees the swatch + A icon.
            // applyColor handles focus + selection restore itself
            // (the picker steals focus when it opens, so we have
            // to put the selection back BEFORE execCommand).
            className="sr-only"
            onChange={(e) => {
              applyColor(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            // Clear color without nuking other formatting (bold /
            // italic / etc.).  foreColor with 'inherit' undoes the
            // span by collapsing the inline style; the markdown
            // round-trip then drops the span on the next emit.
            applyColor('inherit');
          }}
          title="Clear text color"
          className={btn}
        >
          A↺
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={clearFormat}
          title="Clear all formatting"
          className={btn}
        >
          ✕
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        // Force pasted content to plain text so a copy from Word
        // doesn't smuggle in a font tag soup.  Bold + italic still
        // round-trip cleanly because the user re-applies them via
        // the toolbar after pasting.
        onPaste={(e) => {
          if (disabled) return;
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
        className="prose-sm min-h-[120px] w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm leading-snug text-ink-0 focus:border-accent focus:outline-none [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.95em] [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:ml-5 [&_ul]:list-disc [&_a]:text-accent [&_a]:underline"
      />
    </div>
  );
}

/**
 * Markdown -> HTML for the MarkdownLite subset.  Used to paint the
 * RichTextEditor's contenteditable surface from the persisted
 * markdown string.  Mirrors DesignerMarkdownLite + MarkdownLite
 * (runtime) so a round-trip preserves the same set of features.
 */
function markdownToHtml(md: string): string {
  if (!md) return '';
  const blocks = md.split(/\n\n+/);
  const parts: string[] = [];
  for (const block of blocks) {
    const t = block.trim();
    if (!t) continue;
    if (t.startsWith('### ')) {
      parts.push(`<h3>${inlineMdToHtml(t.slice(4))}</h3>`);
      continue;
    }
    if (t.startsWith('## ')) {
      parts.push(`<h2>${inlineMdToHtml(t.slice(3))}</h2>`);
      continue;
    }
    if (t.startsWith('# ')) {
      parts.push(`<h1>${inlineMdToHtml(t.slice(2))}</h1>`);
      continue;
    }
    const lines = t.split('\n');
    if (lines.every((l) => /^[-*]\s/.test(l))) {
      const items = lines.map((l) => `<li>${inlineMdToHtml(l.replace(/^[-*]\s/, ''))}</li>`).join('');
      parts.push(`<ul>${items}</ul>`);
      continue;
    }
    parts.push(`<p>${inlineMdToHtml(t).replace(/\n/g, '<br>')}</p>`);
  }
  return parts.join('');
}

function inlineMdToHtml(s: string): string {
  // Preserve color spans verbatim BEFORE the HTML escape pass so a
  // `<span style="color:#xxx">text</span>` written by the rich-text
  // editor's color picker survives the round-trip.  Each match is
  // stashed under a placeholder; we escape the rest, run markdown
  // transforms, then restore canonical spans.  Only the exact shape
  // (color style, no other attributes, no nested tags) survives --
  // arbitrary HTML never passes through.
  const colorSpans: string[] = [];
  const pre = s.replace(
    /<span style="color:\s*(#[0-9a-fA-F]{3,8})">([^<]+)<\/span>/g,
    (_m, color, text) => {
      const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const idx = colorSpans.length;
      colorSpans.push(`<span style="color: ${color}">${escaped}</span>`);
      return ` COLOR${idx} `;
    },
  );
  let out = pre
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const safeHref = String(href).replace(/"/g, '&quot;');
    return `<a href="${safeHref}">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/ COLOR(\d+) /g, (_m, idx) => {
    return colorSpans[Number(idx)] ?? '';
  });
  return out;
}

/**
 * HTML -> markdown for the MarkdownLite subset.  Walks the
 * contenteditable DOM and emits markdown for the blocks +
 * inline marks the renderer supports.  Anything outside that
 * subset (font tags from a Word paste, divs without a block tag,
 * etc.) is flattened to text to keep the storage clean.
 */
function htmlToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    const md = domNodeToMarkdownBlock(child);
    if (md != null) blocks.push(md);
  }
  return blocks.join('\n\n').trim();
}

function domNodeToMarkdownBlock(node: Node): string | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').trim();
    return t.length > 0 ? t : null;
  }
  if (!(node instanceof HTMLElement)) return null;
  const tag = node.tagName.toLowerCase();
  if (tag === 'h1') return `# ${inlineDomToMarkdown(node)}`;
  if (tag === 'h2') return `## ${inlineDomToMarkdown(node)}`;
  if (tag === 'h3') return `### ${inlineDomToMarkdown(node)}`;
  if (tag === 'ul') {
    const items: string[] = [];
    for (const li of Array.from(node.children)) {
      if (li.tagName.toLowerCase() === 'li') {
        items.push(`- ${inlineDomToMarkdown(li as HTMLElement)}`);
      }
    }
    return items.length > 0 ? items.join('\n') : null;
  }
  if (tag === 'ol') {
    // Renderer doesn't differentiate ordered/unordered; serialize
    // ordered lists as a `- ` list too so the round-trip preserves
    // the visual structure (the runtime won't render numbers).
    const items: string[] = [];
    for (const li of Array.from(node.children)) {
      if (li.tagName.toLowerCase() === 'li') {
        items.push(`- ${inlineDomToMarkdown(li as HTMLElement)}`);
      }
    }
    return items.length > 0 ? items.join('\n') : null;
  }
  if (tag === 'br') return null;
  // p, div, span, anything else: treat as a paragraph wrapper.
  const inner = inlineDomToMarkdown(node);
  return inner.length > 0 ? inner : null;
}

function inlineDomToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\n/g, ' ');
  }
  if (!(node instanceof HTMLElement)) return '';
  const tag = node.tagName.toLowerCase();
  const childrenMd = Array.from(node.childNodes)
    .map(inlineDomToMarkdown)
    .join('');
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${childrenMd}**`;
  if (tag === 'em' || tag === 'i') return `*${childrenMd}*`;
  if (tag === 'code') return `\`${childrenMd}\``;
  if (tag === 'a') {
    const href = node.getAttribute('href') ?? '';
    return `[${childrenMd}](${href})`;
  }
  if (tag === 'span' || tag === 'font') {
    // Color span: emit `<span style="color:#xxx">text</span>` so
    // the markdown renderer's color-span regex picks it up.
    // execCommand('foreColor', ...) emits either inline `style`
    // OR a `<font color="#xxx">` element depending on the browser,
    // so we look at both surfaces and normalize to the canonical
    // shape.  rgb()/rgba() values from the color input are
    // normalized to #RRGGBB so the regex matches.
    const styleColor = (node.style?.color ?? '').trim();
    const fontAttrColor = node.getAttribute('color') ?? '';
    const raw = styleColor || fontAttrColor;
    const hex = cssColorToHex(raw);
    if (hex) {
      return `<span style="color: ${hex}">${stripInnerHtmlMarkup(childrenMd)}</span>`;
    }
    return childrenMd;
  }
  // div / p / li / unknown: pass children through.
  return childrenMd;
}

/**
 * Normalize a CSS color (rgb, rgba, named, hex) into a `#rrggbb`
 * hex string the markdown round-trip regex understands.  Returns
 * null for "no color set" so callers can decide to emit a plain
 * pass-through.  Anything alpha-channel-aware is rounded to 6-digit
 * hex (color spans don't track alpha; the editor only exposes
 * solid colors).
 */
function cssColorToHex(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  const rgb = v.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[0-9.]+)?\s*\)$/,
  );
  if (rgb) {
    const toHex = (n: string) =>
      Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${toHex(rgb[1] ?? '0')}${toHex(rgb[2] ?? '0')}${toHex(rgb[3] ?? '0')}`;
  }
  // Named colors / unsupported syntax: skip rather than guess.
  return null;
}

/**
 * Color spans deliberately can't host nested markdown markup in
 * the v1 round-trip (the renderer's regex uses `[^<]+` so the
 * span contents must be plain text).  If a user manages to nest
 * other inline marks (eg by selecting partly-bold text and
 * applying color), we flatten the inner markdown back to text so
 * the storage stays parseable.  A future v2 can move to a real
 * recursive parser.
 */
function stripInnerHtmlMarkup(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

// ---- Tabs container canvas preview (#362) ---------------------------------

function TabsWidgetCanvas({
  widget,
  activeTabIdx,
  onSetActiveTabIdx,
}: {
  widget: CustomWidget;
  activeTabIdx: number;
  onSetActiveTabIdx: (idx: number) => void;
}) {
  if (widget.config.kind !== 'tabs') return null;
  const tabs = widget.config.tabs;
  const safeIdx = Math.min(activeTabIdx, tabs.length - 1);
  const active = tabs[safeIdx];
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-border bg-surface-1 px-2">
        {tabs.map((t, i) => {
          const isActive = i === safeIdx;
          return (
            <button
              key={t.id}
              type="button"
              // Don't stopPropagation: the click bubbles to the
              // parent WidgetCard so the tabs widget also gets
              // selected, putting tab management in the right rail
              // alongside the active-tab switch.
              onClick={() => onSetActiveTabIdx(i)}
              className={`relative px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? 'text-ink-0'
                  : 'text-muted hover:text-ink-1'
              }`}
            >
              {t.title}
              {isActive && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-ink-0"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 overflow-auto bg-surface-2/30 p-2">
        {active && active.widgets.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-1/60 p-4 text-center">
            <p className="text-xs font-medium text-ink-0">{active.title}</p>
            <p className="text-2xs text-muted">
              Drag a widget here to add it to this tab.
            </p>
          </div>
        ) : (
          active &&
          active.widgets.map((c) => <NestedWidgetPreview key={c.id} widget={c} />)
        )}
      </div>
    </div>
  );
}

/**
 * Compact preview card for a widget nested inside a Tabs container.
 * Doesn't drag / resize / select -- the parent Tabs widget is the
 * canvas-level interactive unit. Click-through is suppressed so the
 * preview cards behave like inert thumbnails.
 */
function NestedWidgetPreview({ widget }: { widget: CustomWidget }) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  const label = tile?.label ?? widget.kind;
  const summary = summarizeWidget(widget);
  // Min-height proportional to the widget's intended row span so a
  // Map widget feels different from a Coordinates widget at a glance.
  const minHeight = Math.max(36, widget.layout.rowSpan * 24);
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs"
      style={{ minHeight }}
    >
      <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
      <span className="font-medium text-ink-1">{label}</span>
      {summary && (
        <span className="ml-auto truncate text-muted" title={summary}>
          {summary}
        </span>
      )}
    </div>
  );
}

// ---- Tabs container config (#362) -----------------------------------------

function TabsWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'tabs'; tabs: Array<{ id: string; title: string; widgets: CustomWidget[] }> };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const confirm = useConfirm();
  function update(idx: number, patch: Partial<(typeof config.tabs)[number]>) {
    const next = config.tabs.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    onChangeConfig({ tabs: next });
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= config.tabs.length) return;
    const next = config.tabs.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(j, 0, moved!);
    onChangeConfig({ tabs: next });
  }
  async function remove(idx: number) {
    if (config.tabs.length <= 1) return; // always one tab minimum
    const tab = config.tabs[idx]!;
    if (tab.widgets.length > 0) {
      const ok = await confirm({
        title: 'Delete tab?',
        message: `Delete tab "${tab.title}" and its ${tab.widgets.length} widget${tab.widgets.length === 1 ? '' : 's'}?`,
        variant: 'danger',
        confirmLabel: 'Delete tab',
      });
      if (!ok) return;
    }
    onChangeConfig({ tabs: config.tabs.filter((_, i) => i !== idx) });
  }
  function add() {
    onChangeConfig({
      tabs: [
        ...config.tabs,
        {
          id: `tab_${Math.random().toString(36).slice(2, 8)}`,
          title: `Tab ${config.tabs.length + 1}`,
          widgets: [],
        },
      ],
    });
  }
  return (
    <div className="space-y-3">
      <Field label="Tabs" hint="Each tab holds its own widgets. Drop widgets onto a tab while it's active in the canvas.">
        <div className="space-y-1.5">
          {config.tabs.map((t, i) => (
            <div
              key={t.id}
              className="flex items-center gap-1 rounded-md border border-border bg-surface-1 p-1"
            >
              <input
                type="text"
                value={t.title}
                disabled={!canEdit}
                onChange={(e) => update(i, { title: e.target.value })}
                className="flex-1 rounded border-0 bg-transparent px-1 text-sm focus:outline-none"
              />
              <span className="text-2xs text-muted">
                {t.widgets.length}w
              </span>
              <button
                type="button"
                title="Move up"
                disabled={!canEdit || i === 0}
                onClick={() => move(i, -1)}
                className="rounded p-1 text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5 rotate-90" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                title="Move down"
                disabled={!canEdit || i === config.tabs.length - 1}
                onClick={() => move(i, 1)}
                className="rounded p-1 text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5 -rotate-90" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                title="Delete tab"
                disabled={!canEdit || config.tabs.length === 1}
                onClick={() => remove(i)}
                className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={add}
              className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs font-medium text-muted hover:border-accent/40 hover:text-ink-1"
            >
              <Plus className="h-3 w-3" strokeWidth={1.75} />
              Add tab
            </button>
          )}
        </div>
      </Field>
      <p className="text-xs leading-snug text-muted">
        To add widgets to a tab: click the tab in the canvas to make
        it active, then drag a widget from the left palette onto the
        tab content area.
      </p>
    </div>
  );
}

// ---- Tool mode + panel arrangement editor (#364) ---------------------------

const ANCHOR_GRID: PanelAnchor[][] = [
  ['top-left', 'top-center', 'top-right'],
  ['middle-left', 'middle-center', 'middle-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
];

const ANCHOR_LABELS: Record<PanelAnchor, string> = {
  'top-left': 'Top left',
  'top-center': 'Top center',
  'top-right': 'Top right',
  'middle-left': 'Left',
  'middle-center': 'Center',
  'middle-right': 'Right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom center',
  'bottom-right': 'Bottom right',
};

/**
 * Properties section that authors use to flip a tool-supporting
 * widget between panel and tool modes, then dial in the popover
 * size and placement when in tool mode. Mirrors EB's Widget
 * Controller properties (anchor grid + W/H + offsets + floating-vs-
 * fixed + animation) but applied per-widget for full flexibility.
 */
function ToolModeSection({
  config,
  canEdit,
  defaultLabel,
  onChangeConfig,
}: {
  config: {
    displayMode?: 'panel' | 'tool';
    panelArrangement?: PanelArrangement;
  };
  canEdit: boolean;
  /**
   * Built-in label for this widget kind (Search, Basemaps,
   * Attribute Table, etc.).  Used as the placeholder for the
   * Caption input so the author can see what the default would
   * have read.
   */
  defaultLabel: string;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const mode = config.displayMode ?? 'panel';
  const pa = config.panelArrangement ?? {};
  const placement = pa.placement ?? 'floating';
  const anchor = pa.anchor ?? 'top-right';
  const animation = pa.animation ?? 'fade';

  function patchArrangement(p: Partial<PanelArrangement>) {
    onChangeConfig({ panelArrangement: { ...pa, ...p } });
  }

  return (
    <div className="space-y-3">
      <div className="-mx-4 border-t border-border" />
      <p className="text-sm font-medium text-ink-0">Display mode</p>
      <div className="flex rounded-md border border-border bg-surface-1 p-0.5">
        {(['panel', 'tool'] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={!canEdit}
            onClick={() => onChangeConfig({ displayMode: m })}
            aria-pressed={mode === m}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
              mode === m
                ? 'bg-surface-2 text-ink-0'
                : 'text-muted hover:text-ink-1'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {m === 'panel' ? 'Panel' : 'Tool icon'}
          </button>
        ))}
      </div>
      <p className="text-xs leading-snug text-muted">
        {mode === 'panel'
          ? 'Widget is always-visible inline on the canvas.'
          : 'Widget renders as a small icon button. Click to open the popover panel below.'}
      </p>

      {mode === 'tool' && (
        <>
          <p className="pt-1 text-sm font-medium text-ink-0">Tool button</p>
          <Field
            label="Caption"
            hint="Override the default label (Search, Basemaps, Attribute Table, etc.) with custom text. Leave blank to use the default."
          >
            <input
              type="text"
              value={pa.labelOverride ?? ''}
              disabled={!canEdit}
              placeholder={defaultLabel}
              onChange={(e) => {
                // exactOptionalPropertyTypes: "unset" the override
                // when the input is empty, otherwise set the string.
                const patch: Partial<PanelArrangement> =
                  e.target.value.length > 0
                    ? { labelOverride: e.target.value }
                    : ({ labelOverride: undefined } as unknown as Partial<PanelArrangement>);
                patchArrangement(patch);
              }}
              className="h-9 w-full rounded-md border border-border bg-surface-0 px-2 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="Display">
            <div className="flex rounded-md border border-border bg-surface-1 p-0.5">
              {(
                [
                  ['icon-and-label', 'Icon + label'],
                  ['icon-only', 'Icon only'],
                ] as const
              ).map(([m, lbl]) => {
                const active = (pa.labelMode ?? 'icon-and-label') === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => patchArrangement({ labelMode: m })}
                    aria-pressed={active}
                    className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                      active
                        ? 'bg-surface-2 text-ink-0'
                        : 'text-muted hover:text-ink-1'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>
            <p className="text-xs leading-snug text-muted">
              {(pa.labelMode ?? 'icon-and-label') === 'icon-and-label'
                ? 'Icon plus a small caption below.'
                : 'Just the icon. Title hover + screen-reader label preserved.'}
            </p>
          </Field>

          <p className="pt-1 text-sm font-medium text-ink-0">
            Panel arrangement
          </p>

          <Field label="Placement">
            <div className="flex rounded-md border border-border bg-surface-1 p-0.5">
              {(
                [
                  ['floating', 'Floating'],
                  ['fixed', 'Fixed'],
                  ['docked-bottom', 'Docked'],
                ] as const
              ).map(([p, lbl]) => (
                <button
                  key={p}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => patchArrangement({ placement: p })}
                  aria-pressed={placement === p}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                    placement === p
                      ? 'bg-surface-2 text-ink-0'
                      : 'text-muted hover:text-ink-1'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <p className="text-xs leading-snug text-muted">
              {placement === 'floating'
                ? 'Floats over the runtime container. Scrolls with the page.'
                : placement === 'fixed'
                  ? 'Pinned to the browser viewport. Stays put on scroll.'
                  : 'Full-width strip docked along the bottom of the runtime, with a collapse handle. Width / anchor / offsets are ignored in this mode.'}
            </p>
          </Field>

          {placement === 'docked-bottom' ? (
            // Docked mode: only height matters. Anchor / width /
            // offsets are ignored because the panel always spans
            // the full width along the bottom edge.
            <Field label="Height (px)">
              <NumberInput
                value={pa.height ?? 280}
                min={120}
                max={800}
                disabled={!canEdit}
                onChange={(v) => patchArrangement({ height: v })}
              />
            </Field>
          ) : (
            <>
              <Field label="Anchor" hint="Where the popover docks within the runtime container.">
                <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-surface-2 p-1.5">
                  {ANCHOR_GRID.flat().map((a) => (
                    <button
                      key={a}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => patchArrangement({ anchor: a })}
                      aria-pressed={anchor === a}
                      title={ANCHOR_LABELS[a]}
                      className={`flex h-7 w-full items-center justify-center rounded transition-colors ${
                        anchor === a
                          ? 'bg-ink-0 text-surface-1'
                          : 'bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    </button>
                  ))}
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Width (px)">
                  <NumberInput
                    value={pa.width ?? 360}
                    min={120}
                    max={1200}
                    disabled={!canEdit}
                    onChange={(v) => patchArrangement({ width: v })}
                  />
                </Field>
                <Field label="Height (px)">
                  <NumberInput
                    value={pa.height ?? 480}
                    min={64}
                    max={1200}
                    disabled={!canEdit}
                    onChange={(v) => patchArrangement({ height: v })}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Offset X (px)">
                  <NumberInput
                    value={pa.offsetX ?? 0}
                    min={-400}
                    max={400}
                    disabled={!canEdit}
                    onChange={(v) => patchArrangement({ offsetX: v })}
                  />
                </Field>
                <Field label="Offset Y (px)">
                  <NumberInput
                    value={pa.offsetY ?? 0}
                    min={-400}
                    max={400}
                    disabled={!canEdit}
                    onChange={(v) => patchArrangement({ offsetY: v })}
                  />
                </Field>
              </div>
            </>
          )}

          <Field label="Animation">
            <select
              value={animation}
              disabled={!canEdit}
              onChange={(e) => {
                const next = e.target.value as PanelArrangement['animation'];
                if (next) patchArrangement({ animation: next });
              }}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
            >
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="slide">Slide</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}


/**
 * #92 generic container editor.  The container is a PURE layout
 * region: it exposes only chrome props (position, layout, variant,
 * collapsible, fixed dimensions, overlay-trigger affordances) and
 * lets the author drag widgets into the canvas body to fill it.
 * There are no Title / Subtitle / Logo URL slots -- the author can
 * drop a Text or Image widget inside if they want a header.
 */
function ContainerConfigEditor({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: {
    kind: 'container';
    position?:
      | 'inline'
      | 'sticky-top'
      | 'sticky-bottom'
      | 'dock-left'
      | 'dock-right'
      | 'overlay-trigger'
      | 'menu';
    edge?: 'left' | 'right' | 'top' | 'bottom';
    layout?: 'row' | 'column';
    variant?: 'elevated' | 'glass' | 'flat' | 'none';
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    widthPx?: number;
    heightPx?: number;
    triggerLabel?: string;
    triggerIcon?: 'menu' | 'layers' | 'tools' | 'filter';
    widgets: CustomWidget[];
  };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const position = config.position ?? 'inline';
  const isDock = position === 'dock-left' || position === 'dock-right';
  const isOverlay = position === 'overlay-trigger';
  const isSticky =
    position === 'sticky-top' || position === 'sticky-bottom';
  return (
    <div className="space-y-3">
      <Field
        label="Position"
        hint="Where the container sits on the page.  Pure layout choice; the author composes the content inside."
      >
        <select
          value={position}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ position: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="inline">Inline (in page grid)</option>
          <option value="sticky-top">Sticky top bar</option>
          <option value="sticky-bottom">Sticky bottom bar</option>
          <option value="dock-left">Docked left</option>
          <option value="dock-right">Docked right</option>
          <option value="overlay-trigger">Overlay drawer (trigger button)</option>
          <option value="menu">Menu stack (icon with dropdown)</option>
        </select>
      </Field>
      <Field
        label="Layout"
        hint="How children flow inside the container body."
      >
        <select
          value={
            config.layout ?? (isSticky ? 'row' : 'column')
          }
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ layout: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="row">Row (horizontal)</option>
          <option value="column">Column (vertical)</option>
        </select>
      </Field>
      <Field label="Variant" hint="Visual chrome surface.">
        <select
          value={config.variant ?? (position === 'inline' ? 'flat' : 'elevated')}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ variant: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="elevated">Elevated (branded header)</option>
          <option value="glass">Glass (translucent)</option>
          <option value="flat">Flat (surface-1)</option>
          <option value="none">None (transparent)</option>
        </select>
      </Field>
      {isDock ? (
        <>
          <Field label="Width (px)">
            <NumberInput
              value={config.widthPx ?? 280}
              min={120}
              max={640}
              disabled={!canEdit}
              onChange={(widthPx) => onChangeConfig({ widthPx })}
            />
          </Field>
          <Field label="Collapsible">
            <label className="flex items-center gap-2 text-xs text-ink-1">
              <input
                type="checkbox"
                checked={config.collapsible !== false}
                disabled={!canEdit}
                onChange={(e) =>
                  onChangeConfig({ collapsible: e.target.checked })
                }
              />
              Show collapse handle
            </label>
          </Field>
          <Field label="Default collapsed">
            <label className="flex items-center gap-2 text-xs text-ink-1">
              <input
                type="checkbox"
                checked={config.defaultCollapsed === true}
                disabled={!canEdit}
                onChange={(e) =>
                  onChangeConfig({ defaultCollapsed: e.target.checked })
                }
              />
              Start collapsed
            </label>
          </Field>
        </>
      ) : null}
      {isOverlay ? (
        <>
          <Field label="Edge">
            <select
              value={config.edge ?? 'left'}
              disabled={!canEdit}
              onChange={(e) => onChangeConfig({ edge: e.target.value })}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </Field>
          <Field
            label={
              config.edge === 'top' || config.edge === 'bottom'
                ? 'Height (px)'
                : 'Width (px)'
            }
          >
            <NumberInput
              value={
                config.edge === 'top' || config.edge === 'bottom'
                  ? config.heightPx ?? 320
                  : config.widthPx ?? 320
              }
              min={120}
              max={800}
              disabled={!canEdit}
              onChange={(n) =>
                onChangeConfig(
                  config.edge === 'top' || config.edge === 'bottom'
                    ? { heightPx: n }
                    : { widthPx: n },
                )
              }
            />
          </Field>
          <Field label="Trigger label">
            <input
              type="text"
              value={config.triggerLabel ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({ triggerLabel: e.target.value })
              }
              placeholder="Tools"
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </Field>
          <Field label="Trigger icon">
            <select
              value={config.triggerIcon ?? 'tools'}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({ triggerIcon: e.target.value })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="tools">Tools (wrench)</option>
              <option value="layers">Layers</option>
              <option value="filter">Filter</option>
              <option value="menu">Menu</option>
            </select>
          </Field>
        </>
      ) : null}
      {!isDock && !isOverlay ? (
        <Field
          label="Collapsible"
          hint="Adds a chevron handle that hides the container body."
        >
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              checked={config.collapsible === true}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({ collapsible: e.target.checked })
              }
            />
            Show collapse handle
          </label>
        </Field>
      ) : null}
    </div>
  );
}

function MapBindingPicker({
  mapWidgetId,
  mapWidgets,
  canEdit,
  onChange,
  extra,
}: {
  mapWidgetId: string;
  mapWidgets: CustomWidget[];
  canEdit: boolean;
  onChange: (next: string) => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Bound map"
        hint={
          mapWidgets.length === 0
            ? 'Drop a Map widget on the page first.'
            : 'The Map widget this control operates on.'
        }
      >
        <select
          value={mapWidgetId}
          disabled={!canEdit || mapWidgets.length === 0}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="">
            {mapWidgets.length === 0 ? '(no map widgets)' : 'Pick a map…'}
          </option>
          {mapWidgets.map((m) => (
            <option key={m.id} value={m.id}>
              Map · {m.id.slice(2, 10)}
            </option>
          ))}
        </select>
      </Field>
      {extra}
    </div>
  );
}

// ---- Generic field + number input -----------------------------------------

/**
 * Set or clear one header field without ever writing `undefined` as a
 * value. The workspace runs exactOptionalPropertyTypes, and a
 * persisted `"title": null` would also mean "titled null" rather than
 * "no title" to every later reader.
 */
function patchHeader(
  header: CustomAppData['header'],
  key: 'title' | 'subtitle',
  raw: string,
): NonNullable<CustomAppData['header']> {
  const next: NonNullable<CustomAppData['header']> = { ...(header ?? {}) };
  const value = raw.trim();
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

/**
 * Resolve the app's targets into the shape the runtime renderers
 * expect, so the canvas can draw real widgets instead of placeholder
 * boxes.
 *
 * This mirrors what the runtime's server entry builds (see
 * custom/run/page.tsx), from the browser and with the same defaults,
 * because the designer has no server pass to do it in. Targets that
 * point at a deleted or unreadable layer are dropped, exactly as the
 * runtime drops them, so the canvas shows the same empty state the
 * published app would.
 */
function useResolvedTargets(sources: AppDataSource[]): ResolvedTargetLite[] {
  const [resolved, setResolved] = useState<ResolvedTargetLite[]>([]);
  // Sources is a fresh array identity on every keystroke in the
  // inspector; key the effect on the identity that actually matters.
  const key = sources
    .map((src) => `${src.id}:${src.layer.dataLayerId}:${src.layer.layerKey}`)
    .join('|');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: ResolvedTargetLite[] = [];
      for (const src of sources) {
        const t = src.layer;
        try {
          const res = await fetch(`/api/portal/items/${t.dataLayerId}`);
          if (!res.ok) continue;
          const item = (await res.json()) as {
            title?: string;
            data?: {
              version?: number;
              layers?: Array<{ id?: string; label?: string; geometryType?: string | null }>;
            };
          };
          if (item.data?.version !== 3) continue;
          const sub = item.data.layers?.find((l) => l.id === t.layerKey);
          if (!sub) continue;
          const title = `${item.title ?? 'Layer'} / ${sub.label ?? t.layerKey}`;
          out.push({
            sourceId: src.id,
            dataLayerId: t.dataLayerId,
            layerKey: t.layerKey,
            title: src.label?.trim() || title,
            mapLayer: {
              id: customTargetLayerId(t),
              title,
              visible: true,
              opacity: 1,
              source: {
                kind: 'geojson-url',
                url: `/api/portal/items/${t.dataLayerId}/layers/${t.layerKey}/geojson`,
              },
              style: DEFAULT_LAYER_STYLE,
              renderer: DEFAULT_LAYER_RENDERER,
              popup: DEFAULT_LAYER_POPUP,
              interactions: DEFAULT_LAYER_INTERACTIONS,
              labels: DEFAULT_LAYER_LABELS,
              search: DEFAULT_LAYER_SEARCH,
              filter: null,
              scale: DEFAULT_LAYER_SCALE,
              access: DEFAULT_LAYER_ACCESS,
            } as MapLayer,
          });
        } catch {
          // A target that cannot be read is simply absent from the
          // canvas, which is what the runtime does too.
        }
      }
      if (!cancelled) setResolved(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return resolved;
}

/**
 * Field names for one app target, read from the data_layer item's
 * schema.
 *
 * The chart and indicator editors both need a real field picker: the
 * aggregate endpoint refuses names that are not on the layer (so a
 * typo produces an error rather than a confident zero), which is the
 * right server behaviour but a poor authoring experience if the
 * author is typing blind. Cached per target for the life of the
 * inspector; layer schemas change on the order of never.
 */
function useTargetFields(target: ViewerTarget | undefined): {
  fields: Array<{ name: string; type?: string }>;
  loading: boolean;
} {
  const [state, setState] = useState<{
    fields: Array<{ name: string; type?: string }>;
    loading: boolean;
  }>({ fields: [], loading: false });
  const dataLayerId = target?.dataLayerId;
  const layerKey = target?.layerKey;
  useEffect(() => {
    if (!dataLayerId || !layerKey) {
      setState({ fields: [], loading: false });
      return;
    }
    let cancelled = false;
    setState({ fields: [], loading: true });
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${dataLayerId}`);
        if (!res.ok) throw new Error('lookup failed');
        const item = (await res.json()) as {
          data?: {
            layers?: Array<{
              id?: string;
              fields?: Array<{ name?: string; type?: string }>;
            }>;
          };
        };
        const layer = item.data?.layers?.find((l) => l.id === layerKey);
        const fields = (layer?.fields ?? [])
          .filter((f): f is { name: string; type?: string } =>
            typeof f.name === 'string' && f.name.length > 0)
          .map((f) => ({
            name: f.name,
            ...(f.type ? { type: f.type } : {}),
          }));
        if (!cancelled) setState({ fields, loading: false });
      } catch {
        // A failed lookup leaves the picker empty rather than
        // blocking the inspector; the author can still switch
        // targets and the server validates on save either way.
        if (!cancelled) setState({ fields: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataLayerId, layerKey]);
  return state;
}

/** Field names that can carry a numeric aggregate. Layers imported
 *  from spreadsheets often type everything as text, so an unknown
 *  type stays offered rather than hidden; the server answers NULL
 *  for a genuinely non-numeric column. */
function numericCandidates(
  fields: Array<{ name: string; type?: string }>,
): Array<{ name: string; type?: string }> {
  return fields.filter(
    (f) =>
      !f.type ||
      ['integer', 'int', 'number', 'double', 'float', 'numeric', 'real', 'bigint'].includes(
        f.type.toLowerCase(),
      ),
  );
}

/** Shared target <select>; both editors bind one layer. */
function TargetSelect({
  value,
  appTargets,
  canEdit,
  onChange,
}: {
  value: number;
  appTargets: AppDataSource[];
  canEdit: boolean;
  onChange: (index: number) => void;
}) {
  // Resolve the layers' real names. The list used to read
  // "#0 4d029569 / bridges", which asks an author to recognise a
  // layer by eight characters of its item's UUID; nobody can, and it
  // is the kind of database detail the UI is supposed to keep to
  // itself.
  const resolved = useResolvedTargets(appTargets);
  return (
    <Field
      label="Layer"
      hint={
        appTargets.length === 0
          ? 'This app has no layers yet. Add one from the Map widget.'
          : 'The layer this widget summarizes.'
      }
    >
      <select
        value={value}
        disabled={!canEdit || appTargets.length === 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
      >
        {appTargets.length === 0 ? (
          <option value={0}>(no layers)</option>
        ) : (
          appTargets.map((src, i) => (
            <option key={src.id} value={i}>
              {src.label?.trim() ||
                resolved.find((r) => r.sourceId === src.id)?.title ||
                src.layer.layerKey}
            </option>
          ))
        )}
      </select>
    </Field>
  );
}

const AGGREGATE_OPTIONS = [
  { value: 'count', label: 'Count of records' },
  // Counts distinct values, not records. On monitoring data the two
  // answer different questions: 1,480 acidic samples could be one
  // creek measured monthly for a decade, while 392 acidic sites is a
  // map.
  { value: 'countDistinct', label: 'Count of distinct values in a field' },
  { value: 'sum', label: 'Sum of a field' },
  { value: 'avg', label: 'Average of a field' },
  { value: 'min', label: 'Smallest value' },
  { value: 'max', label: 'Largest value' },
] as const;

/**
 * Which aggregates need a field, and what to call it.
 *
 * `count` needs none. `countDistinct` needs one but it need not be
 * numeric: the thing being counted is as likely to be a site name as
 * a measurement. The rest need a number.
 */
function measureFieldLabel(op: string): { label: string; hint: string } | null {
  if (op === 'count') return null;
  if (op === 'countDistinct') {
    return {
      label: 'Field to count distinct values of',
      hint: 'Any field. A site id or name counts places; a category counts kinds.',
    };
  }
  return {
    label: 'Number field',
    hint: 'The field to measure. Text values are ignored.',
  };
}

/**
 * Distribution controls (#27).
 *
 * Binning is a second, alternative category axis, so it sits under
 * "Group by" and says plainly that turning it on replaces it. An
 * author who set both would otherwise get an error from the server,
 * which is a worse way to learn that the two mean the same slot.
 *
 * Only numeric fields are offered. Binning a text column produces one
 * bucket holding everything, which looks like a broken chart rather
 * than like the wrong field.
 */
function ChartBinEditor({
  config,
  canEdit,
  fields,
  onChangeConfig,
}: {
  config: Extract<CustomWidget['config'], { kind: 'chart' }>;
  canEdit: boolean;
  fields: Array<{ name: string }>;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const bin = config.bin;
  const mode = bin?.mode ?? 'count';
  return (
    <div className="rounded-md border border-border p-2">
      <Field
        label="Distribution (bin a number)"
        hint={
          fields.length === 0
            ? 'This layer has no numeric fields to bin.'
            : 'Groups a measurement into ranges so the chart shows its shape. Replaces Group by.'
        }
      >
        <select
          value={bin?.field ?? ''}
          disabled={!canEdit || fields.length === 0}
          onChange={(e) => {
            const field = e.target.value;
            if (!field) {
              onChangeConfig({ bin: undefined });
              return;
            }
            // Binning owns the category axis. Clearing groupBy here
            // rather than letting the request fail keeps the two from
            // ever being set at once.
            onChangeConfig({
              bin: { field, mode: 'count', count: 20 },
              groupBy: undefined,
            });
          }}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="">(off, group by a category instead)</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      {bin ? (
        <div className="mt-2 space-y-2">
          <Field label="Ranges">
            <select
              value={mode}
              disabled={!canEdit}
              onChange={(e) => {
                const next = e.target.value;
                if (next === 'count') {
                  onChangeConfig({
                    bin: { field: bin.field, mode: 'count', count: 20 },
                  });
                } else if (next === 'width') {
                  onChangeConfig({
                    bin: { field: bin.field, mode: 'width', width: 1 },
                  });
                } else {
                  onChangeConfig({
                    bin: { field: bin.field, mode: 'edges', edges: [1, 5, 10] },
                  });
                }
              }}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="count">A number of equal ranges</option>
              <option value="width">A fixed range size</option>
              <option value="edges">Ranges I choose</option>
            </select>
          </Field>
          {bin.mode === 'count' ? (
            <Field
              label="How many ranges"
              hint="The portal measures the field and splits its range evenly."
            >
              <input
                type="number"
                min={2}
                max={200}
                value={bin.count}
                disabled={!canEdit}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  onChangeConfig({
                    bin: {
                      field: bin.field,
                      mode: 'count',
                      count: Math.min(200, Math.max(2, Math.round(n))),
                    },
                  });
                }}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
              />
            </Field>
          ) : bin.mode === 'width' ? (
            <Field
              label="Range size"
              hint="In the field's own units, e.g. 0.5 for half a milligram per litre."
            >
              <input
                type="number"
                min={0}
                step="any"
                value={bin.width}
                disabled={!canEdit}
                onChange={(e) => {
                  const w = Number(e.target.value);
                  if (!Number.isFinite(w) || w <= 0) return;
                  onChangeConfig({
                    bin: { field: bin.field, mode: 'width', width: w },
                  });
                }}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
              />
            </Field>
          ) : (
            <Field
              label="Range edges"
              hint="Ascending, comma separated. Use the same numbers as your map's classes and the chart will cut where the legend does."
            >
              <input
                type="text"
                defaultValue={bin.edges.join(', ')}
                disabled={!canEdit}
                onBlur={(e) => {
                  const edges = e.target.value
                    .split(',')
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isFinite(n));
                  // Ascending and de-duplicated, because the server
                  // refuses anything else and an author typing a list
                  // out of order should get a working chart, not an
                  // error about thresholds.
                  const sorted = [...new Set(edges)].sort((a, b) => a - b);
                  if (sorted.length === 0) return;
                  onChangeConfig({
                    bin: { field: bin.field, mode: 'edges', edges: sorted },
                  });
                }}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                placeholder="0.3, 1, 5, 10"
              />
            </Field>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Reference-line editor (#27).
 *
 * A limit line is how a reader interprets a measurement chart: the
 * series only means something against the standard it is compared to.
 * The label is deliberately free text rather than a generated
 * "Reference 0.3", because what matters is whose limit it is.
 */
function ChartReferenceLinesEditor({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: Extract<CustomWidget['config'], { kind: 'chart' }>;
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const lines = config.referenceLines ?? [];
  const update = (next: ChartReferenceLine[]): void => {
    onChangeConfig({ referenceLines: next.length > 0 ? next : undefined });
  };
  if (config.chartType === 'pie') return null;
  return (
    <div className="rounded-md border border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-1">Reference lines</p>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() =>
            update([...lines, { value: 0, label: '', axis: 'value' }])
          }
          className="rounded border border-border px-1.5 py-0.5 text-2xs hover:bg-surface-2 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {lines.length === 0 ? (
        <p className="text-2xs text-muted">
          Draw a limit, target, or threshold across the chart so a
          reader can see at a glance which values clear it.
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line, i) => (
            <li key={i} className="space-y-1 rounded border border-border/60 p-1.5">
              <div className="flex gap-1">
                <input
                  type="number"
                  step="any"
                  value={line.value}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    update(
                      lines.map((l, j) => (j === i ? { ...l, value: v } : l)),
                    );
                  }}
                  className="w-20 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                  placeholder="0.3"
                />
                <input
                  type="text"
                  value={line.label ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const text = e.target.value;
                    update(
                      lines.map((l, j) => {
                        if (j !== i) return l;
                        // Under exactOptionalPropertyTypes an absent
                        // `label` and a `label: undefined` are
                        // different types, so an empty box has to
                        // DELETE the key rather than blank it.
                        const { label: _drop, ...rest } = l;
                        return text ? { ...rest, label: text } : rest;
                      }),
                    );
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                  placeholder="EPA limit"
                />
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => update(lines.filter((_, j) => j !== i))}
                  className="rounded border border-border px-1.5 text-2xs hover:bg-surface-2 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              {config.bin ? (
                <select
                  value={line.axis ?? 'value'}
                  disabled={!canEdit}
                  onChange={(e) =>
                    update(
                      lines.map((l, j) =>
                        j === i
                          ? { ...l, axis: e.target.value as 'value' | 'category' }
                          : l,
                      ),
                    )
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-2xs"
                >
                  <option value="value">Across the measure axis</option>
                  <option value="category">
                    At this point along the ranges
                  </option>
                </select>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Chart inspector. Replaces the "ships after the runtime" placeholder
 * that shipped with the chart widget: without a group-by picker the
 * widget could only ever render one bar, which is why no dashboard
 * could be built out of it.
 */
function ChartWidgetConfigEditor({
  config,
  canEdit,
  appTargets,
  mapWidgets,
  onChangeConfig,
}: {
  config: Extract<CustomWidget['config'], { kind: 'chart' }>;
  canEdit: boolean;
  appTargets: AppDataSource[];
  mapWidgets: CustomWidget[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const target = appTargets.find((src) =>
    config.sourceId !== undefined
      ? src.id === config.sourceId
      : appTargets.indexOf(src) === config.targetIndex,
  )?.layer;
  const { fields, loading } = useTargetFields(target);
  const aggregate = config.aggregate ?? 'count';
  const numeric = numericCandidates(fields);
  return (
    <div className="space-y-3">
      <Field
        label="Title"
        hint="Leave blank to describe the query automatically, e.g. 'Count by Status'."
      >
        <input
          type="text"
          value={config.title ?? ''}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({ title: e.target.value || undefined })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          placeholder="Bridges by condition"
        />
      </Field>
      <Field label="Description" hint="Optional note under the title.">
        <input
          type="text"
          value={config.description ?? ''}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({ description: e.target.value || undefined })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          placeholder="Excludes bridges with no rating"
        />
      </Field>
      <TargetSelect
        value={config.targetIndex}
        appTargets={appTargets}
        canEdit={canEdit}
        onChange={(i) => onChangeConfig({ targetIndex: i })}
      />
      <Field label="Chart type">
        <select
          value={config.chartType}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ chartType: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="bar">Bar (vertical)</option>
          <option value="bar-horizontal">Bar (horizontal)</option>
          <option value="line">Line</option>
          <option value="pie">Pie</option>
        </select>
      </Field>
      <Field
        label="Group by"
        hint={
          loading
            ? 'Reading the layer schema…'
            : fields.length === 0
              ? 'Bind a target layer to choose a field.'
              : config.bin
                ? `Turned off: the chart is binning ${config.bin.field} into ranges instead.`
                : 'One bar or slice per distinct value of this field.'
        }
      >
        <select
          value={config.bin ? '' : (config.groupBy ?? '')}
          disabled={!canEdit || fields.length === 0 || Boolean(config.bin)}
          onChange={(e) =>
            onChangeConfig({ groupBy: e.target.value || undefined })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs disabled:opacity-60"
        >
          <option value="">(everything in one group)</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Measure">
        <select
          value={aggregate}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({
              aggregate: e.target.value,
              // Switching back to count drops the field so the saved
              // config never carries a measure it does not use.
              ...(e.target.value === 'count' ? { valueField: undefined } : {}),
            })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          {AGGREGATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {measureFieldLabel(aggregate) ? (
        <Field
          label={measureFieldLabel(aggregate)!.label}
          hint={measureFieldLabel(aggregate)!.hint}
        >
          <select
            value={config.valueField ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChangeConfig({ valueField: e.target.value || undefined })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          >
            <option value="">(pick a field)</option>
            {(aggregate === 'countDistinct' ? fields : numeric).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {config.chartType !== 'pie' ? (
        <ChartBinEditor
          config={config}
          canEdit={canEdit}
          fields={numeric}
          onChangeConfig={onChangeConfig}
        />
      ) : null}
      <ChartReferenceLinesEditor
        config={config}
        canEdit={canEdit}
        onChangeConfig={onChangeConfig}
      />
      {config.chartType !== 'pie' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Category axis" hint="Blank uses the group-by field.">
            <input
              type="text"
              value={config.xAxisLabel ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({ xAxisLabel: e.target.value || undefined })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </Field>
          <Field label="Value axis" hint="Blank uses the measure.">
            <input
              type="text"
              value={config.yAxisLabel ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({ yAxisLabel: e.target.value || undefined })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/** Indicator inspector: the measure, its caption, how it reads, and
 *  an optional comparison. */
function IndicatorWidgetConfigEditor({
  config,
  canEdit,
  appTargets,
  mapWidgets,
  onChangeConfig,
}: {
  config: Extract<CustomWidget['config'], { kind: 'indicator' }>;
  canEdit: boolean;
  appTargets: AppDataSource[];
  mapWidgets: CustomWidget[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const target = appTargets.find((src) =>
    config.sourceId !== undefined
      ? src.id === config.sourceId
      : appTargets.indexOf(src) === config.targetIndex,
  )?.layer;
  const { fields, loading } = useTargetFields(target);
  const numeric = numericCandidates(fields);
  const fmt = config.format ?? {};
  const patchFormat = (patch: Record<string, unknown>) =>
    onChangeConfig({ format: { ...fmt, ...patch } });
  return (
    <div className="space-y-3">
      <TargetSelect
        value={config.targetIndex}
        appTargets={appTargets}
        canEdit={canEdit}
        onChange={(i) => onChangeConfig({ targetIndex: i })}
      />
      <Field label="Measure">
        <select
          value={config.aggregate}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({
              aggregate: e.target.value,
              ...(e.target.value === 'count' ? { valueField: undefined } : {}),
            })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          {AGGREGATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {config.aggregate !== 'count' ? (
        <Field
          label={measureFieldLabel(config.aggregate)?.label ?? 'Field'}
          hint={
            loading
              ? 'Reading the layer schema…'
              : (measureFieldLabel(config.aggregate)?.hint ?? '')
          }
        >
          <select
            value={config.valueField ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              onChangeConfig({ valueField: e.target.value || undefined })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          >
            <option value="">(pick a field)</option>
            {(config.aggregate === 'countDistinct' ? fields : numeric).map(
              (f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ),
            )}
          </select>
        </Field>
      ) : null}
      <Field label="Caption" hint="Leave blank for an automatic one.">
        <input
          type="text"
          value={config.label ?? ''}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({ label: e.target.value || undefined })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          placeholder="Open permits"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Prefix">
          <input
            type="text"
            value={fmt.prefix ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              patchFormat({ prefix: e.target.value || undefined })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            placeholder="$"
          />
        </Field>
        <Field label="Suffix">
          <input
            type="text"
            value={fmt.suffix ?? ''}
            disabled={!canEdit}
            onChange={(e) =>
              patchFormat({ suffix: e.target.value || undefined })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            placeholder=" acres"
          />
        </Field>
      </div>
      <Field label="Decimal places" hint="Blank shows whole numbers as whole.">
        <input
          type="number"
          min={0}
          max={6}
          value={fmt.decimals ?? ''}
          disabled={!canEdit}
          onChange={(e) =>
            patchFormat({
              decimals:
                e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          checked={fmt.compact === true}
          disabled={!canEdit}
          onChange={(e) => patchFormat({ compact: e.target.checked || undefined })}
        />
        Shorten large numbers (12.3K)
      </label>
      <Field
        label="Compare against"
        hint="Optional target value. Leave blank for no comparison."
      >
        <input
          type="number"
          value={config.reference?.value ?? ''}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({
              reference:
                e.target.value === ''
                  ? undefined
                  : {
                      ...(config.reference ?? {}),
                      value: Number(e.target.value),
                    },
            })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        />
      </Field>
      {config.reference ? (
        <Field
          label="Good when"
          hint="Colors the number. Choose neutral to compare without judging."
        >
          <select
            value={config.reference.goodWhen ?? 'none'}
            disabled={!canEdit}
            onChange={(e) =>
              onChangeConfig({
                reference: {
                  ...config.reference,
                  goodWhen: e.target.value,
                },
              })
            }
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          >
            <option value="none">Neutral</option>
            <option value="above">At or above the target</option>
            <option value="below">At or below the target</option>
          </select>
        </Field>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-ink-1">{label}</label>
      {children}
      {hint && <p className="text-xs leading-snug text-muted">{hint}</p>}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
    />
  );
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Widget kinds whose CustomWidgetConfig has a `mapWidgetId` field
 * the runtime needs filled to do anything useful. addWidgetAt
 * uses this set to decide whether to auto-bind a freshly-dropped
 * widget to the only Map widget on the page; the WidgetConfigForm
 * uses the same shape (a map-binding picker) for them all.
 */
const WIDGETS_BIND_MAP_ID = new Set<CustomWidgetKind>([
  'legend',
  'layer-list',
  'search',
  'print',
  'select',
  'basemap-gallery',
  'create-feature',
  'edit-feature',
  'delete-feature',
]);

/**
 * Pre-fill `mapWidgetId` on a freshly-stamped widget without any
 * exhaustive switch over CustomWidgetConfig: the field is uniformly
 * called `mapWidgetId` across every config kind in the set above,
 * so a structural copy with the patch applied is type-safe via the
 * eventual cast back to CustomWidget.
 */
function autoBindMapWidgetId(
  widget: CustomWidget,
  mapWidgetId: string,
): CustomWidget {
  return {
    ...widget,
    config: {
      ...widget.config,
      mapWidgetId,
    } as CustomWidget['config'],
  };
}

function clampCol(col: number): number {
  return Math.max(1, Math.min(GRID_COLS, Math.round(col)));
}

/**
 * Default size + position for a freshly-stamped widget. Map gets
 * the largest footprint by default because most apps anchor on it;
 * other widgets get sensible smaller blocks. col/row are placeholder
 * 1,1 -- the canvas's drop handler overrides them with the actual
 * grid cell the user dropped into.
 */
function defaultLayoutForKind(kind: CustomWidgetKind): CustomLayout {
  // #95: sizes in v4 grid units (192 cols x 3px rows).  Map-
  // following kinds are sized for tool mode (icon-only card,
  // 8x8 v4 cells ≈ 50px square).  Authors flipping a widget to
  // panel mode get a more useful initial footprint via the
  // properties panel.
  switch (kind) {
    case 'map':
      return { col: 1, row: 1, colSpan: 64, rowSpan: 96 };
    // Tool-mode-by-default kinds. 8x8 v4 cells ≈ 50px square,
    // big enough for a 16px icon + a comfortable click target.
    case 'layer-list':
    case 'legend':
    case 'search':
    case 'print':
    case 'select':
    case 'export':
    case 'basemap-gallery':
    case 'bookmark':
    case 'coordinates':
    case 'my-location':
    case 'elevation-profile':
    case 'magic-outline':
    case 'create-feature':
    case 'edit-feature':
    case 'delete-feature':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 8 };
    case 'attribute-table':
      return { col: 1, row: 1, colSpan: 96, rowSpan: 40 };
    case 'text':
      return { col: 1, row: 1, colSpan: 96, rowSpan: 8 };
    case 'chart':
      return { col: 1, row: 1, colSpan: 48, rowSpan: 48 };
    // Indicators are wide-and-short by default so a row of four
    // tiles across the top of a page is the natural first drop.
    case 'indicator':
      return { col: 1, row: 1, colSpan: 48, rowSpan: 40 };
    case 'image':
      return { col: 1, row: 1, colSpan: 32, rowSpan: 32 };
    case 'button':
      return { col: 1, row: 1, colSpan: 16, rowSpan: 8 };
    case 'tool':
      // Tool defaults to toolbar variant (icon-only round), same
      // footprint as Search / Print / Bookmark.
      return { col: 1, row: 1, colSpan: 8, rowSpan: 8 };
    case 'divider':
      return { col: 1, row: 1, colSpan: 96, rowSpan: 4 };
    case 'embed':
      return { col: 1, row: 1, colSpan: 64, rowSpan: 64 };
    case 'splash':
      // Splash renders nothing on the canvas at runtime (the
      // actual modal is portal-rendered to document.body); the
      // designer shows a small placeholder card so the author
      // sees it's there.  16x8 ≈ 100x50px placeholder.
      return { col: 1, row: 1, colSpan: 16, rowSpan: 8 };
    case 'time-slider':
      // Narrow strip across the bottom or top of the canvas by
      // default; authors typically anchor it like a film-strip
      // timeline.  64 cols wide, 16 rows (~50px) tall.
      return { col: 1, row: 1, colSpan: 64, rowSpan: 16 };
    case 'tabs':
      return { col: 1, row: 1, colSpan: 64, rowSpan: 64 };
    // #92 generic container: fresh containers stamp inline by
    // default and take a modest 64x32 region (= 1/3 width, ~100px
    // tall on a typical canvas).  Once the author flips `position`
    // to sticky-top / dock-left / etc. the runtime dispatches the
    // container into the appropriate page slot and these grid
    // coords become a no-op.
    case 'container':
      return { col: 1, row: 1, colSpan: 64, rowSpan: 32 };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { col: 1, row: 1, colSpan: 12, rowSpan: 8 };
    }
  }
}

/**
 * Sensible per-kind default panel arrangement (#364) used when the
 * author hasn't customized one yet. Each kind picks the corner +
 * size that fits its content best:
 *   - List-style widgets (Layers, Legend, Bookmarks) dock top-right,
 *     ~tall enough to scroll a real list.
 *   - Single-row widgets (Coordinates, Search) dock top-center
 *     with a wider, shorter panel.
 *   - Galleries (Basemap) use a wider square panel.
 *   - One-shot buttons (Print, Select, MyLocation) get a tight
 *     square that fits their compact UI.
 */
function defaultPanelArrangement(kind: CustomWidgetKind): PanelArrangement {
  const base: PanelArrangement = {
    placement: 'floating',
    anchor: 'top-right',
    width: 320,
    height: 420,
    offsetX: 12,
    offsetY: 12,
    animation: 'fade',
  };
  switch (kind) {
    case 'layer-list':
    case 'legend':
    case 'bookmark':
      return { ...base, anchor: 'top-right', width: 280, height: 420 };
    case 'basemap-gallery':
      return { ...base, anchor: 'top-right', width: 320, height: 360 };
    case 'search':
      return {
        ...base,
        anchor: 'top-center',
        width: 420,
        height: 240,
        offsetY: 12,
      };
    case 'coordinates':
      return {
        ...base,
        anchor: 'bottom-left',
        width: 320,
        height: 64,
        offsetX: 12,
        offsetY: 12,
      };
    case 'select':
      return { ...base, anchor: 'top-right', width: 280, height: 200 };
    case 'print':
      return { ...base, anchor: 'top-right', width: 280, height: 180 };
    case 'my-location':
      return { ...base, anchor: 'top-right', width: 280, height: 160 };
    case 'attribute-table':
      // Mirrors the map item's attribute table dock: wide and not
      // very tall, anchored along the bottom edge so the map above
      // stays usable. Width is generous enough for a half-dozen
      // columns at default zoom; the runtime resizer (panel
      // arrangement) lets the author bump it up if they bind many
      // fields.
      return {
        ...base,
        anchor: 'bottom-center',
        width: 720,
        height: 280,
        offsetX: 12,
        offsetY: 12,
      };
    default:
      return base;
  }
}

/**
 * The set of widget kinds that respect displayMode. Used by the
 * properties panel to show / hide the tool-mode controls and by
 * the canvas WidgetCard + runtime to decide between icon and
 * inline rendering.
 */
const TOOL_MODE_KINDS: ReadonlySet<CustomWidgetKind> = new Set([
  'layer-list',
  'legend',
  'search',
  'print',
  'select',
  'basemap-gallery',
  'bookmark',
  'coordinates',
  'my-location',
  // #261 follow-up: attribute-table joins the map-following crew so
  // authors can drop it on the toolbar instead of stealing a row of
  // grid real estate. Default panel arrangement (below) anchors the
  // resulting overlay along the bottom edge, matching where the
  // map-item's attribute table panel docks.
  'attribute-table',
]);

/**
 * Resolve the effective display mode for a widget. Map-following
 * kinds default to 'tool' for new (unstamped) data; legacy widgets
 * without the field stay in 'panel' mode for back-compat.
 */
function effectiveDisplayMode(widget: CustomWidget): 'panel' | 'tool' {
  if (!TOOL_MODE_KINDS.has(widget.kind)) return 'panel';
  const cfg = widget.config as { displayMode?: 'panel' | 'tool' };
  return cfg.displayMode ?? 'panel';
}

/**
 * #362: find a Tabs widget on the page whose grid bounds contain
 * the (col, row) drop point. Drop routing uses this to send a
 * widget into a Tabs container's active tab when the user drops
 * on top of one. Returns the first match (last-on-top would also
 * be reasonable, but a single Tabs container per cell is the
 * common case).
 */
function findTabsHostAt(
  widgets: CustomWidget[],
  col: number,
  row: number,
): CustomWidget | null {
  for (const w of widgets) {
    if (w.kind !== 'tabs') continue;
    const c1 = w.layout.col;
    const c2 = w.layout.col + w.layout.colSpan - 1;
    const r1 = w.layout.row;
    const r2 = w.layout.row + w.layout.rowSpan - 1;
    if (col >= c1 && col <= c2 && row >= r1 && row <= r2) {
      return w;
    }
  }
  return null;
}

/**
 * The widget kinds that act as themed-app containers — they each
 * carry a `widgets: CustomWidget[]` array of children. Drop-routing
 * uses this set to decide whether a drop point lands inside a
 * container that should adopt the new widget.
 *
 * Tabs is intentionally NOT in this set; Tabs has its own
 * tab-index routing path (`findTabsHostAt`) and adds to the active
 * tab's child list rather than the container's flat children
 * array.
 */
const THEMED_CONTAINER_KINDS = new Set<CustomWidgetKind>(['container']);

/**
 * #98: a "partitioned" container is one whose `position` makes it
 * render as a flex sibling OUTSIDE the canvas grid in both the
 * runtime AND (now) the designer.  These containers ignore their
 * grid layout (col/row/colSpan/rowSpan) at render time -- their
 * size is content-driven (sticky-top/sticky-bottom) or prop-driven
 * (dock-left/dock-right via widthPx).  Keeping them out of the grid
 * makes the designer pixel-match the runtime regardless of what
 * rowSpan the seed happens to have.
 *
 * Overlay-trigger containers stay INSIDE the canvas grid because
 * their visible chrome (the floating trigger pill + drawer) is
 * positioned absolutely against the grid cell they live in -- they
 * already act like a content-sized overlay over a grid widget, so
 * pulling them out of the grid would break that positioning.
 *
 * Inline containers also stay in the grid because they're the
 * generic "flow region" case -- they consume grid cells like any
 * other widget.
 */
function isPartitionedContainer(w: CustomWidget): boolean {
  if (w.kind !== 'container') return false;
  if (w.config.kind !== 'container') return false;
  const pos = w.config.position ?? 'inline';
  return (
    pos === 'sticky-top' ||
    pos === 'sticky-bottom' ||
    pos === 'dock-left' ||
    pos === 'dock-right'
  );
}

/**
 * #98: DOM-based container host lookup.  Walks every [data-widget-id]
 * element under the canvas, picks the deepest one whose bounding
 * rect contains (clientX, clientY) AND that's a themed container.
 * Works for both in-grid containers (inline, overlay-trigger) and
 * out-of-grid partitioned containers (sticky-top / sticky-bottom /
 * dock-left / dock-right) without needing to special-case the
 * coordinate space -- the DOM rect is the source of truth either way.
 *
 * Used by the drop-routing handlers in place of the older
 * `findContainerHostAt(widgets, col, row)` (which only works for
 * grid-positioned containers and would route past sticky-top bars).
 */
function findContainerHostAtClient(
  root: HTMLElement | null,
  widgets: CustomWidget[],
  clientX: number,
  clientY: number,
): CustomWidget | null {
  if (!root) return null;
  const els = Array.from(
    root.querySelectorAll('[data-widget-id]'),
  ) as HTMLElement[];
  let best: { widget: CustomWidget; depth: number } | null = null;
  for (const el of els) {
    const id = el.getAttribute('data-widget-id');
    if (!id) continue;
    const found = findWidgetWithParent(widgets, id);
    if (!found) continue;
    const w = found.widget;
    if (!THEMED_CONTAINER_KINDS.has(w.kind)) continue;
    const rect = el.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue;
    }
    // Pick the deepest DOM-nested container so a drop on a nested
    // foldable group routes to the group, not its parent dock.
    let depth = 0;
    let cur: Element | null = el.parentElement;
    while (cur && cur !== root) {
      if (cur.hasAttribute('data-widget-id')) depth++;
      cur = cur.parentElement;
    }
    if (!best || depth > best.depth) best = { widget: w, depth };
  }
  return best?.widget ?? null;
}

/**
 * Find a page-level widget by id walking through container
 * children. Returns the widget plus the parent container's id (or
 * null for top-level). Used by drop-routing's "did we add a child
 * to a container? show the container's properties panel" follow-up.
 */
function findContainerById(
  widgets: CustomWidget[],
  containerId: string,
): CustomWidget | null {
  for (const w of widgets) {
    if (w.id === containerId) return w;
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const inner = findContainerById(cfg.widgets, containerId);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * #22 WYSIWYG: walk every widget tree on the page (including
 * container children, foldable-group children, tabs children) and
 * apply `updater` to the widget whose id matches.  Returns a fresh
 * array with the update applied; non-matching widgets pass through
 * untouched.  Used by the right-rail properties panel so editing
 * a nested child's config persists on the right level of the tree
 * instead of trying to set it on the page-level array (where it
 * doesn't exist for nested ids).
 */
function updateWidgetDeep(
  widgets: CustomWidget[],
  targetId: string,
  updater: (w: CustomWidget) => CustomWidget,
): CustomWidget[] {
  return widgets.map((w) => {
    if (w.id === targetId) return updater(w);
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = updateWidgetDeep(cfg.widgets, targetId, updater);
      if (nextChildren !== cfg.widgets) {
        return {
          ...w,
          config: { ...cfg, widgets: nextChildren },
        } as CustomWidget;
      }
    }
    // #362: tabs also nests widgets per-tab.
    if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
      let touched = false;
      const nextTabs = cfg.tabs.map((t) => {
        const nextTabWidgets = updateWidgetDeep(t.widgets, targetId, updater);
        if (nextTabWidgets !== t.widgets) {
          touched = true;
          return { ...t, widgets: nextTabWidgets };
        }
        return t;
      });
      if (touched) {
        return { ...w, config: { ...cfg, tabs: nextTabs } } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * #22 WYSIWYG: remove a widget by id anywhere in the tree.
 * Mirrors updateWidgetDeep's walking behaviour.
 */
function removeWidgetDeep(
  widgets: CustomWidget[],
  targetId: string,
): CustomWidget[] {
  const filtered = widgets.filter((w) => w.id !== targetId);
  if (filtered.length !== widgets.length) return filtered;
  return widgets.map((w) => {
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = removeWidgetDeep(cfg.widgets, targetId);
      if (nextChildren !== cfg.widgets) {
        return {
          ...w,
          config: { ...cfg, widgets: nextChildren },
        } as CustomWidget;
      }
    }
    if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
      let touched = false;
      const nextTabs = cfg.tabs.map((t) => {
        const nextTabWidgets = removeWidgetDeep(t.widgets, targetId);
        if (nextTabWidgets !== t.widgets) {
          touched = true;
          return { ...t, widgets: nextTabWidgets };
        }
        return t;
      });
      if (touched) {
        return { ...w, config: { ...cfg, tabs: nextTabs } } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * Append a child widget to a container identified by id. Returns a
 * new `widgets` array with the container updated; doesn't mutate.
 * Recurses through nested containers so dropping into a foldable-
 * group inside a dock-panel works.
 */
function appendChildToContainer(
  widgets: CustomWidget[],
  containerId: string,
  child: CustomWidget,
): CustomWidget[] {
  return widgets.map((w) => {
    if (w.id === containerId) {
      const cfg = w.config;
      if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
        return {
          ...w,
          config: { ...cfg, widgets: [...cfg.widgets, child] },
        } as CustomWidget;
      }
      return w;
    }
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = appendChildToContainer(
        cfg.widgets,
        containerId,
        child,
      );
      if (nextChildren !== cfg.widgets) {
        return {
          ...w,
          config: { ...cfg, widgets: nextChildren },
        } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * #96: locate a widget anywhere in the tree along with its parent
 * container's id (null = page-level) and its index in the parent's
 * children array.  Used by the reparent gesture so the move handler
 * can remove the widget from its source location precisely.
 *
 * Recurses through container.config.widgets[] and tabs.tabs[].widgets[].
 */
function findWidgetWithParent(
  widgets: CustomWidget[],
  id: string,
  parentId: string | null = null,
): { widget: CustomWidget; parentId: string | null; index: number } | null {
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i]!;
    if (w.id === id) return { widget: w, parentId, index: i };
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const inner = findWidgetWithParent(cfg.widgets, id, w.id);
      if (inner) return inner;
    }
    if (cfg.kind === 'tabs' && Array.isArray(cfg.tabs)) {
      for (const t of cfg.tabs) {
        const inner = findWidgetWithParent(t.widgets, id, w.id);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/**
 * #96: insert a child widget at a specific index inside a container.
 * `containerId === null` inserts at the page level.  index clamped
 * to [0, parent.length].  Returns a fresh widgets array.
 */
function insertWidgetAt(
  widgets: CustomWidget[],
  containerId: string | null,
  index: number,
  child: CustomWidget,
): CustomWidget[] {
  if (containerId === null) {
    const i = Math.max(0, Math.min(index, widgets.length));
    return [...widgets.slice(0, i), child, ...widgets.slice(i)];
  }
  return widgets.map((w) => {
    if (w.id === containerId) {
      const cfg = w.config;
      if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
        const i = Math.max(0, Math.min(index, cfg.widgets.length));
        const nextChildren = [
          ...cfg.widgets.slice(0, i),
          child,
          ...cfg.widgets.slice(i),
        ];
        return { ...w, config: { ...cfg, widgets: nextChildren } } as CustomWidget;
      }
      return w;
    }
    const cfg = w.config;
    if ('widgets' in cfg && Array.isArray(cfg.widgets)) {
      const nextChildren = insertWidgetAt(cfg.widgets, containerId, index, child);
      if (nextChildren !== cfg.widgets) {
        return { ...w, config: { ...cfg, widgets: nextChildren } } as CustomWidget;
      }
    }
    return w;
  });
}

/**
 * #96: move a widget from wherever it lives in the tree to a new
 * parent + index.  Performs the remove + insert in one pass so the
 * page-level widgets array updates atomically.  When the source
 * widget is rooted at page-level and moves into a container, its
 * grid layout coords are reset to a (1,1,1,1) placeholder because
 * children inside containers ignore grid coords.  When moving from
 * a container OUT to the page level, the caller supplies a
 * `pageLayout` overlay (the cursor's drop coords) so the widget
 * re-acquires a sensible grid position.
 */
function moveWidgetInTree(
  widgets: CustomWidget[],
  sourceId: string,
  targetParentId: string | null,
  targetIndex: number,
  pageLayout: CustomLayout | null,
): CustomWidget[] {
  const found = findWidgetWithParent(widgets, sourceId);
  if (!found) return widgets;
  // When the source and target parent are the same, removing first
  // would shift the indices to the LEFT for any post-source index.
  // Account for that here so callers can pass the "visual" index
  // without thinking about the shift.
  const adjustedIndex =
    found.parentId === targetParentId && targetIndex > found.index
      ? targetIndex - 1
      : targetIndex;
  const withoutSource = removeWidgetDeep(widgets, sourceId);
  let widgetToInsert = found.widget;
  if (pageLayout) {
    // #99: pageLayout is the cursor-derived destination layout.
    // When dropping at page level, it's the grid coords.  When
    // dropping into a container (free-position FlowContainer), it's
    // the in-container col/row in the 1..192 axis space the
    // renderer maps to a left/top percent.  Either way we just
    // overwrite the widget's layout with the cursor-derived one.
    widgetToInsert = { ...widgetToInsert, layout: pageLayout };
  } else if (targetParentId !== null && found.parentId === null) {
    // Moving from page level into a container without a pageLayout
    // (shouldn't happen with the current canvas, but kept as a
    // safety net for any future call site that doesn't compute a
    // cursor-derived destination): collapse the layout to the
    // placeholder origin.  The container's auto-spread fallback
    // will visually distribute the child until it gets its first
    // explicit position write.
    widgetToInsert = {
      ...widgetToInsert,
      layout: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    };
  }
  return insertWidgetAt(withoutSource, targetParentId, adjustedIndex, widgetToInsert);
}

/**
 * Stamp a fresh widget of `kind` with sensible config defaults.
 * Same idea as the previous structural editor's stampWidget; kept
 * here so the designer doesn't depend on the legacy detail page.
 */
function stampWidget(kind: CustomWidgetKind, layout: CustomLayout): CustomWidget {
  const id = `w_${Math.random().toString(36).slice(2, 10)}`;
  switch (kind) {
    case 'map':
      return { id, kind, layout, config: { kind: 'map' } };
    case 'legend':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'legend',
          mapWidgetId: '',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('legend'),
        },
      };
    case 'layer-list':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'layer-list',
          mapWidgetId: '',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('layer-list'),
        },
      };
    case 'attribute-table':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'attribute-table',
          targetIndex: 0,
          // Match the other map-following widgets: default to tool
          // mode so freshly-dropped attribute tables show up as
          // toolbar buttons instead of stealing a row of grid
          // real estate. Authors can flip to 'panel' in the right
          // rail if they want the table inline. (Existing app data
          // without displayMode still resolves to 'panel' via
          // effectiveDisplayMode, so back-compat is preserved.)
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('attribute-table'),
        },
      };
    case 'text':
      return {
        id,
        kind,
        layout,
        config: { kind: 'text', markdown: 'New text widget', preset: 'body' },
      };
    case 'chart':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'chart',
          targetIndex: 0,
          chartType: 'bar',
          aggregate: 'count',
        },
      };
    case 'indicator':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'indicator',
          targetIndex: 0,
          aggregate: 'count',
          format: { grouping: true },
        },
      };
    case 'search':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'search',
          mapWidgetId: '',
          geocodingEnabled: true,
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('search'),
        },
      };
    case 'print':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'print',
          mapWidgetId: '',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('print'),
        },
      };
    case 'select':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'select',
          mapWidgetId: '',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('select'),
        },
      };
    case 'export':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'export',
          mapWidgetId: '',
          defaultFormat: 'xlsx',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('export'),
        },
      };
    case 'splash':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'splash',
          title: 'Welcome',
          markdown:
            'Update this welcome message in the right rail.  Use the toolbar to add headings, lists, and links.',
          size: 'md',
          confirmLabel: 'OK',
          allowDismiss: true,
          requireConfirm: false,
        },
      };
    case 'basemap-gallery':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'basemap-gallery',
          mapWidgetId: '',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('basemap-gallery'),
        },
      };
    case 'image':
      return {
        id,
        kind,
        layout,
        config: { kind: 'image', objectFit: 'contain' },
      };
    case 'button':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'button',
          label: 'Button',
          variant: 'primary',
          linkKind: 'url',
        },
      };
    case 'tool':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'tool',
          display: 'toolbar',
          showLabel: false,
        },
      };
    case 'divider':
      return {
        id,
        kind,
        layout,
        config: { kind: 'divider', thicknessPx: 1, style: 'solid' },
      };
    case 'embed':
      return {
        id,
        kind,
        layout,
        config: { kind: 'embed' },
      };
    case 'bookmark':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'bookmark',
          mapWidgetId: '',
          bookmarks: [],
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('bookmark'),
        },
      };
    case 'coordinates':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'coordinates',
          mapWidgetId: '',
          format: 'dd',
          precision: 5,
          showZoom: false,
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('coordinates'),
        },
      };
    case 'my-location':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'my-location',
          mapWidgetId: '',
          zoomLevel: 14,
          keepMarker: true,
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('my-location'),
        },
      };
    // No displayMode here on purpose: the profile tool's chart
    // panel overlays the bound map itself, so the widget's layout
    // footprint is just the toggle button.
    case 'elevation-profile':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'elevation-profile',
          mapWidgetId: '',
          showLabel: false,
        },
      };
    // Footprint is just the toggle; the outlining happens on the
    // bound map, and results go to the app's editable polygon layer.
    case 'magic-outline':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'magic-outline',
          mapWidgetId: '',
          showLabel: false,
        },
      };
    case 'time-slider':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'time-slider',
          mode: 'date',
          label: 'Time',
          stepDays: 1,
        },
      };
    case 'create-feature':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'create-feature',
          mapWidgetId: '',
          targetIndex: 0,
          label: 'Add feature',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('create-feature'),
        },
      };
    case 'edit-feature':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'edit-feature',
          mapWidgetId: '',
          targetIndex: 0,
          label: 'Edit feature',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('edit-feature'),
        },
      };
    case 'delete-feature':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'delete-feature',
          mapWidgetId: '',
          targetIndex: 0,
          label: 'Delete feature',
          displayMode: 'tool',
          panelArrangement: defaultPanelArrangement('delete-feature'),
        },
      };
    case 'tabs':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'tabs',
          tabs: [
            {
              id: `tab_${Math.random().toString(36).slice(2, 8)}`,
              title: 'Tab 1',
              widgets: [],
            },
          ],
        },
      };
    // #92 generic container.  Stamped fresh with no children;
    // author flips `position` + `variant` to shape the chrome and
    // drops widgets inside to fill it.  Default is an inline,
    // column-layout, flat region -- a neutral starting point.
    case 'container':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'container',
          position: 'inline',
          layout: 'column',
          variant: 'flat',
          widgets: [],
        },
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled widget kind: ${String(_exhaustive)}`);
    }
  }
}
