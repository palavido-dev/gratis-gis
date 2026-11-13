// SPDX-License-Identifier: AGPL-3.0-or-later
// Condition rows for the form designer's expression editors.
//
// The inline editor and the Builder modal turn rows like "species
// contains oak" into the Expression AST the form-schema evaluator
// runs, and back. They moved out of the designer page so the round
// trip can be tested against the real evaluator: "contains" was
// emitted backwards and "Required (not empty)" was true for an
// unanswered question, and neither showed until a respondent hit it.
import type { Expression, Operand } from '@gratis-gis/form-schema';

/**
 * Operators the inline editor exposes for a single condition row.
 * Mirrors the AST opcodes in `Expression`. We list the comparable
 * subset (no `and`/`or`/`not`/arithmetic/concat/if): those are
 * structural and live at the row-list level, not inside a row. The
 * label is what shows in the dropdown; the AST opcode is what we
 * persist.
 *
 * Numeric-only operators (gt/gte/lt/lte/between) still appear on
 * any field type; the evaluator compares numerically when one side
 * is a number and the other reads as one. The author's choice of
 * operator is more reliable than us trying to guess based on field
 * type, especially when a "text" field actually holds numeric content.
 *
 * `in` is shown as "contains": the field's answer (text or a list of
 * picked choices) contains the value. `notEmpty` takes no value.
 */
export type ComparisonOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'between'
  | 'matches'
  | 'notEmpty';

export const COMPARISON_OPERATOR_SPECS: ReadonlyArray<{
  op: ComparisonOp;
  rhsKind: 'value' | 'list' | 'range' | 'none';
}> = [
  { op: 'eq', rhsKind: 'value' },
  { op: 'neq', rhsKind: 'value' },
  { op: 'gt', rhsKind: 'value' },
  { op: 'gte', rhsKind: 'value' },
  { op: 'lt', rhsKind: 'value' },
  { op: 'lte', rhsKind: 'value' },
  { op: 'in', rhsKind: 'value' },
  { op: 'between', rhsKind: 'range' },
  { op: 'matches', rhsKind: 'value' },
  { op: 'notEmpty', rhsKind: 'none' },
];

/**
 * One row in the inline editor. Always references a question on the
 * left; `op` picks one of the comparison operators above; the right
 * side is either a single value or, for `between`, a {min, max} pair.
 *
 * We keep `value` typed as a primitive string in the row even when
 * the left field is numeric -- on render we coerce via `Number(...)`
 * before composing the AST, so the user can type freely without the
 * input flickering between empty and 0.
 *
 * `flags` carries a `matches` row's regex flags through a round trip;
 * the editor has no control for them, but dropping them on save
 * changed what the pattern matched.
 */
export interface ConditionRow {
  ref: string;
  op: ComparisonOp;
  value: string;
  min: string;
  max: string;
  flags?: string;
}

export const DEFAULT_ROW = (): ConditionRow => ({
  ref: '',
  op: 'eq',
  value: '',
  min: '',
  max: '',
});

/**
 * Try to break an Expression into a list of comparison rows joined
 * by AND or OR. Best-effort: if the expression uses ops we don't
 * model in the inline editor (calls, arithmetic, nested and/or, etc.)
 * we return null and the editor falls back to a "complex expression"
 * banner with a clear-and-start-over button. This keeps the UI
 * predictable -- we don't try to round-trip something we couldn't
 * faithfully render.
 */
export function decomposeExpression(expr: Expression | undefined): {
  combinator: 'and' | 'or';
  rows: ConditionRow[];
} | null {
  if (!expr) return { combinator: 'and', rows: [] };
  // Single comparison row at the top level: treat as one-row AND.
  const single = decomposeRow(expr);
  if (single) return { combinator: 'and', rows: [single] };
  // and / or of comparisons.
  if (expr.op === 'and' || expr.op === 'or') {
    const rows: ConditionRow[] = [];
    for (const op of expr.operands) {
      const r = decomposeRow(op);
      if (!r) return null; // bail on first non-row operand
      rows.push(r);
    }
    return { combinator: expr.op, rows };
  }
  return null;
}

