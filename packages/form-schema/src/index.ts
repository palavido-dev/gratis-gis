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
  'email', // text + email validation + email keyboard
  'url', // text + URL validation + URL keyboard
  'phone', // text + tel keyboard + light phone validation
  'regex', // text + author-supplied regex pattern
  'number', // free decimal
  'integer', // whole number
  'boolean', // yes/no toggle
  'select-one', // radio buttons or dropdown (controlled by `appearance`)
  'select-many', // checkboxes
  'matrix-single', // grid: rows of statements, one choice per row
  'matrix-multi', // grid: rows of statements, multi choice per row
  'matrix-dropdown', // grid: per-column dropdown choices
  'matrix-rating', // grid: rating-per-row (stars / hearts / thumbs)
  'ranking', // ordered list (drag or arrows to reorder)
  'date', // calendar date
  'time', // wall-clock time
  'datetime', // calendar + clock
  'name', // composite person name (first / middle / last / suffix / prefix)
  'address', // composite postal address
  'photo', // one or more image attachments
  'image-choice', // single/multi choice where each option is an image
  'image-display', // display-only image embed (no value captured)
  'image-hotspot', // click point(s) on a reference image
  'signature', // ink-on-canvas, stored as PNG
  'geopoint', // single lat/lon
  'geotrace', // polyline
  'geoshape', // polygon
  'rating', // 1-5 stars (or configurable max)
  'likert', // single-row Likert (Strongly disagree -> Strongly agree)
  'nps', // Net Promoter Score (0..10 buttons)
  'slider', // numeric range slider
  'calculated', // read-only, derived from `calculate` expression
  'note', // display-only static text (no value captured)
  'divider', // thin visual separator with optional caption
  'acknowledge', // display long-form text + required "I agree" checkbox
  'hidden', // not rendered; value via prefill / calculate
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

/**
 * Per-question layout hint. The runtime uses this to flow questions
 * side-by-side instead of one-per-row. Sequential questions whose
 * widths sum to <= 1 sit on the same visual row; the next question
 * past 1 wraps to a new row. `full` always starts a new row.
 *
 * Mobile collapses everything to full-width below ~640px so users
 * never have to operate cramped half-width inputs on a phone.
 */
export type QuestionWidth =
  | 'full'
  | 'half'
  | 'third'
  | 'two-thirds'
  | 'quarter'
  | 'three-quarters';

export interface QuestionLayout {
  /** Width within the form column. Default: 'full'. */
  width?: QuestionWidth | undefined;
}

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
  /** Per-question layout (width within the form column). */
  layout?: QuestionLayout | undefined;
  /** Free-form per-question metadata. */
  meta?: Record<string, unknown> | undefined;
}

/** Numeric fraction (0-1) for a width. Used by the runtime to
 *  pack questions and by helpers that compute row breaks. */
export const WIDTH_FRACTION: Record<QuestionWidth, number> = {
  full: 1,
  half: 1 / 2,
  third: 1 / 3,
  'two-thirds': 2 / 3,
  quarter: 1 / 4,
  'three-quarters': 3 / 4,
};

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

interface EmailQuestion extends QuestionBase {
  type: 'email';
  placeholder?: string;
  maxLength?: number;
}

interface UrlQuestion extends QuestionBase {
  type: 'url';
  placeholder?: string;
  maxLength?: number;
  /** Restrict to specific protocols, e.g. ['http', 'https']. When
   *  omitted any URL.parse-able value is accepted. */
  allowedProtocols?: string[];
}

interface PhoneQuestion extends QuestionBase {
  type: 'phone';
  placeholder?: string;
  /** ISO 3166 country hint for the renderer (used to default the
   *  country code prefix). Validation stays light: digits + a few
   *  punctuation chars + length sanity check. */
  defaultCountry?: string;
}

