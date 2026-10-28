// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool items (#90).
 *
 * A "tool" is a reusable, named action.  Drop one on a web app via
 * the Button widget (`linkKind: 'tool'`, `toolId: '...'`) and the
 * tool's `action` determines what happens on click.  The reuse is
 * the point: the same "Open the WV parcel viewer" or "Print the
 * monthly report template" recipe can sit on a dashboard, an admin
 * page, and a field workflow without re-authoring three times.
 *
 * v1 actions are URL-shaped on purpose. "Navigate the user to
 * somewhere" covers a lot of "show me the thing" workflows and
 * needs no execution backend.
 *
 * v2 adds the `recipe` action kind: a parameterized on-demand action
 * that reuses the derived_layer ToolStep vocabulary.  Authors define
 * named parameter slots (an AOI, a target layer, a predicate, a
 * distance) with binding modes (hardcoded, resolved from the host
 * app, drawn at runtime, picked at runtime).  At run time the recipe
 * runner resolves the parameters, substitutes them into the pipeline,
 * compiles to PostGIS, and either updates the host app's selection or
 * creates a derived_layer / data_layer item from the result.
 *
 * See docs/tool-items-v2.md for the full design.
 */

import type { LengthUnit } from './length';
import type {
  SpatialPredicate,
  ToolStep,
} from './derived-layer';

/**
 * What the tool does when triggered.  Discriminated on `kind`.
 *
 * The first three are v1 navigation/export shapes.  `recipe` is the
 * v2 parameterized-action shape; it carries its own sub-schema for
 * parameters + pipeline + output.
 */
export type ToolAction =
  | OpenItemAction
  | OpenUrlAction
  | ExportLayerAction
  | RecipeAction
  | OsmRelationalQueryAction;

/**
 * Open another portal item in the same browser tab.  Resolves to
 * `/items/<targetItemId>` -- the same URL the user would reach by
 * clicking the item in the items grid.  Use this for "go look at
 * the canonical asset" workflows: open a map, open a dashboard,
 * open the public landing page for a layer.
 */
export interface OpenItemAction {
  kind: 'open-item';
  /** Item id to navigate to. */
  targetItemId: string;
  /** When true, opens in a new tab via window.open. */
  newTab?: boolean;
  /** Optional ?view= override, eg 'configure' or 'run'.  Lets a
   *  tool aim at a specific surface of a multi-view item. */
  view?: string;
}

/**
 * Open an absolute URL.  This is the escape hatch -- author drops
 * an internal /items/* path with query params (for selection,
 * highlighting, etc.) OR an external URL to a third-party tool.
 * The URL is opened either in the same tab or a new tab; we don't
 * server-side validate it.
 */
export interface OpenUrlAction {
  kind: 'open-url';
  /** Absolute or app-relative URL.  Empty string is a no-op (the
   *  button still renders, but clicking does nothing -- helpful
   *  for half-configured tools so the UI doesn't crash). */
  url: string;
  /** When true, opens in a new tab via target="_blank". */
  newTab?: boolean;
}

/**
 * Export a data_layer sublayer to CSV or XLSX.  Same client-side
 * code path the Export widget uses (#110), reachable from a
 * Button widget bound to a tool.  Letting an export live as a
 * reusable tool means an org with five apps that all need
 * "download the parcels" can author the tool once and point five
 * buttons at it -- update the format / scope in one place.
 */
export interface ExportLayerAction {
  kind: 'export-layer';
  /** data_layer item id whose features to export. */
  targetItemId: string;
  /** Sublayer key inside the data_layer.  Required because v3
   *  data_layer items are multi-layer; the tool authors pick a
   *  specific sublayer rather than dumping every one. */
  layerKey: string;
  /** Output format. */
  format: 'csv' | 'xlsx';
}

// ---- Recipe action (v2) ----------------------------------------------------

/**
 * Geometry types accepted by a feature-source parameter.  `'any'`
 * relaxes the constraint -- some tools (e.g. Select By Location)
 * work on a point, line, or polygon AOI interchangeably.
 */
export type ParameterGeometryType = 'point' | 'line' | 'polygon' | 'any';

/**
 * Reference to a feature source used as a parameter value.  Used
 * both as a hardcoded binding default and as the run-time payload
 * shape when the binding is `runtime-host` or `runtime-selection`.
 */
export interface FeatureSourceValue {
  /**
   * `data_layer`: the source is a portal data_layer (the typical
   *               case for layers the host app already maps).
   * `derived_layer`: the source is a portal derived_layer.
   * `inline-geojson`: the source is an inline GeoJSON Feature or
   *               FeatureCollection supplied at run time (used by
   *               `runtime-draw` parameters).
   */
  kind: 'data_layer' | 'derived_layer' | 'inline-geojson';
  /** Layer item id; absent for `inline-geojson`. */
  itemId?: string;
  /** Sublayer key for v3 multi-layer data_layers. */
  layerKey?: string;
  /** Inline GeoJSON for `inline-geojson`. */
  geojson?: unknown;
  /** Optional subset of feature ids to constrain the source to. */
  featureIds?: Array<string | number>;
}

/**
 * Feature-source parameter -- typically the AOI, a target layer, or
 * a "filter by" layer for a spatial-filter step.
 *
 * Binding modes:
 *   - `hardcoded`:        the layer is baked into the tool.  Use when
 *                         the tool is meant to operate against one
 *                         specific layer (e.g. "Find addresses inside
 *                         the OSM buildings layer").
 *   - `runtime-host`:     resolved from the host app's available
 *                         layers at run time.  The Button widget can
 *                         pre-bind this to a specific layer; if
 *                         unbound, the runtime parameter UI prompts.
 *   - `runtime-draw`:     user draws a geometry interactively at run
 *                         time (point, line, polygon).
 *   - `runtime-selection`: use the current host map selection as the
 *                         feature source.
 */
