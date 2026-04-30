import { BadRequestException } from '@nestjs/common';
import {
  MAX_BUFFER_DISTANCE_METERS,
  METERS_PER_UNIT,
  isLengthUnit,
  metersFor,
  type BufferParams,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type {
  ToolEnrichContext,
  ToolGenerator,
  ToolValidateContext,
} from './types.js';

/**
 * Buffer generator. Wraps `ST_Buffer(geom::geography, distance)` so the
 * distance is interpreted in meters globally regardless of longitude.
 * Output is cast back to `geometry` (SRID 4326) so it round-trips
 * through the same pipeline machinery as every other step.
 *
 * Two distance modes:
 *   - `fixed` applies the same distance to every input row. Distance
 *     comes from `params.distance` interpreted in `params.unit`,
 *     converted to meters at SQL emission time.
 *   - `field` reads the per-feature distance from a numeric column on
 *     the source schema. The wizard never asks the user for an upper
 *     bound; the server queries `MAX(<field>)` once at recipe-save
 *     time (`enrich`) and caches the result in meters as
 *     `cachedMaxMeters`. That cap drives bbox padding on the read path
 *     and clamps the per-row buffer in SQL via `LEAST(...)` so a stray
 *     oversized value cannot generate a planet-spanning geometry.
 *
 * The `geography` cast is the v1 simplification: it's accurate within
 * a few meters at typical urban / regional scales and avoids the
 * "what CRS is the input in?" question that blocks raw projected
 * buffers. Future tools that need precise geodesic results can pick a
 * different strategy (project to UTM, buffer, project back) under a
 * separate `tool` kind.
 *
 * Backwards compatibility: existing rows persisted with the v1 shape
 * `{ distance, unit: 'meters' }` (no `mode`) are accepted by `validate`
 * and normalized to `{ mode: 'fixed', ... }`. No data migration
 * required; the next save through the new builder writes the fully
 * tagged shape forward.
 */
export const bufferGenerator: ToolGenerator<BufferParams> = {
  kind: 'buffer',

  validate(raw: unknown, ctx?: ToolValidateContext): BufferParams {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException('buffer.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    // Resolve unit first; both modes use it. Default to 'meters' when
    // absent so the v1 persisted shape (which never had a `unit` field
    // worth widening) parses cleanly.
    const unit = resolveUnit(r.unit);

    // Mode resolution: an explicit `mode` wins; otherwise we infer
    // 'fixed' from the presence of `distance`, matching the v1 shape.
    const rawMode = r.mode;
    const mode =
      rawMode === 'field'
        ? 'field'
        : rawMode === 'fixed' || rawMode === undefined
          ? 'fixed'
          : (() => {
              throw new BadRequestException(
                `buffer.params.mode must be 'fixed' or 'field' (got ${JSON.stringify(rawMode)})`,
              );
            })();

    if (mode === 'fixed') {
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
      const distanceMeters = metersFor(distance, unit);
      if (distanceMeters > MAX_BUFFER_DISTANCE_METERS) {
        throw new BadRequestException(
          `buffer.params.distance must not exceed ${MAX_BUFFER_DISTANCE_METERS} meters (got ${distanceMeters}m)`,
        );
      }
      return { mode: 'fixed', distance, unit };
    }

    // mode === 'field'
    const field = r.field;
    if (typeof field !== 'string' || field.length === 0) {
      throw new BadRequestException(
        "buffer.params.field is required when mode is 'field'",
      );
    }
    // When the caller passed in a schema, check that `field` exists
    // and is numeric. Without a schema (read-time validate) we trust
    // the persisted shape and let the SQL surface a clear failure if
    // the field has been removed from the source since save.
    if (ctx?.sourceSchema) {
      const match = ctx.sourceSchema.find((f) => f.name === field);
      if (!match) {
        throw new BadRequestException(
          `buffer.params.field "${field}" does not exist on the source schema`,
        );
      }
      if (match.type !== 'number') {
        throw new BadRequestException(
          `buffer.params.field "${field}" must be a number field (got ${match.type})`,
        );
      }
    }
    // cachedMaxMeters is filled in by `enrich`. Accept whatever's on
    // the wire (the wizard sends 0; the server replaces it). Cap to
    // the global ceiling so a malicious client can't bypass safety
    // by sending a huge cached value directly.
    const rawCap = (r as { cachedMaxMeters?: unknown }).cachedMaxMeters;
    let cachedMaxMeters = 0;
    if (typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0) {
      cachedMaxMeters = Math.min(rawCap, MAX_BUFFER_DISTANCE_METERS);
    }
    return { mode: 'field', field, unit, cachedMaxMeters };
  },

  async enrich(
    params: BufferParams,
    ctx: ToolEnrichContext,
  ): Promise<BufferParams> {
    if (params.mode !== 'field') return params;
    // Compute the global MAX of the named field across the source's
    // feature table, cast to double precision so the `(properties->>...)`
    // text gets interpreted as a number. Rows with NULL or
    // non-numeric values are skipped via NULLIF + a regex guard, so
    // a row whose value is "" or "abc" doesn't blow up the query.
    // The result is converted to meters via the recipe's chosen unit
    // and clamped to the global ceiling so the cached cap is always
    // a meter value within bounds the read path can pad with safely.
    const sql = `
      SELECT COALESCE(
        MAX(
          (NULLIF(properties->>$1, ''))::double precision
        ),
        0
      ) AS max_value
      FROM ${ctx.sourceTable}
      WHERE properties ? $1
        AND (properties->>$1) ~ '^-?[0-9]+(\\.[0-9]+)?$'
    `;
    type Row = { max_value: number | string | null };
    const rows = await ctx.queryRaw<Row>(sql, params.field);
    const raw = rows[0]?.max_value;
    const numeric =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseFloat(raw)
          : 0;
    const safeNumeric = Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
    const cachedMaxMeters = Math.min(
      metersFor(safeNumeric, params.unit),
      MAX_BUFFER_DISTANCE_METERS,
    );
    return { ...params, cachedMaxMeters };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    // Buffer keeps every attribute and changes only the geometry.
    // Returning the same array keeps the cached `outputSchema` shape
    // identical to the source's so dashboards / apps that bound to
    // the source keep binding cleanly.
    return input;
  },

  outwardReachMeters(params: BufferParams): number {
    if (params.mode === 'fixed') {
      return metersFor(params.distance, params.unit);
    }
    // Field mode: trust the cached cap. Zero (no rows or no positive
    // values) yields no expansion, which is correct: a layer whose
    // distances are all zero produces no buffered halo and needs no
    // bbox padding.
    return params.cachedMaxMeters;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    // v1 buffer holds no item references regardless of mode. The
    // slot exists so future tools (intersect against a second layer,
    // choices from a pick list, ...) plug into the dependency graph
    // automatically.
    return { itemIds: [], urls: [] };
  },

  toSql(inputAlias: string, params: BufferParams, paramOffset: number) {
    // The geography cast interprets distance as meters; the cast
    // back to geometry (SRID 4326) keeps the next step / output in
    // the SRID every other layer in the system uses. ST_SetSRID is
    // a no-op when the geography already carries 4326 but cheap
    // insurance against PostGIS spatial-ref drift between Postgres
    // versions.
    if (params.mode === 'fixed') {
      const distancePh = `$${paramOffset + 1}`;
      const sql = `
        SELECT
          global_id,
          ST_SetSRID(
            ST_Buffer(geom::geography, ${distancePh})::geometry,
            4326
          ) AS geom,
          properties
        FROM ${inputAlias}
        WHERE geom IS NOT NULL
      `;
      return { sql, params: [metersFor(params.distance, params.unit)] };
    }
    // Field mode. The per-row distance comes from
    // (properties->>'<field>')::double precision; we convert to meters
    // by multiplying by the unit factor, then clamp with LEAST() to
    // the cached cap so a stray data outlier can't generate a
    // gigantic buffer. NULLIF handles empty strings; the regex guard
    // in the WHERE strips non-numeric junk before the cast so a row
    // with `properties->>'field' = 'unknown'` doesn't error the
    // query.
    const fieldPh = `$${paramOffset + 1}`;
    const factorPh = `$${paramOffset + 2}`;
    const capPh = `$${paramOffset + 3}`;
    const sql = `
      SELECT
        global_id,
        ST_SetSRID(
          ST_Buffer(
            geom::geography,
            LEAST(
              GREATEST(
                (NULLIF(properties->>${fieldPh}, ''))::double precision * ${factorPh},
                0
              ),
              ${capPh}
            )
          )::geometry,
          4326
        ) AS geom,
        properties
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
        AND properties ? ${fieldPh}
        AND (properties->>${fieldPh}) ~ '^-?[0-9]+(\\.[0-9]+)?$'
    `;
    const factor = METERS_PER_UNIT[params.unit];
    return {
      sql,
      params: [params.field, factor, params.cachedMaxMeters],
    };
  },
};

/**
 * Resolve a unit value off the wire. v1 persisted recipes used
 * `unit: 'meters'` so an absent unit defaults to that, keeping
 * existing rows valid without a data migration. Anything else has
 * to be one of the known LengthUnit literals or we 400 with a clear
 * message.
 */
function resolveUnit(raw: unknown): LengthUnit {
  if (raw === undefined) return 'meters';
  if (isLengthUnit(raw)) return raw;
  throw new BadRequestException(
    `buffer.params.unit must be one of meters / kilometers / feet / yards / miles (got ${JSON.stringify(raw)})`,
  );
}
