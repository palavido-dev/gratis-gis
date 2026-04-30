import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated convex-hull params. v1 has no fields; an aggregate
 * "hull of all input features" mode is a future addition under a
 * `mode: 'aggregate'` switch alongside the current per-feature
 * default.
 */
export type ConvexHullParams = Record<string, never>;

/**
 * Convex-hull generator. Replaces each input geometry with its
 * convex hull via `ST_ConvexHull`. v1 computes per-feature so the
 * row count and attributes are unchanged: a row that started as a
 * concave polygon becomes its smallest enclosing convex polygon.
 *
 * For point input the hull is the input point (PostGIS returns
 * a point); for two-point input it's a line; for three-or-more it's
 * a polygon. Downstream renderers cope because each row carries
 * whatever PostGIS produced.
 */
export const convexHullGenerator: ToolGenerator<ConvexHullParams> = {
  kind: 'convex-hull',

  validate(raw: unknown): ConvexHullParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('convex-hull.params must be an object');
    }
    return {} as ConvexHullParams;
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    // The hull is always contained within the input's bbox, so no
    // outward expansion.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(ST_ConvexHull(geom), 4326) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