export interface FeatureSourceParameter {
  kind: 'feature-source';
  /** Slot name; referenced from step params as `{ kind: 'parameter', name }`. */
  name: string;
  /** Human label shown in the runtime UI and the tool designer. */
  label: string;
  /** Optional short blurb shown under the label. */
  hint?: string;
  /** Whether the parameter must be resolved before the tool can run. */
  required?: boolean;
  /** Geometry type constraint.  Defaults to 'any'. */
  geometryType?: ParameterGeometryType;
  binding:
    | { mode: 'hardcoded'; value: FeatureSourceValue }
    | { mode: 'runtime-host'; defaultValue?: FeatureSourceValue }
    | { mode: 'runtime-draw' }
    | { mode: 'runtime-selection' };
}

/**
 * Predicate parameter -- usually drives a spatial-filter step.
 *
 * Binding modes:
 *   - `hardcoded`: the predicate is baked into the tool.
 *   - `runtime-pick`: end-user picks at run time (with optional
 *                     `allowed` set narrowing the chip strip).
 */
export interface PredicateParameter {
  kind: 'predicate';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: SpatialPredicate }
    | {
        mode: 'runtime-pick';
        defaultValue: SpatialPredicate;
        /** Subset of predicates the runtime picker exposes; omitted
         *  means all of them. */
        allowed?: SpatialPredicate[];
      };
}

/**
 * Distance parameter, always in meters internally.  Wizard surfaces
 * a unit toggle; the saved value normalises to meters.
 *
 * Binding modes:
 *   - `hardcoded`: fixed meters value.
 *   - `runtime-input`: user types a number at run time.
 */
export interface DistanceParameter {
  kind: 'distance';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /**
   * Display unit for the user-facing input.  Storage is always
   * meters (so the recipe runner doesn't have to think about
   * units); this field controls only how the author + end-user
   * SEE the distance in the parameter editor + runtime panel.
   * Defaults to `meters` when omitted, preserving the v1 shape.
   * The runtime panel still lets the end-user pick a different
   * unit per run from a small dropdown next to the number input.
   */
  unit?: LengthUnit;
  binding:
    | { mode: 'hardcoded'; meters: number }
    | {
        mode: 'runtime-input';
        defaultMeters: number;
        minMeters?: number;
        maxMeters?: number;
      };
}

/** Plain-number parameter (no unit semantics). */
export interface NumberParameter {
  kind: 'number';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: number }
    | {
        mode: 'runtime-input';
        defaultValue: number;
        min?: number;
        max?: number;
      };
}

/** Free-text parameter -- e.g. a SQL where-clause snippet or a title. */
export interface TextParameter {
  kind: 'text';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: string }
    | { mode: 'runtime-input'; defaultValue?: string };
}

/**
 * Single lat/lon point parameter (#150 / #152).  Underpins tools
 * that ask the user to "drop a pin": Nearest N, Reverse geocode,
 * future bearing / route-from-point queries.  Coordinates are
 * WGS-84 (EPSG:4326) decimal degrees; the runtime UI shows a
 * "drop pin on map" button as the primary affordance and a
 * lat/lon input pair as a fallback so a user with a coordinate
 * in hand can paste it directly.
 *
 *   - `hardcoded`:    the tool is dedicated to one fixed point
 *                     (e.g. "Find every coffee shop near our HQ").
 *                     The runtime UI doesn't show a row; the
 *                     baked-in point ships with the request.
 *   - `runtime-pick`: the user drops a pin (or types coordinates)
 *                     at runtime.  Optional defaults seed the
 *                     initial value so a tool can preselect a
 *                     sensible starting point (e.g. the map's
 *                     current center) without forcing it.
 */
export interface PointParameter {
  kind: 'point';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; lng: number; lat: number }
    | {
        mode: 'runtime-pick';
        /** Optional preselect; the runtime UI seeds the inputs
         *  with these so the user can click Run immediately if the
         *  default is what they wanted.  Either both or neither
         *  should be set; a half-default is treated as "no
         *  default" by the runtime. */
        defaultLng?: number;
        defaultLat?: number;
      };
}

/**
 * Tag filter on an OSM query.  v1 supports literal-equals matches
 * only; contains / regex are queued for wave 3 once we have a
 * frequency-weighted autocomplete catalog to make them useful.
 */
export interface OsmTagFilter {
  key: string;
  value: string;
  op?: 'equals' | 'contains' | 'regex';
}

/**
 * OpenStreetMap feature parameter (#OSM).
 *
 * Lets a recipe consume OSM data on demand: at run time the recipe
 * runner builds an Overpass query from the parameter's preset ids +
 * tag filters, hits the configured Overpass endpoint, converts the
 * result to GeoJSON, and writes it into a transient observation-log
 * scope so downstream steps (spatial-filter, spatial-join) can read
 * it like any other source.
 *
 * The author chooses one of two binding modes:
 *
 *   - `hardcoded`:    the tool is dedicated to one specific OSM
 *                     lookup ("Find pharmacies near my facility").
 *                     User just provides AOI + distance at runtime.
 *   - `runtime-pick`: the user picks at runtime which presets to
 *                     query and (optionally) what tag filters to
 *                     add.  This is the flexible guided-query mode
 *                     that powers "Show me Citgo gas stations within
 *                     1 mile of my parcel": the user multi-selects
 *                     "Gas stations" + types `brand=Citgo`.
 *
 * For `runtime-pick` the author can narrow what the user sees via
 * an `allowedCategories` whitelist (e.g. only let users pick from
 * `amenity` + `shop` categories), an `allowedPresetIds` explicit
 * subset, and an `allowCustomTagFilters` switch (off when the
 * author wants a strictly guided experience with no free-text
 * filters).  Empty / omitted means "any preset / any filter".
 */
