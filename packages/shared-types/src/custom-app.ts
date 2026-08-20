// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in a `web_app` Item's data when
 * `template = 'custom'`. The Custom Web App template is the
 * "designer-first" companion to Viewer / Editor / Survey: where
 * those templates ship with a fixed UI and a small config knob set,
 * a Custom app is a free-form layout of widgets the author drags
 * onto a canvas and binds to data sources individually.
 *
 * Inspirations: Esri Web AppBuilder + Experience Builder. The two
 * camps split because Esri tried to support both "quick configurable
 * app from a template" (Web AppBuilder) and "full-bleed designed
 * experience" (Experience Builder); we want one balanced surface
 * that doesn't feel like a stripped-down copy of either. The widgets
 * are extensible (each carries its own `kind` discriminator and
 * config object), so adding a new widget is "ship one widget renderer
 * + one designer panel" rather than reshaping the schema.
 *
 * Authorization: targets list reuses ViewerTarget shape so the same
 * share + geo-limit pipeline applies. Authoring permission is
 * orthogonal -- only owners / admins can edit the layout, but
 * anyone with view permission on the web_app item plus its
 * referenced layers can render it.
 *
 * See docs/web-app-templates.md and #261 for the broader template
 * registry. Custom is template #4 after Editor (#258), Viewer (#259),
 * and Survey (#260).
 */

import type { ViewerTarget } from './viewer';
import type { MapLayerFilter } from './map';
import type { AssetRef } from './asset-ref';

export interface CustomAppData {
  /** Schema version. Bumped from 1 to 2 (#357) when the canvas grid
   *  resolution doubled (12 -> 24 columns, 48px -> 24px row height)
   *  for finer drag/snap. Bumped again from 2 to 3 (user feedback:
   *  toolbar buttons could only snap to a column-width gap from the
   *  canvas edge or to the edge itself, with no in-between
   *  position) when the grid doubled again to 48 columns + 12px
   *  rows. Migration multiplies every widget's col / row / colSpan /
   *  rowSpan by 2 per version bump and rewrites the version on the
   *  next save. */
  version: 1 | 2 | 3 | 4 | 5;
  /**
   * Optional reference to a `map` item the canvas-style widgets
   * (MapWidget) inherit basemap + viewport from. Individual widgets
   * may override; this is the "default for new map widgets" hint
   * the designer reads when stamping a fresh widget onto the canvas.
   */
  mapId?: string;
  /**
   * Superseded by `sources` at v5. Still read so an app saved by an
   * older client loads, and still written alongside `sources` for one
   * release so an older client can open an app this one saved.
   *
   * Do not add anything here. See `sources`.
   */
  targets: ViewerTarget[];
  /**
   * The layers this app's widgets read, and what each one MEANS.
   *
   * A source is not just an identity. It carries its own scope: which
   * map's view narrows it, a predicate its author fixed, and the
   * relate that ties it to a parent source. Widgets name a source and
   * declare nothing about scope themselves.
   *
   * That inversion is the whole design. When scope lived on the
   * widget, making a page agree cost one deliberate act per tile and
   * the cost grew with exactly the thing that makes a dashboard good.
   * A counter reading the whole layer beside a map showing one valley
   * is two answers presented as one page, and it was the default.
   * Now two widgets on one source cannot disagree by construction.
   *
   * Spec: docs/research/app-data-sources-2026-08-20.md
   */
  sources?: AppDataSource[];
  /**
   * The page tree. v1 supports a single page so the schema is forward-
   * compatible with multi-page apps without forcing every consumer to
   * walk an array today. The home page is always `pages[0]`; the
   * designer's "page chooser" is hidden until pages.length > 1.
   */
  pages: CustomPage[];
  /**
   * App-level theme tokens applied across all pages. Kept tiny in
   * v1; widget-level overrides slot in via widget.style later.
   */
  theme?: {
    /** CSS color value used for primary accents (buttons, focus
     *  rings, active tab underline). Defaults to portal accent. */
    accent?: string;
    /** Background color for the app shell (between widgets). */
    background?: string;
  };
  /**
   * Optional header bar across the top of the app.
   *
   * A dashboard opened from a link, embedded in an intranet page, or
   * left on a wall display arrives with no context: the browser tab
   * title is not visible and the portal chrome is hidden for public
   * apps. Without a header the reader sees four numbers and has to
   * guess what they count and who published them.
   */
  header?: {
    /** Shown large. Defaults to the item's own title when unset. */
    title?: string;
    /** Optional line under the title: scope, as-of date, owner. */
    subtitle?: string;
    /** Set false to hide the bar on an app that does not want one
     *  (a map app inside an iframe, say). Absent means shown. */
    show?: boolean;
  };
  /**
   * Cosmetic origin marker, set when the app was stamped from a
   * starter whose user-facing identity is worth preserving in lists.
   * Today the only value is 'dashboard'.
   *
   * It is READ IN EXACTLY ONE PLACE: the item label / icon helpers in
   * portal-web. Nothing branches on it, no capability depends on it,
   * and clearing it changes nothing except the word on the card. That
   * constraint is the point. A dashboard here is a custom web app
   * that happens to have started from a dashboard layout, and the
   * moment this field gates behaviour it has become a second app
   * type by the back door, which is exactly what folding `editor`
   * back into `web_app` cost a data migration to undo.
   */
  blueprint?: 'dashboard';
  /**
   * Auto-refresh cadence in seconds for data-bound widgets
   * (indicator, chart, attribute table, and map feature sources).
   * Unset or 0 means never: a page only re-fetches when the user
   * acts. Dashboard starter templates ship with this set, because a
   * wall display that silently goes stale is worse than one that
   * costs a request a minute.
   *
   * The runtime floors this at REFRESH_MIN_SECONDS, pauses while the
   * tab is hidden, and jitters each widget so a room full of
   * dashboards does not stampede the API on the same tick.
   */
  refreshSeconds?: number;
  /**
   * Theme reference.  Either:
   *   - a built-in starter kind ('default' / 'slate' / 'aurora' /
   *     'forest' / 'paper') matching seedKind on a seeded theme
   *     item (legacy storage for apps saved before #22 lifted
   *     themes into items), or
   *   - a UUID pointing at a `theme` item the user has access to.
   *
   * The runtime resolves either form against the user's theme
   * catalog (server-side preload).  The older `theme.accent` /
   * `theme.background` overrides still apply on top when set.
   */
  themePresetId?: string;
}

/**
 * Built-in theme presets shipped with the portal. The actual token
 * values live in `app-themes.ts`; this union is the wire-stable id
 * authors save. New presets add new values; renames need a migration
 * step.
 */
export type AppThemePresetId =
  | 'default'
  | 'slate'
  | 'aurora'
  | 'forest'
  | 'paper';

export interface CustomPage {
  /** Stable id; URL-safe so future "named page" routing is possible. */
  id: string;
  /** Displayed in the designer's page list and (eventually) the
   *  multi-page chooser at runtime. */
  title: string;
  /**
   * Widgets on this page. Layout positions are stored on the widget
   * itself (CSS grid coordinates). The designer renders this list
   * inside a 12-column grid; the runtime renders it the same way.
   */
  widgets: CustomWidget[];
}

/**
 * Widget envelope. The discriminator is `kind`; each kind carries
 * its own `config` shape. Keeping the envelope (id + position +
 * style) shared lets the designer's drag-drop / resize plumbing
 * not care about widget specifics.
 */
export interface CustomWidget {
  /** Stable id for selection / layout-state / undo-redo. */
  id: string;
  /** Discriminator. Adding a kind: extend CustomWidgetKind +
   *  CustomWidgetConfig + ship a renderer for it. */
  kind: CustomWidgetKind;
  /** CSS grid position on the page's 12-column grid. Row count is
   *  unbounded so widgets stack vertically as the page grows. */
  layout: CustomLayout;
  /**
   * Per-widget style overrides. Theme propagation makes most
   * widgets inherit from app theme, so this stays empty 99% of
   * the time and the designer only exposes it via "Customize".
   */
  style?: {
    background?: string;
    border?: string;
    /** Hide the widget's title bar. Useful when the widget is
     *  decorative (a TextWidget header) and shouldn't carry chrome. */
    hideHeader?: boolean;
  };
  /**
   * Per-widget auto-refresh override in seconds. Falls back to the
   * app-level `refreshSeconds`. 0 pins this widget to manual even
   * when the app refreshes, which is how an author keeps an
   * expensive table still while the KPI row ticks.
   */
  refreshSeconds?: number;
  /**
   * Show an expand control that grows this widget to fill the page,
   * with a second press to put it back.
   *
   * Off by default, and a per-widget choice rather than a blanket
   * app setting, because expanding is not always sensible: a KPI tile
   * has nothing more to show at four times the size, and a toolbar
   * button covering the map is a trap rather than a feature. It earns
   * its place on the widgets that genuinely run out of room in a
   * dashboard tile: a table with twenty columns, a chart with a long
   * category axis, a map the reader wants to work in.
   *
   * Expanding is a viewing state only. It is never persisted, so a
   * reader who expands a panel and reloads is back to the layout the
   * author published.
   */
  allowMaximize?: boolean;
  /** Free-form per-widget config; shape depends on `kind`. */
  config: CustomWidgetConfig;
}

/**
 * One layer an app reads, plus the scope that says what reading it
 * means on this page.
 */
export interface AppDataSource {
  /**
   * Stable id. Widgets reference this and never a position.
   *
   * Position was the old binding, and it was wrong in a way nobody
   * could see: removing a source shifted every later index, silently
   * rebinding widgets to a different layer. It was already wrong even
   * without an edit, because a target that fails to resolve (deleted,
   * unreadable, or attribute-only) is dropped from the resolved list
   * while the saved indices still count it, so every widget after it
   * read one layer too far.
   */
  id: string;
  /** Author-facing name. Falls back to the layer's own title. */
  label?: string;
  /** What it reads. */
  layer: ViewerTarget;
  /**
   * Recompute from this map widget's current view.
   *
   * The empty string pins the source to the whole layer. Absent means
   * the same thing today; it is kept distinct so a future page-level
   * default has somewhere to be inherited from.
   *
   * A source whose scope is spatial cannot speak for rows that have
   * no location, so a widget reading one reports how many of its rows
   * can participate. Silence is what makes "177" look like a bug when
   * the layer holds 625.
   */
  followMapWidgetId?: string;
  /**
   * Predicate the AUTHOR fixed. Always applied, and never cleared by
   * anything a reader does.
   *
   * Deliberately separate from the reader's cross-filter selection,
   * which lives in page state and never touches this. Merging them
   * would make "why is this number wrong" unanswerable, because
   * nobody could tell the author's intent from the last person's
   * click.
   */
  where?: MapLayerFilter;
  /**
   * Relate: scope this source to the rows whose `myField` value
   * appears among the in-scope rows of `sourceId`.
   *
   * This is what lets a table with no geometry follow a map. A well
   * is spatial and an inspection record is not, so `via` says the
   * inspections in view are the ones whose well id belongs to a well
   * in view.
   *
   * It inherits the parent's RESOLVED scope, not a snapshot of it, so
   * filtering a parent filters its children with nothing further
   * declared. Compiled server-side as a semi-join against the parent
   * scope rather than a harvested `IN (...)` list: the harvest caps
   * out (20 filter clauses, 1000 group keys) and a short key set is a
   * quietly wrong answer.
   *
   * Chains are capped at two hops and cycles are refused.
   */
  via?: {
    /** Parent source id. */
    sourceId: string;
    /** Field on the PARENT holding the shared key. */
    parentField: string;
    /** Field on THIS source holding the shared key. */
    myField: string;
  };
}

/** CSS grid layout descriptor in the page's 12-column grid. */
export interface CustomLayout {
  /** 1-based column number of the widget's top-left cell. */
  col: number;
  /** 1-based row number of the widget's top-left cell. */
  row: number;
  /** Column span; clamped to 12 - col + 1 by the designer. */
  colSpan: number;
  /** Row span; unbounded. */
  rowSpan: number;
}

/**
 * Discriminator for every widget the designer can place. Keep this
 * union narrow; each entry costs a renderer + a designer panel.
 *
 *   - 'map': MapLibre canvas (the workhorse). Bound to one or more
 *     of the app's `targets`.
 *   - 'legend': renders the symbology of every visible layer in a
 *     nominated map widget. Linked by widget id.
 *   - 'layer-list': layer-toggle panel feeding the same map widget.
 *   - 'attribute-table': list rows from one of the app's `targets`,
 *     with selection synced to the linked map widget.
 *   - 'text': a markdown / static-text panel for headers, intros,
 *     attribution, and call-out boxes.
 *   - 'chart': a single-series bar / line / pie chart over a layer's
 *     attributes. Phase 2; ships after the runtime exists.
 *   - 'search': address geocoder + per-target attribute search bar
 *     bound to a map widget. Picking a result pans + highlights.
 *   - 'print': single-button print panel that triggers the bound
 *     map's print stylesheet (#132 once it lands).
 *   - 'select': panel of select-mode buttons (click / rectangle /
 *     polygon / lasso) that drive the bound map's select tool.
 *   - 'basemap-gallery': tile grid of the org's basemap items;
 *     clicking a tile swaps the bound map's basemap.
 */
export type CustomWidgetKind =
  | 'map'
  | 'legend'
  | 'layer-list'
  | 'attribute-table'
  | 'text'
  | 'chart'
  // Indicator: one aggregate number, big. The dashboard
  // primitive. Reads the server-side aggregate endpoint like the
  // chart does, so it costs one small request rather than a layer
  // download, and it respects the caller's sharing scope.
  | 'indicator'
  | 'search'
  | 'print'
  | 'select'
  | 'export'
  | 'splash'
  | 'basemap-gallery'
  // #361: page-element widgets. None of these touch a Map widget or
  // a target layer; they're static content the author drops onto the
  // canvas to round out the page. EB calls these "page element"
  // widgets and groups them in their own bucket; we mirror that.
  | 'image'
  | 'button'
  | 'divider'
  | 'embed'
  // #361 part 2: mapcentric quick wins. Each binds to a Map widget
  // by id (mapWidgetId) and reads or drives that map's state.
  | 'bookmark'
  | 'coordinates'
  | 'my-location'
  // Elevation profile: draw a line on the bound map, chart the
  // ground height along it from the map's elevation layer. Shares
  // its whole implementation with the map builder's toolbar tool.
  | 'elevation-profile'
  // Magic outline: click a building / field on an imagery layer in
  // the bound map and drop its traced polygon into an editable
  // target layer. Server computes per-view SAM embeddings; the
  // browser runs the mask decoder. Reuses lib/sam-outline.
  | 'magic-outline'
  // #87: time-slider drives the app-wide bitemporal "as of" state.
  // No map binding -- when present, every map/chart/table widget on
  // the page reads the slider value via AppTimeContext and re-fetches
  // against that bitemporal projection.  Author configures min/max
  // bounds and a step.  Renders a date input + slider (or just a
  // calendar / picker, depending on mode).
  | 'time-slider'
  // #69 / #70 / #71: feature editing widgets.  Each binds to a Map
  // widget + a target layer (via the parent app's `targets` array).
  // Create opens an empty attribute form; Edit reads the bound
  // map's selection and pre-fills the form; Delete also reads the
  // selection and confirms+removes.  All three disable themselves
  // when AppTimeContext.at is non-null (the engine rejects past-
  // target writes anyway; this is the UX gate so authors don't
  // even see the buttons in time-travel mode).
  | 'create-feature'
  | 'edit-feature'
  | 'delete-feature'
  // #362: layout container. Holds nested widgets organized into
  // tabs. Anti-EB: deliberately simpler than EB's Section + Views
  // pair, just one widget that renders a tab strip and routes
  // child widgets into the active tab.
  | 'tabs'
  // Generic container.  Holds OTHER widgets and renders them inside
  // a styled region.  Drives every flavor that used to be a separate
  // widget kind (app-bar / dock-panel / slideout / foldable-group)
  // by varying its `position`, `variant`, `layout`, and
  // `collapsible` props.  The container does NOT bake in slot-style
  // props (no title, subtitle, logo): the author drops Text, Image,
  // and tool widgets inside to compose whatever header / toolbar /
  // sidebar they want.  This is the same composition model the
  // page-level grid uses; a container is just a sub-region of that
  // grid with its own chrome.
  | 'container'
  // #144: first-class Tool widget. Authors who built a Tool item
  // drop this widget into the layout and pick which tool it
  // invokes, what icon to show, etc. Distinct from Button-bound-
  // to-a-tool (which still works for backward compat) so the
  // mental model matches Search / Print / Layers / etc -- each
  // tool surface is its own widget kind, not a Button binding.
  | 'tool';

// ---- Tool-mode display (#364) ----------------------------------

/**
 * Where a tool-mode panel docks within the runtime viewport.
 * The 9-cell grid mirrors EB's panel arrangement picker.
 */
export type PanelAnchor =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/**
 * Placement strategy:
 *   - 'floating': position absolute, relative to the runtime
 *     container. Scrolls with the page.
 *   - 'fixed': position fixed, relative to the browser viewport.
 *     Stays put on scroll. Useful for sticky tool panels.
 */
/**
 * Where the popover panel anchors at runtime when a tool-mode
 * widget is clicked:
 *   - 'floating': inside the runtime container at one of nine
 *     anchor corners + an offset (the default; gives the author
 *     full control over position).
 *   - 'fixed': pinned to the browser viewport rather than the
 *     runtime container; useful when the app is embedded in a
 *     scrolling parent.
 *   - 'docked-bottom': full-width strip docked along the bottom
 *     edge of the runtime container, height configurable.
 *     Mirrors the map item's attribute-table dock; the runtime
 *     renders a collapse/expand handle so the user can shrink it
 *     to a header strip without losing the layer / query state
 *     inside. Width / anchor / offsetX are ignored in this mode;
 *     only the height applies.
 */
export type PanelPlacement = 'floating' | 'fixed' | 'docked-bottom';

/**
 * Open/close transition for tool-mode panels.
 */
export type PanelAnimation = 'none' | 'fade' | 'slide';

/**
 * Per-widget panel arrangement for tool mode (#364). Mirrors the
 * controls EB's Widget Controller exposes, but applied per-widget
 * here instead of as a single setting on a controller container.
 * That gives authors per-tool flexibility: the Layers panel can
 * dock top-right while the Search panel floats next to its button.
 *
 * All fields are optional; the runtime falls back to sensible
 * defaults (floating, top-right of the runtime container, 360x480,
 * fade animation, no offset).
 */
export interface PanelArrangement {
  placement?: PanelPlacement;
  anchor?: PanelAnchor;
  /** Width in CSS pixels. Default 360. Ignored when
   *  placement = 'docked-bottom' (the panel always spans the
   *  runtime container's full width). */
  width?: number;
  /** Height in CSS pixels. Default 480. */
  height?: number;
  /** Pixel nudge from the anchor corner. Positive values move the
   *  panel inward; the runtime applies the sign for each anchor.
   *  Ignored when placement = 'docked-bottom'. */
  offsetX?: number;
  offsetY?: number;
  animation?: PanelAnimation;
  /**
   * Label rendering for the tool button. 'icon-and-label' (the
   * default) shows the icon plus a small caption underneath, the
   * way Esri Experience Builder's tool buttons render. 'icon-only'
   * drops the caption and falls back to a tooltip + aria-label,
   * so the button can compress to a single icon's worth of space.
   * Useful when packing many tools onto a tight toolbar.
   *
   * Only relevant when the widget is in tool display mode; ignored
   * for panel-mode widgets.
   */
  labelMode?: 'icon-and-label' | 'icon-only';
  /**
   * Author-supplied caption that overrides the tool's default label
   * (Search / Basemaps / Attribute Table / etc.) without changing
   * which widget kind it is.  Useful when an author wants a tool to
   * read "Attributes" instead of "Attribute Table", or a localized
   * caption.  Empty / undefined falls through to the built-in label
   * for the widget kind.
   *
   * The override is rendered everywhere the default label is shown:
   * the button caption (when labelMode === 'icon-and-label'), the
   * popover header, the hover tooltip, and the aria-label.
   */
  labelOverride?: string;
}

/**
 * Widget display modes:
 *   - 'panel': widget renders inline in the canvas grid (existing
 *     behavior). Default for legacy widgets without the field.
 *   - 'tool': widget renders as a small icon button inline; click
 *     opens a popover panel positioned per `panelArrangement`.
 *     Default for newly-stamped map-following widgets so authors
 *     don't have to flip the toggle.
 */
export type DisplayMode = 'panel' | 'tool';

/**
 * Discriminated union of every widget kind's config shape. The
 * runtime + designer narrow on `kind` before reading these fields.
 */
export type CustomWidgetConfig =
  | MapWidgetConfig
  | LegendWidgetConfig
  | LayerListWidgetConfig
  | AttributeTableWidgetConfig
  | TextWidgetConfig
  | ChartWidgetConfig
  | IndicatorWidgetConfig
  | SearchWidgetConfig
  | PrintWidgetConfig
  | SelectWidgetConfig
  | ExportWidgetConfig
  | SplashWidgetConfig
  | BasemapGalleryWidgetConfig
  | ImageWidgetConfig
  | ButtonWidgetConfig
  | DividerWidgetConfig
  | EmbedWidgetConfig
  | BookmarkWidgetConfig
  | CoordinatesWidgetConfig
  | MyLocationWidgetConfig
  | ElevationProfileWidgetConfig
  | MagicOutlineWidgetConfig
  | TimeSliderWidgetConfig
  | CreateFeatureWidgetConfig
  | EditFeatureWidgetConfig
  | DeleteFeatureWidgetConfig
  | TabsWidgetConfig
  | ContainerWidgetConfig
  | ToolWidgetConfig;

/**
 * Time-slider widget config (#87).  Sets the app-wide `at` state
 * that Map / Chart / AttributeTable widgets read via AppTimeContext.
 *
 * - mode 'date' renders a date input with a horizontal slider
 *   between `minDate` and `maxDate` at the given `stepDays` cadence.
 * - mode 'calendar' renders a single date picker without the slider
 *   (lighter UI; useful when the author only wants snap-to-day
 *   navigation, not scrubbing).
 *
 * Both modes anchor the chosen day at end-of-day local time so a
 * "March 5" pick reads what the world looked like at the close of
 * that day, matching the wizard's preview convention.  The widget
 * publishes null when set to "Now" (the default), and a full ISO
 * string when set to any past date.
 */
export interface TimeSliderWidgetConfig {
  kind: 'time-slider';
  mode?: 'date' | 'calendar';
  /** YYYY-MM-DD lower bound for the slider track. */
  minDate?: string;
  /** YYYY-MM-DD upper bound; defaults to "today" at render time. */
  maxDate?: string;
  /** Slider step in days (mode='date' only). Defaults to 1. */
  stepDays?: number;
  /** Optional label override; default 'Time'. */
  label?: string;
  /**
   * #57: animated playback. When true (default), the runtime
   * renders a play / pause button and a speed selector alongside
   * the slider. Tick rate at 1x is one `stepDays` step per
   * second; higher speeds proportionally shorten the interval.
   * Only applies in mode='date' (the calendar mode is a single
   * date picker and has no continuous play semantics).
   */
  playable?: boolean;
  /**
   * #57: behavior when playback reaches `maxDate`. `loop` rewinds
   * to `minDate` and continues; `pause` stops at the end and the
   * user has to hit play again. Defaults to `loop`.
   */
  endBehavior?: 'loop' | 'pause';
  /**
   * #57: available playback multipliers shown in the speed
   * selector. The runtime caps to a sane range; bigger numbers
   * play faster. Defaults to [1, 2, 5, 10]. The user-visible label
   * is `${n}x`.
   */
  speedOptions?: number[];
}

/**
 * Create-feature widget config (#69).  Opens an attribute form for
 * a new row on the chosen target layer.  For point-geometry layers
 * the user clicks once on the bound map to set the location after
 * filling attributes; for table-only (no geometry) layers the form
 * submits directly.  The widget reads AppTimeContext.at and renders
 * disabled when non-null (engine rejects past-target writes).
 */
export interface CreateFeatureWidgetConfig {
  kind: 'create-feature';
  /** Map widget id the click-to-place mode hooks into. */
  mapWidgetId: string;
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /**
   * Optional single-target binding (legacy).  When set, the widget
   * skips the templates picker and immediately enters create mode
   * for the named target.  When omitted (the recommended modern
   * shape), the widget opens a templates palette of every editable
   * target in the bound map -- the author drops one widget per app
   * regardless of how many editable layers it covers.
   */
  targetIndex?: number;
  /** Optional button label override. Default "Add feature". */
  label?: string;
  /** Display mode (panel vs. tool). */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Edit-feature widget config (#70).  Reads the bound map's
 * `selection` state; when exactly one feature is selected, opens
 * an attribute form pre-filled with its properties.  Multi-select
 * is supported as bulk-edit-by-shared-fields in a follow-up; the
 * first slice handles one-at-a-time edits.  Disabled in time-travel
 * mode.
 */
export interface EditFeatureWidgetConfig {
  kind: 'edit-feature';
  mapWidgetId: string;
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /**
   * Optional single-target binding (legacy).  When set, only
   * features in that target are click-editable.  When omitted (the
   * recommended modern shape), every editable target in the bound
   * map participates -- the user clicks any editable feature and
   * the form opens against the layer that feature lives in.
   */
  targetIndex?: number;
  label?: string;
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Delete-feature widget config (#71).  Reads the bound map's
 * selection and offers a Delete button with a count + confirm.
 * Issues one DELETE per selected feature; the engine writes a
 * 'delete' observation rather than truly removing the row, so the
 * deletion is reversible by changing the app-time slider back
 * before the delete timestamp.  Disabled in time-travel mode.
 */
export interface DeleteFeatureWidgetConfig {
  kind: 'delete-feature';
  mapWidgetId: string;
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /**
   * Optional single-target binding (legacy).  When set, only that
   * target's selected features are deleted on confirm.  When
   * omitted (the recommended modern shape), the widget acts against
   * every selected feature across every target in the bound map,
   * dispatching DELETEs per (data_layer, layer) pair.
   */
  targetIndex?: number;
  label?: string;
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface MapWidgetConfig {
  kind: 'map';
  /**
   * Optional map item reference. When set, this widget's basemap +
   * viewport + layer ordering come from that map. When unset, the
   * widget falls back to the app-level `mapId` (CustomAppData.mapId)
   * and finally to a minimal default basemap if neither is set.
   */
  mapId?: string;
  /**
   * Layer subset to render. Each entry indexes into the parent
   * app's `targets`. When undefined, every target is shown.
   */
  showTargets?: number[];
  /** Show the standard zoom in/out + home + locate buttons. */
  showNavigation?: boolean;
}

export interface LegendWidgetConfig {
  kind: 'legend';
  /** id of the map widget on the same page this legend follows.
   *  Required: a free-floating legend with no map reference is
   *  meaningless. */
  mapWidgetId: string;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface LayerListWidgetConfig {
  kind: 'layer-list';
  /** id of the map widget on the same page this layer list controls. */
  mapWidgetId: string;
  /** Allow users to toggle layer visibility. When false, this is a
   *  "see what's loaded" reference panel only. */
  allowToggle?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface AttributeTableWidgetConfig {
  kind: 'attribute-table';
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /** Index into the parent app's `targets` array; identifies the
   *  layer this table renders. */
  targetIndex: number;
  /** Optional map widget id; when set, table selections highlight
   *  + zoom on the linked map. */
  syncWithMapWidgetId?: string;
  /** Maximum rows fetched. Defaults to 200 in the runtime. */
  maxRows?: number;
  /**
   * #261 follow-up: attribute-table joins the map-following crew so
   * authors can drop it on the toolbar instead of stealing a row of
   * grid real estate. When `displayMode === 'tool'`, the widget
   * renders as an icon button and the table opens in a floating
   * panel configured by `panelArrangement`. Default arrangement
   * anchors the panel to the bottom edge of the canvas, matching
   * where the map-item's attribute table docks.
   */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface TextWidgetConfig {
  kind: 'text';
  /** Inline markdown. Rendered with a constrained subset (bold,
   *  italic, links, lists, code) so script injection isn't possible. */
  markdown: string;
  /**
   * One of a small set of presentational presets the designer
   * exposes as a dropdown. Lets the author pick "Header" vs
   * "Body" without diving into custom CSS.
   */
  preset?: 'header' | 'subheader' | 'body' | 'callout';
}

/**
 * How an aggregate number is rendered. Shared by the indicator
 * widget and (later) any other widget that prints a figure, so
 * "1,234.5 ac" formats identically wherever it appears.
 */
export interface NumberFormat {
  /** Fixed decimal places. Omitted = up to 2, trailing zeros dropped. */
  decimals?: number;
  /** Thousands separators, on by default. */
  grouping?: boolean;
  /** Rendered before the number, e.g. "$". */
  prefix?: string;
  /** Rendered after the number, e.g. " ac" or "%". */
  suffix?: string;
  /** Shorten large values: 12,300 -> 12.3K. Off by default because
   *  a count of 1,240 permits is more honest than 1.2K. */
  compact?: boolean;
}

/**
 * Indicator widget: one aggregate value, rendered large, optionally
 * compared against a reference.
 *
 * This is the smallest dashboard primitive and deliberately lives in
 * the same palette as the map and editing widgets: an indicator on a
 * map app is as valid as an indicator on a page of indicators, which
 * is the whole point of not building dashboards as a separate app.
 *
 * The value comes from the server-side aggregate endpoint, so it is
 * scoped to the caller's shares exactly like the features are. A
 * viewer restricted to their own rows sees their own count.
 */
export interface IndicatorWidgetConfig {
  kind: 'indicator';
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /** Index into the app's `targets` (one indicator, one layer). */
  targetIndex: number;
  /** Aggregate to compute. 'count' needs no field. */
  aggregate: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
  /** Numeric field for non-count aggregates. */
  valueField?: string;
  /** Caption under the number. Defaults to a generated description
   *  ("Count of Permits") when unset. */
  label?: string;
  /** Number rendering. */
  format?: NumberFormat;
  /** Superseded at v5 by the source's own scope; see the chart's
   *  note. Kept so an older client's save still parses. */
  followMapWidgetId?: string;
  /**
   * Optional comparison. `value` is a fixed reference (a target, a
   * budget, last year's total). When set, the widget colors itself
   * by whether the aggregate is at or past the reference.
   */
  reference?: {
    value: number;
    /** Which direction counts as good. Drives the color, nothing
     *  else; a neutral choice is 'none'. */
    goodWhen?: 'above' | 'below' | 'none';
    /** Caption for the reference line, e.g. "target". */
    label?: string;
  };
}

/**
 * Numeric binning for a chart's category axis (#27).
 *
 * `groupBy` alone is categorical: it groups on the literal value of an
 * attribute. On a measurement column that produces one group per
 * distinct reading, which is a scatter of one-tall bars, not a
 * distribution. Binning collapses a numeric field into ranges so the
 * chart shows shape.
 *
 * This is the single biggest gap for a scientific reader, who wants
 * the distribution rather than the average. Water quality data is
 * strongly right-skewed; a mean of iron concentration says almost
 * nothing that the histogram does not say better.
 *
 * Three modes, because three different things are known at authoring
 * time:
 *
 *   - `count`: "about twenty bars, whatever the data range is". The
 *     server measures the range and derives the edges. The default,
 *     and the only one an author can pick without knowing the data.
 *   - `width`: "one bar per 0.5 mg/L". For a field with a meaningful
 *     natural unit, where round edges matter more than bar count.
 *   - `edges`: explicit thresholds. Use this to make a histogram's
 *     bars line up with a map's class breaks, so the chart and the
 *     legend beside it are cutting at the same numbers.
 */
export type ChartBin =
  | { field: string; mode: 'count'; count: number }
  | { field: string; mode: 'width'; width: number }
  | { field: string; mode: 'edges'; edges: number[] };

/**
 * A line drawn across a chart at a fixed value (#27).
 *
 * A limit line is how you read a water quality chart: the series is
 * only meaningful against the standard it is being compared to, and a
 * reader forced to hold "0.3 mg/L" in their head while scanning a
 * y-axis is being asked to do the chart's job.
 *
 * `axis` says which way the line runs. 'value' is the usual case: a
 * horizontal rule across a bar or line chart at that measure. On a
 * binned chart 'category' draws it vertically at that position along
 * the binned axis, which is how you show where a limit falls inside a
 * distribution.
 */
export interface ChartReferenceLine {
  value: number;
  /** Caption drawn beside the line, e.g. "EPA limit 0.3 mg/L". */
  label?: string;
  /** Defaults to 'value'. 'category' requires a binned chart. */
  axis?: 'value' | 'category';
  /** Which side of the line is the good side. Drives colour only; a
   *  neutral choice is 'none', which is also the default. */
  goodWhen?: 'above' | 'below' | 'none';
}

export interface ChartWidgetConfig {
  kind: 'chart';
  /**
   * Heading shown on the widget. Every chart used to be titled
   * "Chart", which tells a reader nothing about what they are looking
   * at; four of them on a page is four unlabelled pictures. Unset
   * falls back to a generated description of the query ("Count by
   * Status"), which is honest and usually enough.
   */
  title?: string;
  /** Optional line under the title: a caveat, a unit, a source note. */
  description?: string;
  /**
   * Axis captions. Unset falls back to the grouping field for the
   * category axis and the measure for the value axis. A chart whose
   * axes are unlabelled asks the reader to infer what "43" counts.
   */
  xAxisLabel?: string;
  yAxisLabel?: string;
  /**
   * Superseded at v5 by the source's own `followMapWidgetId`, and no
   * longer read.
   *
   * Scope belongs to the layer, not to each widget that reads it:
   * a source serves many widgets, and a per-widget override asks the
   * author to make the same decision once per tile and get it
   * identical every time. An author who wants a whole-layer total
   * beside a view-scoped one adds a second source on the same layer,
   * which is at least visible in the Layers panel.
   *
   * Kept in the type so an app saved by an older client still parses.
   */
  followMapWidgetId?: string;
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /** Index into targets (one chart binds to one layer). */
  targetIndex: number;
  /**
   * Chart geometry. Bubble / scatter land in a follow-up slice.
   *
   * `bar-horizontal` is the same measure as `bar` turned on its
   * side, and it exists because vertical bars have to rotate or drop
   * their category names once the labels are longer than the bar is
   * wide. Category names read left to right at full size on a
   * horizontal chart, so a field like "Excessive Heat" stays legible
   * in a narrow tile.
   */
  chartType: 'bar' | 'bar-horizontal' | 'line' | 'pie';
  /** Field name to group by (categorical for bar/pie, ordinal for
   *  line). The designer's field picker reads the layer's schema
   *  and offers compatible columns. */
  groupBy?: string;
  /**
   * Aggregation to render per group. 'count' needs no field; every
   * other op requires `valueField`.
   *
   * `countDistinct` counts distinct VALUES of that field rather than
   * records, and its field need not be numeric. On monitoring data
   * that distinction is the difference between a statistic and a
   * finding: "1,480 acidic samples" could be one creek measured
   * monthly for a decade, where "392 acidic sites" is a map.
   */
  aggregate?: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
  /** Numeric field for non-count aggregates. */
  valueField?: string;
  /**
   * Bin a numeric field into ranges instead of grouping on its literal
   * value, turning the chart into a distribution. Adds one category
   * level, so `bin` alone gives a histogram and `groupBy` + `bin`
   * gives one histogram per category.
   *
   * Ignored by pie charts, where a range axis has no meaning.
   */
  bin?: ChartBin;
  /** Fixed lines drawn across the chart: limits, targets, thresholds. */
  referenceLines?: ChartReferenceLine[];
  /**
   * Explicit colour per category, keyed by the label on the axis.
   *
   * Charts otherwise cycle a palette, which makes them legible but
   * means the colours carry no information. This exists so they can:
   * a bar chart of exceedances can paint the health-based limits in
   * the same red the map uses for them and the aesthetic ones in the
   * same ochre, and the reader learns the distinction from the chart
   * instead of being told it in a caption.
   *
   * Categories with no entry fall back to the palette. On a binned
   * chart the keys are the range labels ("0.3 to 1"), which is how a
   * histogram can shade the bars past a limit.
   */
  categoryColors?: Record<string, string>;
}

export interface SearchWidgetConfig {
  kind: 'search';
  /** id of the map widget the search results pan + highlight on.
   *  Required: a search bar with no map target has nowhere to fly. */
  mapWidgetId: string;
  /** Whether to enable Nominatim address geocoding alongside per-
   *  target attribute search. Default true; turning off removes
   *  the address half and leaves a layer-attribute search bar. */
  geocodingEnabled?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface PrintWidgetConfig {
  kind: 'print';
  /** id of the map widget to print. Phase 1 just calls the bound
   *  map's print stylesheet (window.print scoped via CSS); Phase 2
   *  hooks #132's report_template item once it lands. */
  mapWidgetId: string;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
  /** #101 followup: per-app allowlist of print_template item ids
   *  the Print widget exposes in its dropdown.  When undefined OR
   *  empty, the widget falls back to "every print_template the
   *  current user can read" -- useful for orgs that haven't yet
   *  curated per-app lists.  When non-empty, the runtime fetches
   *  only the listed templates (intersection with read access)
   *  so a topic-specific template shared org-wide doesn't appear
   *  in an unrelated app's Print menu just because the user can
   *  see it. */
  templateIds?: string[];
}

export interface SelectWidgetConfig {
  kind: 'select';
  /** id of the map widget the select tool drives. */
  mapWidgetId: string;
  /** Subset of select modes exposed in the panel. Defaults to all
   *  four when omitted. The runtime button order matches this
   *  array order, so authors can promote their preferred mode. */
  modes?: Array<'click' | 'rectangle' | 'polygon' | 'lasso'>;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Splash Screen widget (#111).  Renders a modal dialog once per
 * visit when the web app loads.  Useful for disclaimers, terms
 * of use, welcome messages, branding, and "before you continue"
 * confirmations a la VertiGIS / AGOL splash widgets.
 *
 * Sits on the canvas as a small "Splash" placeholder card in the
 * designer (so the author sees that it exists + can edit it
 * inline), and doesn't paint anything on the runtime canvas --
 * the actual UI is a portal-rendered modal at runtime.
 *
 * Dismissal memory: stored in localStorage keyed by app id +
 * content hash.  When the author edits the splash content, the
 * hash changes and previously-dismissed users see the new
 * version automatically.  No server-side state needed.
 */
export interface SplashWidgetConfig {
  kind: 'splash';
  /** Modal title (plain text). */
  title: string;
  /** Body content stored as markdown (same shape as
   *  TextWidgetConfig.markdown) so we can reuse the existing
   *  RichTextEditor + markdown round-trip. */
  markdown: string;
  /**
   * Modal width preset.
   *   - 'sm'    -> 400px
   *   - 'md'    -> 600px (default)
   *   - 'lg'    -> 800px
   *   - 'custom' -> uses `widthPx`
   */
  size?: 'sm' | 'md' | 'lg' | 'custom';
  /** Used when `size === 'custom'`.  Clamped at runtime so the
   *  modal stays usable on phones (min 280, max 1200). */
  widthPx?: number;
  /** Custom confirm-button label.  Default "OK". */
  confirmLabel?: string;
  /**
   * When true, the modal includes a "Don't show again" checkbox
   * that, when checked at confirm time, writes the dismissal key
   * to localStorage and skips the splash on subsequent visits.
   * Default false: the splash appears every visit.
   */
  allowDismiss?: boolean;
  /**
   * When true, treats the confirm button as required acceptance:
   *   - no close-X button
   *   - escape key does NOT dismiss
   *   - backdrop click does NOT dismiss
   *   - the user MUST click the confirm button
   * Useful for terms-of-service or disclaimer flows where the
   * author wants record that the user actually acknowledged it.
   * Default false: standard dismissable modal.
   */
  requireConfirm?: boolean;
}

/**
 * Export widget (#110).  Renders as a small icon button in
 * tool-display mode; clicking opens a popover with format +
 * scope options that triggers a client-side download via the
 * shared layer-export utility.  Binds to a Map widget so the
 * popover sees the live target list + the bound map's loaded
 * features.
 *
 * Why a dedicated widget rather than just relying on the
 * attribute-table's Export menu (#108): the Export button is a
 * first-class action authors put front-and-center on a
 * deployment ("download the parcels we're looking at").  Hiding
 * it three clicks deep in the attribute-table popover is fine
 * for power users but misses the AGOL-parity moment where
 * "Export" sits next to "Print" on the toolbar.  This widget
 * gives authors that placement.
 */
export interface ExportWidgetConfig {
  kind: 'export';
  /** id of the map widget whose targets we export from. */
  mapWidgetId: string;
  /**
   * Optional default target index (into the bound map's
   * resolvedTargets).  When omitted, the popover prompts the user
   * to pick on each open; when set, the popover defaults to that
   * target and the user can still override.  Useful when the app
   * has a single canonical "export this layer" surface.
   */
  defaultTargetIndex?: number;
  /** Default output format.  Author override; user can change in
   *  the popover.  Defaults to 'xlsx'. */
  defaultFormat?: 'csv' | 'xlsx';
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface BasemapGalleryWidgetConfig {
  kind: 'basemap-gallery';
  /** id of the map widget whose basemap this gallery swaps. */
  mapWidgetId: string;
  /**
   * Optional allowlist of basemap item ids to surface. When
   * undefined, the gallery shows every basemap visible to the
   * caller in the org. Useful for "we want users to choose from
   * these three branded basemaps" scenarios.
   */
  basemapIds?: string[];
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

// ---- Page-element widgets (#361) -------------------------------

/**
 * Static image. Authors pick a File item through the asset picker or
 * paste an external URL; see AssetRef below for the discriminated
 * shapes. The "paste a URL, local upload comes later" note this
 * carried was written before the picker shipped.
 */
export interface ImageWidgetConfig {
  kind: 'image';
  /**
   * Image source. New code paths use the AssetRef discriminated
   * union (file-item id with cached URL, OR a direct external URL)
   * so the system knows which apps depend on which File items.
   * The legacy `url?: string` field below is preserved for older
   * configs that haven't been resaved; runtime + designer fall
   * back to it when `asset` is missing.
   */
  asset?: AssetRef;
  /**
   * Legacy direct URL. Kept for back-compat with existing saved
   * widgets; new configs save through `asset` (AssetPicker emits
   * an AssetRef). The runtime resolves `asset` first, falls back
   * to `url` when `asset` is missing.
   */
  url?: string;
  /** Alt text for accessibility. Empty alt is fine for purely
   *  decorative images; the runtime falls back to '' when omitted. */
  alt?: string;
  /** How the image fits its widget cell. Defaults to 'contain' so
   *  letterboxing is the default and aspect-ratios survive resize. */
  objectFit?: 'contain' | 'cover' | 'fill' | 'none';
  /** Optional click target. Behaves like a Button widget when set:
   *  wraps the image in an <a> with href + target. */
  href?: string;
  /** When true, opens href in a new tab. */
  openInNewTab?: boolean;
}

/**
 * Inline call-to-action button. Two link modes:
 *   - external URL: opens the URL (in a new tab if requested)
 *   - internal page: navigates the runtime to one of the app's
 *     pages by id. Useful for "Next" / "Back" style flows in
 *     multi-page apps.
 */
export interface ButtonWidgetConfig {
  kind: 'button';
  /** Visible label. */
  label: string;
  /**
   * Click target.  Three kinds today:
   *   - 'url'  -> external URL (open in tab or replace location)
   *   - 'page' -> jump to a page within this app
   *   - 'tool' -> run a referenced `tool` item (#90).  The tool's
   *               own `action` declares what runs (open another
   *               item, open a parameterized URL, etc.).  Tools
   *               are reusable across apps; a button is just one
   *               trigger surface for them.
   * The runtime narrows on `linkKind`.
   */
  linkKind?: 'url' | 'page' | 'tool';
  /** External URL (when linkKind='url'). */
  url?: string;
  /** Page id (when linkKind='page'). Falls back to no-op if the
   *  page has been deleted since the button was configured. */
  pageId?: string;
  /** Tool item id (when linkKind='tool').  The runtime fetches the
   *  referenced tool on mount, falls back to a disabled button if
   *  the tool was deleted or the user no longer has read access. */
  toolId?: string;
  /** Visual variant. 'primary' is filled with the app's accent;
   *  'secondary' is outlined. */
  variant?: 'primary' | 'secondary';
  /** Open external links in a new tab. Ignored for page links. */
  openInNewTab?: boolean;
}

/**
 * #144: first-class Tool widget. Authors drop this widget into a
 * layout (toolbar, panel, container, page grid) and bind it to a
 * Tool item. Cleaner mental model than the legacy
 * Button-with-linkKind='tool' path: the icon + label + display
 * variant all live on the widget instance, so the same Tool can
 * appear with different icons in different apps without mutating
 * the Tool item itself.
 *
 * Backward compat: ButtonWidgetConfig with linkKind='tool' keeps
 * working. New authoring flows surface Tool as a first-class
 * palette tile instead.
 */
export interface ToolWidgetConfig {
  kind: 'tool';
  /** Tool item id. The runtime fetches the referenced tool on
   *  mount, falls back to a disabled state if the tool was
   *  deleted or the user no longer has read access. */
  toolId?: string;
  /**
   * Curated lucide icon name shown in toolbar contexts.  Empty
   * string falls through to a generic Wand icon so the widget
   * always has something to render.  Authors pick from the same
   * curated subset used by the layer-symbol picker; the runtime
   * reads MAP_ICONS to resolve.
   */
  iconName?: string;
  /**
   * Optional inline label.  When omitted, the runtime falls back
   * to the bound tool's title.  Useful when the author wants a
   * shorter inline name without renaming the tool itself.
   */
  label?: string;
  /**
   * Whether to show the label alongside the icon in toolbar
   * contexts.  Default: false (icon-only) so the widget reads as
   * part of the toolbar's visual language.  Authors can flip on
   * for a more conventional "icon + text" button look.  In
   * standalone variant the label is always shown.
   */
  showLabel?: boolean;
  /**
   * Visual variant.
   *   - 'toolbar': icon-only round button, sized for inline use
   *     in a Container with layout='horizontal'.
   *   - 'standalone': full button with icon + label (mirrors the
   *     legacy Button-bound-to-tool look).
   * Default: 'toolbar'.
   */
  display?: 'toolbar' | 'standalone';
  /** Variant for the standalone display.  Ignored when display
   *  is 'toolbar'. */
  variant?: 'primary' | 'secondary';
}

/**
 * Horizontal rule. Lets authors break up a page without resorting
 * to a Text widget with `---` markdown.
 */
export interface DividerWidgetConfig {
  kind: 'divider';
  /** Stroke thickness in px. Default 1. */
  thicknessPx?: number;
  /** CSS color for the stroke. Defaults to the app's border color. */
  color?: string;
  /** Style of the rule. */
  style?: 'solid' | 'dashed' | 'dotted';
}

/**
 * Embedded iframe content (videos, dashboards, forms, slide decks).
 * The author pastes a URL; the runtime renders an iframe with a
 * conservative sandbox. Cross-origin embedding obeys the target's
 * X-Frame-Options / CSP -- some sites refuse to embed and the
 * author sees a blank frame. We can't probe ahead-of-time without
 * a server-side check, so we surface a hint instead and trust the
 * author to verify.
 */
export interface EmbedWidgetConfig {
  kind: 'embed';
  /** Iframe src. http(s) only; the designer rejects non-http URLs. */
  url?: string;
  /** Optional title attribute for assistive tech. */
  title?: string;
  /** When true, the iframe runs in a stricter sandbox (allow-same-
   *  origin off). Authors who embed trusted dashboards typically
   *  leave this off; opt in for arbitrary third-party URLs. */
  strict?: boolean;
}

// ---- Mapcentric quick wins (#361 part 2) ----------------------

/**
 * One-click viewport bookmarks for a map. Authors capture the bound
 * Map widget's current viewport at design time + give it a name; at
 * runtime each entry is a button that flies the bound map there.
 *
 * Inspired by Esri's Bookmark widget, scoped to the basics for v1
 * (no folder grouping, no per-entry thumbnail, no time-aware
 * extents). Add those if real authors miss them.
 */
export interface BookmarkWidgetConfig {
  kind: 'bookmark';
  /** id of the Map widget this bookmark list flies. */
  mapWidgetId: string;
  /** Saved viewports. Order is the runtime render order. */
  bookmarks: Array<{
    /** Stable id. Lets the designer reorder + delete without
     *  losing identity. */
    id: string;
    /** Display name shown in the runtime button list. */
    name: string;
    /** [lng, lat] center. Same shape MapData uses. */
    center: [number, number];
    /** Zoom level. */
    zoom: number;
    /** Optional camera bearing in degrees clockwise from north. */
    bearing?: number;
    /** Optional camera pitch in degrees from vertical. */
    pitch?: number;
  }>;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Live coordinate readout. Tracks the cursor position over the
 * bound Map widget and renders the formatted lat/lon. Optional
 * zoom-level chip for "where am I in scale" feedback.
 *
 * v1 supports decimal-degrees and degrees-minutes-seconds. MGRS /
 * UTM are typed but deferred -- they're a half-day of conversion
 * code each and most users want plain DD.
 */
export interface CoordinatesWidgetConfig {
  kind: 'coordinates';
  /** id of the Map widget whose pointer position this tracks. */
  mapWidgetId: string;
  /** Display format. Defaults to 'dd' (decimal degrees). */
  format?: 'dd' | 'dms';
  /** Decimal places for DD; whole-second precision for DMS.
   *  Default: 5 for DD, 0 for DMS. */
  precision?: number;
  /** When true, also displays a small "Zoom: N.NN" chip alongside
   *  the coordinates. Default false. */
  showZoom?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * "Show my location" button. On click, requests the browser's
 * Geolocation API and flies the bound Map widget to the result at
 * a configurable zoom. Drops a temporary marker so the user can
 * see where the device thinks it is.
 *
 * v1 is one-shot (single click = single fly). Continuous-tracking
 * mode (watch position, follow as user moves) is a v2 enhancement.
 */
export interface MyLocationWidgetConfig {
  kind: 'my-location';
  /** id of the Map widget to fly + drop the marker on. */
  mapWidgetId: string;
  /** Zoom level the bound map flies to on success. Default 14. */
  zoomLevel?: number;
  /** When true, the marker stays visible until the user clicks
   *  the button again or the page reloads. Default true. */
  keepMarker?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Elevation profile tool. Renders a toolbar toggle; when active,
 * the user draws a line on the bound Map widget and gets a chart
 * of the ground elevation along it, read from the map's elevation
 * (terrain) layer. Same engine as the map builder's profile tool,
 * so behavior matches everywhere.
 */
export interface ElevationProfileWidgetConfig {
  kind: 'elevation-profile';
  /** id of the Map widget the user draws the line on. */
  mapWidgetId: string;
  /** Optional inline label next to the icon. Default: icon only. */
  showLabel?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Magic outline tool. Renders a toolbar toggle; when active, the
 * user clicks a thing on the bound map's imagery and its traced
 * polygon lands in an editable target layer via the normal
 * create-feature path. The target is chosen from the app's
 * editable layers (polygon geometry only); when more than one
 * exists the author pins one here, else the single one is used.
 */
export interface MagicOutlineWidgetConfig {
  kind: 'magic-outline';
  /** id of the Map widget the user clicks on. */
  mapWidgetId: string;
  /**
   * Which data source this widget reads. Supersedes `targetIndex`.
   *
   * Both are present for one release so an app saved by an older
   * client still binds correctly; the runtime prefers this and falls
   * back to the index. See AppDataSource.id for why position was the
   * wrong binding.
   */
  sourceId?: string;
  /**
   * Index into the app's `targets` array for the polygon layer the
   * outline is written to. Omitted = use the only editable polygon
   * target in the bound map.
   */
  targetIndex?: number;
  /** Optional inline label next to the icon. Default: icon only. */
  showLabel?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

// ---- Tabs container (#362) ------------------------------------

/**
 * Tabs container. A widget that holds N tabs, each tab holding its
 * own array of CustomWidgets. Anti-EB: deliberately simpler than
 * Section + Views. Authors drag the Tabs widget onto the canvas,
 * pick the active tab, drop child widgets into the content area of
 * that tab. Each tab can hold any of the standard widget kinds
 * (Map, Layers, Text, etc.) and they stack vertically inside.
 *
 * v1 limitations:
 *   - Nested widgets stack vertically in the order they were
 *     dropped. Drag-to-reorder inside a tab is a follow-up.
 *   - No nested tabs (tabs-inside-tabs). The runtime will render
 *     them but the designer drop-routing only goes one level deep
 *     to keep the mental model simple.
 *   - No EB-style sub-grid (each tab a 12-column grid). Stack
 *     layout covers most "tabbed info panel" use cases; sub-grid
 *     can come if real authors miss it.
 */
export interface TabsWidgetConfig {
  kind: 'tabs';
  /** Ordered list of tabs. Always non-empty in practice; the
   *  designer initializes a fresh widget with one default tab. */
  tabs: Array<{
    /** Stable id; preserved across rename + reorder. */
    id: string;
    /** Display name in the tab strip. */
    title: string;
    /** Child widgets for this tab. Rendered in document order. */
    widgets: CustomWidget[];
  }>;
}

// ---- Generic container widget ---------------------------------
//
// A container holds a `widgets: CustomWidget[]` array of children
// and renders them inside a styled region.  The region's behavior
// (sticky top bar, side dock, slideout overlay, inline accordion,
// etc.) is fully prop-driven so a single widget kind covers what
// used to be four separate ones (app-bar / dock-panel / slideout /
// foldable-group).
//
// The container does NOT bake in slot props (no title, no subtitle,
// no logo URL).  An author who wants a header label drops a Text
// widget at the top.  An author who wants a logo drops an Image
// widget.  An author who wants tools drops the tool widgets in
// directly.  This keeps the framework out of the business of
// deciding what belongs inside.
//
// Children inside a container ignore `layout.col / row / colSpan /
// rowSpan` — the container's own `layout` prop (row / column)
// determines child placement.  The grid coords stay on the widget
// object so the same widget can be dragged out of a container back
// onto the page grid without losing position metadata.

/**
 * Visual chrome variants for a container.
 *   - 'elevated' (default for sticky positions): branded header
 *     surface (theme `--app-header-*` tokens), subtle shadow.
 *   - 'glass': translucent + backdrop blur over the body surface.
 *     Good for map-first layouts where the map should read as the
 *     dominant surface.
 *   - 'flat': borderless flush on surface-1.  Minimal themes.
 *   - 'none': transparent.  No background, no border, no shadow.
 *     The container becomes an invisible layout region; useful
 *     for grouping without visual chrome.
 */
export type ContainerVariant = 'elevated' | 'glass' | 'flat' | 'none';

/**
 * Where the container sits in the runtime layout.
 *   - 'inline' (default): occupies its placed grid cell on the
 *     page, just like any other widget.
 *   - 'sticky-top' / 'sticky-bottom': spans the page width and
 *     pins to the viewport's top/bottom edge.  Children flow
 *     horizontally by default.
 *   - 'dock-left' / 'dock-right': occupies a fixed-width column
 *     along the page edge, alongside the canvas.  Children flow
 *     vertically by default.  Pair with `collapsible: true` to
 *     get the shrink-to-rail affordance.
 *   - 'overlay-trigger': hidden by default; a trigger button at
 *     the container's `edge` opens the container as an overlay
 *     drawer.  Use for tool palettes the author doesn't want
 *     taking permanent space.
 *   - 'menu' (#104): renders as a single tool-sized button.  Click
 *     opens a small popover below the trigger showing the
 *     container's children stacked vertically -- each child is a
 *     fully-functioning tool button.  Use for packing related
 *     actions like Add/Edit/Delete under a single "Edit" icon.
 *     `triggerLabel` + `triggerIcon` style the button; children
 *     render as menu items via the same renderChild path.
 */
export type ContainerPosition =
  | 'inline'
  | 'sticky-top'
  | 'sticky-bottom'
  | 'dock-left'
  | 'dock-right'
  | 'overlay-trigger'
  | 'menu';

/**
 * Direction children flow inside the container body.
 */
export type ContainerLayout = 'row' | 'column';

/**
 * Generic container widget.  Renders its children inside a styled
 * region whose chrome is fully prop-driven.  See the block comment
 * above for the composition model.
 */
export interface ContainerWidgetConfig {
  kind: 'container';
  /** Child widgets rendered inside the container's body. */
  widgets: CustomWidget[];
  /** Where the container sits in the page layout.  Defaults to
   *  'inline' (the container just occupies its grid cell). */
  position?: ContainerPosition;
  /** Edge the overlay-trigger drawer slides in from.  Ignored for
   *  every other `position`.  Defaults to 'left'. */
  edge?: 'left' | 'right' | 'top' | 'bottom';
  /** Direction children flow.  Defaults to 'row' for sticky-top /
   *  sticky-bottom (action-bar feel) and 'column' for everything
   *  else.  Authors can override per-container. */
  layout?: ContainerLayout;
  /** Visual chrome.  Defaults to 'elevated' for sticky / dock /
   *  overlay-trigger; 'flat' for inline. */
  variant?: ContainerVariant;
  /** Show a chevron toggle that collapses the container.  For
   *  dock-left / dock-right this shrinks to a ~44px rail.  For
   *  inline + sticky-top / sticky-bottom it hides children below
   *  a header strip (accordion).  Ignored for overlay-trigger
   *  (the container is already hidden when not triggered). */
  collapsible?: boolean;
  /** Initial collapsed state when `collapsible: true`.  Defaults
   *  to false. */
  defaultCollapsed?: boolean;
  /** Fixed width in CSS px.  For dock-left / dock-right this is
   *  the panel's width when open (default 280).  For overlay-
   *  trigger from 'left' / 'right' edges, the drawer's width
   *  (default 320). */
  widthPx?: number;
  /** Fixed height in CSS px.  For sticky-top / sticky-bottom this
   *  caps the bar's height (default fits the children).  For
   *  overlay-trigger from 'top' / 'bottom' edges, the drawer's
   *  height (default 320). */
  heightPx?: number;
  /** Overlay-trigger only: label on the trigger button rendered
   *  at the container's `edge` when the drawer is closed.
   *  Defaults to 'Tools'. */
  triggerLabel?: string;
  /** Overlay-trigger only: icon hint for the trigger button.
   *  Defaults vary by `edge`. */
  triggerIcon?: 'menu' | 'layers' | 'tools' | 'filter';
}

/**
 * Freshly-created Custom Web App. One blank page with no widgets;
 * the designer prompts the author to drop a widget on first open.
 */
export const DEFAULT_CUSTOM_APP: CustomAppData = {
  version: 4,
  targets: [],
  pages: [
    {
      id: 'home',
      title: 'Home',
      widgets: [],
    },
  ],
};

/**
 * Migrate a CustomAppData to the latest schema version. Each bump
 * scales every widget layout coordinate so the same physical layout
 * round-trips through a finer designer grid:
 *   v1: 12 col / 48px row
 *   v2: 24 col / 24px row      (2x v1)
 *   v3: 48 col / 12px row      (2x v2)
 *   v4: 192 col / 3px row      (4x v3, #95)
 *
 * Each step was driven by user feedback that the snap stops were
 * too coarse for precise placement.
 *
 * Idempotent: calling on an already-current app is a no-op. Chain
 * upgrades (a v1 app gets v1->v2 then v2->v3 then v3->v4 on load).
 * Caller should persist the result back to the item on the next save
 * (the designer's setApp(initial) flow handles that automatically).
 *
 * Recurses through Tabs widgets (#362) + Container widgets (#92) so
 * nested children also pick up the new grid coordinates.
 */
/**
 * Deterministic source id for the Nth target at migration time.
 *
 * Deterministic on purpose. The migrator runs on every load and only
 * persists on the next save, so a random id would differ between two
 * loads of the same unsaved app. Nothing observes that today, but
 * "the ids change when you reload" is the kind of property that turns
 * into a bug the moment anything starts remembering one.
 *
 * Newly added sources use a random id instead, so they can never
 * collide with a future migration's `s2`.
 */
function migratedSourceId(index: number): string {
  return `s${index}`;
}

/** Mint an id for a source the author adds after migration. */
export function newSourceId(): string {
  return `src_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * v4 to v5: targets become sources, and scope moves onto them.
 *
 * Mechanical, and correct exactly once: at migration time, before any
 * reorder or removal has had a chance to shift the indices out from
 * under the widgets. That is the bug this migration exists to end, so
 * it has to happen while position is still trustworthy.
 *
 * Three moves:
 *   - each target becomes a source with a stable id;
 *   - each widget's `targetIndex` becomes `sourceId` by position,
 *     with `targetIndex` left in place for one release so an app this
 *     client saves still opens in an older one;
 *   - the app-level `followMapWidgetId` (v0.9.46, one release old) is
 *     copied onto every source and dropped. It answered the right
 *     question in the wrong place, and two mechanisms for one
 *     question is how the per-widget mess started.
 *
 * An out-of-range index is left unbound rather than clamped to source
 * zero: a widget pointing at a layer that is not there should render
 * its empty state and say so, not quietly answer about a different
 * layer.
 */
function migrateTargetsToSources(cur: CustomAppData): CustomAppData {
  const legacyFollow = (cur as { followMapWidgetId?: string })
    .followMapWidgetId;
  const sources: AppDataSource[] = (cur.targets ?? []).map((t, i) => ({
    id: migratedSourceId(i),
    layer: t,
    ...(legacyFollow !== undefined
      ? { followMapWidgetId: legacyFollow }
      : {}),
  }));
  const bindWidget = (w: CustomWidget): CustomWidget => {
    const cfg = w.config as { targetIndex?: unknown; sourceId?: unknown };
    let next = w;
    if (
      cfg.sourceId === undefined &&
      typeof cfg.targetIndex === 'number' &&
      cfg.targetIndex >= 0 &&
      cfg.targetIndex < sources.length
    ) {
      next = {
        ...w,
        config: {
          ...w.config,
          sourceId: sources[cfg.targetIndex]!.id,
        } as CustomWidget['config'],
      };
    }
    return mapWidgetChildren(next, bindWidget);
  };
  const migrated: CustomAppData = {
    ...cur,
    version: 5,
    sources,
    pages: cur.pages.map((p) => ({
      ...p,
      widgets: p.widgets.map(bindWidget),
    })),
  };
  delete (migrated as { followMapWidgetId?: string }).followMapWidgetId;
  return migrated;
}

/**
 * Apply `fn` to a widget's nested children (container children and
 * tab contents) and return the widget with them replaced.
 *
 * Mirrors updateWidgetDeep's walk. A migration that only touched
 * page-level widgets would leave a chart inside a tab bound to
 * nothing, which is the failure mode nested layouts hide best.
 */
function mapWidgetChildren(
  w: CustomWidget,
  fn: (child: CustomWidget) => CustomWidget,
): CustomWidget {
  const cfg = w.config as {
    widgets?: CustomWidget[];
    tabs?: Array<{ widgets?: CustomWidget[] }>;
  };
  if (Array.isArray(cfg.widgets)) {
    return {
      ...w,
      config: {
        ...w.config,
        widgets: cfg.widgets.map(fn),
      } as CustomWidget['config'],
    };
  }
  if (Array.isArray(cfg.tabs)) {
    return {
      ...w,
      config: {
        ...w.config,
        tabs: cfg.tabs.map((t) => ({
          ...t,
          widgets: (t.widgets ?? []).map(fn),
        })),
      } as CustomWidget['config'],
    };
  }
  return w;
}

export function migrateCustomAppData(data: CustomAppData): CustomAppData {
  let cur = data;
  if (cur.version === 1) {
    cur = {
      ...cur,
      version: 2,
      pages: cur.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map((w) => migrateWidgetLayout(w, 2)),
      })),
    };
  }
  if (cur.version === 2) {
    cur = {
      ...cur,
      version: 3,
      pages: cur.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map((w) => migrateWidgetLayout(w, 2)),
      })),
    };
  }
  if (cur.version === 3) {
    cur = {
      ...cur,
      version: 4,
      pages: cur.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map((w) => migrateWidgetLayout(w, 4)),
      })),
    };
  }
  if (cur.version === 4) {
    cur = migrateTargetsToSources(cur);
  }
  // #99: spread-normalize.  Containers that hold all their children
  // at the (1, 1, 1, 1) placeholder (the historical default for
  // widgets dragged into a container) now get explicit cols / rows
  // spread evenly along the container's primary axis.  Lets the
  // free-position FlowContainer render them in their natural visual
  // positions and lets the designer's drag gesture compute correct
  // deltas from a real starting point.  Idempotent: a container
  // that already has any child at col != 1 (or row != 1 for column
  // layout) is left alone.  This runs on every load -- no version
  // bump needed because the result is identical for already-spread
  // data.
  cur = {
    ...cur,
    pages: cur.pages.map((p) => ({
      ...p,
      widgets: p.widgets.map(spreadContainerChildren),
    })),
  };
  return cur;
}

/**
 * #99: recursively walk a widget tree and spread each container's
 * children evenly along its primary axis if every child sits at the
 * origin placeholder.  Children at index i of n get axis value
 * 1 + round((i / (n-1)) * 191), so a 4-tool app-bar maps to cols
 * 1, 65, 128, 192 (visually: left edge, first third, second third,
 * right edge).  Non-row/column containers (overlay-trigger, inline)
 * and tabs are left alone -- they don't use the free-position axis
 * for child layout.
 */
function spreadContainerChildren(w: CustomWidget): CustomWidget {
  let next = w;
  if (w.kind === 'container' && w.config.kind === 'container') {
    const cfg = w.config;
    const layout = cfg.layout ?? 'column';
    const pos = cfg.position ?? 'inline';
    const isFlow =
      pos === 'sticky-top' ||
      pos === 'sticky-bottom' ||
      pos === 'inline' ||
      pos === 'dock-left' ||
      pos === 'dock-right';
    if (isFlow && cfg.widgets.length > 1) {
      const axisKey: 'col' | 'row' = layout === 'row' ? 'col' : 'row';
      const everyAtOrigin = cfg.widgets.every(
        (c) => (c.layout[axisKey] ?? 1) === 1,
      );
      if (everyAtOrigin) {
        const n = cfg.widgets.length;
        const respread = cfg.widgets.map((c, i) => ({
          ...c,
          layout: {
            ...c.layout,
            [axisKey]: Math.max(
              1,
              Math.min(192, Math.round((i / (n - 1)) * 191) + 1),
            ),
          },
        }));
        next = {
          ...w,
          config: { ...cfg, widgets: respread },
        } as CustomWidget;
      }
    }
  }
  // Recurse into nested containers + tabs regardless of whether the
  // outer widget was respread.
  const cfg2 = next.config as { widgets?: CustomWidget[] };
  if (Array.isArray(cfg2.widgets)) {
    next = {
      ...next,
      config: {
        ...next.config,
        widgets: cfg2.widgets.map(spreadContainerChildren),
      } as CustomWidget['config'],
    };
  }
  if (next.kind === 'tabs' && next.config.kind === 'tabs') {
    next = {
      ...next,
      config: {
        ...next.config,
        tabs: next.config.tabs.map((t) => ({
          ...t,
          widgets: t.widgets.map(spreadContainerChildren),
        })),
      },
    };
  }
  return next;
}

/**
 * Scale every layout coordinate by `factor` (2 for v1->v2 / v2->v3,
 * 4 for v3->v4).  Preserves the physical layout across grid bumps:
 * a widget at v3 col=1, colSpan=48 maps to v4 col=1, colSpan=192,
 * keeping its visual size identical.  Recurses through Tabs +
 * Container children so nested layouts migrate too (legacy
 * containers like app-bar / dock-panel are no longer in the schema
 * after #92, but if an older blueprint still carries them we walk
 * any `config.widgets` array regardless of the parent's kind).
 */
function migrateWidgetLayout(
  w: CustomWidget,
  factor: number,
): CustomWidget {
  const next: CustomWidget = {
    ...w,
    layout: {
      col: ((w.layout.col - 1) * factor) + 1,
      row: ((w.layout.row - 1) * factor) + 1,
      colSpan: w.layout.colSpan * factor,
      rowSpan: w.layout.rowSpan * factor,
    },
  };
  const cfg = next.config as { widgets?: CustomWidget[] };
  if (Array.isArray(cfg.widgets)) {
    next.config = {
      ...next.config,
      widgets: cfg.widgets.map((c) => migrateWidgetLayout(c, factor)),
    } as CustomWidget['config'];
  }
  if (w.kind === 'tabs' && w.config.kind === 'tabs') {
    next.config = {
      ...w.config,
      tabs: w.config.tabs.map((t) => ({
        ...t,
        widgets: t.widgets.map((c) => migrateWidgetLayout(c, factor)),
      })),
    };
  }
  return next;
}
