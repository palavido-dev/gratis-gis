import { BadRequestException } from '@nestjs/common';
import {
  isLengthUnit,
  metersFor,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

export interface DensifyParams {
  maxSegmentLength: number;
  unit: LengthUnit;
}

/**
 * Hard cap on the maxSegmentLength a recipe can ask for. Mostly a
 * safety net: a tiny segment length on a continental line could
 * generate millions of intermediate vertices and exhaust memory.
 * 1 meter minimum is also enforced via validate().
 */
const MAX_SEGMENT_LENGTH_METERS = 100_000;
const MIN_SEGMENT_LENGTH_METERS = 1;

/**
 * Densify generator. Adds intermediate vertices along input lines /
 * polygon boundaries so no segment exceeds `maxSegmentLength` in
 * `unit`. Uses `ST_Segmentize(geom::geography, lengthMeters)` so the
 * spacing is accurate-on-Earth regardless of latitude.
 *
 * Useful before reprojection (preserves curves' visual shape across
 * a CRS change), for smoother along-line interpolation, and as a
 * preprocessing step for fishnet / vertices on long thin features.
 *
 * Point-only input is an effective no-op (a point has no segments);
 * the SQL still runs and yields the input unchanged.
 */
export const densifyGenerator: ToolGenerator<DensifyParams> = {
  kind: 'densify',

  validate(raw: unknown): DensifyParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('densify.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const len = r.maxSegmentLength;
    if (typeof len !== 'number' || !Number.isFinite(len)) {
      throw new BadRequestException(
        'densify.params.maxSegmentLength must be a finite number',
      );
    }
    const unit = isLengthUnit(r.unit) ? r.unit : 'meters';
    const meters = metersFor(len, unit);
    if (meters < MIN_SEGMENT_LENGTH_METERS) {
      throw new BadRequestException(
        `densify.params.maxSegmentLength must be at least ${MIN_SEGMENT_LENGTH_METERS} meter (got ${meters}m)`,
      );
    }
    if (meters > MAX_SEGMENT_LENGTH_METERS) {
      throw new BadRequestException(
        `densify.params.maxSegmentLength must not exceed ${MAX_SEGMENT_LENGTH_METERS} meters (got ${meters}m)`,
      );
    }
    return { maxSegmentLength: len, unit };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    // ST_Segmentize only ADDS vertices on existing edges; the
    // resulting geometry has the same bbox as the input.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: DensifyParams, paramOffset: number) {
    // The geography cast interprets the segment length as meters;
    // the cast back to geometry (SRID 4326) keeps downstream steps
    // in the SRID every other layer uses.
    const placeholder = `$${paramOffset + 1}`;
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(
          ST_Segmentize(geom::geography, ${placeholder})::geometry,
          4326
        ) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    const meters = metersFor(params.maxSegmentLength, params.unit);
    return { sql, params: [meters] };
  },
};