interface RegexQuestion extends QuestionBase {
  type: 'regex';
  placeholder?: string;
  /** Author-supplied regex pattern. The runtime anchors it when
   *  validating (^...$). Required for a useful regex question. */
  pattern: string;
  /** Optional flags ("i", "u", etc.). The runtime defaults to no
   *  flags. */
  flags?: string;
  maxLength?: number;
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

/**
 * A row in a matrix question. Rows are stable: the row `id` is the
 * key used in the Response, so renaming a row label is safe but
 * deleting and re-adding a row loses any captured value.
 */
export interface MatrixRow {
  id: string;
  label: string;
}

/**
 * A column in a matrix question. For `matrix-single` and `matrix-multi`
 * every column shares the same set of choices (the columns ARE the
 * choices). The `value` is what's stored in the Response.
 */
export interface MatrixColumn {
  value: string;
  label: string;
}

/**
 * Matrix with one selectable column per row (radio grid).
 *
 * Response shape: `Record<rowId, columnValue | null>` -- a flat object
 * keyed by row id, with the chosen column's `value` as the value.
 * Rows the respondent never touched are simply absent.
 */
interface MatrixSingleQuestion extends QuestionBase {
  type: 'matrix-single';
  rows: MatrixRow[];
  columns: MatrixColumn[];
  /** When set, rows are sourced from a pick list at runtime; the
   *  inline `rows` may still be used as a designer-time preview. */
  rowsPickListId?: string;
  /** When true, every row counts toward `required`. When false (the
   *  default), the question's `required` flag means "at least one
   *  row has a value". */
  perRowRequired?: boolean;
}

/**
 * Matrix with one or many selectable columns per row (checkbox grid).
 *
 * Response shape: `Record<rowId, columnValue[]>` -- a flat object
 * keyed by row id, with the array of chosen column values. Rows the
 * respondent never touched are absent.
 */
interface MatrixMultiQuestion extends QuestionBase {
  type: 'matrix-multi';
  rows: MatrixRow[];
  columns: MatrixColumn[];
  rowsPickListId?: string;
  /** Minimum selected columns per row. */
  perRowMinSelected?: number;
  /** Maximum selected columns per row. */
  perRowMaxSelected?: number;
}

/**
 * A column in a `matrix-dropdown` question -- carries its own
 * `choices` list, so each column can be a different dropdown
 * (e.g. "Current state" with one choice set, "Target state" with
 * another).
 */
export interface MatrixDropdownColumn {
  value: string;
  label: string;
  choices: Choice[];
}

/**
 * Matrix where each cell is a per-column dropdown. Useful when the
 * columns aren't parallel choices (the matrix-single / matrix-multi
 * case) but instead are different facets of each row that the
 * respondent answers from different lists.
 *
 * Response shape:
 *   Record<rowId, Record<columnValue, choiceValue | null>>
 */
interface MatrixDropdownQuestion extends QuestionBase {
  type: 'matrix-dropdown';
  rows: MatrixRow[];
  columns: MatrixDropdownColumn[];
  rowsPickListId?: string;
}

/**
 * Matrix where each row gets the same rating widget (stars / hearts
 * / thumbs). Quick way to score a list of items on a shared scale.
 *
 * Response shape: Record<rowId, number> (1..max).
 */
interface MatrixRatingQuestion extends QuestionBase {
  type: 'matrix-rating';
  rows: MatrixRow[];
  rowsPickListId?: string;
  /** Number of icons. Default 5. */
  max?: number;
  /** Icon shape. */
  shape?: 'star' | 'heart' | 'thumb';
  /** When true, every row counts toward `required`. */
  perRowRequired?: boolean;
}

/**
 * Ranking: the respondent orders the choices into a preferred
 * sequence by dragging or by tapping up / down. The Response is an
 * ordered array of choice values.
 *
 * Response shape: string[] -- the values of the choices in the
 * order the respondent placed them.
 */
interface RankingQuestion extends QuestionBase {
  type: 'ranking';
  choices: Choice[];
  pickListId?: string;
  /** Minimum number of choices that must be ranked. Default: all. */
  minRanked?: number;
  /** Maximum number of choices the respondent can rank. Useful for
   *  "rank your top 3" prompts -- defaults to all. */
  maxRanked?: number;
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

/** Components a `name` question can request. The renderer hides
 *  components not in this set (or all six when omitted). */
export type NameComponent =
  | 'prefix'
  | 'first'
  | 'middle'
  | 'last'
  | 'suffix';

/**
 * Composite person name. Captures named subfields. Response shape:
 * `{ prefix?, first?, middle?, last?, suffix? }` -- all optional
 * strings. The form-level `required` flag means at least one of the
 * required components must be filled.
 */
interface NameQuestion extends QuestionBase {
  type: 'name';
  /** Which components to surface. Default: ['first', 'last']. */
  components?: NameComponent[];
  /** Required components. Defaults to ['first', 'last'] when the
   *  question is required. Hidden when the question is optional. */
  requiredComponents?: NameComponent[];
}

/** Components an `address` question can request. */
export type AddressComponent =
  | 'street1'
  | 'street2'
  | 'city'
  | 'region'
  | 'postal'
  | 'country';

/**
 * Composite postal address. Response shape:
 * `{ street1?, street2?, city?, region?, postal?, country? }` --
 * all optional strings. The renderer hides components not in
 * `components`.
 */
interface AddressQuestion extends QuestionBase {
  type: 'address';
  components?: AddressComponent[];
  requiredComponents?: AddressComponent[];
}

interface PhotoQuestion extends QuestionBase {
  type: 'photo';
  /** Max number of attachments. Default 1. */
  maxCount?: number;
  /** Soft cap per file in bytes; renderer warns above this. */
  maxBytes?: number;
}

/** A choice-with-image. Same shape as Choice plus an imageUrl that
 *  the runtime renders as the visual face of the option. */
export interface ImageChoice {
  value: string;
  label: string;
  imageUrl: string;
  /** Optional alternate text. Falls back to `label`. */
  alt?: string;
}

/**
 * Image-choice question: the options are images. Set `multi` to
 * allow more than one selection. Response shape:
 *   - multi=false: chosen value (string) or null
 *   - multi=true: chosen values (string[])
 */
interface ImageChoiceQuestion extends QuestionBase {
  type: 'image-choice';
  choices: ImageChoice[];
  /** Default false: behaves like select-one. */
  multi?: boolean;
  /** Per-row only meaningful for multi=true. */
  minSelected?: number;
  maxSelected?: number;
}

/**
 * Image-display question: a non-interactive image embed. No value
 * is captured. Useful for instructional content above a question.
 */
interface ImageDisplayQuestion extends QuestionBase {
  type: 'image-display';
  imageUrl: string;
  alt?: string;
  /** Optional caption shown below the image. */
  caption?: string;
}

/**
 * Image-hotspot: respondent clicks one or more points on a
 * reference image. Coordinates are captured as fractions of the
 * image's natural size (so the value is resolution-independent).
 *
 * Response shape: Array<{ x: number; y: number }> in [0..1].
 */
interface ImageHotspotQuestion extends QuestionBase {
  type: 'image-hotspot';
  imageUrl: string;
  alt?: string;
  /** Maximum number of points the respondent may place. Default 1. */
  maxPoints?: number;
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

/**
 * Single-row Likert scale. Today this is doable with `select-one`
 * plus careful labeling, but a first-class type lets the runtime
 * render a canonical horizontal scale and lets future analytics
 * treat the value as ordinal rather than categorical.
 *
 * Response: the index of the chosen point (1..points), or null.
 */
interface LikertQuestion extends QuestionBase {
  type: 'likert';
  /** Number of points. Common values: 5 or 7. Default 5. */
  points?: number;
  /** Label for the leftmost point. */
  leftLabel?: string;
  /** Label for the rightmost point. */
  rightLabel?: string;
  /** Optional middle label (shown above the centre point). */
  centerLabel?: string;
}

/**
 * Net Promoter Score: 0..10 buttons with the standard
 * Detractor / Passive / Promoter coloring. Captured as integer.
 */
interface NpsQuestion extends QuestionBase {
  type: 'nps';
  /** Optional caption above the scale (e.g. "How likely..."). */
  caption?: string;
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

/** A thin visual separator. No value captured. The optional
 *  `caption` is shown above the rule. */
interface DividerQuestion extends QuestionBase {
  type: 'divider';
  caption?: string;
}

/**
 * Long-form text plus a required acknowledgement checkbox. When the
 * respondent checks the box the runtime stamps an ISO timestamp so
 * the system has an audit trail of when consent was given.
 *
 * Response shape: `{ acknowledged: boolean, at?: string }`.
 */
interface AcknowledgeQuestion extends QuestionBase {
  type: 'acknowledge';
  /** Body text shown above the checkbox. Markdown-lite is rendered
   *  the same way as `note.appearance === 'markdown'`. */
  body: string;
  appearance?: 'plain' | 'markdown';
  /** Label next to the checkbox. Default: "I have read and agree". */
  agreeLabel?: string;
}

/**
 * Hidden field. Never rendered. Value comes from URL prefill, a
 * `calculated` expression, or some other surface (e.g. a campaign
 * tracking id seeded by the page). The runtime preserves the
 * captured value across submissions so analytics can stitch the
 * record together.
 */
interface HiddenQuestion extends QuestionBase {
  type: 'hidden';
  /** Default value. Used when no prefill or calculate hits. */
  defaultValue?: string | number | boolean | null;
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
  | EmailQuestion
  | UrlQuestion
  | PhoneQuestion
  | RegexQuestion
  | NumberQuestion
  | IntegerQuestion
  | BooleanQuestion
  | SelectOneQuestion
  | SelectManyQuestion
  | MatrixSingleQuestion
  | MatrixMultiQuestion
  | MatrixDropdownQuestion
  | MatrixRatingQuestion
  | RankingQuestion
  | DateQuestion
  | TimeQuestion
  | DateTimeQuestion
  | NameQuestion
  | AddressQuestion
  | PhotoQuestion
  | ImageChoiceQuestion
  | ImageDisplayQuestion
  | ImageHotspotQuestion
  | SignatureQuestion
  | GeoPointQuestion
  | GeoTraceQuestion
  | GeoShapeQuestion
  | RatingQuestion
  | LikertQuestion
  | NpsQuestion
  | SliderQuestion
  | CalculatedQuestion
  | NoteQuestion
  | DividerQuestion
  | AcknowledgeQuestion
  | HiddenQuestion
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
  /**
   * Form-level link to a data_layer item. When set, the form is
   * "bound" to that layer:
   *
   *   - Submissions land in the layer's feature table (Field runtime
   *     and any data_collection deployment that picks this form
   *     and the same target layer).
   *   - Designer shows per-question status against the layer's
   *     current schema (matched / new-column-on-save / orphaned).
   *   - Adding a question whose `bindTo.column` doesn't yet exist on
   *     the layer is allowed: it lands as an additive `addColumn`
   *     ALTER the first time a submission references it, per the
   *     schema-evolution policy in editing-and-collection.md.
   *
   * The optional `linkedLayerKey` picks one layer inside a multi-
   * layer data_layer item (single-layer layers omit it).
   */
  linkedLayerId?: string;
  linkedLayerKey?: string;
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
    if (
      q.type === 'page' ||
      q.type === 'note' ||
      q.type === 'group' ||
      q.type === 'divider' ||
      q.type === 'image-display'
    ) {
      continue;
    }
    if (!isVisible(q, response)) continue;