export interface OsmFeatureParameter {
  kind: 'osm-feature';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /**
   * #101: per-recipe Overpass cache TTL in minutes. Caller-visible
   * shape: 0 means "always fresh" (skip the cache), unset means
   * "use the engine default" (currently 1 hour), and a number means
   * "use the cache for this many minutes." The recipe runner clamps
   * this to a sane upper bound so a typo can't permanently pin
   * stale data.
   */
  ttlMinutes?: number;
  binding:
    | {
        mode: 'hardcoded';
        /** One or more preset ids from the catalog; queries are a
         *  union across all of them. */
        presetIds: string[];
        tagFilters?: OsmTagFilter[];
      }
    | {
        mode: 'runtime-pick';
        defaultPresetIds?: string[];
        defaultTagFilters?: OsmTagFilter[];
        /** Top-level OSM tag-key categories the picker is allowed
         *  to surface (e.g. ['amenity', 'shop']).  Empty / omitted
         *  means no restriction. */
        allowedCategories?: string[];
        /** Explicit subset of preset ids the picker may surface.
         *  Empty / omitted means no restriction. */
        allowedPresetIds?: string[];
        /** When false, the runtime tag-filter editor is hidden;
         *  the user can only choose presets.  Defaults to true. */
        allowCustomTagFilters?: boolean;
      };
}

/**
 * Discriminated union of every tool-recipe parameter kind.  Adding a
 * new parameter kind means extending the union, the runtime UI's
 * prompt switch, and the recipe runner's substitution map.
 */
export type ToolParameter =
  | FeatureSourceParameter
  | PredicateParameter
  | DistanceParameter
  | NumberParameter
  | TextParameter
  | OsmFeatureParameter
  | PointParameter;

/**
 * What happens with the pipeline's output when the tool finishes.
 *
 *   - `selection`:           update the host app's selection state on
 *                            the layer referenced by
 *                            `targetParameterRef` to the set of
 *                            feature ids produced by the pipeline.
 *                            No new persistent item is created.
 *   - `osm-features-overlay`: render the pipeline output as a
 *                            transient overlay on the host map(s),
 *                            with ODbL attribution baked in.  The
 *                            user gets a "Save as data layer" button
 *                            to materialise the overlay into a real
 *                            data_layer when they want to keep it.
 *                            Output features are not associated with
 *                            any pre-existing layer.
 *   - `derived-layer` / `data-layer`: kept in the type union for
 *                            older saved recipes, but the runner
 *                            refuses them. Authors who want a
 *                            persistent layer create a derived_layer
 *                            item (or use Analyze shortcuts) instead
 *                            of a tool-recipe output sink
 *                            (R6-recipe-sink-honesty).
 */
export type ToolOutput =
  | { kind: 'selection'; targetParameterRef: string }
  | { kind: 'osm-features-overlay' }
  | { kind: 'derived-layer'; titleTemplate: string }
  | { kind: 'data-layer'; titleTemplate: string };

/**
 * The v2 recipe action.  Carries everything the runner needs to
 * resolve a tool invocation: the parameter schema, the pipeline that
 * consumes them, and the output sink.
 *
 * Steps inside `pipeline` may reference parameters via
 * `{ kind: 'parameter', name: '<paramName>' }` shapes in their
 * source / predicate / distance fields.  The recipe runner walks the
 * pipeline at run time and replaces each parameter reference with the
 * resolved value before handing the (now derived_layer-shaped)
 * pipeline to the existing SQL compiler.
 */
export interface RecipeAction {
  kind: 'recipe';
  /** Schema version inside the recipe action; bumped on incompat. */
  recipeVersion: 1;
  parameters: ToolParameter[];
  pipeline: ToolStep[];
  output: ToolOutput;
  /**
   * Parameter ref that provides the pipeline's input rows.  When
   * omitted, defaults to `output.targetParameterRef` for selection
   * output (preserving the v1 behaviour).  Must be set for output
   * sinks where the "source layer" isn't on the output:
   *
   *   - `osm-features-overlay`: point at the osm-feature parameter
   *     whose query the pipeline filters / annotates.
   *   - `derived-layer` / `data-layer` (future): the parameter
   *     whose data is the recipe's input.
   *
   * Valid parameter kinds:
   *   - `feature-source`: pipeline reads from a data_layer (current
   *     behaviour for selection output).
   *   - `osm-feature`: pipeline reads from the OSM-feature
   *     parameter's transient scope materialised by the recipe
   *     runner.
   */
  sourceParameterRef?: string;
  /**
   * For OSM-driven output sinks: the parameter whose resolved
   * geometry provides the area of interest.  The recipe runner
   * uses its bbox (padded by any distance step in the pipeline) to
   * bound the Overpass call so we don't fetch the whole continent
   * when the user only cares about features near their parcel.
   *
   * Required when `output.kind === 'osm-features-overlay'` and the
   * pipeline references an osm-feature parameter; ignored
   * otherwise.
   */
  aoiParameterRef?: string;
  /**
   * Alternative AOI source for `osm-features-overlay` output:
   * a `point` parameter (#150).  When set, the recipe runner
   * derives the bbox from the resolved point + the distance
   * parameter (point ± radius), and post-fetch sorts the result
   * by distance to the point.  `aoiParameterRef` is ignored when
   * `pointParameterRef` is present; the two are alternatives.
   *
   * The killer use case: "drop a pin, give me the N closest
   * coffee shops, sorted by walking distance" -- the runner
   * attaches a `distance_m` property to each output feature so
   * popups can show "0.3 mi away" without a second fetch.
   */
  pointParameterRef?: string;
  /**
   * Optional NumberParameter ref bounded to integer in [1, 500].
   * When `pointParameterRef` is set, results are truncated to the
   * top N closest to the point.  Without this, every feature in
   * the search radius comes back (still sorted by distance) which
   * is the right shape for "list every park within 0.5 mi" --
   * use the limit when you want "list the 10 closest parks."
   */
  nearestLimitParameterRef?: string;
  /**
   * Reverse-geocode-at-point mode (#152).  When set with a
   * `pointParameterRef`, the recipe runner takes a completely
   * different path: instead of building an Overpass query from
   * preset selectors + bbox, it calls OsmService.resolveAtPoint
   * which uses `is_in:` + `around:radius` to return every feature
   * AT the point (admin boundaries, named places, building
   * polygons) plus everything within the search radius.  The
   * `sourceParameterRef` osm-feature parameter is ignored in this
   * mode -- the whole point is "give me everything here, I'll
   * pick what's relevant."  Output is the standard
   * osm-features-overlay shape; the client renders + ranks.
   */
  reverseGeocodeAtPoint?: boolean;
  /**
   * Hard cap on rows returned for `output.kind === 'selection'`. The
   * runtime warns the user when truncation occurs.  Mirrors the
   * features-page cap so big-data layers degrade gracefully rather
   * than freezing the browser.
   */
  selectionLimit?: number;
  /**
   * #157 Workflow graph (DAG) extension. Optional. When present,
   * the recipe runner uses the graph as the execution plan instead
   * of the linear `pipeline` field. The graph is converted to a
   * topologically-ordered step list at execution time, which means
   * a workflow that's actually a straight line (one node per
   * pipeline step, edges chaining them in order) produces exactly
   * the same observable behaviour as the legacy linear `pipeline`
   * path. Branching node kinds (fork / join / union) land in
   * Phase 2 alongside their per-node executor wiring.
   *
   * Backward compatibility: when `graph` is absent (the existing
   * shape), the runner uses `pipeline` unchanged. Existing recipes
   * keep running with no migration. A new recipe author can opt
   * into the graph form by writing nodes + edges; the visual
   * graph editor lands in Phase 3.
   */
  graph?: WorkflowGraph;
}

