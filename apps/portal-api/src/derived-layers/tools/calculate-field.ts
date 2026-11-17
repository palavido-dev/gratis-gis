// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  compileExpression,
  fieldRefTypeFor,
  parseExpression,
  validateExpression,
  ExpressionError,
  isSqlSafeFieldName,
  SQL_SAFE_FIELD_NAME_RE,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolSqlContext, ToolValidateContext } from './types.js';
import { numericTextSql } from './numeric-text.js';

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
  // Allowlist gate (SEC-expr-field-allowlist). Parser already
  // enforces this; refuse to emit SQL if a bad name slips through.
  if (!isSqlSafeFieldName(fieldName)) {
    throw new BadRequestException(
      `calculate-field expression field "${fieldName}" must match ${SQL_SAFE_FIELD_NAME_RE}`,
    );
  }
  const ref = schema.find((f) => f.name === fieldName);
  const raw = `(properties->>'${fieldName}')`;
  switch (ref?.type) {
    case 'number':
      // Non-numeric text (empty, "n/a") reads as NULL instead of
      // failing the whole query.
      return numericTextSql(raw);
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
        // Same mapping as filter.ts: the cast carried date and
        // multi_select through as if they were one of the four types.
        type: fieldRefTypeFor(f.type),
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
    ctx?: ToolSqlContext,
  ) {
    const ast = parseExpression(params.expression);
    // Same as filter: the compiler emits no casts, so numeric fields
    // are cast here from the input schema the caller threads through.
    const schema: FeatureField[] = ctx?.inputSchema ?? [];
    const compiled = compileExpression(
      ast,
      (name) => columnForField(name, schema),
      paramOffset,
    );
    // Pass the field name as a parameter so the JSONB key never has
    // to be escaped by hand. jsonb_build_object takes VARIADIC "any",
    // so the key needs an explicit ::text: an untyped parameter there
    // fails to plan under the pg driver.
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
          $${fieldNameIdx}::text,
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
