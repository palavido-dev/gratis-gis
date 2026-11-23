// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Syntax tree and value types for the GratisGIS expression language.
 *
 * One language, three runtimes: the type checker (this package), the
 * SQL compiler (server, PostGIS) and the JavaScript evaluator (browser
 * previews and the offline field app). Every node carries `pos`, the
 * offset of its first character, so errors can point at the source.
 */

/** Static types the checker assigns. */
export type ValueType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'date'
  | 'list'
  /** A single feature or row: `$feature`, or `first(...)` of a set. */
  | 'feature'
  /** A set of rows from a related table or another layer. */
  | 'set'
  /** A field with no declared type (a layer with no schema). */
  | 'unknown'
  /** The `null` literal. */
  | 'null';

/** Kept for callers that name the old type. */
export type FieldRefType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'date'
  | 'list'
  | 'unknown';

/** A declared field the expression may reference. */
export interface FieldRef {
  name: string;
  type: FieldRefType;
  /** Display label, for the builder and for error messages. */
  label?: string;
}

/**
 * The type-checker's view of a declared layer field. One mapping so
 * every caller that builds FieldRefs from a FeatureField schema agrees.
 */
export function fieldRefTypeFor(
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'multi_select',
): FieldRefType {
  return fieldType === 'multi_select' ? 'list' : fieldType;
}

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'AND'
  | 'OR'
  | '~~';

export type Expr =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'bool'; value: boolean; pos: number }
  | { kind: 'null'; pos: number }
  /**
   * A field. `outer` is true for `$feature.name`, which always means
   * the feature the expression is evaluated for. A plain `{{name}}`
   * means the innermost row: the feature itself at top level, or the
   * related row inside a set function such as `filter()`.
   */
  | { kind: 'field'; name: string; outer: boolean; pos: number }
  /** `$feature` on its own: the whole current feature. */
  | { kind: 'feature'; pos: number }
  /** `expr.name`: a field of a feature-valued expression. */
  | { kind: 'member'; object: Expr; name: string; pos: number }
  /** `[a, b]` or the parenthesized list after IN. */
  | { kind: 'list'; items: Expr[]; pos: number }
  | { kind: 'unop'; op: '-' | 'NOT'; arg: Expr; pos: number }
  | { kind: 'binop'; op: BinOp; left: Expr; right: Expr; pos: number }
  | { kind: 'isnull'; arg: Expr; negated: boolean; pos: number }
  | { kind: 'in'; arg: Expr; list: Expr; negated: boolean; pos: number }
  | {
      kind: 'between';
      arg: Expr;
      low: Expr;
      high: Expr;
      negated: boolean;
      pos: number;
    }
  | {
      kind: 'like';
      arg: Expr;
      pattern: Expr;
      negated: boolean;
      caseInsensitive: boolean;
      pos: number;
    }
  | {
      kind: 'case';
      subject: Expr | null;
      whens: Array<{ when: Expr; then: Expr }>;
      otherwise: Expr | null;
      pos: number;
    }
  | { kind: 'func'; name: string; args: Expr[]; pos: number };

export class ExpressionError extends Error {
  /** Offset into the source string where the error starts. */
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

/** One problem found by the checker. */
export interface ExpressionIssue {
  message: string;
  pos: number;
}

/** Visit every node, parents before children. */
export function walkExpr(e: Expr, visit: (n: Expr) => void): void {
  visit(e);
  switch (e.kind) {
    case 'member':
      walkExpr(e.object, visit);
      return;
    case 'list':
      for (const i of e.items) walkExpr(i, visit);
      return;
    case 'unop':
    case 'isnull':
      walkExpr(e.arg, visit);
      return;
    case 'binop':
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      return;
    case 'in':
      walkExpr(e.arg, visit);
      walkExpr(e.list, visit);
      return;
    case 'between':
      walkExpr(e.arg, visit);
      walkExpr(e.low, visit);
      walkExpr(e.high, visit);
      return;
    case 'like':
      walkExpr(e.arg, visit);
      walkExpr(e.pattern, visit);
      return;
    case 'case':
      if (e.subject) walkExpr(e.subject, visit);
      for (const w of e.whens) {
        walkExpr(w.when, visit);
        walkExpr(w.then, visit);
      }
      if (e.otherwise) walkExpr(e.otherwise, visit);
      return;
    case 'func':
      for (const a of e.args) walkExpr(a, visit);
      return;
    default:
      return;
  }
}
