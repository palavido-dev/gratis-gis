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
import type { LengthUnit } from './length';

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
 * Discriminated union of every available tool step. Adding a new tool
 * means adding a member here, a generator file in
 * apps/portal-api/src/derived-layers/tools/, and a wizard step in
 * apps/portal-web. No schema migration required.
 */
export type ToolStep = BufferStep;

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
