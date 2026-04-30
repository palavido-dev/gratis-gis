import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

export type NearestNeighborParams = Record<string, never>;

/**
 * Nearest-neighbor distance generator. Adds a `nearest_distance_m`
 * numeric attribute to each input feature: the geographic distance
 * (meters) to the closest OTHER feature in the same input.
 *
 * Implemented as a self-join with `ST_Distance(a.geom::geography,
 * b.geom::geography)`, narrowed to `b.global_id <> a.global_id` so
 * a feature's distance to itself doesn't dominate. The first / only
 * feature in a single-row input yields NULL, which downstream tools
 * handle the same way they handle any other NULL-valued attribute.
 *
 * Composes well with top-N (find the rows with the smallest
 * nearest_distance_m to identify clusters) and calculate-geometry
 * (combine length / area with proximity in one recipe).
 *
 * Performance note: this is O(N^2) per read. For sources of more
 * than a few thousand features the read time grows linearly with
 * the squared row count. PostGIS's KNN operator (`<->`) could
 * narrow this to O(N log N) once we're willing to require a GIST
 * index on the upstream step, which the pipeline doesn't currently
 * provision. For v1 we accept the cost; the recipe's `featureLimit`
 * still caps the output row count, but the join itself runs over
 * the full input.
 */
export const nearestNeighborGenerator: ToolGenerator<NearestNeighborParams> = {
  kind: 'nearest-neighbor',

  validate(raw: unknown): NearestNeighborParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('nearest-neighbor.params must be an object');
    }
    return {} as NearestNeighborParams;
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return [
      ...input,
      {
        name: 'nearest_distance_m',
        label: 'Distance to nearest (m)',
        type: 'number',
        nullable: true,
      },
    ];
  },

  outwardReachMeters(): number {
    // The output geometry is unchanged from the input; bbox doesn't
    // grow.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    // The MIN(...) aggregate over the cross-join gives each row the
    // distance to its closest neighbor. ST_Distance on geography
    // returns meters globally regardless of latitude, so the
    // attribute name (nearest_distance_m) is honest.
    //
    // properties || jsonb_build_object('nearest_distance_m', ...)
    // merges the new field into the existing JSONB blob; the new
    // key wins on conflict, so a source field accidentally named
    // 'nearest_distance_m' gets overwritten (intended: the tool's
    // contract is "this attribute now means distance to nearest").
    const sql = `
      SELECT
        a.global_id,
        a.geom,
        a.properties || jsonb_build_object(
          'nearest_distance_m',
          (
            SELECT MIN(ST_Distance(a.geom::geography, b.geom::geography))
            FROM ${inputAlias} b
            WHERE b.global_id <> a.global_id
              AND b.geom IS NOT NULL
          )
        ) AS properties
      FROM ${inputAlias} a
      WHERE a.geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
