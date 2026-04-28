/**
 * Form schema for the Data Collection workflow (#131).
 *
 * Two runtimes consume this schema:
 *
 *   - Survey runtime (form-first, Survey123 style): renders the
 *     full form to a respondent. Geometry capture is optional and
 *     declared by a geopoint/geotrace/geoshape question, if any.
 *   - Field runtime (map-first, Field Maps style): the respondent
 *     taps a layer on the map; the form bound to that layer opens
 *     pre-bound to the new feature's geometry. Question types are
 *     constrained to those compatible with the layer's column types.
 *
 * The two runtimes share this schema, the same designer (palette +
 * canvas + properties), the same conditional-visibility evaluator,
 * the same calculation evaluator, and the same validator. The only
 * differentiator is the entry point. See docs/editing-and-collection.md.
 *
 * Goals:
 *
 *   - JSON-serializable (lives on Item.data_json as form-item content
 *     and on Notification payloads when triggers fire).
 *   - Renderer-agnostic (no React, no MapLibre).
 *   - Stable + versioned: `schemaVersion` lets us evolve without
 *     breaking already-captured submissions.
 *   - Expression language is small and total: no eval(), no Function
 *     constructor. The same evaluator runs in the browser and on
 *     the server.
 *   - Future-friendly to layer binding: each question optionally
 *     declares `bindTo` (a column on a data_layer) so the Field
 *     runtime can map a submission straight into a feature row,
 *     while the Survey runtime can still treat the form as
 *     standalone (submissions land in a form_submission_collection).
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export type FormSchemaVersion = 1;
export const CURRENT_FORM_SCHEMA_VERSION: FormSchemaVersion = 1;

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

/**
 * Catalog of every question kind the runtimes know how to render.
 * The Field runtime (map-first) hides kinds that can't bind to a
 * given column type; see `compatibleColumnTypes` below.
 */
export const QUESTION_TYPES = [
  'text', // single-line free text
  'multiline', // multi-line free text (textarea)
  'number', // free decimal
  'integer', // whole number
  'boolean', // yes/no toggle
  'select-one', // radio buttons or dropdown (controlled by `appearance`)
  'select-many', // checkboxes
  'date', // calendar date
  'time', // wall-clock time
  'datetime', // calendar + clock
  'photo', // one or more image attachments
  'signature', // ink-on-canvas, stored as PNG
  'geopoint', // single lat/lon
  'geotrace', // polyline
  'geoshape', // polygon
  'rating', // 1-5 stars (or configurable max)
  'slider', // numeric range slider
  'calculated', // read-only, derived from `calculate` expression
  'note', // display-only static text (no value captured)
  'page', // page break (for paged surveys)
  'group', // logical grouping with optional repeat (see `repeat`)
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

/** Stable identifier for a question. Becomes the column name in the
 *  generated layer schema (Path B) or maps to an existing column
 *  (Path A) via `bindTo`. */
export type QuestionId = string;

export interface Choice {
  value: string;
  label: string;
  /** Optional pick_list item id when this choice is sourced from a
   *  reusable pick list. The designer can attach a pick_list item to
   *  populate `choices` automatically. */
  pickListId?: string;
}

/** Free-form short hint shown beneath the question. */
export type Hint = string;

/**
 * Layer-binding metadata. When present, the Field runtime maps the
 * captured value into the named column on the target data_layer.
 * The Survey runtime ignores this field; submissions go into a
 * form_submission_collection regardless.
 *
 * `column` is the on-disk column name (snake_case is the convention,
 * matching how the data_layer schema is stored). When omitted, the
 * Field runtime falls back to the question id.
 */
export interface BindTo {
  /** Layer key inside the multi-layer data_layer item; matches
   *  data_layer.layers[].key. Optional for single-layer data_layers. */
  layerKey?: string;
  /** Column name on the target table. Optional; when omitted the
   *  question id is used. */
  column?: string;
}

// ---------------------------------------------------------------------------
// Per-question shapes
// ---------------------------------------------------------------------------

interface QuestionBase {
  id: QuestionId;
  /** User-facing label. Shown above the input. */
  label: string;
  /** Optional secondary explanatory text. */
  hint?: Hint | undefined;
  /** When false, the runtime hides the question and clears its
   *  value before submit. Default true. */
  visible?: boolean | undefined;
  /** Conditional visibility -- evaluated against the in-progress
   *  response. When false, behaves like `visible: false`. */
  visibleIf?: Expression | undefined;
  /** Required when truthy. Required-if when an Expression. */
  required?: boolean | Expression | undefined;
  /** Custom validation expression. */
  constraint?: Expression | undefined;
  /** Error message shown when `constraint` fails. */
  message?: string | undefined;
  /** Read-only: the runtime renders a value but does not allow edits. */
  readOnly?: boolean | Expression | undefined;
  /** Layer binding (Field runtime only). */
  bindTo?: BindTo | undefined;
  /** Free-form per-question metadata. */
  meta?: Record<string, unknown> | undefined;
}

interface TextQuestion extends QuestionBase {
  type: 'text';
  placeholder?: string;
  /** UTF-16 code-unit cap (matches HTML maxLength). */
  maxLength?: number;
  /** Regex pattern (anchored automatically). */
  pattern?: string;
  /** When true, hides the input value (password-like). Submission
   *  payload is plaintext; this is purely a UI hint. */
  obscured?: boolean;
}

interface MultilineQuestion extends QuestionBase {
  type: 'multiline';
  placeholder?: string;
  maxLength?: number;
  /** Suggested rows. UI may grow as the user types. */
  rows?: number;
}

interface NumberQuestion extends QuestionBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  /** ISO 4217 currency code, when this is a money field. Renderer
   *  uses it for the prefix/suffix and to choose precision. */
  currency?: string;
  /** Show as `12,345.67` rather than `12345.67`. */
  thousandsSeparator?: boolean;
}

