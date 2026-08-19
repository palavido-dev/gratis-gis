// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * App templates: pre-configured CustomAppData instances that seed
 * new Custom Web App items with a thoughtful layout, a theme, and
 * a sensible widget set. Authors pick a template in the new-item
 * wizard; the item gets created from the template's seed, and the
 * author can save-as-is, customize a few inputs (title, map
 * binding, theme), or open Advanced mode to edit anything.
 *
 * Critical design constraint: templates are pre-configured
 * CustomAppData instances. They use the SAME widget kinds the
 * freeform path uses. Anything in a template can be built from
 * scratch in the freeform Custom Web App; anything in the freeform
 * path can be saved as a template. No template-only widgets, no
 * template-only rendering paths.
 *
 * All structural chrome (top bars, side docks, overlay drawers,
 * accordion sections) is expressed via the single generic
 * `container` widget with appropriate `position` / `variant` /
 * `layout` / `collapsible` props.  Templates do not stamp
 * label widgets inside containers by default: the author can drop
 * a Text widget into any container if they want a header.  Keeping
 * the seed minimal matches the "pure container" model -- the
 * framework provides a region; the author composes its contents.
 *
 * The `mapId` field is always left blank in the seed: the wizard
 * asks the author to pick a map item (or seeds it from a passed
 * default) before persisting. Same for any target binding fields
 * (the seed includes empty / placeholder values that the wizard
 * fills in.
 */
import type { CustomAppData, CustomWidget } from './custom-app';

/**
 * Stable id for a template; persisted in analytics + wizard URLs.
 * Names describe the LAYOUT / INTENT of the template (sidebar
 * explorer, showcase map, compact drawer, blank) rather than a
 * specific data topic. Topic examples live in the template's
 * description + use lines instead; a "Sidebar Explorer" is just
 * as good for asset inventories as it is for parcel viewers, so
 * locking the name to one topic narrows the apparent fit.
 *
 * The earlier topic-named ids (parcel-viewer, public-info-map,
 * field-inspection) are kept as aliases so any in-flight test
 * apps that referenced them still resolve. New saves write the
 * layout-named ids.
 */
export type AppTemplateId =
  | 'blank-canvas'
  | 'kpi-dashboard'
  | 'ops-board'
  | 'sidebar-explorer'
  | 'showcase-map'
  | 'compact-drawer'
  // Legacy aliases for templates created before the layout-named
  // rename. Kept resolvable; getAppTemplate maps these to their
  // new equivalents.
  | 'blank'
  | 'parcel-viewer'
  | 'public-info-map'
  | 'field-inspection';

/**
 * Metadata + seed function for one template. The seed is a function
 * (not a static object) so we can stamp fresh widget ids per
 * instance; otherwise two apps from the same template would share
 * widget ids and the designer's selection state would get confused.
 */
export interface AppTemplate {
  id: AppTemplateId;
  label: string;
  description: string;
  /**
   * Short tagline / use-case description rendered in the template
   * gallery underneath the visual preview.
   */
  use: string;
  /**
   * Tags shown as small pills under the title. Used for filtering
   * the gallery + giving the author a quick read on what's in the
   * template.
   */
  tags: string[];
  /** Build a fresh CustomAppData seeded from this template. */
  seed: () => CustomAppData;
}

/**
 * Mint a short random widget id. Mirrors the designer's
 * convention; templates use this so every stamped widget has a
 * unique id within the seeded app.
 */
function wid(): string {
  return `w_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generic helper for placing a child widget inside a container.
 * Children inside a container ignore their layout.col/row, but the
 * shape needs to be present on the widget envelope. We stamp a
 * (1, 1, 1, 1) placeholder.
 */
function childWidget(
  kind: CustomWidget['kind'],
  config: CustomWidget['config'],
): CustomWidget {
  return {
    id: wid(),
    kind,
    layout: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    config,
  };
}

/**
 * Default panel-arrangement helper used by templates when stamping
 * tool-mode widgets that get popovers. Keeps the templated seeds
 * concise; the runtime falls back to its own defaults for any
 * fields left undefined.
 */
function toolPanel(anchor: 'top-right' | 'bottom-center' | 'top-center') {
  return {
    placement: 'floating' as const,
    anchor,
    width: anchor === 'bottom-center' ? 720 : 320,
    height: anchor === 'bottom-center' ? 280 : 420,
    offsetX: 12,
    offsetY: 12,
    animation: 'fade' as const,
  };
}

/**
 * Cluster a row-container's tool widgets to the right edge of the
 * 192-col canvas.
 *
 * Background: spreadContainerChildren (custom-app.ts) sees children
 * sitting at the (1, 1, 1, 1) placeholder and distributes them
 * evenly across the container's primary axis. That gave starter
 * templates a stretched-out toolbar with awkward gaps between every
 * tool button -- the opposite of what most map-app authors expect.
 *
 * AGO ships toolbars on the right; matching that pattern by default
 * is the right call (and the WV Parcel Viewer's own ad-hoc layout
 * already moved tools there manually). Spacing is 5 cols apart with
 * the rightmost tool at col 187, leaving ~5 cols of right margin so
 * the icon + label don't crash into the chrome edge.
 *
 * Returns the same widgets array with each child's `layout.col`
 * patched. The spread pass sees a non-1 col and leaves the layout
 * alone, so the cluster sticks.
 */
function rightCluster(widgets: CustomWidget[]): CustomWidget[] {
  const RIGHTMOST_COL = 187;
  const STEP = 5;
  const n = widgets.length;
  return widgets.map((w, i) => ({
    ...w,
    layout: {
      ...w.layout,
      col: RIGHTMOST_COL - (n - 1 - i) * STEP,
      row: 1,
      colSpan: 1,
      rowSpan: 1,
    },
  }));
}

/**
 * Sidebar Explorer template.  A working layout for parcel viewers,
 * asset inventories, and "browse a map by toggling layers" apps:
 *
 *   - Top sticky container (position='sticky-top', layout='row') with
 *     Search / Basemaps / Attribute Table / Print as tool widgets.
 *   - Left docked container (position='dock-left', layout='column',
 *     collapsible) with a LayerList.  Collapses to a rail when the
 *     user wants the map to take the full width.
 *   - Map widget fills the remaining canvas.
 *
 * The author can drag a Text widget into the top container if they
 * want a title -- the container itself stays a pure layout region.
 */
function parcelViewerSeed(): CustomAppData {
  const mapId = wid();

  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 320,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const print = childWidget('print', {
    kind: 'print',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });

  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const topBar: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 16 },
    config: {
      kind: 'container',
      position: 'sticky-top',
      layout: 'row',
      variant: 'elevated',
      widgets: rightCluster([search, basemap, attrTable, print]),
    },
  };
  const leftDock: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 17, colSpan: 48, rowSpan: 240 },
    config: {
      kind: 'container',
      position: 'dock-left',
      layout: 'column',
      variant: 'flat',
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
      widgets: [layerList],
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 256 },
    config: { kind: 'map' },
  };

  return {
    version: 4,
    themePresetId: 'default',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [topBar, leftDock, map],
      },
    ],
  };
}

/**
 * Showcase Map template.  Map-first, minimal chrome:
 *
 *   - Top sticky container with 'glass' variant for translucent
 *     floating chrome over the map.  Search + Layers + Basemap
 *     as tool widgets.
 *   - Map widget fills the canvas.
 *
 * Good for "look at this map" presentations where the map is the
 * dominant surface.
 */
function publicInfoMapSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });

  const topBar: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 16 },
    config: {
      kind: 'container',
      position: 'sticky-top',
      layout: 'row',
      variant: 'glass',
      widgets: rightCluster([search, layerList, basemap]),
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 256 },
    config: { kind: 'map' },
  };

  return {
    version: 4,
    themePresetId: 'aurora',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [topBar, map],
      },
    ],
  };
}

/**
 * Compact Drawer template.  Map-first with a drawer that slides in
 * from the left on demand.  Top sticky container carries a few
 * tools; an overlay-trigger container holds the layer list (hidden
 * until the user opens the drawer).
 */
function fieldInspectionSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const myLocation = childWidget('my-location', {
    kind: 'my-location',
    mapWidgetId: mapId,
    zoomLevel: 16,
    keepMarker: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 320,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const topBar: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 16 },
    config: {
      kind: 'container',
      position: 'sticky-top',
      layout: 'row',
      variant: 'elevated',
      widgets: rightCluster([search, myLocation, attrTable]),
    },
  };
  const drawer: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 17, colSpan: 16, rowSpan: 240 },
    config: {
      kind: 'container',
      position: 'overlay-trigger',
      edge: 'left',
      layout: 'column',
      variant: 'elevated',
      triggerLabel: 'Tools',
      triggerIcon: 'tools',
      widthPx: 320,
      widgets: [layerList],
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 256 },
    config: { kind: 'map' },
  };

  return {
    version: 4,
    themePresetId: 'slate',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [topBar, map, drawer],
      },
    ],
  };
}

/**
 * #22: Editor template.  A working app for staff who add / edit /
 * delete features.  Top sticky container with Search / Select /
 * Basemap / Attribute Table tools; left docked container with the
 * LayerList; map fills the rest.
 */
function editorWorkspaceSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const select = childWidget('select', {
    kind: 'select',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 360,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const topBar: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 16 },
    config: {
      kind: 'container',
      position: 'sticky-top',
      layout: 'row',
      variant: 'elevated',
      widgets: rightCluster([search, select, basemap, attrTable]),
    },
  };
  const leftDock: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 17, colSpan: 48, rowSpan: 240 },
    config: {
      kind: 'container',
      position: 'dock-left',
      layout: 'column',
      variant: 'flat',
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
      widgets: [layerList],
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 256 },
    config: { kind: 'map' },
  };

  return {
    version: 4,
    themePresetId: 'slate',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [topBar, leftDock, map],
      },
    ],
  };
}

/**
 * #22: Viewer template.  Read-only audience-facing app.  Top sticky
 * container with Search / Basemap / Print; left docked container
 * with the LayerList (toggle visibility only); no attribute table
 * by default.
 */
function viewerReadonlySeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const print = childWidget('print', {
    kind: 'print',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const topBar: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 16 },
    config: {
      kind: 'container',
      position: 'sticky-top',
      layout: 'row',
      variant: 'elevated',
      widgets: rightCluster([search, basemap, print]),
    },
  };
  const leftDock: CustomWidget = {
    id: wid(),
    kind: 'container',
    layout: { col: 1, row: 17, colSpan: 48, rowSpan: 240 },
    config: {
      kind: 'container',
      position: 'dock-left',
      layout: 'column',
      variant: 'flat',
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
      widgets: [layerList],
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 192, rowSpan: 256 },
    config: { kind: 'map' },
  };

  return {
    version: 4,
    themePresetId: 'default',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [topBar, leftDock, map],
      },
    ],
  };
}

/**
 * Blank template. Empty page + portal-default theme. The "Custom
 * Web App from scratch" path users who don't want to start from a
 * template land in.
 */
/**
 * KPI Dashboard starter.
 *
 * A row of indicators over a chart pair and a map. Deliberately built
 * from ordinary widgets on the ordinary canvas: an author who wants a
 * layer list, an editing tool, or a second page adds them from the
 * same palette, because this is a web app that starts out looking
 * like a dashboard rather than a dashboard product with walls around
 * it.
 *
 * `targets` is empty on purpose. The author binds layers after
 * creation; the widgets carry targetIndex 0 and render an empty
 * state until then, the same convention every other starter uses.
 */
function kpiDashboardSeed(): CustomAppData {
  const mapId = wid();
  const indicator = (
    aggregate: 'count' | 'sum',
    label: string,
    col: number,
  ): CustomWidget => ({
    id: wid(),
    kind: 'indicator',
    layout: { col, row: 1, colSpan: 48, rowSpan: 40 },
    config: {
      kind: 'indicator',
      targetIndex: 0,
      aggregate,
      label,
      format: { grouping: true },
      ...(aggregate === 'sum' ? { valueField: '' } : {}),
    },
  });

  return {
    version: 4,
    themePresetId: 'default',
    blueprint: 'dashboard',
    // 60s: live enough that a wall display stays honest, cheap enough
    // that a public dashboard is one small aggregate per minute.
    refreshSeconds: 60,
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Overview',
        widgets: [
          indicator('count', 'Total records', 1),
          indicator('count', 'Records', 49),
          indicator('count', 'Records', 97),
          indicator('count', 'Records', 145),
          {
            id: wid(),
            kind: 'chart',
            layout: { col: 1, row: 41, colSpan: 96, rowSpan: 110 },
            config: {
              kind: 'chart',
              targetIndex: 0,
              chartType: 'bar',
              aggregate: 'count',
            },
          },
          {
            id: wid(),
            kind: 'chart',
            layout: { col: 97, row: 41, colSpan: 96, rowSpan: 110 },
            config: {
              kind: 'chart',
              targetIndex: 0,
              chartType: 'pie',
              aggregate: 'count',
            },
          },
          {
            id: mapId,
            kind: 'map',
            layout: { col: 1, row: 151, colSpan: 192, rowSpan: 120 },
            config: {
              kind: 'map',
              // showTargets is a target-index subset; omitting it
              // means "every bound target", which is what a starter
              // wants before the author has bound anything.
              showNavigation: true,
            },
          },
        ],
      },
    ],
  };
}

/**
 * Operations Board starter.
 *
 * Indicators down the left, a live map on the right, and the
 * attribute table underneath: the "what is happening right now"
 * layout for a duty desk or a wall screen. Same construction as
 * every other app; the only dashboard-specific parts are the widget
 * choices and the refresh cadence.
 */
function opsBoardSeed(): CustomAppData {
  const mapId = wid();
  const stat = (label: string, row: number): CustomWidget => ({
    id: wid(),
    kind: 'indicator',
    layout: { col: 1, row, colSpan: 48, rowSpan: 40 },
    config: {
      kind: 'indicator',
      targetIndex: 0,
      aggregate: 'count',
      label,
      format: { grouping: true },
    },
  });

  return {
    version: 4,
    themePresetId: 'slate',
    blueprint: 'dashboard',
    refreshSeconds: 60,
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Operations',
        widgets: [
          stat('Open', 1),
          stat('In progress', 41),
          stat('Closed today', 81),
          {
            id: mapId,
            kind: 'map',
            layout: { col: 49, row: 1, colSpan: 144, rowSpan: 160 },
            config: {
              kind: 'map',
              // showTargets is a target-index subset; omitting it
              // means "every bound target", which is what a starter
              // wants before the author has bound anything.
              showNavigation: true,
            },
          },
          {
            id: wid(),
            kind: 'attribute-table',
            layout: { col: 1, row: 161, colSpan: 192, rowSpan: 90 },
            config: {
              kind: 'attribute-table',
              targetIndex: 0,
              syncWithMapWidgetId: mapId,
              displayMode: 'panel',
            },
          },
        ],
      },
    ],
  };
}

function blankSeed(): CustomAppData {
  return {
    version: 4,
    themePresetId: 'default',
    targets: [],
    pages: [{ id: 'home', title: 'Home', widgets: [] }],
  };
}

/**
 * Registry of all built-in templates. The new-item wizard reads
 * this to render the gallery. Templates are listed in the order
 * the wizard should display them: blank last (it's the
 * "no template" path).
 */
export const APP_TEMPLATES: readonly AppTemplate[] = [
  {
    id: 'sidebar-explorer',
    label: 'Sidebar Explorer',
    description:
      'Top bar with map tools, collapsible side panel with layers + legend, full-bleed map, attribute table that slides up from the bottom on demand.',
    use: 'Parcel viewers, asset inventories, environmental layer browsers, anything "show me this data layer with click-to-inspect details".',
    tags: ['sidebar', 'browse', 'inspect'],
    seed: parcelViewerSeed,
  },
  {
    id: 'showcase-map',
    label: 'Showcase Map',
    description:
      'Map-first layout with minimal chrome. Glass-style top bar floats over the map; search, layers, and basemap as overlay buttons.',
    use: 'Community maps, public information portals, project showcases, story maps, "look at this map" presentations.',
    tags: ['map-first', 'minimal', 'public'],
    seed: publicInfoMapSeed,
  },
  {
    id: 'compact-drawer',
    label: 'Compact Drawer',
    description:
      'Map fills the screen; a tool drawer slides in from the edge on demand. Smaller permanent chrome footprint for mobile / focused workflows.',
    use: 'Field-staff apps, mobile-friendly maps, inspection workflows, anywhere screen real estate is at a premium.',
    tags: ['mobile', 'drawer', 'compact'],
    seed: fieldInspectionSeed,
  },
  {
    id: 'kpi-dashboard',
    label: 'KPI Dashboard',
    description:
      'A row of big-number indicators over a bar and pie chart, with a map underneath. Refreshes on its own once a minute.',
    use: 'Program summaries, permit counts, wall displays, "how are we doing" views that someone checks each morning.',
    tags: ['dashboard', 'indicators', 'charts'],
    seed: kpiDashboardSeed,
  },
  {
    id: 'ops-board',
    label: 'Operations Board',
    description:
      'Indicators down the side, live map beside them, attribute table below. Refreshes on its own once a minute.',
    use: 'Duty desks, incident boards, dispatch screens, anything watched while work is happening.',
    tags: ['dashboard', 'operations', 'live'],
    seed: opsBoardSeed,
  },
  {
    id: 'blank-canvas',
    label: 'Blank Canvas',
    description:
      'Empty page with the default theme. No containers, no widgets; start from scratch in advanced mode.',
    use: 'When none of the layouts above fit, or you want full control from the first widget drop.',
    tags: ['advanced'],
    seed: blankSeed,
  },
];

// ============================================================
// #22 starter library + blueprint stamping.
// ============================================================
//
// "Starters" are the four built-in templates we seed into every
// org as app_template items on bootstrap.  After seeding, an admin
// can edit / delete / replace them like any other item; the
// `seedKind` column on item carries the stable starter id forward
// so the housekeeping "Restore starter templates" button can
// detect which starters this org is missing.
//
// The wizard does NOT iterate this array directly anymore (the
// wizard reads app_template items from the API).  These exports
// exist for two consumers:
//
//   * org-bootstrap (apps/portal-api) calls each starter's seed
//     function at org-creation time to stamp the four starter
//     items into the new org.
//
//   * admin-restore (apps/portal-api) calls the same seeds when
//     an admin asks to restore a missing starter.

/**
 * Stable identifier persisted on the seeded item's `seedKind`
 * column.  Lets the admin restore flow answer "does this org
 * already have the sidebar-explorer starter?" without scanning
 * content.  Do NOT change a starter's kind after release; rename
 * the label / description instead.
 */
export type StarterKind =
  | 'sidebar-explorer'
  | 'kpi-dashboard'
  | 'ops-board'
  | 'showcase-map'
  | 'compact-drawer'
  | 'editor-workspace'
  | 'viewer-readonly'
  | 'blank-canvas';

/**
 * One starter's metadata + seed function.  The seed returns a
 * fresh CustomAppData with new widget ids per call, so two
 * different orgs (or two restores within the same org) get
 * non-colliding ids.
 */
export interface StarterTemplate {
  kind: StarterKind;
  label: string;
  description: string;
  use: string;
  tags: readonly string[];
  seed: () => CustomAppData;
}

/**
 * The built-in starters seeded into every org.  Order in this
 * array is the order the admin restore UI displays them in.
 */
export const STARTERS: readonly StarterTemplate[] = [
  {
    kind: 'sidebar-explorer',
    label: 'Sidebar Explorer',
    description:
      'Top sticky container with map tools, left dock container with a layer list, map fills the rest of the canvas. The classic sidebar explorer layout.',
    use: 'Parcel viewers, asset inventories, internal data exploration, any "explore a map by toggling layers" workflow.',
    tags: ['explorer', 'dock', 'map-first'],
    seed: parcelViewerSeed,
  },
  {
    kind: 'showcase-map',
    label: 'Showcase Map',
    description:
      'Map-first layout with minimal chrome. Glass-style top container floats over the map; search, layers, and basemap as overlay buttons.',
    use: 'Community maps, public information portals, project showcases, story maps, "look at this map" presentations.',
    tags: ['map-first', 'minimal', 'public'],
    seed: publicInfoMapSeed,
  },
  {
    kind: 'compact-drawer',
    label: 'Compact Drawer',
    description:
      'Map fills the screen; an overlay-trigger container slides in from the edge on demand. Smaller permanent chrome footprint for mobile / focused workflows.',
    use: 'Field-staff apps, mobile-friendly maps, inspection workflows, anywhere screen real estate is at a premium.',
    tags: ['mobile', 'drawer', 'compact'],
    seed: fieldInspectionSeed,
  },
  {
    kind: 'editor-workspace',
    label: 'Editor',
    description:
      'Workspace layout for staff adding, editing, and deleting features. Top container with search + select, left dock with layers, attribute table docked at the bottom.',
    use: 'Data maintenance workflows, asset stewardship, anyone whose job is to keep a data layer current.',
    tags: ['editor', 'data-maintenance'],
    seed: editorWorkspaceSeed,
  },
  {
    kind: 'viewer-readonly',
    label: 'Viewer',
    description:
      'Read-only audience-facing app. Search + basemap + print in the top container, layer toggles in the side dock, no editing affordances.',
    use: 'Public information maps, internal share-only views, anywhere the audience reads but does not write.',
    tags: ['viewer', 'read-only', 'public'],
    seed: viewerReadonlySeed,
  },
  {
    kind: 'kpi-dashboard',
    label: 'KPI Dashboard',
    description:
      'Indicator row over a bar chart and a pie chart, with a map underneath. Auto-refreshes once a minute.',
    use: 'Program summaries, permit counts, wall displays, morning "how are we doing" checks.',
    tags: ['dashboard', 'indicators', 'charts'],
    seed: kpiDashboardSeed,
  },
  {
    kind: 'ops-board',
    label: 'Operations Board',
    description:
      'Indicators down the side, live map beside them, attribute table below. Auto-refreshes once a minute.',
    use: 'Duty desks, incident boards, dispatch screens, anything watched while work happens.',
    tags: ['dashboard', 'operations', 'live'],
    seed: opsBoardSeed,
  },
  {
    kind: 'blank-canvas',
    label: 'Blank Canvas',
    description:
      'Empty page with the default theme. No containers, no widgets; start from scratch in advanced mode.',
    use: 'When none of the layouts above fit, or you want full control from the first widget drop.',
    tags: ['advanced'],
    seed: blankSeed,
  },
];

/**
 * Look up a starter by its kind.  Returns null when the kind isn't
 * one of the four built-ins; callers should treat that as "this
 * isn't a starter, it's a user-saved template" and skip the
 * restore-from-seed path.
 */
export function getStarter(kind: string): StarterTemplate | null {
  return STARTERS.find((s) => s.kind === kind) ?? null;
}

/**
 * Mint fresh widget ids across a CustomAppData blueprint while
 * preserving cross-widget references (mapWidgetId, syncWithMap-
 * WidgetId, etc.).  Used when stamping a saved template into a
 * fresh app: the template's widget ids are reused inside its own
 * tree, but two app instances should not share ids.
 *
 * Strategy: walk the tree, build an id remap (oldId -> newId) for
 * every widget, then walk again and rewrite both each widget's own
 * id and any string fields on `config` that look like a known id
 * reference.  Container widgets carry `widgets: CustomWidget[]`
 * children that get the same treatment recursively.
 */
export function stampBlueprint(blueprint: CustomAppData): CustomAppData {
  const idRemap = new Map<string, string>();

  function collectIds(widgets: readonly CustomWidget[]): void {
    for (const w of widgets) {
      idRemap.set(w.id, wid());
      const cfg = w.config as { widgets?: CustomWidget[] };
      if (Array.isArray(cfg.widgets)) collectIds(cfg.widgets);
    }
  }

  function remapRefsInConfig(cfg: unknown): unknown {
    if (cfg === null || typeof cfg !== 'object') return cfg;
    if (Array.isArray(cfg)) return cfg.map((v) => remapRefsInConfig(v));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (
        (k === 'mapWidgetId' ||
          k === 'syncWithMapWidgetId' ||
          k === 'targetWidgetId') &&
        typeof v === 'string' &&
        idRemap.has(v)
      ) {
        out[k] = idRemap.get(v);
      } else {
        out[k] = remapRefsInConfig(v);
      }
    }
    return out;
  }

  function rewriteWidgets(widgets: readonly CustomWidget[]): CustomWidget[] {
    return widgets.map((w) => {
      const newId = idRemap.get(w.id) ?? wid();
      const cfg = w.config as { widgets?: CustomWidget[] };
      // Rewrite cross-widget id references on config.  For
      // containers, recurse into config.widgets to mint child ids.
      const rewrittenCfg = remapRefsInConfig(cfg) as typeof cfg;
      if (Array.isArray(cfg.widgets)) {
        rewrittenCfg.widgets = rewriteWidgets(cfg.widgets);
      }
      return {
        ...w,
        id: newId,
        config: rewrittenCfg as CustomWidget['config'],
      };
    });
  }

  // Collect ids first across every page so cross-page references
  // (rare but possible) also remap consistently.
  for (const p of blueprint.pages) collectIds(p.widgets);

  return {
    ...blueprint,
    pages: blueprint.pages.map((p) => ({
      ...p,
      widgets: rewriteWidgets(p.widgets),
    })),
  };
}

/**
 * Look up a template by id. Maps legacy topic-named ids
 * (parcel-viewer, public-info-map, field-inspection, blank) to
 * their layout-named successors so already-created apps keep
 * resolving. Returns Blank Canvas as a final fallback.
 */
export function getAppTemplate(id: AppTemplateId): AppTemplate {
  const legacyMap: Record<string, AppTemplateId> = {
    'parcel-viewer': 'sidebar-explorer',
    'public-info-map': 'showcase-map',
    'field-inspection': 'compact-drawer',
    blank: 'blank-canvas',
  };
  const resolved = legacyMap[id] ?? id;
  return (
    APP_TEMPLATES.find((t) => t.id === resolved) ??
    APP_TEMPLATES[APP_TEMPLATES.length - 1]!
  );
}
