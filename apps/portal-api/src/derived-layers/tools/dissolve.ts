import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated dissolve params. v1 has no fields; the type exists so
 * the generator's type parameter is unambiguous and so a future
 * addition (e.g. a `groupBy` attribute) lands as a type widening
 * rather than a generator rewrite.
 */
export type DissolveParams = Record<string, never>;

/**
 * Dissolve generator. Merges every input geometry into a single
 * feature via PostGIS `ST_Union(geom)`. v1 always produces exactly
 * one row regardless of input cardinality, with empty properties.
 * A future `groupBy` parameter would partition the input by an
 * attribute and emit one row per partition; the schema stays a
 * deliberate placeholder for that growth.
 *
 * Why empty properties? Aggregating N attribute values into 1 row
 * has no canonical answer (which `name` wins when 50 census tracts
 * dissolve into one polygon?). Rather than pick a wrong default,
 * v1 drops all attributes and lets future tools provide explicit
 * aggregation operators (MIN, MAX, COUNT, etc.) when group-by lands.
 *
 * Schema implications: outputSchema returns `[]`, so a downstream
 * step that names a field on the source schema (e.g. a field-mode
 * buffer) will fail validation with "field does not exist on the
 * source schema" when placed AFTER a dissolve. That message is the
 * intended UX: dissolve is destructive and the user is expected to
 * either reorder or pick a different field source.
 *
 * Outward reach: 0. Dissolve doesn't expand geometry, so the bbox
 * pad budget is unaffected by placing one in the pipeline.
 */
export const dissolveGenerator: ToolGenerator<DissolveParams> = {
  kind: 'dissolve',

  validate(raw: unknown): DissolveParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('dissolve.params must be an object');
    }
    // v1 accepts an empty object; a future param shape (e.g.
    // { groupBy: '<field>' }) lands as an additive change here. We
    // tolerate keys we don't recognize so a forward-compat schema
    // version doesn't blow up on this server.
    return {} as DissolveParams;
  },

  outputSchema(): FeatureField[] {
    // v1 dissolve drops all attributes. See the class comment for
    // why. Returning a fresh empty array (rather than the input
    // reference) makes the intent explicit: this is a deliberate
    // schema break, not an oversight.
    return [];
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string) {
    // Single-row aggregate. We invent a stable global_id so the
    // outer SELECT (which always projects global_id) has something
    // to return for the single dissolved row. ST_SetSRID guards
    // against any spatial-ref drift in the input; the ::text cast
    // on the output of gen_random_uuid keeps it as a string in the
    // properties column.
    //
    // No parameters: dissolve takes no user-controllable inputs in
    // v1, so paramOffset is irrelevant. Returning an empty params
    // array keeps the service's chained-CTE param numbering correct
    // for any downstream step.
    const sql = `
      SELECT
        gen_random_uuid()::text AS global_id,
        ST_SetSRID(ST_Union(geom), 4326) AS geom,
        '{}'::jsonb AS properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    return { sql, params: [] };
  },
};
