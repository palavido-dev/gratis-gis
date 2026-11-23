// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Field Maps form (a web map layer's `formInfo`) to a GratisGIS form.
 *
 * The questions start from the form the field app would build from
 * the layer's own fields, so types, pick lists and column bindings
 * match what the layer stores. The Field Maps form then decides which
 * fields appear, in what order and groups, with what labels, and when
 * each one shows, is required or can be edited.
 *
 * Field Maps writes those rules in Arcade. Each one is translated to
 * an expression, then to the form's own rule format. A rule that does
 * not fit is dropped with a warning that says what happens instead
 * (always shown, optional or editable), so the form still works.
 */
import {
  generateFormFromLayer,
  type Expression,
  type FormSchema,
  type LayerFieldForGeneration,
  type Operand,
  type Question,
} from '@gratis-gis/form-schema';
import {
  parseExpression,
  translateArcade,
  type Expr,
  type FeatureField,
} from '@gratis-gis/shared-types';

/** One input control setting on a Field Maps field element. */
interface AgoFormInput {
  type?: string;
  includeTime?: boolean;
}

/** A Field Maps form element. Only the keys read here are typed. */
export interface AgoFormElement {
  type?: string;
  fieldName?: string;
  label?: string;
  description?: string;
  hint?: string;
  editable?: boolean;
  editableExpression?: string;
  requiredExpression?: string;
  visibilityExpression?: string;
  valueExpression?: string;
  inputType?: AgoFormInput;
  formElements?: AgoFormElement[];
  text?: string;
  textFormat?: string;
}

/** A web map layer's `formInfo`. */
export interface AgoFormInfo {
  title?: string;
  description?: string;
  formElements?: AgoFormElement[];
  expressionInfos?: Array<{ name?: string; expression?: string; title?: string }>;
}

export interface FieldMapsFormArgs {
  formInfo: AgoFormInfo;
  dataLayerId: string;
  layerKey: string;
  layerTitle: string;
  fields: FeatureField[];
  /** Form title when the Field Maps form has none. */
  title: string;
}

/**
 * Build the form. Returns null when the Field Maps form lists no
 * fields this layer has, in which case the field app's own form from
 * the layer's fields is the better result.
 */
export function fieldMapsFormToSchema(args: FieldMapsFormArgs): {
  form: FormSchema | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const base = generateFormFromLayer(
    {
      key: args.layerKey,
      label: args.layerTitle,
      fields: args.fields.map(toGeneratorField),
    },
    { dataLayerId: args.dataLayerId, formId: '', title: args.title },
  );
  const byColumn = new Map<string, Question>();
  for (const q of base.questions) {
    const column = q.bindTo?.column;
    if (column) byColumn.set(column.toLowerCase(), q);
  }
  const ctx: Ctx = {
    byColumn,
    exprs: new Map(
      (args.formInfo.expressionInfos ?? [])
        .filter((e) => typeof e.name === 'string' && typeof e.expression === 'string')
        .map((e) => [e.name!, e.expression!]),
    ),
    used: new Set(),
    refs: new Set(),
    ids: new Set(),
    warnings,
    layer: args.layerTitle,
  };
  const questions = convertElements(args.formInfo.formElements ?? [], ctx);
  if (ctx.used.size === 0) return { form: null, warnings };
  // Fields a rule reads that the form does not show: carried as hidden
  // questions so the rule sees the feature's value.
  for (const name of ctx.refs) {
    if (ctx.used.has(name)) continue;
    const q = byColumn.get(name)!;
    questions.push({
      type: 'hidden',
      id: q.id,
      label: q.label,
      ...(q.bindTo ? { bindTo: q.bindTo } : {}),
    });
  }
  const title = args.formInfo.title?.trim() || args.title;
  const description = args.formInfo.description?.trim();
  return {
    form: {
      ...base,
      title,
      ...(description ? { description } : {}),
      questions,
      meta: { importedFrom: 'field-maps', sourceLayerKey: args.layerKey },
    },
    warnings,
  };
}