function literal(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function isRef(o: Operand): o is { ref: string } {
  return 'ref' in o && typeof o.ref === 'string';
}

function isLiteral(o: Operand): o is { value: string | number | boolean | null } {
  return 'value' in o;
}

/**
 * If `expr` is one of our supported comparison shapes, return the
 * matching row. Otherwise null.
 */
export function decomposeRow(expr: Expression): ConditionRow | null {
  if (expr.op === 'in') {
    // "field contains value": the evaluator's haystack is the right
    // operand, so the field goes on the right.
    if (isLiteral(expr.left) && isRef(expr.right)) {
      return {
        ...DEFAULT_ROW(),
        ref: expr.right.ref,
        op: 'in',
        value: literal(expr.left.value),
      };
    }
    // The editor used to write "contains" the other way round, which
    // tested whether the value contained the answer. Read that shape
    // as the "contains" row its author picked, so editing the
    // condition writes it the right way round. A list on the right is
    // a hand-written "answer is one of" and stays as it is.
    if (
      isRef(expr.left) &&
      isLiteral(expr.right) &&
      typeof expr.right.value === 'string'
    ) {
      return {
        ...DEFAULT_ROW(),
        ref: expr.left.ref,
        op: 'in',
        value: expr.right.value,
      };
    }
    return null;
  }
  // notEmpty: len(field) > 0. Unanswered questions resolve to null,
  // and `null neq ''` is true, so a not-equal-empty row passed for a
  // question nobody had touched.
  if (
    expr.op === 'gt' &&
    'call' in expr.left &&
    expr.left.call === 'len' &&
    Array.isArray(expr.left.args) &&
    expr.left.args.length === 1 &&
    isRef(expr.left.args[0]!) &&
    isLiteral(expr.right) &&
    expr.right.value === 0
  ) {
    return {
      ...DEFAULT_ROW(),
      ref: (expr.left.args[0] as { ref: string }).ref,
      op: 'notEmpty',
    };
  }
  if (
    expr.op === 'eq' ||
    expr.op === 'neq' ||
    expr.op === 'gt' ||
    expr.op === 'gte' ||
    expr.op === 'lt' ||
    expr.op === 'lte' ||
    expr.op === 'matches'
  ) {
    if (isRef(expr.left) && isLiteral(expr.right)) {
      const row: ConditionRow = {
        ...DEFAULT_ROW(),
        ref: expr.left.ref,
        op: expr.op,
        value: literal(expr.right.value),
      };
      if (expr.op === 'matches' && expr.flags) row.flags = expr.flags;
      return row;
    }
    return null;
  }
  if (expr.op === 'between') {
    if (isRef(expr.value) && isLiteral(expr.min) && isLiteral(expr.max)) {
      return {
        ...DEFAULT_ROW(),
        ref: expr.value.ref,
        op: 'between',
        min: literal(expr.min.value),
        max: literal(expr.max.value),
      };
    }
    return null;
  }
  return null;
}

/**
 * Compose rows + combinator back into an Expression. Returns
 * undefined when the result would be empty (no rows, or the only
 * row has no field picked). undefined is the schema's "no condition"
 * value, which is what we want for unset visibleIf / constraint.
 */
export function composeExpression(
  combinator: 'and' | 'or',
  rows: ConditionRow[],
): Expression | undefined {
  const valid = rows.filter((r) => r.ref);
  if (valid.length === 0) return undefined;
  const exprs = valid.map(rowToExpression);
  if (exprs.length === 1) return exprs[0];
  return { op: combinator, operands: exprs };
}

export function rowToExpression(r: ConditionRow): Expression {
  if (r.op === 'between') {
    return {
      op: 'between',
      value: { ref: r.ref },
      min: { value: coerceLiteral(r.min) },
      max: { value: coerceLiteral(r.max) },
    };
  }
  if (r.op === 'matches') {
    // RHS is a regex pattern -- never coerce to number/boolean even
    // if the pattern happens to look like one (e.g. "true|false").
    return {
      op: 'matches',
      left: { ref: r.ref },
      right: { value: r.value },
      ...(r.flags ? { flags: r.flags } : {}),
    };
  }
  if (r.op === 'in') {
    // The evaluator reads `in` as "left is inside right", so the
    // answer (a string or a list of picked choices) is the right side.
    // Kept as typed: a choice value "2" must not become the number 2,
    // which a list of picked strings never includes.
    return { op: 'in', left: { value: r.value }, right: { ref: r.ref } };
  }
  if (r.op === 'notEmpty') {
    return {
      op: 'gt',
      left: { call: 'len', args: [{ ref: r.ref }] },
      right: { value: 0 },
    };
  }
  return {
    op: r.op,
    left: { ref: r.ref },
    right: { value: coerceLiteral(r.value) },
  } as Expression;
}

/**
 * Coerce a string-typed input value into the literal we persist on
 * the AST: numeric strings become numbers, "true"/"false" become
 * booleans, empty stays empty. The evaluator compares a number or a
 * boolean with a string answer by value, so `rating eq 2` still
 * matches the choice "2".
 */
export function coerceLiteral(s: string): string | number | boolean {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  // Strict numeric: string must parse cleanly and round-trip.
  const n = Number(s);
  if (!Number.isNaN(n) && String(n) === s) return n;
  return s;
}

// Data model for the Builder modal: a `Rule` is a single ConditionRow,
// a nested `RuleGroup`, or a `raw` expression the rows cannot show.
// `RuleTree` is the top level (a combinator + a list of rules).

export type Rule =
  | { kind: 'row'; row: ConditionRow }
  | { kind: 'group'; combinator: 'and' | 'or'; rules: Rule[] }
  | { kind: 'raw'; expr: Expression };

export interface RuleTree {
  combinator: 'and' | 'or';
  rules: Rule[];
}

/**
 * Decode an Expression into the modal's RuleTree shape. Comparison
 * ops, in and between become rows; and/or become groups at any depth.
 *
 * Anything we can't model (not, function calls, arithmetic, concat,
 * if, field-to-field comparisons) becomes a `raw` rule that is shown
 * read-only and written back unchanged. It used to become an empty
 * row, which Save then dropped, so opening the Builder and saving
 * erased a calculation or part of a condition.
 */
export function treeFromExpression(expr: Expression | undefined): RuleTree {
  if (!expr) return { combinator: 'and', rules: [] };
  if (expr.op === 'and' || expr.op === 'or') {
    return {
      combinator: expr.op,
      rules: expr.operands.map(operandToRule),
    };
  }
  return { combinator: 'and', rules: [operandToRule(expr)] };
}

function operandToRule(expr: Expression): Rule {
  if (expr.op === 'and' || expr.op === 'or') {
    return {
      kind: 'group',
      combinator: expr.op,
      rules: expr.operands.map(operandToRule),
    };
  }
  const row = decomposeRow(expr);
  if (row) return { kind: 'row', row };
  return { kind: 'raw', expr };
}

export function treeToExpression(tree: RuleTree): Expression | undefined {
  const exprs: Expression[] = [];
  for (const rule of tree.rules) {
    const e = ruleToExpression(rule);
    if (e !== undefined) exprs.push(e);
  }
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0];
  return { op: tree.combinator, operands: exprs };
}

function ruleToExpression(rule: Rule): Expression | undefined {
  if (rule.kind === 'raw') return rule.expr;
  if (rule.kind === 'row') {
    if (!rule.row.ref) return undefined;
    return rowToExpression(rule.row);
  }
  return treeToExpression({
    combinator: rule.combinator,
    rules: rule.rules,
  });
}
