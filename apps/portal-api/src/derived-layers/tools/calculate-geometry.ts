import { BadRequestException } from '@nestjs/common';
import {
  METERS_PER_UNIT,
  SQ_METERS_PER_AREA_UNIT,
  isAreaUnit,
  isLengthUnit,
  type AreaUnit,
  type CalculateGeometryParams,
  type FeatureField,
  type LengthUnit,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';

/**
 * Maximum length of a user-chosen field name. Generous enough for
 * descriptive names ("hectares_in_county") while preventing
 * pathological inputs that could blow up the JSONB blob.
 */
const MAX_FIELD_NAME_LENGTH = 60;

/**
 * Field names that are reserved for system metadata (the editor
 * tracking columns, the v3 underscore-prefixed identifiers). Reject
 * these at validate time so a user can't accidentally clobber the
 * properties bag's reserved keys.
 */
const RESERVED_FIELD_NAMES = new Set<string>([
  '_global_id',
  '_created_by',
  '_created_at',
  '_edited_by',
  '_edited_at',
  'global_id',
]);

/**
 * Calculate-geometry generator. Adds one numeric attribute to each
 * row carrying the input geometry's length / perimeter / area in
 * the user-chosen unit, with a user-chosen column name.
 *
 * Computation runs on geography (which returns meters / square
 * meters globally) and converts to the chosen unit at SQL time so
 * the persisted column matches what the user typed.
 *
 * Length is `ST_Length` over geography (lines and the boundary of
 * polygons in geography give meaningful answers; the SQL doesn't
 * gate on geometryType so a polygon-input length yields the
 * polygon's perimeter, which is sometimes what users want). For
 * stricter "polygon perimeter" semantics there's a `perimeter`
 * mode that explicitly applies ST_Boundary first.
 *
 * Area is `ST_Area` over geography. Square units are converted via
 * `SQ_METERS_PER_AREA_UNIT`; hectares and acres are first-class
 * units, which is the conventional ask for parcels and field
 * surveying.
 */
export const calculateGeometryGenerator: ToolGenerator<CalculateGeometryParams> =
  {
    kind: 'calculate-geometry',

    validate(raw: unknown, ctx?: ToolValidateContext): CalculateGeometryParams {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(
          'calculate-geometry.params must be an object',
        );
      }
      const r = raw as Record<string, unknown>;

      const measurement = r.measurement;
      if (
        measurement !== 'length' &&
        measurement !== 'perimeter' &&
        measurement !== 'area'
      ) {
        throw new BadRequestException(
          "calculate-geometry.params.measurement must be 'length', 'perimeter', or 'area'",
        );
      }

      const fieldName = r.fieldName;
      if (typeof fieldName !== 'string' || fieldName.length === 0) {
        throw new BadRequestException(
          'calculate-geometry.params.fieldName is required',
        );
      }
      if (fieldName.length > MAX_FIELD_NAME_LENGTH) {
        throw new BadRequestException(
          `calculate-geometry.params.fieldName must be ${MAX_FIELD_NAME_LENGTH} characters or fewer`,
        );
      }
      if (!/^[a-z_][a-z0-9_]*$/i.test(fieldName)) {
        throw new BadRequestException(
          'calculate-geometry.params.fieldName must start with a letter or underscore and contain only letters, numbers, and underscores',
        );
      }
      if (RESERVED_FIELD_NAMES.has(fieldName)) {
        throw new BadRequestException(
          `calculate-geometry.params.fieldName "${fieldName}" is reserved`,
        );
      }
      // Reject field names that already exist on the upstream schema.
      // Quietly overwriting a source column would be confusing; a
      // user who wants to overwrite can rename the existing field
      // first, or pick a different output name. Read-time validate
      // skips the schema check (we trust the persisted shape).
      if (ctx?.sourceSchema) {
        const clash = ctx.sourceSchema.find((f) => f.name === fieldName);
        if (clash) {
          throw new BadRequestException(
            `calculate-geometry.params.fieldName "${fieldName}" already exists on the source schema; pick a different name`,
          );
        }
      }

      if (measurement === 'area') {
        if (!isAreaUnit(r.unit)) {
          throw new BadRequestException(
            "calculate-geometry.params.unit must be one of square-meters / square-kilometers / hectares / square-feet / square-yards / acres / square-miles for area",
          );
        }
        return {
          measurement: 'area',
          unit: r.unit,
          fieldName,
        };
      }

      // length / perimeter share LengthUnit
      if (!isLengthUnit(r.unit)) {
        throw new BadRequestException(
          "calculate-geometry.params.unit must be one of meters / kilometers / feet / yards / miles for length",
        );
      }
      return {
        measurement,
        unit: r.unit,
        fieldName,
      };
    },

    outputSchema(
      input: FeatureField[],
      params: CalculateGeometryParams,
    ): FeatureField[] {
      // Append the new field. Label uses the field name itself as a
      // start; the user can edit the label later via the data-layer
      // editor (the recipe is just the field's source-of-truth, the
      // label's pretty form lives downstream).
      return [
        ...input,
        {
          name: params.fieldName,
          label: params.fieldName,
          type: 'number',
          nullable: true,
        },
      ];
    },

    outwardReachMeters(): number {
      // Geometry passes through unchanged.
      return 0;
    },

    extractDependencies(): { itemIds: string[]; urls: string[] } {
      return { itemIds: [], urls: [] };
    },

    toSql(
      inputAlias: string,
      params: CalculateGeometryParams,
      paramOffset: number,
    ) {
      const fieldPh = `$${paramOffset + 1}`;
      const factorPh = `$${paramOffset + 2}`;

      // SQL chooses the right PostGIS function per measurement. All
      // three branches use geography for accurate-on-Earth values:
      // ST_Length and ST_Area on geography return meters / square
      // meters; the unit factor is divided in to convert to the
      // user's chosen unit.
      let measurementSql: string;
      let factor: number;
      if (params.measurement === 'area') {
        measurementSql = `ST_Area(${inputAlias}.geom::geography)`;
        factor = SQ_METERS_PER_AREA_UNIT[params.unit as AreaUnit];
      } else if (params.measurement === 'perimeter') {
        // Apply ST_Boundary first so a polygon's "length" is its
        // perimeter rather than implicit-cast behavior. For line /
        // multi-line input this yields the line's endpoints (a
        // multipoint), and ST_Length over a multipoint geography is
        // 0 -- a sane no-op.
        measurementSql = `ST_Length(ST_Boundary(${inputAlias}.geom)::geography)`;
        factor = METERS_PER_UNIT[params.unit as LengthUnit];
      } else {
        measurementSql = `ST_Length(${inputAlias}.geom::geography)`;
        factor = METERS_PER_UNIT[params.unit as LengthUnit];
      }

      const sql = `
        SELECT
          ${inputAlias}.global_id,
          ${inputAlias}.geom,
          ${inputAlias}.properties || jsonb_build_object(
            ${fieldPh},
            (${measurementSql}) / ${factorPh}::double precision
          ) AS properties
        FROM ${inputAlias}
        WHERE ${inputAlias}.geom IS NOT NULL
      `;
      return { sql, params: [params.fieldName, factor] };
    },
  };
