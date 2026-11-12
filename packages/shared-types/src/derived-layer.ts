// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's dataJson when `type =
 * 'derived_layer'`.
 *
 * A derived layer holds a recipe, never a snapshot: a reference to a
 * source data_layer plus an ordered pipeline of tool steps. The read
 * path runs the pipeline against the source's PostGIS table on every
 * request, so the derived layer stays in sync with its source for
 * free.
 *
 * See docs/derived-layers.md for the full design (data shape, tool
 * registry, read path, sharing, dependency tracking).
 *
 * Versioned for forward compatibility: bump `version` and write a
 * migrator when a breaking change is needed. The runtime should
 * tolerate missing fields and fall back to defaults so older derived
 * layer items keep rendering after additive shape changes.
 */

import type { FeatureField } from './data-layer';
import type { AreaUnit, LengthUnit } from './length';

/**
 * Source kind.  Now supports both data_layer and derived_layer
 * sources so authors can chain pipelines across items (#78): a
 * derived layer can feed another derived layer's input.  The
 * read path detects cycles at save time and rejects them; sharing
 * checks recursively, so a viewer must hold read on every layer
 * in the source chain.
 */
export interface DerivedLayerSource {
  kind: 'data_layer' | 'derived_layer';
  /** UUID of the source Item (data_layer or derived_layer). */
  itemId: string;
  /**
   * Optional sublayer key when the source is a v3 multi-layer data
   * layer.  Null / undefined means "the layer's only sublayer" or
   * "treat the data_layer as a single feature collection".  Ignored
   * for kind='derived_layer' (a derived layer has a single output).
   */
  layerKey?: string;
}

/**
 * Buffer tool step. Expands every input geometry outward using PostGIS
 * `ST_Buffer(geom::geography, distanceMeters)`. The `geography` cast
 * keeps distance correct globally regardless of longitude.
 *
 * Distance can come from one of two places:
 *   - `mode: 'fixed'` applies the same `distance` (interpreted in
 *     `unit`) to every input feature.
 *   - `mode: 'field'` reads a per-feature distance from the named
 *     numeric field on the source schema, interpreted in `unit`. The
 *     server stamps `cachedMaxMeters` at recipe-save time by querying
 *     the source's MAX of that field, so the read path can pad the
 *     bbox correctly without inspecting source rows on every call.
 */
export type BufferParams =
  | {
      mode: 'fixed';
      /** Buffer distance in `unit`. Must be a finite number > 0. */
      distance: number;
      unit: LengthUnit;
    }
  | {
      mode: 'field';
      /**
       * Name of a field on the source schema whose value supplies the
       * per-feature buffer distance. Must reference a `type: 'number'`
       * FeatureField. NULL or non-numeric row values produce NULL
       * geometry (skipped by the read path's `WHERE geom IS NOT NULL`).
       */
      field: string;
      /** Unit the field's stored value is interpreted in. */
      unit: LengthUnit;
      /**
       * Server-computed cap on the per-feature buffer in meters,
       * derived from the source's MAX of `field` at recipe-save time.
       * Drives bbox padding on the read path and clamps each feature's
       * buffer in SQL so a stray oversized value can't generate a
       * planet-spanning geometry. Persisted on the recipe; the wizard
       * never asks the user for it. Stale-when-source-grows is
       * acknowledged in v1; see docs/derived-layers.md.
       */
      cachedMaxMeters: number;
    };

export interface BufferStep {
  tool: 'buffer';
  params: BufferParams;
}

/**
 * Dissolve tool step. Merges every input geometry into a single
 * feature via PostGIS `ST_Union(geom)`. Drops all attributes (since
 * N rows collapse to 1, there is no deterministic answer for what
 * each attribute should be in the merged row); v2 may add a
 * `groupBy` parameter that aggregates by an attribute.
 *
 * Runs before downstream steps that don't depend on per-feature
 * attributes; placing dissolve before a field-mode buffer is a
 * validate-time error because the named field no longer exists in
 * the merged step's schema.
 */
export interface DissolveStep {
  tool: 'dissolve';
  params: Record<string, never>;
}

/**
 * Centroid tool step. Replaces each input geometry with its centroid
 * point via PostGIS `ST_Centroid(geom)`. Attributes pass through
 * unchanged. Output is always point geometry regardless of input.
 *
 * Useful for "where is the middle of each polygon" workflows
 * (labeling, density grids, snapping to nearest road, etc).
 */
export interface CentroidStep {
  tool: 'centroid';
  params: Record<string, never>;
}

/**
 * Convex-hull tool step. Replaces each input geometry with its
 * convex hull (`ST_ConvexHull`). Attributes pass through. v1
 * computes per-feature; an aggregate "hull of all features" mode
 * could land later as a `mode: 'aggregate'` switch.
 */
export interface ConvexHullStep {
  tool: 'convex-hull';
  params: Record<string, never>;
}

/**
 * Bounding-box (envelope) tool step. Replaces each input geometry
 * with its axis-aligned bounding rectangle via `ST_Envelope(geom)`.
 * Attributes pass through. Output is polygon geometry.
 */
export interface BboxStep {
  tool: 'bbox';
  params: Record<string, never>;
}

/**
 * Simplify tool step. Reduces vertex count via Douglas-Peucker on
 * the input geometry. Tolerance is in meters via the geography
 * cast, matching buffer's distance handling. Smaller tolerance =
 * more vertices kept = closer to original.
 */
export interface SimplifyStep {
  tool: 'simplify';
  params: {
    /** Tolerance in `unit`. Vertices closer than this are dropped. */
    tolerance: number;
    unit: LengthUnit;
  };
}

/**
 * Vertices tool step. Explodes each input line / polygon geometry
 * into one point feature per vertex. Adds `vertex_index` (0-based)
 * to each output row's attributes; the source schema is preserved
 * alongside it. Useful for "show me the corners" workflows.
 */
export interface VerticesStep {
  tool: 'vertices';
  params: Record<string, never>;
}

/**
 * Densify tool step. Adds intermediate vertices along input lines /
 * polygon boundaries so no segment exceeds `maxSegmentLength` in
 * `unit`. Uses `ST_Segmentize` on geography for accurate-on-Earth
 * spacing. Useful before reprojection (line preservation) and for
 * smoother along-line interpolation.
 */
export interface DensifyStep {
  tool: 'densify';
  params: {
    maxSegmentLength: number;
    unit: LengthUnit;
  };
}

/**
 * Top-N filter step. Keeps the N rows with the highest (or lowest)
 * value of a numeric field. The field must exist on the upstream
 * schema and be numeric. Useful for "ten largest parcels", "five
 * closest hospitals" style workflows once distance fields are
 * available.
 */
export interface TopNStep {
  tool: 'top-n';
  params: {
    field: string;
    n: number;
    direction: 'asc' | 'desc';
  };
}

/**
 * Random-sample filter step. Returns a deterministic random subset
 * of the input. `mode: 'percentage'` keeps roughly `value` percent
 * of rows; `mode: 'count'` keeps exactly `value` rows. The seed is
 * persisted so the same recipe yields the same sample across reads.
 */
export interface RandomSampleStep {
  tool: 'random-sample';
  params: {
    mode: 'percentage' | 'count';
    /** Percentage in 0..100 when mode='percentage'; count when 'count'. */
    value: number;
    /** Persisted random seed for stable output across reads. */
    seed: number;
  };
}

/**
 * Nearest-neighbor distance step. Adds a `nearest_distance_m`
 * numeric attribute to each input feature: the meters-distance to
 * the closest OTHER feature in the same input. Computed via a
 * self-join with `ST_Distance(geography, geography)`. Geometry
 * passes through unchanged. The first / only feature in a layer
 * yields NULL.
 */
export interface NearestNeighborStep {
  tool: 'nearest-neighbor';
  params: Record<string, never>;
}

/**
 * Fishnet step. Generates a grid of square cells (or transect
 * lines) covering each input polygon's bounding box, clipped to
 * the polygon. Cell size in `unit`. Output mode picks polygons
 * (filled cells) or lines (just the grid lines / transects).
 *
 * Restricted to polygon input: the generator validates the source
 * schema's geometryType when the recipe is saved.
 */
export interface FishnetStep {
  tool: 'fishnet';
  params: {
    cellSize: number;
    unit: LengthUnit;
    /** 'polygons' = filled cells; 'lines' = grid lines only. */
    output: 'polygons' | 'lines';
  };
}

/**
 * Calculate-geometry step. Adds one numeric attribute per row whose
 * value is the input geometry's length, perimeter, or area in the
 * user-chosen unit. The output column name is also user-chosen so the
 * recipe can produce a meaningful field ("acreage", "length_km")
 * instead of a generic name.
 *
 * Length and perimeter units are LengthUnit; area uses AreaUnit
 * (square versions plus hectares and acres). The generator picks the
 * right SQL based on `measurement` so a single tool covers all three
 * cases without forcing the user to pick a measurement-specific
 * sub-tool.
 *
 * Geometry passes through unchanged; the source schema gains exactly
 * one numeric field with the user's chosen name.
 */
export type CalculateGeometryParams =
  | {
      measurement: 'length' | 'perimeter';
      unit: LengthUnit;
      fieldName: string;
    }
  | {
      measurement: 'area';
      unit: AreaUnit;
      fieldName: string;
    };

export interface CalculateGeometryStep {
  tool: 'calculate-geometry';
  params: CalculateGeometryParams;
}

/**
 * Spatial-join step (#79).  The most-requested geoprocessing
 * primitive: take the upstream rows ("left side") and join in
 * attributes (or just a count) from a second source ("right side")
 * via a spatial predicate.
 *
 * v1 supports:
 *   - predicate 'within':     left.geom is fully inside right.geom
 *                             (typically point-in-polygon style:
 *                             "which county does this point land in")
 *   - predicate 'intersects': left.geom shares any space with
 *                             right.geom (the classic overlay)
 *   - predicate 'nearest':    right's centroid within `nearestMaxMeters`
 *                             of left.geom (default 1000 m).  Picks
 *                             the closest right row.
 *
 * attributeStrategy:
 *   - 'count':  appends a single numeric `<prefix>count` attribute
 *               with COUNT(*) of matching right rows.
 *   - 'first':  appends each named attribute from the FIRST matching
 *               right row (deterministic on entity id) under
 *               `<prefix><attrname>`.  Single output row per left row;
 *               no cartesian explosion.
 *
 * Geometry passes through unchanged from the left side.  Output
 * schema = upstream schema + the new joined attribute(s).
 */
export interface SpatialJoinStep {
  tool: 'spatial-join';
  params: {
    otherSource: {
      kind: 'data_layer';
      itemId: string;
      layerKey?: string;
    };
    predicate: 'within' | 'intersects' | 'nearest';
    /** For predicate='nearest': max distance (meters).  Defaults to
     *  1000 when the field is missing on persisted recipes. */
    nearestMaxMeters?: number;
    attributeStrategy: 'count' | 'first';
    /** For attributeStrategy='first': which right-side attribute
     *  names to project onto each left row.  Must be non-empty
     *  when strategy='first'; ignored for 'count'. */
    attrsToKeep?: string[];
    /** Prefix prepended to every joined attribute name to avoid
     *  collisions with upstream field names.  Defaults to 'joined_'. */
    attrPrefix?: string;
  };
}

/**
 * Group-by aggregation step (#80).  The principled generalization
 * of dissolve: collapse N rows into one (or one-per-group) and
 * compute aggregate values across them.
 *
 * Geometry handling: when at least one group is set, output
 * geometry is ST_Union of the inputs in each group ("dissolve by
 * attribute", the AGO/QGIS classic).  When groupBy is empty, the
 * whole layer collapses to one feature whose geometry is the
 * union of all inputs (current dissolve behavior).
 *
 * Aggregations: for each entry in `aggs` the step adds one
 * attribute named `outputName` whose value is `op(field)` across
 * the group.  `op: 'count'` ignores field and counts rows; 'sum',
 * 'avg', 'min', 'max' need a numeric field; 'first' picks any one
 * row's value deterministically (the lowest global_id) so the
 * result is stable across reads of the same recipe.
 */
export type AggOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first';

export interface AggregateAggregation {
  /** Field on the upstream schema to aggregate over.  Empty for op='count'. */
  field: string;
  op: AggOp;
  /** Output column name; must not collide with any group-by column. */
  outputName: string;
}

export interface AggregateStep {
  tool: 'aggregate';
  params: {
    /**
     * Upstream attribute names to group by.  Empty array means
     * "single output row" (the current dissolve behavior).  Each
     * named field is preserved on the output schema with its
     * original type.
     */
    groupBy: string[];
    aggs: AggregateAggregation[];
  };
}

/**
 * Attribute filter step (#76).  Keeps rows whose expression
 * evaluates truthy.  The expression is parsed + validated against
 * the upstream schema at recipe-save time; the SQL emitter
 * compiles it to a parameterized WHERE clause.
 *
 * Geometry and attributes pass through unchanged.  Empty
 * `expression` is a save-time validation error: an "always true"
 * filter adds noise without value, and an "always false" filter
 * is more clearly written as `false`.
 */
export interface FilterStep {
  tool: 'filter';
  params: {
    /** Expression source, e.g. `{{acres}} > 5 AND {{zoning}} == 'R1'`. */
    expression: string;
  };
}

/**
 * Field calculator step (#77).  Appends one new attribute to each
 * row by evaluating the expression against the upstream schema.
 * The result column is named by `outputName` and typed by
 * `outputType` -- the SQL emitter casts the expression value to
 * the declared type, so a user writing a numeric expression but
 * setting outputType='string' gets a TEXT column.
 *
 * Geometry passes through unchanged.  Attributes pass through and
 * gain one more.  `outputName` must not collide with an existing
 * field; the save-time validator rejects shadows.
 */
export interface CalculateFieldStep {
  tool: 'calculate-field';
  params: {
    outputName: string;
    outputType: 'number' | 'string' | 'boolean';
    /** Expression source, e.g. `{{acres}} * 0.4047`. */
    expression: string;
  };
}

/**
 * Contour-from-points step (#88).  Takes point features with a
 * numeric attribute (elevation, water level, sample reading) and
 * emits contour lines at user-chosen intervals.  Output is one
 * line feature per (triangle, level) intersection, tagged with a
 * `level` property; downstream tools can dissolve / aggregate
 * those into per-level multilines if a single feature per level
 * is preferred.
 *
 * Implementation uses a TIN-interpolated surface:
 *   1. ST_DelaunayTriangles(ST_Collect(geom)) builds the TIN.
 *   2. For each triangle + each contour level, compute where the
 *      triangle's linearly-interpolated surface crosses the level.
 *      A triangle crosses a level when min(zA,zB,zC) <= level <=
 *      max(zA,zB,zC); the crossing produces one line segment from
 *      the two interpolated points on the two crossing edges.
 *   3. Emit one feature per segment, tagged with `level`.
 *
 * Levels are specified one of two ways:
 *   - `mode: 'auto'`: server computes min/max of the field at
 *     save time, generates levels at the chosen step.
 *   - `mode: 'manual'`: an explicit list of level values the
 *     author wants drawn (handy for "round numbers" or matched-to-
 *     a-domain conventions like the 10-year flood line).
 *
 * Not supported in v1 (queued):
 *   - Kriging (currently linear TIN interpolation).
 *   - Polygon "filled contour" output (closed isobands between
 *     adjacent levels).  The line output is sufficient for visual
 *     interpolation; filled bands need a marching-squares variant
 *     that closes the lines against an extent polygon.
 *   - Per-feature value from a related table; the current tool
 *     reads the value field straight off the upstream row.  Pair
 *     with #88's eventual attribute-join tool to handle the
 *     wells + measurements split for the groundwater scenario.
 */
export interface ContourStep {
  tool: 'contour';
  params: {
    /**
     * Numeric field on the upstream schema whose value is the
     * surface height (elevation, water level, sample reading).
     * Save-time validator rejects non-numeric fields.
     */
    field: string;
    mode: 'auto' | 'manual';
    /**
     * Interval between contour levels, in the field's own units.
     * Required for mode='auto'; ignored for mode='manual'.
     */
    interval?: number;
    /**
     * Lower bound for auto-generated levels.  Defaults to the
     * field's MIN at save time when omitted.  Always tightly
     * coupled with the cached values stamped by enrich at save.
     */
    minLevel?: number;
    /** Upper bound; defaults to the field's MAX at save time. */
    maxLevel?: number;
    /**
     * Explicit list of level values to draw (mode='manual').
     * Must be a sorted ascending array of finite numbers, length
     * 1-100.  The 100 cap matches the auto-mode safety on
     * (max-min)/interval so the output never explodes.
     */
    levels?: number[];
    /**
     * Server-stamped cache: actual levels the read path uses.
     * Computed from min/max/interval at save time so the SQL
     * doesn't recompute the per-recipe range on every read.
     * Always present on persisted recipes; the wizard never asks
     * the author for this directly.
     */
    cachedLevels?: number[];
  };
}

/**
 * Spatial predicates supported across the recipe vocabulary.
 *
 *  - intersects: any shared point between left and right (the classic
 *                overlay; covers touches, within, contains, equal)
 *  - within:     left.geom is fully inside right.geom
 *  - contains:   left.geom fully contains right.geom (inverse of within)
 *  - touches:    left and right share only boundary (no interior overlap)
 *  - near:       left.geom is within `distance` meters of right.geom
 *                (compiled via ST_DWithin on geography)
 *
 * Shared by `spatial-filter` here in the derived_layer vocabulary and
 * by `PredicateParameter` in the tool recipe layer.  Adding a
 * predicate means extending this union and teaching every SQL emitter
 * that consumes it; SpatialJoinStep predates this union and keeps its
 * narrower set ('within' | 'intersects' | 'nearest') for historical
 * reasons -- joining and filtering have subtly different semantics
 * for "near" (join picks the closest right row; filter keeps any
 * left row near any right row), so they are intentionally different
 * vocabularies.
 */
export type SpatialPredicate =
  | 'intersects'
  | 'within'
  | 'contains'
  | 'touches'
  | 'near';

/**
 * Reference to a step's "other source".  Three forms cover the
 * recipe-vocabulary use cases:
 *
 *   - `data_layer`:       a portal data_layer item, optionally
 *                         restricted to a sublayer and / or a
 *                         specific set of feature ids.  The only
 *                         form valid in a saved derived_layer.
 *   - `inline-geometry`:  raw GeoJSON spliced into the step at run
 *                         time.  Populated by the tool-recipe runner
 *                         when a `feature-source` parameter bound to
 *                         `runtime-draw` is resolved.  Rejected by
 *                         the derived_layer save-time validator (an
 *                         inline geometry baked into a saved recipe
 *                         would freeze a once-drawn AOI forever).
 *   - `parameter`:        unresolved reference to a tool-recipe
 *                         parameter slot.  Valid only inside a tool
 *                         recipe's pipeline at design time; the
 *                         recipe runner replaces every parameter ref
 *                         with the appropriate resolved shape before
 *                         handing the pipeline to the SQL compiler.
 */
export type SourceRef =
  | {
      kind: 'data_layer';
      itemId: string;
      layerKey?: string;
      /** Optional subset; when present, the step's right-side rows
       *  are restricted to these feature ids.  Populated by the
       *  recipe runner when a feature-source parameter bound to
       *  `runtime-selection` resolves to "use the current selection
       *  on this layer". */
      featureIds?: Array<string | number>;
    }
  | {
      /** Inline GeoJSON Feature, FeatureCollection, or bare Geometry.
       *  Only valid post-resolution; the SQL compiler converts the
       *  shape into a one-row VALUES table via ST_GeomFromGeoJSON. */
      kind: 'inline-geometry';
      geometry: unknown;
    }
  | { kind: 'parameter'; name: string }
  | {
      /**
       * Live OpenStreetMap query, materialised into a transient
       * observation-log scope by the recipe runner.  Only valid
       * post-resolution (a tool recipe that has an OSM-feature
       * parameter resolves to this shape; derived_layer recipes
       * reject this kind via save-time validation in v1 -- adding
       * persistent OSM-backed derived_layers is the wave-3 work).
       *
       * `presetIds` references entries in the OSM preset catalog
       * (apps/portal-web/content/osm/preset-catalog.json); the
       * adapter expands them to Overpass QL clauses (a union of
       * the per-preset tag combinations across the declared
       * geometries).  `tagFilters` are ANDed onto every clause.
       * `bboxPaddingMeters` lets a recipe step's distance grow
       * the AOI's bbox before the Overpass call, ensuring features
       * near the AOI's edge are pulled.
       */
      kind: 'osm-query';
      presetIds: string[];
      tagFilters?: Array<{ key: string; value: string; op?: 'equals' | 'contains' | 'regex' }>;
      bboxPaddingMeters?: number;
      /**
       * #101: per-recipe cache TTL in minutes. When set, overrides
       * the engine default (60 minutes). 0 means "always fresh"
       * (skip the cache entirely); a large value lets a recipe
       * that hits historical / slow-changing data avoid re-fetching
       * for a day or more. The adapter caps this server-side so a
       * runaway value can't permanently pin a stale scope.
       */
      ttlMinutes?: number;
    };

/** Distance reference: a fixed meters value or a parameter resolved at run time. */
export type DistanceRef =
  | { kind: 'fixed'; meters: number }
  | { kind: 'parameter'; name: string };

/** Predicate reference: a literal predicate or a parameter resolved at run time. */
export type PredicateRef =
  | { kind: 'fixed'; value: SpatialPredicate }
  | { kind: 'parameter'; name: string };

/**
 * Spatial-filter step. Keeps upstream rows whose geometry satisfies a
 * predicate against `otherSource`. Output schema = upstream schema
 * (no attribute decoration -- pair with spatial-join for that). Output
 * geometry = upstream geometry passed through unchanged.
 *
 * Compiles to a WHERE clause:
 *   - intersects: ST_Intersects(left.geom, right.geom)
 *   - within:     ST_Within(left.geom, right.geom)
 *   - contains:   ST_Contains(left.geom, right.geom)
 *   - touches:    ST_Touches(left.geom, right.geom)
 *   - near:       ST_DWithin(left.geom::geography,
 *                            right.geom::geography,
 *                            distanceMeters)
 *
 * When `otherSource.kind === 'data_layer'` the right side is a
 * subquery against the referenced data_layer.  When it's
 * `'parameter'`, the tool recipe runner substitutes an inline
 * geometry (a drawn AOI) before SQL compilation.
 *
 * `distance` is required when the (resolved) predicate is 'near' and
 * ignored otherwise. The save-time validator rejects 'near' with no
 * distance.  Inside a derived_layer (no parameters), `otherSource`
 * and `predicate` and `distance` must all be `{ kind: 'fixed' }` /
 * `{ kind: 'data_layer' }`.
 */
export interface SpatialFilterStep {
  tool: 'spatial-filter';
  params: {
    otherSource: SourceRef;
    predicate: PredicateRef;
    distance?: DistanceRef;
  };
}

/**
 * Discriminated union of every available tool step. Adding a new tool
 * means adding a member here, a generator file in
 * apps/portal-api/src/derived-layers/tools/, and a wizard step in
 * apps/portal-web. No schema migration required.
 *
 * The same union is the step vocabulary for both derived_layer
 * pipelines and tool-recipe pipelines; steps that allow parameter
 * refs (like spatial-filter) restrict those refs to the tool path
 * via save-time validation, not via separate types.
 */
export type ToolStep =
  | BufferStep
  | DissolveStep
  | CentroidStep
  | ConvexHullStep
  | BboxStep
  | SimplifyStep
  | VerticesStep
  | DensifyStep
  | TopNStep
  | RandomSampleStep
  | NearestNeighborStep
  | FishnetStep
  | CalculateGeometryStep
  | FilterStep
  | CalculateFieldStep
  | AggregateStep
  | SpatialJoinStep
  | SpatialFilterStep
  | ClipStep
  | EraseStep
  | ContourStep;

/**
 * #157 Phase 2: binary spatial overlay step. Clip the upstream
 * features to the geometric intersection with a second data_layer:
 * only the parts of upstream that fall inside the other layer
 * survive, and the output geometry is the clipped piece. Rows that
 * have no overlap at all are dropped.
 *
 * Attributes pass through unchanged from the upstream side; the
 * other layer's attributes are NOT joined (use spatial-join for
 * that). This keeps the operation cookie-cutter-simple: same rows
 * minus the rows that miss, with geometries trimmed to fit.
 *
 * Implemented as ST_Intersection(upstream.geom, ST_Union(other.geom))
 * filtered to upstream rows that ST_Intersects the other layer's
 * union. Empty-result rows are dropped post-intersection so a
 * row whose geometry happens to lie entirely on a shared boundary
 * (zero-area intersection) doesn't survive.
 */
export interface ClipStep {
  tool: 'clip';
  params: {
    otherSource: {
      kind: 'data_layer';
      itemId: string;
      layerKey?: string;
    };
  };
}

/**
 * #157 Phase 2: binary spatial overlay step. The inverse of clip:
 * keep only the parts of upstream features that fall OUTSIDE the
 * second data_layer. Useful for "find areas more than X miles from
 * any park" by feeding a buffered parks layer in as otherSource,
 * or "every parcel except those owned by the city" via a city-
 * owned-parcels mask.
 *
 * Implemented as ST_Difference(upstream.geom, ST_Union(other.geom)).
 * Rows whose entire geometry is consumed by the difference (i.e.
 * fully covered by the other layer) drop out of the result.
 */
export interface EraseStep {
  tool: 'erase';
  params: {
    otherSource: {
      kind: 'data_layer';
      itemId: string;
      layerKey?: string;
    };
  };
}

/**
 * The recipe persisted in `item.data` when `type = 'derived_layer'`.
 */
export interface DerivedLayerData {
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1;

  /** The single input layer (a data_layer or another derived_layer). */
  source: DerivedLayerSource;

  /**
   * Ordered list of tool steps. The output of step N is the input of
   * step N+1. An empty pipeline is invalid: a derived layer with no
   * steps adds no value over reading the source directly, so the
   * server rejects it.
   */
  pipeline: ToolStep[];

  /**
   * Hard ceiling on features returned by the read path. Applied after
   * the pipeline runs (i.e. on the output rows). Default 1000. The
   * map UI passes a bbox on every read so on real map workflows this
   * cap rarely bites; it's the safety net for "open the layer with no
   * map context" cases.
   */
  featureLimit: number;

  /**
   * Cached output schema computed at save time from the source schema
   * + pipeline. Lets dashboards and apps bind to the layer without
   * running the query first. Recomputed on every recipe edit by the
   * server (the client may send a hint, but the server is the
   * authoritative writer).
   */
  outputSchema: FeatureField[];

  /**
   * Cached bounding box in EPSG:4326 as [west, south, east, north],
   * derived from the source's bbox padded outward by the pipeline's
   * total outward reach. Recomputed by the server whenever the
   * recipe changes or the source's bbox is recomputed. Empty array
   * when the source has no spatial footprint yet (matching the
   * convention used by Item.bbox).
   */
  bbox: number[];
}

/**
 * The default for the feature cap. Lifted into a constant so backend
 * validation, the wizard's UI, and tests stay in sync.
 */
export const DEFAULT_DERIVED_LAYER_FEATURE_LIMIT = 1000;

/**
 * Per-tool maximum buffer distance the wizard exposes (meters). Soft
 * UI bound to prevent accidental world-spanning buffers; the server
 * enforces a matching ceiling (see backend `bufferGenerator`).
 */
export const MAX_BUFFER_DISTANCE_METERS = 100_000;

/**
 * Default buffer step the wizard emits on first mount: 100 meters,
 * fixed mode. Lifted into shared-types so the new-item wizard, the
 * edit page builder, and any test that wants to seed a sane recipe
 * agree on the same starting point.
 */
export const DEFAULT_BUFFER_STEP: BufferStep = {
  tool: 'buffer',
  params: { mode: 'fixed', distance: 100, unit: 'meters' },
};

/**
 * Default dissolve step. Empty params shape since v1 dissolve takes
 * no inputs. Exported for symmetry with `DEFAULT_BUFFER_STEP`; the
 * pipeline builder uses it when the user picks "Dissolve" from the
 * add-step picker.
 */
export const DEFAULT_DISSOLVE_STEP: DissolveStep = {
  tool: 'dissolve',
  params: {},
};

export const DEFAULT_CENTROID_STEP: CentroidStep = {
  tool: 'centroid',
  params: {},
};
export const DEFAULT_CONVEX_HULL_STEP: ConvexHullStep = {
  tool: 'convex-hull',
  params: {},
};
export const DEFAULT_BBOX_STEP: BboxStep = {
  tool: 'bbox',
  params: {},
};
export const DEFAULT_SIMPLIFY_STEP: SimplifyStep = {
  tool: 'simplify',
  params: { tolerance: 10, unit: 'meters' },
};
export const DEFAULT_VERTICES_STEP: VerticesStep = {
  tool: 'vertices',
  params: {},
};
export const DEFAULT_DENSIFY_STEP: DensifyStep = {
  tool: 'densify',
  params: { maxSegmentLength: 100, unit: 'meters' },
};
export const DEFAULT_TOP_N_STEP: TopNStep = {
  tool: 'top-n',
  params: { field: '', n: 10, direction: 'desc' },
};
export const DEFAULT_RANDOM_SAMPLE_STEP: RandomSampleStep = {
  tool: 'random-sample',
  // Percentage mode by default at 10%; the wizard rolls a fresh seed
  // when the user inserts the step so two newly-added samples don't
  // accidentally produce the same subset. The persisted seed makes
  // the output stable across reads of the same recipe.
  params: { mode: 'percentage', value: 10, seed: 0 },
};
export const DEFAULT_NEAREST_NEIGHBOR_STEP: NearestNeighborStep = {
  tool: 'nearest-neighbor',
  params: {},
};
export const DEFAULT_FISHNET_STEP: FishnetStep = {
  tool: 'fishnet',
  params: { cellSize: 100, unit: 'meters', output: 'polygons' },
};
export const DEFAULT_CALCULATE_GEOMETRY_STEP: CalculateGeometryStep = {
  tool: 'calculate-geometry',
  // Default to area in square meters with a sensible field name; the
  // wizard surfaces a measurement toggle so the user picks length /
  // perimeter / area immediately on insert. Field name is
  // user-editable but starts with the measurement name so a recipe
  // saved without changing it still produces a coherent column.
  params: {
    measurement: 'area',
    unit: 'square-meters',
    fieldName: 'area',
  },
};
export const DEFAULT_FILTER_STEP: FilterStep = {
  tool: 'filter',
  // Empty expression saves the user a click but fails validation on
  // submit; the chip-strip editor prompts them to write one.
  params: { expression: '' },
};
export const DEFAULT_CALCULATE_FIELD_STEP: CalculateFieldStep = {
  tool: 'calculate-field',
  params: {
    outputName: 'new_field',
    outputType: 'number',
    expression: '',
  },
};
export const DEFAULT_CONTOUR_STEP: ContourStep = {
  tool: 'contour',
  params: {
    field: '',
    mode: 'auto',
    interval: 10,
  },
};

export const DEFAULT_SPATIAL_JOIN_STEP: SpatialJoinStep = {
  tool: 'spatial-join',
  params: {
    otherSource: { kind: 'data_layer', itemId: '' },
    predicate: 'intersects',
    attributeStrategy: 'count',
    attrPrefix: 'joined_',
  },
};
export const DEFAULT_SPATIAL_FILTER_STEP: SpatialFilterStep = {
  tool: 'spatial-filter',
  // Defaults match the most common Select-By-Location workflow:
  // "keep features in this layer that intersect <something>".
  // The wizard / tool designer fills in the otherSource shape; an
  // empty data_layer itemId fails save-time validation, prompting
  // the user to pick one (or in tool recipes, swap to a parameter
  // reference).
  params: {
    otherSource: { kind: 'data_layer', itemId: '' },
    predicate: { kind: 'fixed', value: 'intersects' },
  },
};

export const DEFAULT_CLIP_STEP: ClipStep = {
  tool: 'clip',
  params: {
    otherSource: { kind: 'data_layer', itemId: '' },
  },
};
export const DEFAULT_ERASE_STEP: EraseStep = {
  tool: 'erase',
  params: {
    otherSource: { kind: 'data_layer', itemId: '' },
  },
};
export const DEFAULT_AGGREGATE_STEP: AggregateStep = {
  tool: 'aggregate',
  // No groupBy + a count(*) aggregation: equivalent to the legacy
  // dissolve, but with a row count attached.  Authors can switch to
  // group-by attributes from here without re-picking a tool.
  params: {
    groupBy: [],
    aggs: [{ field: '', op: 'count', outputName: 'count' }],
  },
};

/**
 * Lookup table of "what step should we splice into the pipeline when
 * the user picks <tool>?" Exported alongside the per-step defaults so
 * a UI surface can populate an add-step picker without copy-pasting
 * the defaults map. Keys match the `tool` discriminator on each
 * ToolStep variant.
 */
export const DEFAULT_STEPS: Record<ToolStep['tool'], ToolStep> = {
  buffer: DEFAULT_BUFFER_STEP,
  dissolve: DEFAULT_DISSOLVE_STEP,
  centroid: DEFAULT_CENTROID_STEP,
  'convex-hull': DEFAULT_CONVEX_HULL_STEP,
  bbox: DEFAULT_BBOX_STEP,
  simplify: DEFAULT_SIMPLIFY_STEP,
  vertices: DEFAULT_VERTICES_STEP,
  densify: DEFAULT_DENSIFY_STEP,
  'top-n': DEFAULT_TOP_N_STEP,
  'random-sample': DEFAULT_RANDOM_SAMPLE_STEP,
  'nearest-neighbor': DEFAULT_NEAREST_NEIGHBOR_STEP,
  fishnet: DEFAULT_FISHNET_STEP,
  'calculate-geometry': DEFAULT_CALCULATE_GEOMETRY_STEP,
  filter: DEFAULT_FILTER_STEP,
  'calculate-field': DEFAULT_CALCULATE_FIELD_STEP,
  aggregate: DEFAULT_AGGREGATE_STEP,
  'spatial-join': DEFAULT_SPATIAL_JOIN_STEP,
  'spatial-filter': DEFAULT_SPATIAL_FILTER_STEP,
  clip: DEFAULT_CLIP_STEP,
  erase: DEFAULT_ERASE_STEP,
  contour: DEFAULT_CONTOUR_STEP,
};

/**
 * Empty scaffold for a brand-new derived layer. The wizard fills
 * `source` and `pipeline` before the first save, since a derived
 * layer with no source / pipeline is invalid and the server rejects
 * it. Provided here for symmetry with the other DEFAULT_* constants.
 */
export const DEFAULT_DERIVED_LAYER: DerivedLayerData = {
  version: 1,
  source: { kind: 'data_layer', itemId: '' },
  pipeline: [],
  featureLimit: DEFAULT_DERIVED_LAYER_FEATURE_LIMIT,
  outputSchema: [],
  bbox: [],
};

/**
 * Type guard for a DerivedLayerData value coming off the wire / out of
 * the database. Defensive: tolerates the shape going stale (older
 * versions, fields the client doesn't recognize) by returning false
 * rather than throwing.
 */
export function isDerivedLayerData(value: unknown): value is DerivedLayerData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  const src = v.source as Record<string, unknown> | undefined;
  if (
    !src ||
    (src.kind !== 'data_layer' && src.kind !== 'derived_layer') ||
    typeof src.itemId !== 'string'
  ) {
    return false;
  }
  if (!Array.isArray(v.pipeline)) return false;
  if (typeof v.featureLimit !== 'number') return false;
  if (!Array.isArray(v.outputSchema)) return false;
  return true;
}