/**
 * #157 Workflow graph (DAG). Nodes wrap individual `ToolStep`s and
 * edges describe data flow between them. The graph is acyclic by
 * construction: the executor refuses to run a graph whose
 * topological sort fails (any cycle aborts before mutating any
 * downstream state).
 */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Schema version for forward compat. v1 is single-input nodes
   *  only; v2 adds multi-input join / union nodes. */
  graphVersion: 1;
}

export interface WorkflowNode {
  /** Stable graph-scoped id. Used as the edge source / target
   *  reference and as the visual builder's node selection key. */
  id: string;
  /** The step this node executes. Reuses the existing pipeline
   *  step vocabulary so any step that works in a linear pipeline
   *  works in a graph node with no shape change. */
  step: ToolStep;
  /**
   * Optional UI position for the visual graph editor. Pure
   * ornament; the executor ignores it. Kept on the persisted
   * graph so node positions survive a save / reload round trip.
   */
  position?: { x: number; y: number };
  /**
   * Optional human-readable label shown above the node in the
   * graph editor. When absent, the editor falls back to a label
   * derived from `step.kind`. Authors can rename for clarity
   * ("Buffer by 200m for school search").
   */
  label?: string;
}

export interface WorkflowEdge {
  /** id of the upstream node whose output flows into the
   *  downstream node. */
  source: string;
  /** id of the downstream node consuming the upstream output. */
  target: string;
  /**
   * For multi-input downstream nodes (joins, unions), which input
   * port consumes this edge. Most nodes have a single implicit
   * input port; v1 nodes ignore this field. v2 join / union nodes
   * read `'left'` / `'right'` or named ports.
   */
  targetPort?: string;
}

/**
 * Result of a topological sort of a WorkflowGraph. The `order`
 * field is the array of node ids in execution order;
 * `error` is set when the graph has a cycle or references a
 * missing node, in which case `order` is undefined.
 */
export interface WorkflowGraphOrder {
  order?: string[];
  error?: 'cycle' | 'missing-node' | 'duplicate-node';
  /** Optional human-readable detail for logging / UI display. */
  detail?: string;
}

/**
 * Topologically sort a workflow graph by Kahn's algorithm.
 *
 *   - Returns `{ order }` on success: an array of node ids such
 *     that for every edge `source -> target`, `source` appears
 *     before `target` in the order.
 *   - Returns `{ error: 'cycle' }` when a cycle prevents the
 *     algorithm from finishing.
 *   - Returns `{ error: 'missing-node' }` when an edge points at
 *     a node id not present in `graph.nodes`.
 *   - Returns `{ error: 'duplicate-node' }` when two nodes share
 *     an id.
 *
 * Pure helper with no I/O; safe to use from the runner, the
 * visual graph editor (to flag a cycle before save), and from
 * tests.
 */
export function topologicalSort(graph: WorkflowGraph): WorkflowGraphOrder {
  // Detect duplicate node ids first.
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) {
      return {
        error: 'duplicate-node',
        detail: `Duplicate node id "${n.id}"`,
      };
    }
    ids.add(n.id);
  }
  // Build adjacency + in-degree.
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      return {
        error: 'missing-node',
        detail: `Edge references unknown node "${ids.has(e.source) ? e.target : e.source}"`,
      };
    }
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  // Kahn: pull nodes with in-degree 0 in insertion order so a
  // graph that's already linear keeps its author-written order.
  const queue: string[] = [];
  for (const n of graph.nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) queue.push(n.id);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    return { error: 'cycle', detail: 'Graph contains a cycle' };
  }
  return { order };
}

/**
 * Convert a legacy linear `pipeline: ToolStep[]` into a degenerate
 * `WorkflowGraph` whose nodes execute in pipeline order. Used by
 * the runner as a uniform-shape adapter so the executor has a
 * single code path; also useful in the visual graph editor to
 * import an existing linear recipe into the canvas.
 */
