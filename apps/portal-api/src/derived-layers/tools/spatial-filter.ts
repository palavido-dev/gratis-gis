// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type {
  FeatureField,
  SourceRef,
  SpatialPredicate,
} from '@gratis-gis/shared-types';

import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../../engine/data-layer.js';
import { validateGeoJson } from '../../common/geometry-validation.js';
import type {
  ToolDependencies,
  ToolGenerator,
  ToolValidateContext,
} from './types.js';

/**
 * Resolved param shape for spatial-filter at SQL-emit time.  Mirrors
 * `SpatialFilterStep['params']` from shared-types but with the
 * `{ kind: 'parameter', name }` form excluded; the recipe runner is
 * expected to substitute parameter refs before handing the step to
 * the generator, and the derived_layer save path never produces
 * parameter refs in the first place.
 */
export interface SpatialFilterParams {
  otherSource:
    | { kind: 'data_layer'; itemId: string; layerKey?: string; featureIds?: Array<string | number> }
    | { kind: 'inline-geometry'; geometry: unknown };
  predicate: SpatialPredicate;
  distanceMeters?: number;
}

const MAX_DISTANCE_METERS = 1_000_000; // 1000 km guardrail
const MAX_INLINE_FEATURE_IDS = 50_000;

/**
 * Spatial-filter generator (#90).  Keeps upstream rows whose
 * geometry satisfies a predicate against `otherSource` -- the
 * filtering counterpart to spatial-join (which decorates with
 * attributes / counts rather than dropping rows).  Used both inside
 * tool recipes (with the right side typically resolved from a
 * runtime-drawn AOI parameter) and inside derived_layer pipelines
 * (with the right side hardcoded to another portal layer).
 *
 * Predicates compile to:
 *   - intersects: ST_Intersects(l.geom, r.geom)
 *   - within:     ST_Within(l.geom, r.geom)         left in right
 *   - contains:   ST_Contains(l.geom, r.geom)       left contains right
 *   - touches:    ST_Touches(l.geom, r.geom)        boundary only
 *   - near:       ST_DWithin(l.geom::geography,
 *                            r.geom::geography,
 *                            distanceMeters)
 *
 * The right side is materialised inline as a CTE.  For
 * `kind: 'data_layer'`, we use the engine's
 * `dataLayerSourceSqlFragment` so the projection picks up the same
 * current-truth view used everywhere else.  For
 * `kind: 'inline-geometry'`, we splice a single VALUES row through
 * ST_GeomFromGeoJSON -- the geometry text goes through a $N
 * placeholder so the SQL stays parameterized.
 *
 * The "left rows pass through unchanged" output schema is the
 * essential difference from spatial-join.  No attribute projection,
 * no row multiplication; the filter is purely a WHERE clause.
 */
