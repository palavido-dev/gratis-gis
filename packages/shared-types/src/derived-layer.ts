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
 * v1 always points at a single data_layer item. Stored as a tagged
 * shape so future kinds (a second derived_layer, a temporary
 * in-pipeline source) can slot in without rewriting reads.
 */
export interface DerivedLayerSource {
  kind: 'data_layer';
  /** UUID of the source `data_layer` Item. */
  itemId: string;
  /**
   * Optional sublayer key when the source is a v3 multi-layer data
   * layer. Null / undefined means "the layer's only sublayer" or
   * "treat the data_layer as a single feature collection".
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
 * Discriminated union of every available tool step. Adding a new tool
 * means adding a member here, a generator file in
 * apps/portal-api/src/derived-layers/tools/, and a wizard step in
 * apps/portal-web. No schema migration required.
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
  | CalculateGeometryStep;

/**
 * The recipe persisted in `item.data` when `type = 'derived_layer'`.
 */
export interface DerivedLayerData {
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1;

  /** The single input layer (v1: data_layer only). */
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
  if (!src || src.kind !== 'data_layer' || typeof src.itemId !== 'string') {
    return false;
  }
  if (!Array.isArray(v.pipeline)) return false;
  if (typeof v.featureLimit !== 'number') return false;
  if (!Array.isArray(v.outputSchema)) return false;
  return true;
}