export function pipelineToGraph(pipeline: ToolStep[]): WorkflowGraph {
  const nodes: WorkflowNode[] = pipeline.map((step, i) => ({
    id: `n${i}`,
    step,
  }));
  const edges: WorkflowEdge[] = nodes
    .slice(0, -1)
    .map((n, i) => ({ source: n.id, target: nodes[i + 1]!.id }));
  return { nodes, edges, graphVersion: 1 };
}

/**
 * Stored data shape for a `tool` item.  Item core fields (id,
 * title, description, owner, sharing) live on the item table; this
 * is the `data` blob.
 */
export interface ToolItemData {
  /** Schema version.  Bumped whenever the data shape changes
   *  incompatibly so the runtime can refuse stale tool configs
   *  cleanly.  v1 only had navigation actions; v2 added the recipe
   *  action kind.  Existing v1 tools deserialize fine under v2
   *  because v2 is purely additive at the union level. */
  schemaVersion: 1;
  /** The thing the tool does on trigger. */
  action: ToolAction;
  /**
   * Optional short blurb shown next to the tool's name in pickers
   * (the Button widget's "Pick a tool" dropdown, the tool detail
   * page header).  When empty, the tool's item description is used
   * as a fallback.
   */
  hint?: string;
}

/** Returns a freshly-stubbed tool data blob -- used by the
 *  new-item wizard.  Defaults to an open-url action with an
 *  empty URL so the user lands on the detail page with a tool
 *  that's safe to save and clearly half-finished. */
export function emptyToolData(): ToolItemData {
  return {
    schemaVersion: 1,
    action: { kind: 'open-url', url: '', newTab: true },
  };
}

/**
 * Default selection cap for recipe runs.  Mirrors features-page so
 * the parcel-style "1.4M rows" case can't melt the browser.  The
 * recipe runner reports `truncated: true` when the cap is reached.
 */
export const DEFAULT_TOOL_SELECTION_LIMIT = 5000;

/**
 * Returns a freshly-stubbed recipe action.  Used by the tool
 * designer when the author switches the action kind to "recipe" and
 * by the "new tool from template" path when seeding a starter.
 *
 * The default is intentionally empty:
 *   - no parameters
 *   - no pipeline
 *   - selection output bound to no parameter (invalid until the
 *     author wires one up)
 *
 * The designer prompts the author to fill these in; the save-time
 * validator rejects an empty pipeline so a half-finished recipe
 * doesn't silently no-op at runtime.
 */
export function emptyRecipeAction(): RecipeAction {
  return {
    kind: 'recipe',
    recipeVersion: 1,
    parameters: [],
    pipeline: [],
    output: { kind: 'selection', targetParameterRef: '' },
    selectionLimit: DEFAULT_TOOL_SELECTION_LIMIT,
  };
}

/** Type guard for the recipe action kind.  Useful where we need to
 *  branch on action without exhaustive switches. */
export function isRecipeAction(action: ToolAction): action is RecipeAction {
  return action.kind === 'recipe';
}

/**
 * Distance value + unit pair used by the relational query (and any
 * future surface that needs the same shape).  Mirrors the runtime
 * distance picker so the user's "0.5 mi" travels through the action
 * payload without intermediate normalisation.  The recipe runner is
 * the canonical converter to meters.
 */
export interface RelationalDistance {
  value: number;
  unit: 'm' | 'km' | 'ft' | 'mi';
}

/**
 * Relational OSM query: find every feature of `anchorPreset` that
 * sits within distance D_i of at least one feature of each
 * `conditions[i].preset`, all inside the resolved AOI.  The classic
 * use case is "find me every school within 0.5 miles of a park AND
 * within 0.5 miles of a liquor store" - shippable as a single tool
 * the user can re-run per neighbourhood.
 *
 * v1 is AND-only across conditions and skips per-condition tag
 * filters; both are tracked as follow-ups so the schema stays
 * narrow while we ship the dominant case.  See the spec on issue
 * #142 for the full design.
 */