export const spatialFilterGenerator: ToolGenerator<SpatialFilterParams> = {
  kind: 'spatial-filter',

  validate(raw: unknown, _ctx?: ToolValidateContext): SpatialFilterParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('spatial-filter.params must be an object');
    }
    const r = raw as Record<string, unknown>;

    const otherSource = parseResolvedSource(r.otherSource);

    // Predicate comes in either as a SpatialPredicate string (resolved
    // form) or as a `{ kind: 'fixed', value }` reference shape that the
    // tool recipe runner produces post-substitution.  Accept both for
    // resilience; the generator only ever sees the literal at the end.
    const predicate = resolvePredicate(r.predicate);

    // Distance is required for 'near'; ignored otherwise.  The recipe
    // runner is expected to normalise to meters before calling us, so
    // we accept a raw number here.  Accept both the resolved meters
    // form and the discriminated `{ kind: 'fixed', meters }` shape.
    let distanceMeters: number | undefined;
    if (predicate === 'near') {
      distanceMeters = resolveDistance(r.distance);
      if (distanceMeters === undefined) {
        throw new BadRequestException(
          "spatial-filter.params.distance is required when predicate is 'near'",
        );
      }
      if (
        !Number.isFinite(distanceMeters) ||
        distanceMeters <= 0 ||
        distanceMeters > MAX_DISTANCE_METERS
      ) {
        throw new BadRequestException(
          `spatial-filter.params.distance must be a positive number of meters <= ${MAX_DISTANCE_METERS}`,
        );
      }
    }

    return {
      otherSource,
      predicate,
      ...(distanceMeters !== undefined ? { distanceMeters } : {}),
    };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Filter steps pass attributes through unchanged.
    return input;
  },

  outwardReachMeters(params: SpatialFilterParams): number {
    // 'near' pulls in features up to `distanceMeters` away; other
    // predicates don't grow the bbox.  Used by the read path's
    // bbox-padding pass so a tile-edge feature stays in scope when
    // it would otherwise be clipped.
    if (params.predicate === 'near' && typeof params.distanceMeters === 'number') {
      return params.distanceMeters;
    }
    return 0;
  },

  extractDependencies(params: SpatialFilterParams): ToolDependencies {
    if (params.otherSource.kind === 'data_layer') {
      return { itemIds: [params.otherSource.itemId], urls: [] };
    }
    // Inline geometries don't reference any other portal item.
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: SpatialFilterParams, paramOffset: number) {
    const sqlParams: unknown[] = [];

    // Build the right-side CTE.  Data layer -> use the engine
    // fragment for the matching layer scope.  Inline geometry ->
    // emit a one-row VALUES with ST_GeomFromGeoJSON.
    let rightCte: string;
    if (params.otherSource.kind === 'data_layer') {
      const right = params.otherSource;
      const rightScope = dataLayerScope(
        right.itemId,
        right.layerKey ?? 'default',
      );
      const baseConditions = ['valid_to IS NULL'];
      const baseFragment = dataLayerSourceSqlFragment(rightScope, {
        collapseConditions: baseConditions,
      });
      if (right.featureIds && right.featureIds.length > 0) {
        // Restrict to the caller's chosen subset.  Used when a
        // runtime-selection feature-source parameter resolves to
        // "use the current selection on this layer".  Cap protects
        // the SQL planner from a runaway in-list.
        if (right.featureIds.length > MAX_INLINE_FEATURE_IDS) {
          throw new BadRequestException(
            `spatial-filter.params.otherSource.featureIds may not exceed ${MAX_INLINE_FEATURE_IDS}`,
          );
        }
        sqlParams.push(right.featureIds);
        const placeholder = `$${paramOffset + sqlParams.length}`;
        rightCte = `
          SELECT * FROM (${baseFragment}) r
          WHERE r.global_id = ANY(${placeholder}::text[])
        `;
      } else {
        rightCte = baseFragment;
      }
    } else {
      // Inline geometry: parameterized GeoJSON, no DB lookup.  We
      // normalize the input to a single GeoJSON Geometry (collapse
      // Feature / FeatureCollection wrappers) and validate it
      // against the engine's size limits so a runaway payload fails
      // fast rather than blowing up the query planner.
      const geometry = extractGeometry(params.otherSource.geometry);
      if (!geometry) {
        throw new BadRequestException(
          'spatial-filter.params.otherSource.geometry must be a GeoJSON Geometry, Feature, or single-feature FeatureCollection',
        );
      }
      validateGeoJson(geometry);
      sqlParams.push(JSON.stringify(geometry));
      const ph = `$${paramOffset + sqlParams.length}`;
      // Use ST_SetSRID + ST_GeomFromGeoJSON to land in EPSG:4326,
      // matching every other source projection in the engine.  The
      // VALUES form gives the join a single right-side row whose
      // geometry is the AOI.  A `null` global_id matches the column
      // shape engine fragments produce.
      rightCte = `
        SELECT
          NULL::text AS global_id,
          ST_SetSRID(ST_GeomFromGeoJSON(${ph}), 4326) AS geom,
          '{}'::jsonb AS properties,
          NULL::timestamptz AS valid_from,
          NULL::timestamptz AS valid_to
      `;
    }

    // Predicate SQL.  ST_DWithin needs the geography cast for
    // meter-correct distance worldwide; the other predicates work
    // directly on planar geometry in 4326 (acceptable for our
    // tolerance, since the polygon-rich workflows we care about are
    // local-scale).
    let whereClause: string;
    if (params.predicate === 'near') {
      const meters = params.distanceMeters as number;
      sqlParams.push(meters);
      const mPh = `$${paramOffset + sqlParams.length}`;
      whereClause = `ST_DWithin(l.geom::geography, r.geom::geography, ${mPh})`;
    } else {
      const fn =
        params.predicate === 'within'
          ? 'ST_Within'
          : params.predicate === 'contains'
            ? 'ST_Contains'
            : params.predicate === 'touches'
              ? 'ST_Touches'
              : 'ST_Intersects';
      whereClause = `${fn}(l.geom, r.geom)`;
    }

    // EXISTS keeps the row count stable: each upstream row appears
    // once if ANY right row matches.  This is the semantic
    // difference from spatial-join, where a join would multiply
    // rows.
    const sql = `
      WITH right_rows AS (${rightCte})
      SELECT l.global_id, l.geom, l.properties
      FROM ${inputAlias} l
      WHERE EXISTS (
        SELECT 1 FROM right_rows r
        WHERE ${whereClause}
      )
    `;

    return { sql, params: sqlParams };
  },
};