function toGeneratorField(f: FeatureField): LayerFieldForGeneration {
  const out: LayerFieldForGeneration = { name: f.name, type: f.type, nullable: f.nullable };
  if (f.label) out.label = f.label;
  if (
    f.domain &&
    (f.domain.type === 'coded-value' ||
      f.domain.type === 'coded-value-ref' ||
      f.domain.type === 'range')
  ) {
    out.domain = f.domain as NonNullable<LayerFieldForGeneration['domain']>;
  }
  return out;
}

interface Ctx {
  byColumn: Map<string, Question>;
  exprs: Map<string, string>;
  /** Columns already placed, so a field listed twice appears once. */
  used: Set<string>;
  /** Columns a rule reads. */
  refs: Set<string>;
  /** Ids of groups and notes made here. */
  ids: Set<string>;
  warnings: string[];
  layer: string;
}

function convertElements(elements: AgoFormElement[], ctx: Ctx): Question[] {
  const out: Question[] = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const q = convertElement(el, ctx);
    if (q) out.push(q);
  }
  return out;
}

function convertElement(el: AgoFormElement, ctx: Ctx): Question | null {
  switch (el.type) {
    case 'field':
      return convertField(el, ctx);
    case 'group': {
      const children = convertElements(el.formElements ?? [], ctx);
      if (children.length === 0) return null;
      const group: Question = {
        type: 'group',
        id: freshId('group', ctx),
        label: el.label?.trim() || 'Group',
        children,
      };
      if (el.description?.trim()) group.hint = el.description.trim();
      applyRule(group, 'visible', el.visibilityExpression, ctx, `group "${group.label}"`);
      return group;
    }
    case 'text': {
      const text = el.text?.trim();
      if (!text) return null;
      return {
        type: 'note',
        id: freshId('note', ctx),
        label: el.textFormat === 'markdown' ? text : stripTags(text),
        appearance: el.textFormat === 'markdown' ? 'markdown' : 'plain',
      };
    }
    case 'attachment':
      ctx.warnings.push(
        `${ctx.layer}: the attachment element "${el.label ?? 'Attachments'}" was not converted. ` +
          'Photos still attach through the field app when the layer has attachments turned on.',
      );
      return null;
    case 'relationship':
      ctx.warnings.push(
        `${ctx.layer}: the related records element "${el.label ?? 'Related records'}" was not converted. ` +
          'The field app lists related records for layers set up as child layers.',
      );
      return null;
    default:
      ctx.warnings.push(
        `${ctx.layer}: a form element of type "${String(el.type)}" was not converted.`,
      );
      return null;
  }
}

function convertField(el: AgoFormElement, ctx: Ctx): Question | null {
  const name = el.fieldName?.toLowerCase();
  const found = name ? ctx.byColumn.get(name) : undefined;
  if (!found || !name) {
    ctx.warnings.push(
      `${ctx.layer}: the form lists field "${String(el.fieldName)}", which the layer does not have to edit. It was left out.`,
    );
    return null;
  }
  if (ctx.used.has(name)) return null;
  ctx.used.add(name);
  let q = structuredClone(found) as Question;
  if (el.label?.trim()) q.label = el.label.trim();
  const help = el.description?.trim() || el.hint?.trim();
  if (help) q.hint = help;
  q = applyInput(q, el.inputType);
  const what = `field "${q.label}"`;
  if (el.editable === false) q.readOnly = true;
  applyRule(q, 'visible', el.visibilityExpression, ctx, what);
  applyRule(q, 'required', el.requiredExpression, ctx, what);
  if (el.editable !== false) applyRule(q, 'editable', el.editableExpression, ctx, what);
  if (el.valueExpression) {
    const src = ctx.exprs.get(el.valueExpression);
    const calc = src
      ? tryConvert(ctx, () => toCalculation(parseArcade(src), ctx))
      : { error: 'the expression is missing' };
    if ('value' in calc) {
      q.calculate = calc.value;
      q.readOnly = true;
    } else {
      ctx.warnings.push(
        `${ctx.layer}: the calculated value for ${what} was not converted (${calc.error}). The field is filled in by hand.`,
      );
    }
  }
  return q;
}