interface IntegerQuestion extends QuestionBase {
  type: 'integer';
  min?: number;
  max?: number;
}

interface BooleanQuestion extends QuestionBase {
  type: 'boolean';
  /** "Yes" / "No" by default; renderer can override. */
  trueLabel?: string;
  falseLabel?: string;
}

interface SelectOneQuestion extends QuestionBase {
  type: 'select-one';
  choices: Choice[];
  /** `radio` (default) or `dropdown`. */
  appearance?: 'radio' | 'dropdown';
  /** When set, choices come from this pick_list at runtime instead
   *  of the inline `choices` array. The inline `choices` may still
   *  be used as a designer-time preview. */
  pickListId?: string;
}

interface SelectManyQuestion extends QuestionBase {
  type: 'select-many';
  choices: Choice[];
  /** Minimum number of selected choices required. */
  minSelected?: number;
  /** Maximum allowed. */
  maxSelected?: number;
  pickListId?: string;
}

interface DateQuestion extends QuestionBase {
  type: 'date';
  /** ISO 8601 date or `today`. */
  min?: string;
  max?: string;
}

interface TimeQuestion extends QuestionBase {
  type: 'time';
  /** HH:mm 24-hour. */
  min?: string;
  max?: string;
}

interface DateTimeQuestion extends QuestionBase {
  type: 'datetime';
  /** ISO 8601 timestamp or `now`. */
  min?: string;
  max?: string;
}

interface PhotoQuestion extends QuestionBase {
  type: 'photo';
  /** Max number of attachments. Default 1. */
  maxCount?: number;
  /** Soft cap per file in bytes; renderer warns above this. */
  maxBytes?: number;
}

interface SignatureQuestion extends QuestionBase {
  type: 'signature';
}