export interface OsmRelationalQueryAction {
  kind: 'osm-relational-query';
  /** Schema version inside the action.  Bumped on incompat. */
  relationalVersion: 1;
  /**
   * Preset id from the iD preset catalog (e.g. 'amenity/school').
   * Every matching feature returned by Overpass is a candidate; the
   * relational predicates below filter it down to the survivors.
   */
  anchorPreset: string;
  /**
   * Optional anchor result cap.  Forwarded to the Overpass call so
   * a runaway AOI doesn't try to return 50k schools.  Defaults to
   * the engine's `DEFAULT_OSM_MAX_FEATURES`.
   */
  anchorMaxResults?: number;
  /**
   * Conditions every surviving anchor must satisfy.  v1 is
   * AND-only: an anchor is kept iff at least one feature of each
   * condition's preset lies within `condition.distance` of it.
   * Empty list = "every anchor inside the AOI" (degenerate; the
   * caller probably wants a plain OSM query instead).
   *
   * `tagFilters` optionally narrows the condition's feature set
   * by additional tag clauses -- e.g. a leisure/park condition
   * with `tagFilters: [{key: 'leisure', value: 'park'},
   * {key: 'name', value: 'Lincoln', op: 'contains'}]` matches
   * only parks named Lincoln.  Same shape and ops the
   * OsmFeatureParameter and the runtime tag-filter UI use.
   */
  conditions: Array<{
    preset: string;
    distance: RelationalDistance;
    tagFilters?: OsmTagFilter[];
  }>;
  /**
   * Reserved for the eventual OR / mixed-operator extension.  v1
   * accepts only 'and' and ignores anything else.  Kept on the wire
   * so existing tools deserialise cleanly when OR ships.
   */
  combinator?: 'and';
  /**
   * Negation conditions (#153).  An anchor survives only if NO
   * feature of any negation preset lies within `distance` of it.
   * Implemented via Overpass set-difference on the survivor set,
   * so the negation is enforced server-side in the same round-trip
   * that runs the AND conjunctions.
   *
   * Killer use case: "school near park AND near liquor store AND
   * NOT near a highway" -- the negation drops survivors that have
   * a busy road within walking distance even though they pass the
   * other criteria.
   */
  negations?: Array<{
    preset: string;
    distance: RelationalDistance;
  }>;
  /**
   * Bearing predicates (#153).  An anchor survives only if AT
   * LEAST ONE feature of the condition at `conditionIndex` lies
   * in the angular arc `[bearingDegrees - toleranceDegrees,
   * bearingDegrees + toleranceDegrees]` measured from the
   * condition feature TO the anchor.  Bearings are
   * compass-style: 0 = North, 90 = East, 180 = South, 270 = West.
   *
   * The detective use case: "watertower (anchor) roughly NW of a
   * railroad (condition[0])" -> conditionIndex=0,
   * bearingDegrees=315, toleranceDegrees=30.  Combine with the
   * AND conjunction to dramatically narrow candidate locations
   * from "watertowers near railroads" to "watertowers NW of
   * nearby railroads."
   *
   * Evaluated client-side after the Overpass call; cheap haversine
   * + atan2 math on the candidate pairs.
   */
  bearings?: Array<{
    conditionIndex: number;
    bearingDegrees: number;
    toleranceDegrees: number;
  }>;
  /**
   * Per-recipe Overpass cache TTL override in minutes.  Same
   * semantics as OsmFeatureParameter.ttlMinutes: 0 means
   * "always fresh", unset means "engine default", >0 means
   * "cache for this many minutes" (clamped server-side).
   */
  ttlMinutes?: number;
  /**
   * Runtime parameters the user fills in.  v1 needs exactly one
   * FeatureSourceParameter (the AOI); future versions can let the
   * user pick anchor / condition presets at runtime by promoting
   * those fields to runtime parameters.
   */
  parameters: ToolParameter[];
  /**
   * Name of the FeatureSourceParameter that provides the area of
   * interest.  The runner pads its bbox by the largest condition
   * distance before the Overpass call so features just outside the
   * AOI but within distance are still considered for the join.
   */
  aoiParameterRef: string;
}

/** Type guard for the relational-query action kind. */
export function isOsmRelationalQueryAction(
  action: ToolAction,
): action is OsmRelationalQueryAction {
  return action.kind === 'osm-relational-query';
}

/**
 * Returns a freshly-stubbed relational-query action.  Used by the
 * tool designer when the author switches the action kind to
 * "OSM relational query" and by the new-tool-from-template path.
 *
 * The default is empty enough that the designer's save-time
 * validator can reject it loudly (no preset chosen, no conditions,
 * no AOI parameter) instead of silently shipping a broken tool.
 */
export function emptyOsmRelationalQueryAction(): OsmRelationalQueryAction {
  return {
    kind: 'osm-relational-query',
    relationalVersion: 1,
    anchorPreset: '',
    conditions: [],
    combinator: 'and',
    parameters: [],
    aoiParameterRef: '',
  };
}

/**
 * Catalog of starter recipe templates.  Each entry is a small
 * factory the tool designer surfaces as a "Start from template"
 * option so authors can stamp out a working recipe without
 * hand-wiring every parameter.  The user can edit anything after
 * stamping; the template is just a head start.
 *
 * Add a template by appending an entry to RECIPE_TEMPLATES.  Each
 * template returns a fresh RecipeAction blob (defensive cloning so
 * future edits don't leak across stamps).
 */
export interface RecipeTemplate {
  /** Stable id used as the picker's option key. */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /**
   * Factory: returns a fresh tool action the editor can adopt.
   * Templates can produce either a `RecipeAction` (selection /
   * osm-features-overlay) or an `OsmRelationalQueryAction` (#142).
   * The detail page renders whatever shape the template emits.
   */
  build(): RecipeAction | OsmRelationalQueryAction;
}

/**
 * Select-By-Location template.  The canonical recipe we ship as a
 * proof of concept: pick a target layer, pick an AOI (drawn or from
 * the current selection), pick a predicate, optionally a distance,
 * and the runtime updates the target layer's selection with the
 * matching feature ids.
 *
 * Parameter slots:
 *   target:    runtime-host  -- the host app maps a real layer to
 *                               this slot (or the user picks one).
 *   aoi:       runtime-draw  -- the user draws (or pastes) a
 *                               geometry at run time.  Polygon by
 *                               default; the constraint can be
 *                               relaxed by the author after
 *                               stamping.
 *   predicate: runtime-pick  -- defaults to 'intersects'; the full
 *                               five-way set is allowed.
 *   distance:  runtime-input -- only used when predicate='near';
 *                               default 100 m.
 */
const SELECT_BY_LOCATION: RecipeTemplate = {
  id: 'select-by-location',
  label: 'Select By Location',
  description:
    'Select features in one layer based on a spatial relationship to another geometry. Mirrors the classic GIS workflow.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'target',
          label: 'Target layer',
          hint: 'The layer features are selected from.',
          required: true,
          geometryType: 'any',
          binding: { mode: 'runtime-host' },
        },
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape (or use the current map view) to define the selection geometry.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'predicate',
          name: 'predicate',
          label: 'Spatial relationship',
          binding: {
            mode: 'runtime-pick',
            defaultValue: 'intersects',
            allowed: ['intersects', 'within', 'contains', 'touches', 'near'],
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Distance (meters)',
          hint: "Only used when the predicate is 'near'.",
          binding: { mode: 'runtime-input', defaultMeters: 100 },
        },
      ],
      pipeline: [
        {
          tool: 'spatial-filter',
          params: {
            otherSource: { kind: 'parameter', name: 'aoi' },
            predicate: { kind: 'parameter', name: 'predicate' },
            distance: { kind: 'parameter', name: 'distance' },
          },
        },
      ],
      output: { kind: 'selection', targetParameterRef: 'target' },
      selectionLimit: DEFAULT_TOOL_SELECTION_LIMIT,
    };
  },
};