/** Match the control Field Maps asked for where the form has one. */
function applyInput(q: Question, input: AgoFormInput | undefined): Question {
  switch (input?.type) {
    case 'text-area':
      return q.type === 'text' ? { ...q, type: 'multiline' } : q;
    case 'barcode-scanner':
      return q.type === 'text' ? { ...q, type: 'barcode' } : q;
    case 'radio-buttons':
      return q.type === 'select-one' ? { ...q, appearance: 'radio' } : q;
    case 'combo-box':
      return q.type === 'select-one' ? { ...q, appearance: 'dropdown' } : q;
    case 'datetime-picker':
      if (q.type === 'datetime' && input.includeTime === false) return { ...q, type: 'date' };
      return q;
    default:
      return q;
  }
}

/** Set a show, required or editable rule from a named Arcade expression. */
function applyRule(
  q: Question,
  rule: 'visible' | 'required' | 'editable',
  name: string | undefined,
  ctx: Ctx,
  what: string,
): void {
  if (!name) return;
  const fallback = { visible: 'always shown', required: 'optional', editable: 'always editable' }[
    rule
  ];
  const src = ctx.exprs.get(name);
  const res = src
    ? tryConvert(ctx, () => toCondition(parseArcade(src), ctx))
    : { error: `the expression "${name}" is missing` };
  if ('error' in res) {
    ctx.warnings.push(
      `${ctx.layer}: the ${rule} rule on ${what} was not converted (${res.error}). It is ${fallback}.`,
    );
    return;
  }
  if (rule === 'visible') q.visibleIf = res.value;
  else if (rule === 'required') q.required = res.value;
  else q.readOnly = { op: 'not', operand: res.value };
}

class Unconvertible extends Error {}

/** Run one conversion; on failure, forget the fields it read. */
function tryConvert<T>(ctx: Ctx, fn: () => T): { value: T } | { error: string } {
  const refs = new Set(ctx.refs);
  try {
    return { value: fn() };
  } catch (e) {
    if (e instanceof Unconvertible) {
      ctx.refs = refs;
      return { error: e.message };
    }
    throw e;
  }
}

function parseArcade(src: string): Expr {
  const t = translateArcade(src);
  if (!('expression' in t) || t.expression === undefined) {
    throw new Unconvertible(('error' in t && t.error) || 'the Arcade did not translate');
  }
  try {
    return parseExpression(t.expression);
  } catch {
    throw new Unconvertible('the Arcade did not translate');
  }
}

const COMPARE = {
  '==': 'eq',
  '!=': 'neq',
  '<': 'lt',
  '<=': 'lte',
  '>': 'gt',
  '>=': 'gte',
} as const;

const TRUE: Expression = { op: 'eq', left: { value: true }, right: { value: true } };
const FALSE: Expression = { op: 'not', operand: TRUE };

/** A true/false rule. */
function toCondition(e: Expr, ctx: Ctx): Expression {
  switch (e.kind) {
    case 'bool':
      return e.value ? TRUE : FALSE;
    case 'unop':
      if (e.op === 'NOT') return { op: 'not', operand: toCondition(e.arg, ctx) };
      break;
    case 'binop':
      if (e.op === 'AND' || e.op === 'OR') {
        return {
          op: e.op === 'AND' ? 'and' : 'or',
          operands: [toCondition(e.left, ctx), toCondition(e.right, ctx)],
        };
      }
      if (e.op in COMPARE) {
        return {
          op: COMPARE[e.op as keyof typeof COMPARE],
          left: toOperand(e.left, ctx),
          right: toOperand(e.right, ctx),
        };
      }
      break;
    case 'isnull': {
      const test = isEmpty(toOperand(e.arg, ctx));
      return e.negated ? { op: 'not', operand: test } : test;
    }
    case 'in': {
      if (e.list.kind !== 'list') break;
      const left = toOperand(e.arg, ctx);
      const test: Expression = {
        op: 'or',
        operands: e.list.items.map((item) => ({
          op: 'eq' as const,
          left,
          right: toOperand(item, ctx),
        })),
      };
      return e.negated ? { op: 'not', operand: test } : test;
    }
    case 'between': {
      const test: Expression = {
        op: 'between',
        value: toOperand(e.arg, ctx),
        min: toOperand(e.low, ctx),
        max: toOperand(e.high, ctx),
      };
      return e.negated ? { op: 'not', operand: test } : test;
    }
    case 'field':
      return { op: 'eq', left: toOperand(e, ctx), right: { value: true } };
    case 'func': {
      const name = e.name.toLowerCase();
      if (name === 'is_empty' || name === 'isempty') {
        if (e.args.length !== 1) break;
        return isEmpty(toOperand(e.args[0]!, ctx));
      }
      if (name === 'if' || name === 'iif') {
        if (e.args.length !== 3) break;
        const c = toCondition(e.args[0]!, ctx);
        return {
          op: 'or',
          operands: [
            { op: 'and', operands: [c, toCondition(e.args[1]!, ctx)] },
            { op: 'and', operands: [{ op: 'not', operand: c }, toCondition(e.args[2]!, ctx)] },
          ],
        };
      }
      return { op: 'eq', left: toOperand(e, ctx), right: { value: true } };
    }
    default:
      break;
  }
  throw new Unconvertible('it uses something the form rules do not support');
}