interface GeoPointQuestion extends QuestionBase {
  type: 'geopoint';
  /** Capture mode hints. The runtime picks the strategy:
   *  - `auto`: prefer GPS, fall back to map-pick.
   *  - `gps`: GPS only.
   *  - `map`: tap-on-map only.
   *  - `manual`: lat/lon text inputs only. */
  capture?: 'auto' | 'gps' | 'map' | 'manual';
}

interface GeoTraceQuestion extends QuestionBase {
  type: 'geotrace';
}

interface GeoShapeQuestion extends QuestionBase {
  type: 'geoshape';
}

interface RatingQuestion extends QuestionBase {
  type: 'rating';
  /** Number of icons (default 5). */
  max?: number;
  /** UI hint: `star` | `heart` | `thumb`. */
  shape?: 'star' | 'heart' | 'thumb';
}

interface SliderQuestion extends QuestionBase {
  type: 'slider';
  min: number;
  max: number;
  step?: number;
  showValue?: boolean;
}

interface CalculatedQuestion extends QuestionBase {
  type: 'calculated';
  /** Expression that produces this question's value at runtime.
   *  Re-evaluated whenever a referenced field changes. */
  calculate: Expression;
  /** Display format hint: `text` (default) | `number` | `date`. */
  format?: 'text' | 'number' | 'date';
}

interface NoteQuestion extends QuestionBase {
  type: 'note';
  /** Render as plain or markdown-lite (bold, italic, links). */
  appearance?: 'plain' | 'markdown';
}

interface PageQuestion extends QuestionBase {
  type: 'page';
  /** Page header text (overrides `label` when present). */
  title?: string;
}

interface GroupQuestion extends QuestionBase {
  type: 'group';
  /** When `repeat` is set, this is a repeating group: the user
   *  captures multiple instances of the inner questions. The Field
   *  runtime maps repeating groups to a related child layer. */
  repeat?:
    | {
        /** Min / max instance count. */
        min?: number | undefined;
        max?: number | undefined;
        /** UI label per added instance ("Add another inspection"). */
        addLabel?: string | undefined;
      }
    | undefined;
  /** Child questions. Pages/groups can nest. */
  children: Question[];
}

export type Question =
  | TextQuestion
  | MultilineQuestion
  | NumberQuestion
  | IntegerQuestion
  | BooleanQuestion
  | SelectOneQuestion
  | SelectManyQuestion
  | DateQuestion
  | TimeQuestion
  | DateTimeQuestion
  | PhotoQuestion
  | SignatureQuestion
  | GeoPointQuestion
  | GeoTraceQuestion
  | GeoShapeQuestion
  | RatingQuestion
  | SliderQuestion
  | CalculatedQuestion
  | NoteQuestion
  | PageQuestion
  | GroupQuestion;

// ---------------------------------------------------------------------------
// Top-level form
// ---------------------------------------------------------------------------

export interface FormSchema {
  schemaVersion: FormSchemaVersion;
  /** Matches the `form` item id this schema lives on. */
  id: string;
  title: string;
  description?: string;
  /** Linear list of questions; pages/groups nest inside. The runtime
   *  walks this in order. */
  questions: Question[];
  /** Optional default geometry binding for the Field runtime. When
   *  present, the layer's geometry column is filled from this question
   *  rather than from a separate `geopoint` capture flow. */
  geometryQuestionId?: QuestionId;
  /** Designer metadata (palette state, last-edit timestamps) the
   *  runtime ignores. */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Expression language
// ---------------------------------------------------------------------------

/**
 * Tiny expression DSL used for visibility, validation, calculations,
 * and required-if. JSON-serializable; no eval, no Function. The same
 * evaluator runs on the browser and the server -- by design, we have
 * one source of truth for "did this submission validate".
 *
 * Operands:
 *   - { ref: 'questionId' }            value of another question
 *   - { value: 42 | 'x' | true | null} literal
 *   - { call: 'today' }                zero-arg builtin
 *   - { call: 'len', args: [...] }     n-arg builtin
 *
 * Operators support short-circuiting via `and` / `or`.
 */
export type Expression =
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; left: Operand; right: Operand }
  | { op: 'and' | 'or'; operands: Expression[] }
  | { op: 'not'; operand: Expression }
  | { op: 'in'; left: Operand; right: Operand }
  | { op: 'between'; value: Operand; min: Operand; max: Operand }
  | {
      op: 'add' | 'sub' | 'mul' | 'div';
      left: Operand;
      right: Operand;
    }
  | { op: 'concat'; operands: Operand[] }
  | { op: 'if'; condition: Expression; then: Operand; else: Operand };

