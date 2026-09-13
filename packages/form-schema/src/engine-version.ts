// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine versioning for the form evaluator.
 *
 * The web client and the server always run the same build of this
 * package, so they cannot disagree about what a form means. A native
 * client does not have that property: it carries whatever build of
 * the evaluator it was installed with, and keeps carrying it for
 * months after the server has moved on. When authoring gains a
 * question type, an expression operator or a builtin, an older
 * evaluator would silently mis-evaluate a form that uses it, and
 * nothing in the repo would notice because every commit was green
 * on its own. See docs/mobile-field-app.md, "Engine versioning".
 *
 * The mechanism is a table lookup, not a heuristic:
 *
 *   - `ENGINE_VERSION` is bumped in any commit that changes what a
 *     form evaluates to. New question types, operators and builtins
 *     are registered below with the version they were introduced in.
 *   - `requiredEngineVersion(form)` walks a form and returns the
 *     highest version anything in it needs. The server stamps that
 *     onto the form at save so a client learns it from the listing
 *     without opening each form.
 *   - A client whose `ENGINE_VERSION` is below the stamped value must
 *     not evaluate the form. Anything it does not recognise resolves
 *     to `ENGINE_VERSION + 1`, so an unknown feature always reads as
 *     "newer than me" rather than "unversioned".
 *
 * Do not stamp the server's current `ENGINE_VERSION` instead of the
 * walked value: that would force an app update on every deploy for
 * forms that use nothing new.
 */

import type {
  BuiltinName,
  Expression,
  FormSchema,
  FormSchemaVersion,
  Operand,
  Question,
  QuestionType,
} from './index';

/**
 * Bump when evaluation behaviour changes. Additions register their
 * introduction version in the tables below; behavioural fixes to
 * existing features bump this without adding a table entry, because
 * the corpus cases they change are only valid from this version on.
 */
export const ENGINE_VERSION = 1;

export type ExpressionOp = Expression['op'];

/** Version each question type first evaluated correctly. */
export const QUESTION_TYPE_ENGINE_VERSION: Readonly<Record<QuestionType, number>> = {
  text: 1,
  multiline: 1,
  email: 1,
  url: 1,
  phone: 1,
  regex: 1,
  number: 1,
  integer: 1,
  boolean: 1,
  'select-one': 1,
  'select-many': 1,
  'matrix-single': 1,
  'matrix-multi': 1,
  'matrix-dropdown': 1,
  'matrix-rating': 1,
  ranking: 1,
  date: 1,
  time: 1,
  datetime: 1,
  name: 1,
  address: 1,
  photo: 1,
  audio: 1,
  video: 1,
  barcode: 1,
  sketch: 1,
  file: 1,
  'image-choice': 1,
  'image-display': 1,
  'image-hotspot': 1,
  signature: 1,
  geopoint: 1,
  geotrace: 1,
  geoshape: 1,
  'pick-feature': 1,
  route: 1,
  'area-buffer': 1,
  rating: 1,
  likert: 1,
  nps: 1,
  slider: 1,
  calculated: 1,
  note: 1,
  divider: 1,
  acknowledge: 1,
  hidden: 1,
  page: 1,
  group: 1,
};

/** Version each expression operator first evaluated correctly. */
export const EXPRESSION_OP_ENGINE_VERSION: Readonly<Record<ExpressionOp, number>> = {
  eq: 1,
  neq: 1,
  gt: 1,
  gte: 1,
  lt: 1,
  lte: 1,
  and: 1,
  or: 1,
  not: 1,
  in: 1,
  between: 1,
  matches: 1,
  add: 1,
  sub: 1,
  mul: 1,
  div: 1,
  concat: 1,
  if: 1,
};

/** Version each builtin first evaluated correctly. */
export const BUILTIN_ENGINE_VERSION: Readonly<Record<BuiltinName, number>> = {
  today: 1,
  now: 1,
  len: 1,
  sum: 1,
  count: 1,
  coalesce: 1,
  lower: 1,
  upper: 1,
  trim: 1,
  contains: 1,
  starts_with: 1,
  ends_with: 1,
  substring: 1,
  abs: 1,
  round: 1,
  floor: 1,
  ceil: 1,
  min_of: 1,
  max_of: 1,
  selected: 1,
};

/** Version each form schema version first loaded correctly. */
export const FORM_SCHEMA_ENGINE_VERSION: Readonly<Record<FormSchemaVersion, number>> = {
  1: 1,
};

