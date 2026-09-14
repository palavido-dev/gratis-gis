// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  compileExpression,
  parseExpression,
  validateExpression,
  ExpressionError,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';

export interface CalculateFieldParams {
  outputName: string;
  outputType: 'number' | 'string' | 'boolean';
  expression: string;
}

const MAX_FIELD_NAME_LENGTH = 60;
const MAX_EXPRESSION_LENGTH = 2000;

const RESERVED_FIELD_NAMES = new Set<string>([
  '_global_id',
  '_created_by',
  '_created_at',
  '_edited_by',
  '_edited_at',
  '_observation_id',
  'global_id',
]);

function columnForField(
  fieldName: string,
  schema: FeatureField[],
): string {
  const ref = schema.find((f) => f.name === fieldName);
  const safe = fieldName.replace(/'/g, "''");
  const raw = `(properties->>'${safe}')`;
  switch (ref?.type) {
    case 'number':
      return `NULLIF(${raw}, '')::double precision`;
    case 'boolean':
      return `(${raw}::boolean)`;
    default:
      return raw;
  }
}

/**
 * Calculate-field generator (#77).  Appends one user-named attribute
 * to every row whose value is the expression compiled against the
 * upstream schema.  The expression's natural SQL type is cast to the
 * declared `outputType` and stamped into the properties JSONB blob
 * as a stringified value (matching how the rest of the v3 attribute
 * pipeline stores values).
 *
 * Geometry passes through unchanged.
 *
 * Generalizes calculate-geometry: where calculate-geometry only knows
 * length/perimeter/area, calculate-field handles arbitrary
 * expressions over upstream attributes (e.g. `{{acres}} * 0.4047` →
 * hectares, `concat({{first_name}}, ' ', {{last_name}})` →
 * full_name).
 */
export const calculateFieldGenerator: ToolGenerator<CalculateFieldParams> = {
  kind: 'calculate-field',

  validate(raw: unknown, ctx?: ToolValidateContext): CalculateFieldParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException(
        'calculate-field.params must be an object',
      );
    }
    const r = raw as Record<string, unknown>;
    const outputName = r.outputName;
    if (typeof outputName !== 'string' || outputName.length === 0) {
      throw new BadRequestException(
        'calculate-field.params.outputName is required',
      );
    }
    if (outputName.length > MAX_FIELD_NAME_LENGTH) {
      throw new BadRequestException(
        `calculate-field.params.outputName must be ${MAX_FIELD_NAME_LENGTH} characters or fewer`,
      );
    }
    if (!/^[a-z_][a-z0-9_]*$/i.test(outputName)) {
      throw new BadRequestException(
        'calculate-field.params.outputName must start with a letter or underscore and contain only letters, numbers, and underscores',
      );
    }
    if (RESERVED_FIELD_NAMES.has(outputName)) {
      throw new BadRequestException(
        `calculate-field.params.outputName "${outputName}" is reserved`,
      );
    }
    if (ctx?.sourceSchema) {
      const clash = ctx.sourceSchema.find((f) => f.name === outputName);
      if (clash) {
        throw new BadRequestException(
          `calculate-field.params.outputName "${outputName}" already exists on the upstream schema`,
        );
      }
    }
    const outputType = r.outputType;
    if (
      outputType !== 'number' &&
      outputType !== 'string' &&
      outputType !== 'boolean'
    ) {
      throw new BadRequestException(
        "calculate-field.params.outputType must be 'number', 'string', or 'boolean'",
      );
    }
    const expression = r.expression;
    if (typeof expression !== 'string') {
      throw new BadRequestException(
        'calculate-field.params.expression must be a string',
      );
    }
    if (expression.trim().length === 0) {
      throw new BadRequestException(
        'calculate-field.params.expression cannot be empty',
      );
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new BadRequestException(
        `calculate-field.params.expression must be at most ${MAX_EXPRESSION_LENGTH} characters`,
      );
    }
    let ast;
    try {
      ast = parseExpression(expression);
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new BadRequestException(
          `calculate-field.params.expression: ${err.message} (at position ${err.pos})`,
        );
      }
      throw err;
    }
    if (ctx?.sourceSchema) {
      const schema = ctx.sourceSchema.map((f) => ({
        name: f.name,
        type: f.type as 'number' | 'string' | 'boolean' | 'unknown',
      }));
      const errors = validateExpression(ast, schema);
      if (errors.length > 0) {
        throw new BadRequestException(
          `calculate-field.params.expression: ${errors.join('; ')}`,
        );
      }
    }
    return { outputName, outputType, expression };
  },

  outputSchema(
    input: FeatureField[],
    params: CalculateFieldParams,
  ): FeatureField[] {
    return [
      ...input,
      {
        name: params.outputName,
        label: params.outputName,
        type: params.outputType,
        nullable: true,
      },
    ];
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(): { itemIds: string[]; urls: string[] } {
    return { itemIds: [], urls: [] };
  },

  toSql(
    inputAlias: string,
    params: CalculateFieldParams,
    paramOffset: number,
  ) {
    const ast = parseExpression(params.expression);
    // Same fallback as filter: no schema at read time, so cast logic
    // keys off the operator rather than the column type.  Result is
    // still correct for arithmetic + comparisons because the
    // compiler emits explicit casts where needed.
    const compiled = compileExpression(
      ast,
      (name) => columnForField(name, [] as FeatureField[]),
      paramOffset,
    );
    // Stash the field name as the first parameter so the JSONB key
    // doesn't have to be escaped manually.  PostgreSQL's
    // jsonb_build_object handles the key + value coercion.
    const fieldNameIdx = paramOffset + compiled.params.length + 1;
    const valueCast =
      params.outputType === 'number'
        ? '::double precision'
        : params.outputType === 'boolean'
          ? '::boolean'
          : '::text';
    const sql = `
      SELECT
        ${inputAlias}.global_id,
        ${inputAlias}.geom,
        ${inputAlias}.properties || jsonb_build_object(
          $${fieldNameIdx},
          (${compiled.sql})${valueCast}
        ) AS properties
      FROM ${inputAlias}
    `;
    return {
      sql,
      params: [...compiled.params, params.outputName],
    };
  },
};