export type Operand =
  | { ref: QuestionId }
  | { value: string | number | boolean | null }
  | { call: BuiltinName; args?: Operand[] };

/** Whitelist of builtins the evaluator knows. Extend deliberately:
 *  every entry here ships in both the browser and the server. */
export const BUILTINS = [
  'today', // current date as YYYY-MM-DD string
  'now', // current ISO datetime string
  'len', // string length
  'sum', // numeric sum of a list of refs/values
  'count', // count of selected choices in a select-many
  'coalesce', // first non-null
  'lower',
  'upper',
] as const;
export type BuiltinName = (typeof BUILTINS)[number];

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Map of `questionId -> currently captured value`. */
export type Response = Record<string, unknown>;

/**
 * Evaluate an Expression against the in-progress response. Returns
 * any JSON-serialisable value. Throws on malformed schemas (mainly
 * for tests / designer validation).
 */
export function evaluate(expr: Expression | undefined, response: Response): unknown {
  if (!expr) return null;
  switch (expr.op) {
    case 'eq':
      return resolve(expr.left, response) === resolve(expr.right, response);
    case 'neq':
      return resolve(expr.left, response) !== resolve(expr.right, response);
    case 'gt':
      return cmp(expr.left, expr.right, response) > 0;
    case 'gte':
      return cmp(expr.left, expr.right, response) >= 0;
    case 'lt':
      return cmp(expr.left, expr.right, response) < 0;
    case 'lte':
      return cmp(expr.left, expr.right, response) <= 0;
    case 'and':
      return expr.operands.every((e) => Boolean(evaluate(e, response)));
    case 'or':
      return expr.operands.some((e) => Boolean(evaluate(e, response)));
    case 'not':
      return !evaluate(expr.operand, response);
    case 'in': {
      const haystack = resolve(expr.right, response);
      const needle = resolve(expr.left, response);
      if (Array.isArray(haystack)) return haystack.includes(needle);
      if (typeof haystack === 'string' && typeof needle === 'string') {
        return haystack.includes(needle);
      }
      return false;
    }
    case 'between': {
      const v = numericResolve(expr.value, response);
      const lo = numericResolve(expr.min, response);
      const hi = numericResolve(expr.max, response);
      if (v === null || lo === null || hi === null) return false;
      return v >= lo && v <= hi;
    }
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const a = numericResolve(expr.left, response);
      const b = numericResolve(expr.right, response);
      if (a === null || b === null) return null;
      switch (expr.op) {
        case 'add':
          return a + b;
        case 'sub':
          return a - b;
        case 'mul':
          return a * b;
        case 'div':
          return b === 0 ? null : a / b;
      }
      return null;
    }
    case 'concat':
      return expr.operands
        .map((o) => {
          const v = resolve(o, response);
          return v === null || v === undefined ? '' : String(v);
        })
        .join('');
    case 'if':
      return evaluate(expr.condition, response)
        ? resolve(expr.then, response)
        : resolve(expr.else, response);
  }
}

function resolve(operand: Operand, response: Response): unknown {
  if ('value' in operand) return operand.value;
  if ('ref' in operand) return response[operand.ref] ?? null;
  // builtin call
  return callBuiltin(operand.call, operand.args ?? [], response);
}