/**
 * Parse the post-resolution otherSource shape.  Rejects parameter
 * refs (the recipe runner should have substituted them) and any
 * unrecognised kind.
 */
function parseResolvedSource(value: unknown): SpatialFilterParams['otherSource'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('spatial-filter.params.otherSource must be an object');
  }
  const v = value as Record<string, unknown> & SourceRef;
  if (v.kind === 'parameter') {
    throw new BadRequestException(
      'spatial-filter.params.otherSource is an unresolved parameter reference; the recipe runner must substitute parameter values before SQL compilation',
    );
  }
  if (v.kind === 'data_layer') {
    const itemId = v.itemId;
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new BadRequestException(
        'spatial-filter.params.otherSource.itemId must be a non-empty string',
      );
    }
    const layerKey =
      typeof v.layerKey === 'string' && v.layerKey.length > 0
        ? v.layerKey
        : undefined;
    let featureIds: Array<string | number> | undefined;
    if (Array.isArray(v.featureIds)) {
      featureIds = v.featureIds.filter(
        (x): x is string | number =>
          typeof x === 'string' || typeof x === 'number',
      );
      if (featureIds.length !== v.featureIds.length) {
        throw new BadRequestException(
          'spatial-filter.params.otherSource.featureIds entries must be strings or numbers',
        );
      }
    }
    return {
      kind: 'data_layer',
      itemId,
      ...(layerKey !== undefined ? { layerKey } : {}),
      ...(featureIds !== undefined ? { featureIds } : {}),
    };
  }
  if (v.kind === 'inline-geometry') {
    const geometry = (v as { geometry?: unknown }).geometry;
    if (geometry === undefined || geometry === null) {
      throw new BadRequestException(
        'spatial-filter.params.otherSource.geometry is required for kind=inline-geometry',
      );
    }
    return { kind: 'inline-geometry', geometry };
  }
  // Exhausted the union; whatever's here is an unsupported kind.
  // Read the kind off the original raw value to give the caller a
  // legible error.
  const unknownKind = (value as Record<string, unknown>).kind;
  throw new BadRequestException(
    `spatial-filter.params.otherSource.kind '${String(unknownKind)}' is not supported`,
  );
}

function resolvePredicate(value: unknown): SpatialPredicate {
  if (
    value === 'intersects' ||
    value === 'within' ||
    value === 'contains' ||
    value === 'touches' ||
    value === 'near'
  ) {
    return value;
  }
  // PredicateRef form: { kind: 'fixed', value: SpatialPredicate }.
  // 'parameter' must have been substituted; if we see it, the recipe
  // runner skipped a step.
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.kind === 'parameter') {
      throw new BadRequestException(
        'spatial-filter.params.predicate is an unresolved parameter reference',
      );
    }
    if (v.kind === 'fixed' && typeof v.value === 'string') {
      return resolvePredicate(v.value);
    }
  }
  throw new BadRequestException(
    "spatial-filter.params.predicate must be 'intersects', 'within', 'contains', 'touches', or 'near'",
  );
}

/**
 * Normalise a GeoJSON value to a single Geometry.  Accepts:
 *
 *   - a bare Geometry ({ type: 'Polygon', coordinates: ... })
 *   - a Feature        ({ type: 'Feature', geometry: { ... } })
 *   - a FeatureCollection with exactly one Feature
 *
 * Returns null if the shape can't be reduced to one geometry.
 * Multi-feature collections are intentionally rejected here: the
 * spatial-filter contract is "test against ONE geometry" so the
 * caller (recipe runner) should either pre-union or pre-pick a
 * single feature before handing the value to the generator.
 */
function extractGeometry(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return null;
  if (v.type === 'Feature') {
    const g = (v as { geometry?: unknown }).geometry;
    if (g && typeof g === 'object') return g;
    return null;
  }
  if (v.type === 'FeatureCollection') {
    const features = (v as { features?: unknown }).features;
    if (Array.isArray(features) && features.length === 1) {
      return extractGeometry(features[0]);
    }
    return null;
  }
  // Otherwise assume it's a geometry shape; ST_GeomFromGeoJSON will
  // reject if the type isn't one it recognises.
  return v;
}

function resolveDistance(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.kind === 'parameter') {
      throw new BadRequestException(
        'spatial-filter.params.distance is an unresolved parameter reference',
      );
    }
    if (v.kind === 'fixed' && typeof v.meters === 'number') {
      return v.meters;
    }
  }
  throw new BadRequestException(
    'spatial-filter.params.distance must be a number of meters or { kind: "fixed", meters: number }',
  );
}