    const value = response[q.id];
    if (isRequired(q, response) && isEmpty(value)) {
      errors.push({ questionId: q.id, message: 'This field is required.' });
      continue;
    }
    // Matrix questions with perRowRequired enforce row-level checks
    // even when nothing is filled, so we let validateType run.
    const skipIfEmpty =
      !(q.type === 'matrix-single' && q.perRowRequired) &&
      !(q.type === 'matrix-multi' && q.perRowMinSelected) &&
      !(q.type === 'matrix-rating' && q.perRowRequired);
    if (isEmpty(value) && skipIfEmpty) continue;

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

/** Human label for a NameComponent. Exported because the runtime
 *  uses it for placeholders too. */
export function labelForNameComponent(c: NameComponent): string {
  switch (c) {
    case 'prefix':
      return 'Prefix';
    case 'first':
      return 'First name';
    case 'middle':
      return 'Middle name';
    case 'last':
      return 'Last name';
    case 'suffix':
      return 'Suffix';
  }
}

/** Human label for an AddressComponent. */
export function labelForAddressComponent(c: AddressComponent): string {
  switch (c) {
    case 'street1':
      return 'Street address';
    case 'street2':
      return 'Apt / suite';
    case 'city':
      return 'City';
    case 'region':
      return 'State / region';
    case 'postal':
      return 'Postal code';
    case 'country':
      return 'Country';
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  // Plain objects (matrix responses) are empty when no row has any
  // value. We treat null / '' / [] as "no value" recursively.
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return true;
    return entries.every(([, v]) => isEmpty(v));
  }
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
    case 'email': {
      if (typeof value !== 'string') return 'Expected text.';
      if (q.maxLength && value.length > q.maxLength) {
        return `Must be ${q.maxLength} characters or fewer.`;
      }
      // Pragmatic email check (RFC 5322 lite). We accept anything
      // with one @, a non-empty local part, and a domain that has at
      // least one dot. The full RFC grammar is famously over-broad
      // and rejects almost no real addresses; this catches typos.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'Enter a valid email address.';
      }
      return null;
    }
    case 'url': {
      if (typeof value !== 'string') return 'Expected text.';
      if (q.maxLength && value.length > q.maxLength) {
        return `Must be ${q.maxLength} characters or fewer.`;
      }
      let parsed: URL | null = null;
      try {
        parsed = new URL(value);
      } catch {
        return 'Enter a valid URL.';
      }
      if (q.allowedProtocols && q.allowedProtocols.length > 0) {
        const proto = parsed.protocol.replace(/:$/, '');
        if (!q.allowedProtocols.includes(proto)) {
          return `URL must use ${q.allowedProtocols.join(' or ')}.`;
        }
      }
      return null;
    }
    case 'phone': {
      if (typeof value !== 'string') return 'Expected text.';
      // Strip allowed punctuation; what's left should be digits with
      // optional leading +. Length sanity: 7..16 digits is the
      // ITU-T E.164 envelope minus a small slack for short codes.
      const cleaned = value.replace(/[\s().-]/g, '');
      if (!/^\+?\d{7,16}$/.test(cleaned)) {
        return 'Enter a valid phone number.';
      }
      return null;
    }
    case 'regex': {
      if (typeof value !== 'string') return 'Expected text.';
      if (q.maxLength && value.length > q.maxLength) {
        return `Must be ${q.maxLength} characters or fewer.`;
      }
      let re: RegExp;
      try {
        re = new RegExp(`^(?:${q.pattern})$`, q.flags ?? '');
      } catch {
        // A bad pattern is a designer error; pass validation rather
        // than block the respondent on something they can't fix.
        return null;
      }
      if (!re.test(value)) return q.message ?? 'Does not match the required format.';
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
    case 'matrix-single': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected one choice per row.';
      }
      const map = value as Record<string, unknown>;
      const validValues = new Set(q.columns.map((c) => c.value));
      for (const row of q.rows) {
        const v = map[row.id];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || !validValues.has(v)) {
          return `Row "${row.label}" has an unrecognized value.`;
        }
      }
      // Per-row required: every row must have a non-empty selection.
      if (q.perRowRequired) {
        for (const row of q.rows) {
          const v = map[row.id];
          if (v === undefined || v === null || v === '') {
            return `Row "${row.label}" is required.`;
          }
        }
      }
      return null;
    }
    case 'matrix-multi': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected selections per row.';
      }
      const map = value as Record<string, unknown>;
      const validValues = new Set(q.columns.map((c) => c.value));
      for (const row of q.rows) {
        const v = map[row.id];
        if (v === undefined || v === null) continue;
        if (!Array.isArray(v)) {
          return `Row "${row.label}" has an unexpected value.`;
        }
        for (const x of v) {
          if (typeof x !== 'string' || !validValues.has(x)) {
            return `Row "${row.label}" has an unrecognized value.`;
          }
        }
        if (
          q.perRowMinSelected !== undefined &&
          v.length < q.perRowMinSelected
        ) {
          return `Row "${row.label}": pick at least ${q.perRowMinSelected}.`;
        }
        if (
          q.perRowMaxSelected !== undefined &&
          v.length > q.perRowMaxSelected
        ) {
          return `Row "${row.label}": pick at most ${q.perRowMaxSelected}.`;
        }
      }
      return null;
    }
    case 'matrix-dropdown': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected selections per row.';
      }
      const map = value as Record<string, unknown>;
      const colMap = new Map(q.columns.map((c) => [c.value, c]));
      for (const row of q.rows) {
        const cells = map[row.id];
        if (cells === undefined || cells === null) continue;
        if (
          typeof cells !== 'object' ||
          Array.isArray(cells)
        ) {
          return `Row "${row.label}" has an unexpected value.`;
        }
        for (const [colValue, choice] of Object.entries(
          cells as Record<string, unknown>,
        )) {
          if (choice === null || choice === undefined || choice === '') continue;
          const col = colMap.get(colValue);
          if (!col) {
            return `Row "${row.label}": unknown column "${colValue}".`;
          }
          const validChoices = new Set(col.choices.map((c) => c.value));
          if (typeof choice !== 'string' || !validChoices.has(choice)) {
            return `Row "${row.label}", column "${col.label}" has an unrecognized choice.`;
          }
        }
      }
      return null;
    }
    case 'matrix-rating': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected a rating per row.';
      }
      const map = value as Record<string, unknown>;
      const max = q.max ?? 5;
      for (const row of q.rows) {
        const v = map[row.id];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
          return `Row "${row.label}" has an unexpected rating.`;
        }
      }
      if (q.perRowRequired) {
        for (const row of q.rows) {
          const v = map[row.id];
          if (v === undefined || v === null || v === '') {
            return `Row "${row.label}" is required.`;
          }
        }
      }
      return null;
    }
    case 'ranking': {
      if (!Array.isArray(value)) return 'Expected an ordered list.';
      const validValues = new Set(q.choices.map((c) => c.value));
      const seen = new Set<string>();
      for (const v of value) {
        if (typeof v !== 'string' || !validValues.has(v)) {
          return 'List contains an unrecognized choice.';
        }
        if (seen.has(v)) return 'List contains a duplicate choice.';
        seen.add(v);
      }
      const min = q.minRanked ?? 0;
      const max = q.maxRanked ?? q.choices.length;
      if (value.length < min) return `Rank at least ${min}.`;
      if (value.length > max) return `Rank at most ${max}.`;
      return null;
    }
    case 'date':
    case 'time':
    case 'datetime':
      if (typeof value !== 'string') return 'Expected a valid value.';
      return null;
    case 'name': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected a name object.';
      }
      const map = value as Record<string, unknown>;
      const reqd = q.requiredComponents ?? (q.required ? ['first', 'last'] : []);
      for (const c of reqd) {
        const v = map[c];
        if (typeof v !== 'string' || v.trim() === '') {
          return `${labelForNameComponent(c)} is required.`;
        }
      }
      return null;
    }
    case 'address': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Expected an address object.';
      }
      const map = value as Record<string, unknown>;
      const reqd = q.requiredComponents ?? [];
      for (const c of reqd) {
        const v = map[c];
        if (typeof v !== 'string' || v.trim() === '') {
          return `${labelForAddressComponent(c)} is required.`;
        }
      }
      return null;
    }
    case 'photo':
      if (!Array.isArray(value)) return 'Expected one or more attachments.';
      if (q.maxCount !== undefined && value.length > q.maxCount) {
        return `Up to ${q.maxCount} attachments allowed.`;
      }
      return null;
    case 'image-choice': {
      const validValues = new Set(q.choices.map((c) => c.value));
      if (q.multi) {
        if (!Array.isArray(value)) return 'Pick one or more options.';
        for (const v of value) {
          if (typeof v !== 'string' || !validValues.has(v)) {
            return 'Selection contains an unrecognized option.';
          }
        }
        if (q.minSelected !== undefined && value.length < q.minSelected) {
          return `Pick at least ${q.minSelected}.`;
        }
        if (q.maxSelected !== undefined && value.length > q.maxSelected) {
          return `Pick at most ${q.maxSelected}.`;
        }
      } else {
        if (typeof value !== 'string' || !validValues.has(value)) {
          return 'Pick one option.';
        }
      }
      return null;
    }
    case 'image-display':
      // Display-only: no captured value to validate.
      return null;
    case 'acknowledge': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'Please acknowledge to continue.';
      }
      const v = (value as { acknowledged?: unknown }).acknowledged;
      if (v !== true) return 'Please acknowledge to continue.';
      return null;
    }
    case 'hidden':
      return null;
    case 'image-hotspot': {
      if (!Array.isArray(value)) return 'Expected one or more points.';
      const max = q.maxPoints ?? 1;
      if (value.length > max) return `Up to ${max} points allowed.`;
      for (const p of value) {
        if (
          typeof p !== 'object' ||
          p === null ||
          typeof (p as { x: unknown }).x !== 'number' ||
          typeof (p as { y: unknown }).y !== 'number'
        ) {
          return 'Point format is invalid.';
        }
        const x = (p as { x: number }).x;
        const y = (p as { y: number }).y;
        if (x < 0 || x > 1 || y < 0 || y > 1) {
          return 'Point is outside the image.';
        }
      }
      return null;
    }
    case 'signature':
    case 'geopoint':
    case 'geotrace':
    case 'geoshape':
    case 'rating':
    case 'slider':
    case 'calculated':
      return null;
    case 'likert': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return 'Pick a point on the scale.';
      }
      const points = q.points ?? 5;
      if (value < 1 || value > points) return 'Pick a point on the scale.';
      return null;
    }
    case 'nps': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return 'Pick a number from 0 to 10.';
      }
      if (value < 0 || value > 10) return 'Pick a number from 0 to 10.';
      return null;
    }
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
    if (
      q.type === 'page' ||
      q.type === 'note' ||
      q.type === 'group' ||
      q.type === 'divider' ||
      q.type === 'image-display'
    ) {
      continue;
    }
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
    case 'email':
      return { ...base, type };
    case 'url':
      return { ...base, type };
    case 'phone':
      return { ...base, type };
    case 'regex':
      return { ...base, type, pattern: '.+' };
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
    case 'matrix-single':
      return {
        ...base,
        type,
        rows: [
          { id: 'row_1', label: 'Statement 1' },
          { id: 'row_2', label: 'Statement 2' },
          { id: 'row_3', label: 'Statement 3' },
        ],
        columns: [
          { value: 'strongly_disagree', label: 'Strongly disagree' },
          { value: 'disagree', label: 'Disagree' },
          { value: 'neutral', label: 'Neutral' },
          { value: 'agree', label: 'Agree' },
          { value: 'strongly_agree', label: 'Strongly agree' },
        ],
      };
    case 'matrix-multi':
      return {
        ...base,
        type,
        rows: [
          { id: 'row_1', label: 'Item 1' },
          { id: 'row_2', label: 'Item 2' },
          { id: 'row_3', label: 'Item 3' },
        ],
        columns: [
          { value: 'option_a', label: 'Option A' },
          { value: 'option_b', label: 'Option B' },
          { value: 'option_c', label: 'Option C' },
        ],
      };
    case 'matrix-dropdown':
      return {
        ...base,
        type,
        rows: [
          { id: 'row_1', label: 'Item 1' },
          { id: 'row_2', label: 'Item 2' },
        ],
        columns: [
          {
            value: 'current',
            label: 'Current',
            choices: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
          },
          {
            value: 'target',
            label: 'Target',
            choices: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
          },
        ],
      };
    case 'matrix-rating':
      return {
        ...base,
        type,
        rows: [
          { id: 'row_1', label: 'Item 1' },
          { id: 'row_2', label: 'Item 2' },
          { id: 'row_3', label: 'Item 3' },
        ],
        max: 5,
        shape: 'star',
      };
    case 'ranking':
      return {
        ...base,
        type,
        choices: [
          { value: 'option_1', label: 'Option 1' },
          { value: 'option_2', label: 'Option 2' },
          { value: 'option_3', label: 'Option 3' },
        ],
      };
    case 'date':
      return { ...base, type };
    case 'time':
      return { ...base, type };
    case 'datetime':
      return { ...base, type };
    case 'name':
      return { ...base, type, components: ['first', 'last'] };
    case 'address':
      return {
        ...base,
        type,
        components: ['street1', 'street2', 'city', 'region', 'postal', 'country'],
      };
    case 'photo':
      return { ...base, type, maxCount: 1 };
    case 'image-choice':
      return {
        ...base,
        type,
        choices: [
          { value: 'option_1', label: 'Option 1', imageUrl: '' },
          { value: 'option_2', label: 'Option 2', imageUrl: '' },
        ],
      };
    case 'image-display':
      return { ...base, type, imageUrl: '' };
    case 'image-hotspot':
      return { ...base, type, imageUrl: '', maxPoints: 1 };
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
    case 'likert':
      return {
        ...base,
        type,
        points: 5,
        leftLabel: 'Strongly disagree',
        rightLabel: 'Strongly agree',
      };
    case 'nps':
      return { ...base, type };
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
    case 'divider':
      return { ...base, type, label: '' };
    case 'acknowledge':
      return {
        ...base,
        type,
        body: 'Please read the terms and check the box to continue.',
      };
    case 'hidden':
      return { ...base, type };
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
      email: 'Email',
      url: 'URL',
      phone: 'Phone',
      regex: 'Pattern',
      number: 'Number',
      integer: 'Whole number',
      boolean: 'Yes / No',
      'select-one': 'Single choice',
      'select-many': 'Multiple choice',
      'matrix-single': 'Matrix (single)',
      'matrix-multi': 'Matrix (multi)',
      'matrix-dropdown': 'Matrix (dropdown)',
      'matrix-rating': 'Matrix (rating)',
      ranking: 'Ranking',
      date: 'Date',
      time: 'Time',
      datetime: 'Date and time',
      name: 'Full name',
      address: 'Address',
      photo: 'Photo',
      'image-choice': 'Image choice',
      'image-display': 'Image',
      'image-hotspot': 'Image hotspot',
      signature: 'Signature',
      geopoint: 'Location (point)',
      geotrace: 'Path (polyline)',
      geoshape: 'Area (polygon)',
      rating: 'Rating',
      likert: 'Likert',
      nps: 'NPS (0-10)',
      slider: 'Slider',
      calculated: 'Calculated',
      note: 'Note',
      divider: 'Divider',
      acknowledge: 'Acknowledge',
      hidden: 'Hidden',
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