export interface EngineRequirement {
  /** Highest engine version anything in the form needs. */
  version: number;
  /**
   * Features this build does not recognise, as `kind:name` strings
   * (`question-type:foo`, `op:bar`, `builtin:baz`,
   * `schema-version:2`). Non-empty means `version` is
   * `ENGINE_VERSION + 1` and the form came from a newer server. Kept
   * so a client can say what it did not understand.
   */
  unknown: string[];
}

/** The version an unknown feature resolves to: always newer than us. */
const UNKNOWN_VERSION = ENGINE_VERSION + 1;

/**
 * Walk a form and report the engine version it needs. Tolerant of
 * malformed input: anything that is not the shape we expect counts as
 * unknown rather than throwing, because this runs on a client against
 * whatever the server sent.
 */
export function engineRequirement(form: FormSchema): EngineRequirement {
  const unknown = new Set<string>();
  let version = 1;

  const need = (v: number | undefined, label: string): void => {
    if (v === undefined) {
      unknown.add(label);
      version = Math.max(version, UNKNOWN_VERSION);
    } else {
      version = Math.max(version, v);
    }
  };

  const walkOperand = (operand: Operand | undefined): void => {
    if (!operand || typeof operand !== 'object') return;
    if ('call' in operand) {
      const name = operand.call as string;
      need(
        Object.prototype.hasOwnProperty.call(BUILTIN_ENGINE_VERSION, name)
          ? BUILTIN_ENGINE_VERSION[name as BuiltinName]
          : undefined,
        `builtin:${name}`,
      );
      for (const arg of operand.args ?? []) walkOperand(arg);
    }
    // `ref` and `value` operands carry no versioned feature.
  };

  const walkExpression = (expr: Expression | undefined): void => {
    if (!expr || typeof expr !== 'object' || typeof expr.op !== 'string') return;
    const op = expr.op as string;
    need(
      Object.prototype.hasOwnProperty.call(EXPRESSION_OP_ENGINE_VERSION, op)
        ? EXPRESSION_OP_ENGINE_VERSION[op as ExpressionOp]
        : undefined,
      `op:${op}`,
    );
    switch (expr.op) {
      case 'and':
      case 'or':
        for (const e of expr.operands ?? []) walkExpression(e);
        return;
      case 'not':
        walkExpression(expr.operand);
        return;
      case 'between':
        walkOperand(expr.value);
        walkOperand(expr.min);
        walkOperand(expr.max);
        return;
      case 'concat':
        for (const o of expr.operands ?? []) walkOperand(o);
        return;
      case 'if':
        walkExpression(expr.condition);
        walkOperand(expr.then);
        walkOperand(expr.else);
        return;
      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'in':
      case 'matches':
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
        walkOperand(expr.left);
        walkOperand(expr.right);
        return;
      default:
        // Unknown op: already recorded above; its shape is unknown
        // too, so there is nothing further to walk.
        return;
    }
  };

  const walkQuestion = (q: Question): void => {
    if (!q || typeof q !== 'object') return;
    const type = q.type as string;
    need(
      Object.prototype.hasOwnProperty.call(QUESTION_TYPE_ENGINE_VERSION, type)
        ? QUESTION_TYPE_ENGINE_VERSION[type as QuestionType]
        : undefined,
      `question-type:${type}`,
    );
    walkExpression(q.visibleIf);
    if (typeof q.required === 'object') walkExpression(q.required);
    walkExpression(q.constraint);
    if (typeof q.readOnly === 'object') walkExpression(q.readOnly);
    walkExpression(q.calculate);
    // Only groups nest today (pages are markers). Read `children`
    // off the raw object rather than the narrowed type so a future
    // nesting container is still walked instead of silently skipped.
    const children = (q as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) walkQuestion(child as Question);
    }
  };

  const schemaVersion = form?.schemaVersion as number | undefined;
  need(
    schemaVersion !== undefined &&
      Object.prototype.hasOwnProperty.call(FORM_SCHEMA_ENGINE_VERSION, schemaVersion)
      ? FORM_SCHEMA_ENGINE_VERSION[schemaVersion as FormSchemaVersion]
      : undefined,
    `schema-version:${String(schemaVersion)}`,
  );
  for (const q of form?.questions ?? []) walkQuestion(q);

  return { version, unknown: [...unknown].sort() };
}

/** Highest engine version the form needs. See {@link engineRequirement}. */
export function requiredEngineVersion(form: FormSchema): number {
  return engineRequirement(form).version;
}

/** True when this build of the evaluator can run the form. */
export function engineSupports(form: FormSchema): boolean {
  return requiredEngineVersion(form) <= ENGINE_VERSION;
}