function isEmpty(o: Operand): Expression {
  return {
    op: 'or',
    operands: [
      { op: 'eq', left: o, right: { value: null } },
      { op: 'eq', left: o, right: { value: '' } },
    ],
  };
}

/** Expression functions the form rules have, by expression name. */
const BUILTIN: Record<string, string> = {
  lower: 'lower',
  upper: 'upper',
  trim: 'trim',
  length: 'len',
  abs: 'abs',
  round: 'round',
  floor: 'floor',
  ceil: 'ceil',
  ceiling: 'ceil',
  coalesce: 'coalesce',
  defaultvalue: 'coalesce',
  contains: 'contains',
  starts_with: 'starts_with',
  startswith: 'starts_with',
  ends_with: 'ends_with',
  endswith: 'ends_with',
  today: 'today',
  now: 'now',
  min: 'min_of',
  least: 'min_of',
  max: 'max_of',
  greatest: 'max_of',
};

/** A value inside a rule: a field, a literal or a function call. */
function toOperand(e: Expr, ctx: Ctx): Operand {
  switch (e.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return { value: e.value };
    case 'null':
      return { value: null };
    case 'unop':
      if (e.op === '-' && e.arg.kind === 'num') return { value: -e.arg.value };
      break;
    case 'field': {
      const q = ctx.byColumn.get(e.name.toLowerCase());
      if (!q) throw new Unconvertible(`it reads "${e.name}", which is not a field on this layer`);
      ctx.refs.add(e.name.toLowerCase());
      return { ref: q.id };
    }
    case 'func': {
      const builtin = BUILTIN[e.name.toLowerCase()];
      if (!builtin) throw new Unconvertible(`the form rules have no ${e.name}()`);
      return {
        call: builtin as Extract<Operand, { call: unknown }>['call'],
        args: e.args.map((a) => toOperand(a, ctx)),
      };
    }
    default:
      break;
  }
  throw new Unconvertible('it uses something the form rules do not support');
}

/** A calculated value: one arithmetic step, a join, a choice or a plain value. */
function toCalculation(e: Expr, ctx: Ctx): Expression {
  if (e.kind === 'binop') {
    const op = ({ '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' } as const)[
      e.op as '+' | '-' | '*' | '/'
    ];
    if (op) return { op, left: toOperand(e.left, ctx), right: toOperand(e.right, ctx) };
  }
  if (e.kind === 'func') {
    const name = e.name.toLowerCase();
    if (name === 'concat' || name === 'concatenate') {
      return { op: 'concat', operands: e.args.map((a) => toOperand(a, ctx)) };
    }
    if ((name === 'if' || name === 'iif') && e.args.length === 3) {
      return {
        op: 'if',
        condition: toCondition(e.args[0]!, ctx),
        then: toOperand(e.args[1]!, ctx),
        else: toOperand(e.args[2]!, ctx),
      };
    }
  }
  // A plain value: a choice whose two sides are the same.
  const v = toOperand(e, ctx);
  return { op: 'if', condition: TRUE, then: v, else: v };
}

function freshId(prefix: string, ctx: Ctx): string {
  let n = ctx.ids.size + 1;
  let id = `${prefix}_${n}`;
  while (ctx.ids.has(id) || ctx.byColumn.has(id)) {
    n += 1;
    id = `${prefix}_${n}`;
  }
  ctx.ids.add(id);
  return id;
}

/** Plain text from a text element that may hold simple HTML. */
function stripTags(s: string): string {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out.trim();
}