// ---------------------------------------------------------------------------
// Portable export / import
// ---------------------------------------------------------------------------

/**
 * Envelope used for native GratisGIS form export (#142). Wraps a
 * FormSchema with a small bit of provenance metadata so a future
 * GratisGIS knows the file came from us, what version, and where
 * (informational; for cross-portal migration audits).
 *
 * `schemaVersion` mirrors the inner FormSchema's so you can pick the
 * right migrator if we ever bump it without opening the inner schema.
 */
export interface FormExportEnvelope {
  /** Magic header so importers can sniff before parsing further. */
  kind: 'gratisgis-form';
  /** The form-schema version the inner form is on. */
  schemaVersion: FormSchemaVersion;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /** Optional: free-form note about where the form came from. */
  source?: {
    /** Human-friendly origin (org name, portal URL). */
    portal?: string;
    /** The original form item id at the source portal -- not used
     *  on import, just for trail-of-breadcrumbs. */
    formId?: string;
  };
  /** The portable form. Local-only fields (linkedLayerId, the
   *  linkedLayerTitle in meta) are stripped before this is written;
   *  see `toExportEnvelope`. */
  form: FormSchema;
}

/** Magic kind string we sniff for on import. */
export const FORM_EXPORT_KIND = 'gratisgis-form' as const;

