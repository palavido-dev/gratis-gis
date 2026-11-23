// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The GratisGIS expression language: public entry points.
 *
 * One language for calculated fields, filters, derived layers, labels,
 * popups and styling. The implementation lives in ./expr:
 *
 *   parser.ts    text to syntax tree
 *   check.ts     types, and every decision both runtimes must share
 *   catalog.ts   built-in functions, SQL and JavaScript side by side
 *   sql.ts       compile to a Postgres fragment (server)
 *   evaluate.ts  evaluate in JavaScript (browser preview, offline)
 *   values.ts    value conversions shared by the evaluator
 *
 * The language reference for users is the help page
 * apps/portal-web/content/help/expressions.md.
 */

import {
  ExpressionError,
  walkExpr,
  type Expr,
  type ExpressionIssue,
  type FieldRef,
  type ValueType,
} from './expr/ast';
import { checkExpression, type CheckOptions, type CheckResult } from './expr/check';
import { evaluateChecked, toJsonValue, convertValue, type JsDataProvider } from './expr/evaluate';
import { parseExpression } from './expr/parser';
import { compileChecked, type CompiledSql, type SqlCompileOptions } from './expr/sql';
import type { FeatureVal } from './expr/values';

export {
  ExpressionError,
  fieldRefTypeFor,
  walkExpr,
  type BinOp,
  type Expr,
  type ExpressionIssue,
  type FieldRef,
  type FieldRefType,
  type ValueType,
} from './expr/ast';
export {
  isSqlSafeFieldName,
  MAX_SQL_SAFE_FIELD_NAME_LENGTH,
  SQL_SAFE_FIELD_NAME_RE,
  toSqlSafeFieldName,
} from './expr/names';
export { parseExpression, MAX_EXPRESSION_LENGTH } from './expr/parser';
export { checkExpression, type CheckOptions, type CheckResult } from './expr/check';
export { FUNCTIONS, type FnSpec, type Category as FunctionCategory } from './expr/catalog';
export { compileChecked } from './expr/sql';
export { evaluateChecked } from './expr/evaluate';
export {
  fieldSql,
  NEAREST_CANDIDATES,
  type CompiledSql,
  type SqlDataAdapter,
  type SqlRowContext,
} from './expr/sql';
export {
  collectDataRefs,
  DATA_FUNCTION_DOCS,
  usesDataAccess,
  type DataRef,
  type DataResolver,
  type DataSource,
  type Resolved as ResolvedDataSource,
} from './expr/data';
export type { JsDataProvider } from './expr/evaluate';
export type { FeatureVal as ExpressionFeature } from './expr/values';
export { FORMAT_TOKENS } from './expr/dates';
export { AREA_UNITS as EXPRESSION_AREA_UNITS, LENGTH_UNITS as EXPRESSION_LENGTH_UNITS } from './expr/geo';


/** Parse and type-check. Never throws; syntax errors come back as issues. */
export function analyzeExpression(
  src: string,
  opts: CheckOptions,
): { ast: Expr | null; type: ValueType | null; issues: ExpressionIssue[]; checked: CheckResult | null } {
  let ast: Expr;
  try {
    ast = parseExpression(src);
  } catch (e) {
    if (e instanceof ExpressionError) {
      return { ast: null, type: null, issues: [{ message: e.message, pos: e.pos }], checked: null };
    }
    throw e;
  }
  const checked = checkExpression(ast, opts);
  return { ast, type: checked.type, issues: checked.issues, checked };
}

function toAst(src: string | Expr): Expr {
  return typeof src === 'string' ? parseExpression(src) : src;
}

/**
 * Compile to SQL. Throws ExpressionError (with a position) when the
 * expression does not parse or check.
 */
export function compileExpressionSql(
  src: string | Expr,
  opts: CheckOptions & SqlCompileOptions,
): CompiledSql {
  const ast = toAst(src);
  const checked = checkExpression(ast, opts);
  return compileChecked(ast, checked, opts);
}

export interface EvaluateOptions extends CheckOptions {
  properties: Record<string, unknown>;
  geometry?: unknown;
  /** The feature's id, for related(). */
  id?: string;
  /** Rows of other sources, for data access. */
  rows?: JsDataProvider;
  now?: number;
  timeZone?: string;
  /** Convert the result, as the SQL compiler's `as`. */
  as?: 'number' | 'string' | 'boolean' | 'date' | 'list' | 'value';
}

/**
 * Evaluate for one feature in JavaScript. The result is plain JSON:
 * dates come back as text (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`).
 * Throws ExpressionError when the expression does not parse or check.
 */
export function evaluateExpressionValue(src: string | Expr, opts: EvaluateOptions): unknown {
  const ast = toAst(src);
  const checked = checkExpression(ast, opts);
  const feature: FeatureVal = {
    kind: 'feature',
    properties: opts.properties,
    geometry: opts.geometry ?? null,
    fields: opts.fields,
  };
  if (opts.id !== undefined) feature.id = opts.id;
  const env: { feature: FeatureVal; now?: number; timeZone?: string; data?: JsDataProvider } = { feature };
  if (opts.rows) env.data = opts.rows;
  if (opts.now !== undefined) env.now = opts.now;
  if (opts.timeZone !== undefined) env.timeZone = opts.timeZone;
  let v = evaluateChecked(ast, checked, env);
  if (opts.as && opts.as !== 'value') v = convertValue(v, opts.as);
  return toJsonValue(v);
}

// ---- Older entry points -----------------------------------------

/**
 * Type-check against a schema; returns messages, empty when valid.
 * Fields typed 'unknown' are not checked beyond existing.
 */
export function validateExpression(expr: Expr, schema: FieldRef[]): string[] {
  return checkExpression(expr, { fields: schema }).issues.map((i) => i.message);
}

/**
 * Evaluate against one row's attributes with no declared schema:
 * every field reads as untyped text. Prefer evaluateExpressionValue
 * with the layer's fields.
 */
export function evaluateExpression(expr: Expr, props: Record<string, unknown>): unknown {
  return evaluateExpressionValue(expr, { fields: [], allowUnknownFields: true, properties: props });
}

/** Every field an expression reads, at any depth. */
export function collectFieldRefs(expr: Expr): string[] {
  const out = new Set<string>();
  walkExpr(expr, (n) => {
    if (n.kind === 'field') out.add(n.name);
  });
  return [...out];
}
