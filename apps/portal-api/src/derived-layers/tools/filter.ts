// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  compileExpression,
  parseExpression,
  validateExpression,
  ExpressionError,
  collectFieldRefs,
  fieldRefTypeFor,
} from '@gratis-gis/shared-types';

import type { ToolGenerator, ToolValidateContext } from './types.js';

export interface FilterParams {
  expression: string;
}

/**
 * Maximum length of an expression string.  Generous enough for the
 * complex predicates a power user might write while preventing
 * pathological input that would blow up the SQL planner.
 */
const MAX_EXPRESSION_LENGTH = 2000;

/**
 * Resolve a {{field}} reference to a typed SQL expression against
 * the row's properties JSONB blob.  Numbers cast to double precision
 * (so arithmetic + numeric comparisons work), booleans cast to
 * boolean, strings stay as text.  Unknown types fall back to text,
 * which is the conservative pick: every JSONB value is representable
 * as text, and SQL's TEXT comparisons sort as the user expects.
 */
function columnForField(
  fieldName: string,
  schema: FeatureField[],
): string {
  const ref = schema.find((f) => f.name === fieldName);
  // Escape the field name as a SQL literal: properties->>'name'
  // Single quotes are not allowed inside field names by the
  // calculate-geometry validator (alpha-num + underscore only), and
  // the filter generator inherits that same constraint via the
  // shared validator below.  Belt-and-suspenders: replace any stray
  // apostrophe so the emitted SQL stays well-formed regardless.
  const safe = fieldName.replace(/'/g, "''");
  const raw = `(properties->>'${safe}')`;
  switch (ref?.type) {
    case 'number':
      // NULLIF guards against empty-string-to-double cast errors.
      return `NULLIF(${raw}, '')::double precision`;
    case 'boolean':
      return `(${raw}::boolean)`;
    default:
      return raw;
  }
}

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
    let ast;
    try {
      ast = parseExpression(expression);
    } catch (err) {
      if (err instanceof ExpressionError) {
        throw new BadRequestException(
          `filter.params.expression: ${err.message} (at position ${err.pos})`,
        );
      }
      throw err;
    }
    // Schema check when we have the source schema (save time).
    if (ctx?.sourceSchema) {
      const schema = ctx.sourceSchema.map((f) => ({
        name: f.name,
        type: fieldRefTypeFor(f.type),
      }));
      const errors = validateExpression(ast, schema);
      if (errors.length > 0) {
        throw new BadRequestException(
          `filter.params.expression: ${errors.join('; ')}`,
        );
      }
    }
    return { expression };
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

  toSql(inputAlias: string, params: FilterParams, paramOffset: number) {
    // Parse again at SQL time.  This is cheap (the AST is built from
    // a short string) and means save-time and read-time validation
    // stay in lockstep without persisting the AST.
    const ast = parseExpression(params.expression);
    // We don't have the schema here (read-time path), so fall back
    // to treating unreferenced fields as text.  Expression
    // generation still works because the cast logic is keyed off
    // the operator, not the column type.
    const refs = collectFieldRefs(ast);
    const schema: FeatureField[] = refs.map((name) => ({
      name,
      label: name,
      type: 'string',
      nullable: true,
    }));
    const compiled = compileExpression(
      ast,
      (name) => columnForField(name, schema),
      paramOffset,
    );
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