/**
 * Strip everything that's local to one GratisGIS portal so the file
 * is portable. We keep:
 *
 *   - Form title, description, and the question tree (with bindTo
 *     metadata: column names are useful even when the layer doesn't
 *     exist at the destination -- a re-link will line them up by
 *     name).
 *   - Question id, label, hint, validation, expressions, choices.
 *
 * We strip:
 *
 *   - `id` on the FormSchema (this matches the source form item's
 *     id; the destination's form item has a different id).
 *   - `linkedLayerId` / `linkedLayerKey` (refer to a remote item).
 *   - `meta.linkedLayerTitle` (display name of a remote item).
 *
 * We do NOT strip per-question `bindTo`. The destination importer
 * decides whether to clear bindings (if the target layer differs)
 * or keep them (if a layer with the same column names is being
 * relinked).
 */
export function toExportEnvelope(
  form: FormSchema,
  opts: { portal?: string } = {},
): FormExportEnvelope {
  const portable: FormSchema = {
    schemaVersion: form.schemaVersion,
    id: '', // destination assigns
    title: form.title,
    questions: form.questions,
  };
  if (form.description !== undefined) portable.description = form.description;
  if (form.geometryQuestionId !== undefined) {
    portable.geometryQuestionId = form.geometryQuestionId;
  }
  // Drop linkedLayerTitle from meta; keep anything else.
  if (form.meta) {
    const { linkedLayerTitle: _drop, ...rest } = form.meta as Record<
      string,
      unknown
    >;
    void _drop;
    if (Object.keys(rest).length > 0) portable.meta = rest;
  }
  const env: FormExportEnvelope = {
    kind: FORM_EXPORT_KIND,
    schemaVersion: form.schemaVersion,
    exportedAt: new Date().toISOString(),
    form: portable,
  };
  if (opts.portal) {
    env.source = { portal: opts.portal, formId: form.id };
  } else if (form.id) {
    env.source = { formId: form.id };
  }
  return env;
}

