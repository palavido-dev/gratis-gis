import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

export interface RandomSampleParams {
  mode: 'percentage' | 'count';
  /** Percentage in 0..100 when mode='percentage'; row count when 'count'. */
  value: number;
  /** Persisted seed for stable output across reads of the same recipe. */
  seed: number;
}

const MAX_COUNT = 100_000;

/**
 * Random-sample filter generator. Returns a deterministic random
 * subset of the input.
 *
 * Two modes:
 * - `percentage`: keep roughly `value` percent of rows. Implemented
 *   in SQL via `WHERE md5(global_id::text || seed) < threshold`,
 *   which converts each row's id+seed to a hex digit, takes the
 *   first N hex chars as a number, and compares against a fraction
 *   of the namespace. Stable for a given (recipe, source) pair
 *   because both global_id and seed are stable.
 * - `count`: keep exactly `value` rows. Implemented as `ORDER BY
 *   md5(global_id::text || seed) LIMIT value`, which selects the N
 *   rows whose hashes sort earliest. Also stable.
 *
 * The hash-based approach beats `random()` because Postgres's
 * random() is per-query (not per-row-deterministic), so two reads
 * of the same recipe would return different samples. The persisted
 * seed makes the sample shift only when the user explicitly rolls
 * a new one (via the wizard's "shuffle" button, eventually).
 */
export const randomSampleGenerator: ToolGenerator<RandomSampleParams> = {
  kind: 'random-sample',

  validate(raw: unknown): RandomSampleParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('random-sample.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const mode = r.mode === 'count' ? 'count' : 'percentage';
    const value = r.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(
        'random-sample.params.value must be a positive number',
      );
    }
    if (mode === 'percentage' && value > 100) {
      throw new BadRequestException(
        'random-sample.params.value must be at most 100 in percentage mode',
      );
    }
    if (mode === 'count') {
      if (!Number.isInteger(value)) {
        throw new BadRequestException(
          'random-sample.params.value must be an integer in count mode',
        );
      }
      if (value > MAX_COUNT) {
        throw new BadRequestException(
          `random-sample.params.value must not exceed ${MAX_COUNT} in count mode`,
        );
      }
    }
    const rawSeed = r.seed;
    let seed = 0;
    if (typeof rawSeed === 'number' && Number.isFinite(rawSeed)) {
      seed = Math.floor(Math.abs(rawSeed)) % 2147483647;
    }
    if (seed === 0) {
      // 0 is a degenerate seed (all hashes start with the same
      // bytes-of-zero), so substitute a stable nonzero default.
      seed = 1;
    }
    return { mode, value, seed };
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

  toSql(inputAlias: string, params: RandomSampleParams, paramOffset: number) {
    const seedPh = `$${paramOffset + 1}`;
    if (params.mode === 'percentage') {
      // Convert percentage 0..100 to a numeric threshold the hash
      // can be compared against. We use md5 -> first 8 hex chars
      // -> 32-bit unsigned integer / 2^32, which is uniformly
      // distributed in [0, 1). Compare against value/100.
      const valPh = `$${paramOffset + 2}`;
      const sql = `
        SELECT global_id, geom, properties
        FROM ${inputAlias}
        WHERE (
          ('x' || substr(md5(global_id::text || ${seedPh}::text), 1, 8))::bit(32)::bigint::double precision
          / 4294967295.0
        ) < (${valPh}::double precision / 100.0)
      `;
      return { sql, params: [params.seed, params.value] };
    }
    // count mode: ORDER BY hash, LIMIT value.
    const limitPh = `$${paramOffset + 2}`;
    const sql = `
      SELECT global_id, geom, properties
      FROM ${inputAlias}
      ORDER BY md5(global_id::text || ${seedPh}::text)
      LIMIT ${limitPh}
    `;
    return { sql, params: [params.seed, params.value] };
  },
};