/**
 * Find-OSM-features-near-selection template (#OSM).  Stamps out a
 * working "Show me [user-picked OSM features] within [N] miles of
 * my [drawn AOI / parcel]" tool.  The runtime renders matching
 * features as an overlay on the host map with the required ODbL
 * attribution.
 *
 * Parameter slots:
 *   aoi:      runtime-draw  -- the user draws their area of
 *                              interest on the map at run time.
 *   osm:      runtime-pick  -- the user picks from the iD preset
 *                              catalog and optionally adds tag
 *                              filters (brand=Citgo, etc.).
 *   distance: runtime-input -- meters; default 1609 (~1 mile)
 *                              so the bbox padding feels right
 *                              for the canonical "things near
 *                              this parcel" framing.
 *
 * Pipeline is empty in v1; the recipe runner returns every OSM
 * feature inside the AOI's padded bbox.  Wave 2 will add a
 * spatial-filter step over a transient scope so tighter "exactly
 * within X distance" filtering becomes possible.
 */
const FIND_OSM_NEAR: RecipeTemplate = {
  id: 'find-osm-near',
  label: 'Find OSM features near my area',
  description:
    'Draw an area on the map; pick which OpenStreetMap features to show (gas stations, restaurants, schools, ...); optionally add tag filters (brand, cuisine, ...). Matching features appear on the host map.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape on the map; OSM features within (and just outside) this area will show up.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more kinds of OpenStreetMap feature.  Optional filters narrow it further.',
          required: true,
          binding: {
            mode: 'runtime-pick',
            allowCustomTagFilters: true,
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Search radius',
          hint: 'Pad the area of interest before the OSM query.  Change units on the input if you prefer feet, kilometers, etc.',
          unit: 'miles',
          binding: { mode: 'runtime-input', defaultMeters: 1609.344 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      aoiParameterRef: 'aoi',
    };
  },
};

/**
 * OSM Name Search starter (#149).  Same osm-features-overlay
 * output as FIND_OSM_NEAR, but the OSM feature parameter ships
 * with a pre-stamped `name~"…"` (contains, case-insensitive) tag
 * filter so the runtime user can type a place name and get every
 * matching feature back -- the canonical "find every Speedway in
 * this county" / "what's that building called X" workflow.
 *
 * The op selector on the runtime tag-filter UI lets the user
 * switch to exact match or regex; the stamped default is
 * contains because that's the lowest-effort happy path for the
 * dominant use case.
 */
const FIND_OSM_BY_NAME: RecipeTemplate = {
  id: 'find-osm-by-name',
  label: 'Find OSM features by name',
  description:
    "Draw an area on the map; pick what kind of OpenStreetMap feature to look in; type a name (or part of one) and get every match. Handy for 'every Speedway in this county' or 'find the building named Roosevelt Apartments' workflows.",
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape on the map; the search runs inside (and a small buffer beyond) it.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more feature kinds, then type the name (or part of one) in the filter value box.',
          required: true,
          binding: {
            mode: 'runtime-pick',
            // Default to a name-substring filter so the user only
            // has to type the value at runtime.  The runtime UI's
            // op picker lets them switch to exact match or regex
            // if they want.
            defaultTagFilters: [{ key: 'name', value: '', op: 'contains' }],
            allowCustomTagFilters: true,
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Search radius',
          hint: 'Pad the area of interest before the OSM query.  Change units on the input if you prefer feet, kilometers, etc.',
          unit: 'miles',
          binding: { mode: 'runtime-input', defaultMeters: 1609.344 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      aoiParameterRef: 'aoi',
    };
  },
};

/**
 * Nearest-N starter (#150).  Drop a pin, pick a feature kind,
 * set a search radius + a count, get the N closest matching OSM
 * features back sorted by distance with each feature carrying a
 * `distance_meters` property for popup display.
 *
 * The canonical "what's near here" workflow: useful both as
 * exploration ("coffee shops near my hotel") and as verification
 * during the detective-style geolocation workflow ("if the video
 * is here, what OSM landmarks should be visible nearby?").
 */
const FIND_OSM_NEAREST_N: RecipeTemplate = {
  id: 'find-osm-nearest-n',
  label: 'Find the N closest OSM features to a pin',
  description:
    "Drop a pin on the map, pick a feature kind (coffee shop, school, gas station, ...), set a search radius and a count, and get the N closest matching features sorted by distance. Each popup shows how far the feature is from the pin.",
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'point',
          name: 'point',
          label: 'Drop a pin',
          hint: 'Click on the map to set the search center, or paste a lat / lng pair.',
          required: true,
          binding: { mode: 'runtime-pick' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more kinds of OpenStreetMap feature.',
          required: true,
          binding: { mode: 'runtime-pick', allowCustomTagFilters: true },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Search radius',
          hint: 'How far to search around the pin.  Defaults to 1 mile; change units if you prefer kilometers, feet, etc.',
          unit: 'miles',
          binding: { mode: 'runtime-input', defaultMeters: 1609.344 },
        },
        {
          kind: 'number',
          name: 'nearestLimit',
          label: 'How many results',
          hint: 'Show the N closest matches.  10 by default; set higher for a denser list, lower for the bare-essentials view.',
          required: false,
          binding: { mode: 'runtime-input', defaultValue: 10, min: 1, max: 500 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      // #150: pointParameterRef + nearestLimitParameterRef put the
      // recipe runner into Nearest-N mode -- bbox is derived from
      // the point and the result is sorted by distance + truncated.
      pointParameterRef: 'point',
      nearestLimitParameterRef: 'nearestLimit',
    };
  },
};

