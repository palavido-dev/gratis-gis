import { BadRequestException } from '@nestjs/common';
import {
  MAX_BUFFER_DISTANCE_METERS,
  type FeatureField,
} from '@gratis-gis/shared-types';

import type { ToolGenerator } from './types.js';

/**
 * Validated buffer params after `validate(...)` returns. Mirrors
 * `BufferStep['params']` from shared-types but lives here too so the
 * generator's signature doesn't bleed shared-types' wider unions
 * (additional tools, sublayer hints) into the buffer code path.
 */
export interface BufferParams {
  distance: number;
  unit: 'meters';
}

/**
 * Buffer generator. Wraps `ST_Buffer(geom::geography, distance)` so
 * the distance is interpreted in meters globally regardless of
 * longitude. Output is cast back to `geometry` (SRID 4326) so it
 * round-trips through the same pipeline machinery as every other
 * step.
 *
 * The `geography` cast is the v1 simplification: it's accurate within
 * a few meters at typical urban / regional scales and avoids the
 * "what CRS is the input in?" question that blocks raw projected
 * buffers. Future tools that need precise geodesic results can pick
 * a different strategy (project to UTM, buffer, project back) under
 * a separate `tool` kind.
 */
export const bufferGenerator: ToolGenerator<BufferParams> = {
  kind: 'buffer',

  validate(raw: unknown): BufferParams {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException('buffer.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const distance = r.distance;
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
      throw new BadRequestException(
        'buffer.params.distance must be a finite number',
      );
    }
    if (distance <= 0) {
      throw new BadRequestException(
        'buffer.params.distance must be greater than 0',
      );
    }
    if (distance > MAX_BUFFER_DISTANCE_METERS) {
      throw new BadRequestException(
        `buffer.params.distance must not exceed ${MAX_BUFFER_DISTANCE_METERS} meters`,
      );
    }
    if (r.unit !== 'meters') {
      // v1 ships meters only; reject anything else loudly so callers
      // notice rather than silently treating their value as meters.
      throw new BadRequestException(
        'buffer.params.unit must be "meters" in v1',
      );
    }
    return { distance, unit: 'meters' };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Buffer keeps every attribute and changes only the geometry.
    // Returning the same array keeps the cached `outputSchema` shape
    // identical to the source's so dashboards / apps that bound to
    // the source keep binding cleanly.
    return input;
  },

  outwardReachMeters(params: BufferParams): number {
    return params.distance;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    // v1 buffer holds no item references. The slot exists so future
    // tools (intersect against a second layer, choices from a pick
    // list, ...) plug into the dependency graph automatically.
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: BufferParams, paramOffset: number) {
    // The geography cast interprets distance as meters; the cast
    // back to geometry (SRID 4326) keeps the next step / output in
    // the SRID every other layer in the system uses. ST_SetSRID is
    // a no-op when the geography already carries 4326 but cheap
    // insurance against PostGIS spatial-ref drift between Postgres
    // versions.
    const placeholder = `$${paramOffset + 1}`;
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(
          ST_Buffer(geom::geography, ${placeholder})::geometry,
          4326
        ) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
    `;
    return { sql, params: [params.distance] };
  },
};
