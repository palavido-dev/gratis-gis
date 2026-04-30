import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated centroid params. v1 has no fields; the type exists so
 * the generator's signature is unambiguous.
 */
export type CentroidParams = Record<string, never>;

/**
 * Centroid generator. Replaces each input geometry with its
 * `ST_Centroid(geom)`. Attributes pass through unchanged. Output is
 * always point geometry regardless of input.
 *
 * Useful for "where is the middle of each polygon" workflows
 * (labeling, density grids, snapping to nearest road, etc).
 */
export const centroidGenerator: ToolGenerator<CentroidParams> = {
  kind: 'centroid',

  validate(raw: unknown): CentroidParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('centroid.params must be an object');
    }
    return {} as CentroidParams;
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Centroid keeps every attribute. We return the same array so
    // dashboards / apps that bound to the input keep binding.
    return input;
  },

  outwardReachMeters(): number {
    // A centroid is always strictly INSIDE the input geometry's
    // bbox, so it can never extend outward. Return 0.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    // ST_SetSRID is no-op on already-4326 input but cheap insurance
    // against a stray spatial-ref drift between Postgres versions.
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(ST_Centroid(geom), 4326) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