/**
 * Corridor-along-a-line starter (#151).  Draw a line on the map
 * (a planned route, a road segment, a trail), set a corridor
 * width, pick a feature kind, get every matching feature within
 * the corridor.  Canonical "every gas station along I-95 from
 * Boston to NYC" / "every farm stand along this country road"
 * workflow.
 *
 * v1 uses the LineString's bbox padded by the search radius as
 * the Overpass query bound; that over-fetches corner features
 * (anything in the rectangular bbox but not strictly inside the
 * buffer polygon will still come back).  Tighter "actually
 * inside the buffer" filtering is a follow-up that adds a PostGIS
 * ST_Buffer + ST_DWithin post-pass; for typical short / medium
 * lines the over-fetch is small and acceptable.
 */
const FIND_OSM_ALONG_LINE: RecipeTemplate = {
  id: 'find-osm-along-line',
  label: 'Find OSM features along a line',
  description:
    'Draw a line on the map (a route, a road, a trail); set a corridor width; pick a feature kind; matching features inside the corridor appear on the host map. Handy for "every gas station along this route" workflows.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Route or line',
          hint: 'Draw a line on the map; the search runs inside (and a buffer beyond) it.',
          required: true,
          geometryType: 'line',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more kinds of OpenStreetMap feature.  Optional filters narrow it further.',
          required: true,
          binding: { mode: 'runtime-pick', allowCustomTagFilters: true },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Corridor width',
          hint: 'Pad the line by this distance on each side. 1 km by default; widen if you need a fatter corridor.',
          unit: 'kilometers',
          binding: { mode: 'runtime-input', defaultMeters: 1000 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      aoiParameterRef: 'aoi',
    };
  },
};

/**
 * Reverse-geocode-at-point starter (#152).  Drop a pin, get
 * every OSM feature AT that point: containing admin polygons,
 * named places, building footprints, plus everything within a
 * small radius (POIs, roads, etc.).  Results are ranked by
 * approximate bbox area so the building outranks the city
 * outranks the state.
 *
 * The "drop pin -> what's actually here" workflow.  Useful both
 * as casual exploration ("what's this place I clicked on") and
 * as the verification step in the detective geolocation flow
 * ("if my guess is right, what should be at this coordinate").
 */
const REVERSE_GEOCODE_AT_POINT: RecipeTemplate = {
  id: 'osm-reverse-geocode-at-point',
  label: 'What is at this point',
  description:
    'Drop a pin on the map and see every OpenStreetMap feature at that point: the building, the road, the named place, the city, the county, the state. Useful for "where am I?" exploration and for verifying a guessed geolocation.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'point',
          name: 'point',
          label: 'Drop a pin',
          hint: 'Click on the map to set the point, or paste a lat / lng pair.',
          required: true,
          binding: { mode: 'runtime-pick' },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Nearby radius',
          hint: 'How far around the pin to include nearby features (buildings, POIs, roads).  Defaults to 50 m.',
          unit: 'meters',
          binding: { mode: 'runtime-input', defaultMeters: 50 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      // #152: reverseGeocodeAtPoint flips the runner into the
      // is_in: + around: path -- no preset filter needed, no
      // sourceParameterRef referenced.  The point parameter
      // supplies the location; distance the surrounding radius.
      reverseGeocodeAtPoint: true,
      pointParameterRef: 'point',
    };
  },
};

/**
 * Schools-near-park-and-liquor-store starter (#142).  Stamps out
 * a working OsmRelationalQueryAction: find schools inside the
 * runtime AOI that have at least one park AND at least one
 * liquor store within half a mile.  The canonical walkability /
 * urban-planning shape; users clone and re-preset to express any
 * A-near-B-AND-C query.
 *
 * Today's detail page renders a JSON-edit fallback for the
 * relational action shape since the visual builder is still
 * queued.  Users can still run the stamped tool unchanged from
 * any Custom Web App's Tool widget; the AOI parameter collects
 * from a drawn polygon at runtime and the three result layers
 * (anchor / supporting / buffers) appear on the host map.
 */
const RELATIONAL_SCHOOLS_PARK_LIQUOR: RecipeTemplate = {
  id: 'osm-relational-school-park-liquor',
  label: 'Schools near a park AND a liquor store',
  description:
    'Find schools inside your drawn area that are within half a mile of both a park and a liquor store. The canonical OSM relational starter; clone and change the presets to express any A-near-B-AND-C query.',
  build(): OsmRelationalQueryAction {
    return {
      kind: 'osm-relational-query',
      relationalVersion: 1,
      anchorPreset: 'amenity/school',
      conditions: [
        { preset: 'leisure/park', distance: { value: 0.5, unit: 'mi' } },
        { preset: 'shop/alcohol', distance: { value: 0.5, unit: 'mi' } },
      ],
      combinator: 'and',
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a polygon on the map; the search runs inside (and a small buffer beyond) it.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
      ],
      aoiParameterRef: 'aoi',
    };
  },
};

export const RECIPE_TEMPLATES: RecipeTemplate[] = [
  SELECT_BY_LOCATION,
  FIND_OSM_NEAR,
  FIND_OSM_BY_NAME,
  FIND_OSM_NEAREST_N,
  FIND_OSM_ALONG_LINE,
  REVERSE_GEOCODE_AT_POINT,
  RELATIONAL_SCHOOLS_PARK_LIQUOR,
];

/** Convenience accessor for the canonical Select-By-Location
 *  template.  Useful for tests + the new-item wizard's "stamp out
 *  a working starter" path. Returns the concrete RecipeAction
 *  shape (not the widened union) because Select-By-Location is
 *  always a recipe with selection output. */
export function selectByLocationRecipe(): RecipeAction {
  return SELECT_BY_LOCATION.build() as RecipeAction;
}
