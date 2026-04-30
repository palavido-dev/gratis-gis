import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';

export interface TopNParams {
  field: string;
  n: number;
  direction: 'asc' | 'desc';
}

/**
 * Hard cap on N. Mostly a safety net to prevent a misclick from
 * forcing the read path to return millions of rows; the recipe's
 * own `featureLimit` is the user-tunable ceiling but this stays
 * higher than the default to make the cap on top-N not bite first.
 */
const MAX_N = 100_000;

/**
 * Top-N filter generator. Keeps the N rows with the highest (or
 * lowest) value of a numeric attribute. Geometry and attributes
 * pass through unchanged. The named field must exist on the
 * upstream schema and have type 'number' at recipe-save time;
 * read-time validate trusts the persisted shape.
 *
 * Useful for "ten largest parcels" / "five closest hospitals" once
 * a distance attribute is available (composes well with
 * nearest-neighbor and calculate-geometry).
 *
 * NULL values are sorted to the end via NULLS LAST/FIRST so the
 * top-N for a column with sparse data doesn't get clogged with
 * NULLs. asc -> NULLS LAST, desc -> NULLS LAST (i.e. NULLs always
 * dropped to the bottom regardless of direction; a top-10 by
 * "highest population" should not return rows with NULL population).
 */
export const topNGenerator: ToolGenerator<TopNParams> = {
  kind: 'top-n',

  validate(raw: unknown, ctx?: ToolValidateContext): TopNParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('top-n.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const field = r.field;
    if (typeof field !== 'string' || field.length === 0) {
      throw new BadRequestException('top-n.params.field is required');
    }
    if (ctx?.sourceSchema) {
      const match = ctx.sourceSchema.find((f) => f.name === field);
      if (!match) {
        throw new BadRequestException(
          `top-n.params.field "${field}" does not exist on the source schema`,
        );
      }
      if (match.type !== 'number') {
        throw new BadRequestException(
          `top-n.params.field "${field}" must be a number field (got ${match.type})`,
        );
      }
    }
    const n = r.n;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      throw new BadRequestException(
        'top-n.params.n must be a positive integer',
      );
    }
    if (n < 1) {
      throw new BadRequestException(
        'top-n.params.n must be at least 1',
      );
    }
    if (n > MAX_N) {
      throw new BadRequestException(
        `top-n.params.n must not exceed ${MAX_N}`,
      );
    }
    const direction = r.direction === 'asc' ? 'asc' : 'desc';
    return { field, n, direction };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: TopNParams, paramOffset: number) {
    // NULLIF + the regex guard mirror the buffer field-mode pattern:
    // a row with a non-numeric or empty value at `field` casts to
    // NULL via NULLIF, gets sorted to the end via NULLS LAST, and
    // is therefore dropped from the top-N as long as N is smaller
    // than the field's NULL count. (When the user really does want
    // NULL rows, they shouldn't be top-N filtering on a sparse
    // attribute.)
    const fieldPh = `$${paramOffset + 1}`;
    const limitPh = `$${paramOffset + 2}`;
    const dir = params.direction === 'asc' ? 'ASC' : 'DESC';
    const sql = `
      SELECT global_id, geom, properties
      FROM ${inputAlias}
      WHERE properties ? ${fieldPh}
        AND (properties->>${fieldPh}) ~ '^-?[0-9]+(\\.[0-9]+)?$'
      ORDER BY (NULLIF(properties->>${fieldPh}, ''))::double precision ${dir} NULLS LAST
      LIMIT ${limitPh}
    `;
    return { sql, params: [params.field, params.n] };
  },
};