/**
 * Apply a portable envelope onto a destination form. Keeps the
 * destination's `id` (the local form item id stays the source of
 * truth), copies title / description / questions / geometry binding
 * from the import. Does NOT carry the source's `linkedLayerId` (the
 * remote layer doesn't exist locally; the user re-links explicitly).
 *
 * Returns the new FormSchema. Caller drives state.
 */
export function fromImportEnvelope(
  env: FormExportEnvelope,
  destinationId: string,
): FormSchema {
  const next: FormSchema = {
    schemaVersion: env.form.schemaVersion,
    id: destinationId,
    title: env.form.title,
    questions: env.form.questions,
  };
  if (env.form.description !== undefined) next.description = env.form.description;
  if (env.form.geometryQuestionId !== undefined) {
    next.geometryQuestionId = env.form.geometryQuestionId;
  }
  if (env.form.meta) next.meta = { ...env.form.meta };
  return next;
}

/**
 * Validate that an unknown blob is a well-formed export envelope.
 * Returns the typed envelope on success or a string error suitable
 * for showing in a dialog.
 */
export function parseExportEnvelope(
  raw: unknown,
): FormExportEnvelope | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Not a valid form export file (expected JSON object).' };
  }
  const r = raw as Record<string, unknown>;
  if (r.kind !== FORM_EXPORT_KIND) {
    return {
      error: `Not a GratisGIS form export. Expected kind="${FORM_EXPORT_KIND}", got "${String(r.kind)}".`,
    };
  }
  if (typeof r.schemaVersion !== 'number') {
    return { error: 'Export is missing a schemaVersion.' };
  }
  if (r.schemaVersion > CURRENT_FORM_SCHEMA_VERSION) {
    return {
      error: `This form was exported from a newer GratisGIS (schema v${r.schemaVersion}). Update this portal to import it.`,
    };
  }
  const form = r.form as Record<string, unknown> | undefined;
  if (!form || typeof form !== 'object') {
    return { error: 'Export is missing the form payload.' };
  }
  if (typeof form.title !== 'string') {
    return { error: 'Form is missing a title.' };
  }
  if (!Array.isArray(form.questions)) {
    return { error: 'Form is missing the questions array.' };
  }
  return raw as FormExportEnvelope;
}

/**
 * Suggest a download filename based on the form title.
 * "Nest Inspections" -> "nest-inspections.gratisgis-form.json"
 */
export function suggestExportFilename(form: FormSchema): string {
  const slug = form.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'form';
  return `${slug}.gratisgis-form.json`;
}