function numericResolve(operand: Operand, response: Response): number | null {
  const v = resolve(operand, response);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cmp(left: Operand, right: Operand, response: Response): number {
  const a = resolve(left, response);
  const b = resolve(right, response);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // String compare for everything else (dates compare correctly as
  // ISO strings).
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function callBuiltin(
  name: BuiltinName,
  args: Operand[],
  response: Response,
): unknown {
  switch (name) {
    case 'today': {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
    case 'now':
      return new Date().toISOString();
    case 'len': {
      const v = args[0] ? resolve(args[0], response) : null;
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      return 0;
    }
    case 'sum': {
      let total = 0;
      for (const a of args) {
        const v = numericResolve(a, response);
        if (v !== null) total += v;
      }
      return total;
    }
    case 'count': {
      const v = args[0] ? resolve(args[0], response) : null;
      return Array.isArray(v) ? v.length : 0;
    }
    case 'coalesce': {
      for (const a of args) {
        const v = resolve(a, response);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    }
    case 'lower': {
      const v = args[0] ? resolve(args[0], response) : null;
      return typeof v === 'string' ? v.toLowerCase() : v;
    }
    case 'upper': {
      const v = args[0] ? resolve(args[0], response) : null;
      return typeof v === 'string' ? v.toUpperCase() : v;
    }
  }
}

// ---------------------------------------------------------------------------
// Walker / utilities
// ---------------------------------------------------------------------------

/**
 * Iterate every question in the schema, walking into pages/groups.
 * Used by the designer (palette dragdrop), the runtime (visibility
 * resolution), and the validator.
 */
export function* walkQuestions(form: FormSchema): Iterable<Question> {
  yield* walkList(form.questions);
}

function* walkList(qs: Question[]): Iterable<Question> {
  for (const q of qs) {
    yield q;
    if (q.type === 'group') yield* walkList(q.children);
  }
}

/** Lookup by id; O(n) but n is small in practice. */
export function findQuestion(
  form: FormSchema,
  id: QuestionId,
): Question | undefined {
  for (const q of walkQuestions(form)) if (q.id === id) return q;
  return undefined;
}

/**
 * Compatible question types per data_layer column type. The Field
 * runtime uses this to filter the palette when binding to an
 * existing layer column. Returns the empty set if the column type
 * is unknown to us.
 */
export function compatibleQuestionTypes(
  columnType: string,
): readonly QuestionType[] {
  const t = columnType.toLowerCase();
  if (/text|varchar|char/.test(t)) return ['text', 'multiline', 'select-one'];
  if (/int|smallint|bigint/.test(t)) return ['integer', 'rating', 'slider', 'select-one'];
  if (/numeric|float|double|real|decimal/.test(t)) {
    return ['number', 'slider'];
  }
  if (/bool/.test(t)) return ['boolean'];
  if (t.includes('date') && t.includes('time')) return ['datetime'];
  if (t.includes('time')) return ['time'];
  if (t.includes('date')) return ['date'];
  if (/geometry|geography|point/.test(t)) {
    if (/point/.test(t)) return ['geopoint'];
    if (/line/.test(t)) return ['geotrace'];
    if (/polygon/.test(t)) return ['geoshape'];
    return ['geopoint', 'geotrace', 'geoshape'];
  }
  if (/json/.test(t)) return ['select-many', 'multiline'];
  return [];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface ValidationError {
  questionId: QuestionId;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/**
 * Validate a response against the schema. Honors visibility (hidden
 * fields are not validated), required (incl. required-if), constraint
 * expressions, and per-type bounds (min/max length, min/max value,
 * min/max selected, etc).
 */
export function validate(form: FormSchema, response: Response): ValidationResult {
  const errors: ValidationError[] = [];
  for (const q of walkQuestions(form)) {
    if (q.type === 'page' || q.type === 'note' || q.type === 'group') continue;
    if (!isVisible(q, response)) continue;

    const value = response[q.id];
    if (isRequired(q, response) && isEmpty(value)) {
      errors.push({ questionId: q.id, message: 'This field is required.' });
      continue;
    }
    if (isEmpty(value)) continue; // nothing more to validate when blank + optional

    const typeError = validateType(q, value);
    if (typeError) {
      errors.push({ questionId: q.id, message: typeError });
      continue;
    }

    if (q.constraint) {
      const ok = evaluate(q.constraint, response);
      if (!ok) {
        errors.push({
          questionId: q.id,
          message: q.message ?? 'Value is not valid.',
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function isVisible(q: Question, response: Response): boolean {
  if (q.visible === false) return false;
  if (!q.visibleIf) return true;
  return Boolean(evaluate(q.visibleIf, response));
}

export function isRequired(q: Question, response: Response): boolean {
  if (q.required === undefined) return false;
  if (typeof q.required === 'boolean') return q.required;
  return Boolean(evaluate(q.required, response));
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function validateType(q: Question, value: unknown): string | null {
  switch (q.type) {
    case 'text':
    case 'multiline': {
      if (typeof value !== 'string') return 'Expected text.';
      if (q.maxLength && value.length > q.maxLength) {
        return `Must be ${q.maxLength} characters or fewer.`;
      }
      if (q.type === 'text' && q.pattern) {
        const re = new RegExp(`^(?:${q.pattern})$`);
        if (!re.test(value)) return 'Does not match the required format.';
      }
      return null;
    }
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return 'Expected a number.';
      if (q.type === 'integer' && !Number.isInteger(n)) {
        return 'Expected a whole number.';
      }
      if (q.min !== undefined && n < q.min) return `Must be at least ${q.min}.`;
      if (q.max !== undefined && n > q.max) return `Must be at most ${q.max}.`;
      return null;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return 'Expected yes or no.';
      return null;
    case 'select-one':
      if (typeof value !== 'string') return 'Pick one option.';
      return null;
    case 'select-many': {
      if (!Array.isArray(value)) return 'Pick from the options.';
      if (q.minSelected !== undefined && value.length < q.minSelected) {
        return `Pick at least ${q.minSelected}.`;
      }
      if (q.maxSelected !== undefined && value.length > q.maxSelected) {
        return `Pick at most ${q.maxSelected}.`;
      }
      return null;
    }
    case 'date':
    case 'time':
    case 'datetime':
      if (typeof value !== 'string') return 'Expected a valid value.';
      return null;
    case 'photo':
      if (!Array.isArray(value)) return 'Expected one or more attachments.';
      if (q.maxCount !== undefined && value.length > q.maxCount) {
        return `Up to ${q.maxCount} attachments allowed.`;
      }
      return null;
    case 'signature':
    case 'geopoint':
    case 'geotrace':
    case 'geoshape':
    case 'rating':
    case 'slider':
    case 'calculated':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers used by the runtime to compute derived values
// ---------------------------------------------------------------------------

/**
 * For every `calculated` question whose dependencies have changed,
 * recompute its value and write it into the response. Returns the
 * mutated response (callers can rely on identity equality when
 * nothing changed).
 */
export function applyCalculations(
  form: FormSchema,
  response: Response,
): Response {
  let next = response;
  let changed = false;
  for (const q of walkQuestions(form)) {
    if (q.type !== 'calculated') continue;
    const computed = evaluate(q.calculate, response);
    if (next[q.id] !== computed) {
      if (!changed) {
        next = { ...response };
        changed = true;
      }
      next[q.id] = computed;
    }
  }
  return next;
}

/**
 * Strip values for hidden fields so submissions don't leak data the
 * respondent never confirmed. Called by the runtime before submit.
 */
export function pruneHidden(form: FormSchema, response: Response): Response {
  const out: Response = {};
  for (const q of walkQuestions(form)) {
    if (q.type === 'page' || q.type === 'note' || q.type === 'group') continue;
    if (!isVisible(q, response)) continue;
    if (q.id in response) out[q.id] = response[q.id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Designer helpers (used by the form builder UI)
// ---------------------------------------------------------------------------

/** Generate a fresh, empty FormSchema bound to a given form item id. */
export function emptyForm(id: string, title = 'Untitled form'): FormSchema {
  return {
    schemaVersion: CURRENT_FORM_SCHEMA_VERSION,
    id,
    title,
    questions: [],
  };
}

/** Default question shape per type. The designer drops one of these
 *  into the canvas when the user drags a palette item. */
export function defaultQuestion(type: QuestionType, id: QuestionId): Question {
  const base = { id, label: defaultLabel(type) };
  switch (type) {
    case 'text':
      return { ...base, type };
    case 'multiline':
      return { ...base, type, rows: 3 };
    case 'number':
      return { ...base, type };
    case 'integer':
      return { ...base, type };
    case 'boolean':
      return { ...base, type };
    case 'select-one':
      return {
        ...base,
        type,
        appearance: 'radio',
        choices: [
          { value: 'option_1', label: 'Option 1' },
          { value: 'option_2', label: 'Option 2' },
        ],
      };
    case 'select-many':
      return {
        ...base,
        type,
        choices: [
          { value: 'option_1', label: 'Option 1' },
          { value: 'option_2', label: 'Option 2' },
        ],
      };
    case 'date':
      return { ...base, type };
    case 'time':
      return { ...base, type };
    case 'datetime':
      return { ...base, type };
    case 'photo':
      return { ...base, type, maxCount: 1 };
    case 'signature':
      return { ...base, type };
    case 'geopoint':
      return { ...base, type, capture: 'auto' };
    case 'geotrace':
      return { ...base, type };
    case 'geoshape':
      return { ...base, type };
    case 'rating':
      return { ...base, type, max: 5, shape: 'star' };
    case 'slider':
      return { ...base, type, min: 0, max: 100, step: 1, showValue: true };
    case 'calculated':
      // Trivial pass-through expression so the field has a valid
      // calculate that never errors. The designer prompts the user
      // to wire in real refs.
      return {
        ...base,
        type,
        calculate: { op: 'concat', operands: [{ value: '' }] },
      };
    case 'note':
      return { ...base, type, appearance: 'plain' };
    case 'page':
      return { ...base, type, label: 'Page break' };
    case 'group':
      return { ...base, type, children: [] };
  }
}

function defaultLabel(type: QuestionType): string {
  return (
    {
      text: 'Short text',
      multiline: 'Long text',
      number: 'Number',
      integer: 'Whole number',
      boolean: 'Yes / No',
      'select-one': 'Single choice',
      'select-many': 'Multiple choice',
      date: 'Date',
      time: 'Time',
      datetime: 'Date and time',
      photo: 'Photo',
      signature: 'Signature',
      geopoint: 'Location (point)',
      geotrace: 'Path (polyline)',
      geoshape: 'Area (polygon)',
      rating: 'Rating',
      slider: 'Slider',
      calculated: 'Calculated',
      note: 'Note',
      page: 'New page',
      group: 'Group',
    } satisfies Record<QuestionType, string>
  )[type];
}

/**
 * Generate a unique question id from a label. Lowercase, snake_case,
 * truncated to 40 chars. Not a strict slugifier; the designer
 * deduplicates on save.
 */
export function suggestQuestionId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return base || 'question';
}

/**
 * Walk the schema and return a Set of all question ids in use, so
 * the designer can avoid id collisions when adding new questions.
 */
export function collectIds(form: FormSchema): Set<string> {
  const ids = new Set<string>();
  for (const q of walkQuestions(form)) ids.add(q.id);
  return ids;
}

/** Ensure a candidate id is unique; appends `_2`, `_3`, ... as needed. */
export function uniqueQuestionId(form: FormSchema, candidate: string): string {
  const existing = collectIds(form);
  if (!existing.has(candidate)) return candidate;
  let i = 2;
  while (existing.has(`${candidate}_${i}`)) i += 1;
  return `${candidate}_${i}`;
}
