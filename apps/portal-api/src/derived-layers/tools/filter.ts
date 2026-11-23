// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { compileStepExpression, readDataRefs, validateStepExpression, type StoredDataRef } from './expression-step.js';
import type { ToolGenerator, ToolSqlContext, ToolValidateContext } from './types.js';

export interface FilterParams {
  /** Sources the expression reads, resolved on save. */
  dataRefs?: StoredDataRef[];
  expression: string;
}

/**
 * Maximum length of an expression string.  Generous enough for the
 * complex predicates a power user might write while preventing
 * pathological input that would blow up the SQL planner.
 */
const MAX_EXPRESSION_LENGTH = 2000;

/**
 * Attribute filter generator (#76).  Compiles the user's expression
 * to a SQL WHERE clause via the shared expression engine, then emits
 * a CTE body that selects every input row whose predicate is true.
 *
 * Geometry passes through.  Attributes pass through.  Output schema
 * matches the input schema.
 *
 * Empty / whitespace-only expressions fail validation: a filter that
 * keeps everything is more clearly written as no step at all.
 */
export const filterGenerator: ToolGenerator<FilterParams> = {
  kind: 'filter',

  validate(raw: unknown, ctx?: ToolValidateContext): FilterParams {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('filter.params must be an object');
    }
    const r = raw as Record<string, unknown>;
    const expression = r.expression;
    if (typeof expression !== 'string') {
      throw new BadRequestException(
        'filter.params.expression must be a string',
      );
    }
    if (expression.trim().length === 0) {
      throw new BadRequestException(
        'filter.params.expression cannot be empty',
      );
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new BadRequestException(
        `filter.params.expression must be at most ${MAX_EXPRESSION_LENGTH} characters`,
      );
    }
    // Parse to catch syntax errors at save time.
    const dataRefs = validateStepExpression(
      expression,
      'filter.params.expression',
      r.dataRefs,
      ctx,
    );
    return dataRefs.length > 0 ? { expression, dataRefs } : { expression };
  },

  outputSchema(input: FeatureField[]): FeatureField[] {
    return input;
  },

  outwardReachMeters(): number {
    return 0;
  },

  extractDependencies(params: FilterParams): { itemIds: string[]; urls: string[] } {
    return {
      itemIds: [...new Set(readDataRefs(params.dataRefs).map((r) => r.itemId))],
      urls: [],
    };
  },

  toSql(
    inputAlias: string,
    params: FilterParams,
    paramOffset: number,
    ctx?: ToolSqlContext,
  ) {
    // Compile at SQL time from the saved text, so save-time and
    // read-time checks cannot drift. Fields the schema does not
    // declare read as untyped text rather than failing the read.
    const compiled = compileStepExpression(params.expression, inputAlias, paramOffset, ctx, {
      predicate: true,
    });
    const sql = `
      SELECT
        ${inputAlias}.global_id,
        ${inputAlias}.geom,
        ${inputAlias}.properties
      FROM ${inputAlias}
      WHERE ${compiled.sql}
    `;
    return { sql, params: compiled.params };
  },
};
