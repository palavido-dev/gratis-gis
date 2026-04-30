import { BadRequestException } from '@nestjs/common';
import {
  isLengthUnit,
  metersFor,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated simplify params. Tolerance interpreted in `unit`; the
 * SQL converts to degrees of latitude before passing to ST_Simplify
 * so the visible effect matches what the user typed.
 */
export interface SimplifyParams {
  tolerance: number;
  unit: LengthUnit;
}

/**
 * Maximum simplify tolerance the wizard will accept. 100 km is wider
 * than any real "smooth this polygon" tolerance and matches the
 * buffer ceiling so a misclick can't spawn a pathological geometry.
 */
const MAX_SIMPLIFY_METERS = 100_000;

/**
 * One degree of latitude is roughly 111_320 meters. The constant is
 * the conversion factor used to translate the user-supplied tolerance
 * (in meters) to the unit ST_Simplify expects (degrees, since the
 * geometry is stored in EPSG:4326). At higher latitudes a degree of
 * longitude is shorter, but Douglas-Peucker tolerance is symmetric;
 * using the latitude factor keeps the simplification slightly more
 * aggressive at high latitudes, which is acceptable for a recipe
 * tool. Future precision work could project to UTM, simplify, and
 * project back -- not warranted in v1.
 */
const METERS_PER_DEGREE = 111_320;

/**
 * Simplify generator. Wraps `ST_Simplify(geom, toleranceDegrees)`
 * with the user-supplied tolerance converted from meters first. Drops
 * vertices that lie within the tolerance of a straight line between
 * their neighbors. The geometry's topological validity is not
 * guaranteed by ST_Simplify; ST_SimplifyPreserveTopology is the
 * stricter alternative but is much slower. v1 uses the fast path.
 */
export const simplifyGenerator: ToolGenerator<SimplifyParams> = {
  kind: 'simplify',

  validate(raw: unknown): SimplifyParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('simplify.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const tolerance = r.tolerance;
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance)) {
      throw new BadRequestException(
        'simplify.params.tolerance must be a finite number',
      );
    }
    if (tolerance <= 0) {
      throw new BadRequestException(
        'simplify.params.tolerance must be greater than 0',
      );
    }
    const unit = isLengthUnit(r.unit) ? r.unit : 'meters';
    const toleranceMeters = metersFor(tolerance, unit);
    if (toleranceMeters > MAX_SIMPLIFY_METERS) {
      throw new BadRequestException(
        `simplify.params.tolerance must not exceed ${MAX_SIMPLIFY_METERS} meters (got ${toleranceMeters}m)`,
      );
    }
    return { tolerance, unit };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    // Simplify can only DROP vertices; the resulting geometry is
    // strictly inside the input's convex hull, so no outward reach.
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: SimplifyParams, paramOffset: number) {
    // ST_Simplify takes tolerance in the geometry's units; we store
    // in 4326 (degrees), so convert meters -> degrees here. The
    // factor is the same on both axes (see METERS_PER_DEGREE
    // comment).
    const placeholder = `$${paramOffset + 1}`;
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(ST_Simplify(geom, ${placeholder}), 4326) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    const toleranceMeters = metersFor(params.tolerance, params.unit);
    const toleranceDegrees = toleranceMeters / METERS_PER_DEGREE;
    return { sql, params: [toleranceDegrees] };
  },
};
