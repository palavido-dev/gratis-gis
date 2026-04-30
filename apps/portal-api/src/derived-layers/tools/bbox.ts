import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated bbox params. v1 has no fields.
 */
export type BboxParams = Record<string, never>;

/**
 * Bounding-box generator. Replaces each input geometry with its
 * axis-aligned envelope via `ST_Envelope(geom)`. Output is polygon
 * (PostGIS produces a closed rectangle). Attributes pass through.
 *
 * Useful for "show me the extent of each parcel" workflows and as
 * a cheap stand-in when full feature geometry is heavy and only
 * the rectangle matters (e.g. clustering by extent overlap).
 */
export const bboxGenerator: ToolGenerator<BboxParams> = {
  kind: 'bbox',

  validate(raw: unknown): BboxParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('bbox.params must be an object');
    }
    return {} as BboxParams;
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    // The envelope contains the input geometry; it can never extend
    // outward beyond the input's own bbox.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(ST_Envelope(geom), 4326) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
