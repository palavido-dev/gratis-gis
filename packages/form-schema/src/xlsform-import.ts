// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * XLSForm / Survey123 import (#103).
 *
 * Translates a parsed XLSForm workbook into a GratisGIS FormSchema.
 * The input shape is what SheetJS's `XLSX.utils.sheet_to_json`
 * produces -- an array of plain objects keyed by header row text --
 * so this module is pure: the caller does the binary parse, we do
 * the schema translation.  Keeping it side-effect-free lets the
 * same translator run client-side (form designer's Import button)
 * AND server-side (eg a bulk-import endpoint later) without forking.
 *
 * What we translate today
 * -----------------------
 * Question types: the common XLSForm primitives (text, integer,
 * decimal, date/time/datetime, geopoint/trace/shape, image/audio/
 * video/file, barcode, note, acknowledge, calculate, hidden,
 * range, rank, select_one, select_multiple) map to GratisGIS
 * question types one-to-one or one-to-many (multiline text and
 * dropdowns are appearance-driven in XLSForm, dedicated types
 * here).  begin_group / end_group becomes a group container;
 * begin_repeat / end_repeat becomes a group with repeat=true.
 *
 * Choices: lists are looked up by `type` suffix (`select_one yes_no`
 * picks up `list_name=yes_no`) and converted to {value,label}.
 *
 * Labels, hints, defaults, required, read_only: passed through.
 *
 * What we DON'T translate (yet)
 * -----------------------------
 * Expressions in `relevant`, `constraint`, `calculation`,
 * `choice_filter`: stashed as raw strings in `question.meta.xlsform`
 * for the author to re-author in the GratisGIS expression editor.
 * Doing a real AST translation needs a full XPath-subset parser +
 * mapping every XForm function to a GratisGIS BUILTIN; the prior-
 * art parser at `survey123-designer/src/utils/expressionParser.ts`
 * is a good starting point for a v2 slice.
 *
 * Multi-language label::* columns: we take the bare `label` column,
 * falling back to the first `label::*` if `label` is missing.  A
 * v2 can promote one of the languages to primary.
 *
 * Settings sheet: form_title becomes the schema title; everything
 * else is dropped today.
 *
 * Unrecognized rows produce a warning rather than failing the
 * whole import, so a survey with 95% supported questions still
 * lands and the author can fix the rest by hand.
 */

import {
  CURRENT_FORM_SCHEMA_VERSION,
  defaultQuestion,
  type Choice,
  type FormSchema,
  type Question,
  type QuestionType,
} from './index';

/** Single row of the XLSForm `survey` sheet. */
export interface XlsFormSurveyRow {
  type?: string;
  name?: string;
  label?: string;
  hint?: string;
  required?: string;
  relevant?: string;
  constraint?: string;
  constraint_message?: string;
  calculation?: string;
  appearance?: string;
  default?: string;
  read_only?: string;
  readonly?: string;
  choice_filter?: string;
  parameters?: string;
  bind?: string;
  // Allow any other column -- we ignore unknowns.  label::English (en)
  // and similar variants come through as keys we pick up by prefix.
  [k: string]: unknown;
}

/** Single row of the XLSForm `choices` sheet. */
export interface XlsFormChoicesRow {
  list_name?: string;
  name?: string;
  label?: string;
  [k: string]: unknown;
}

/** Single row of the XLSForm `settings` sheet. */
export interface XlsFormSettingsRow {
  form_title?: string;
  form_id?: string;
  version?: string;
  instance_name?: string;
  default_language?: string;
  [k: string]: unknown;
}

export interface XlsFormWorkbook {
  survey: XlsFormSurveyRow[];
  choices: XlsFormChoicesRow[];
  settings: XlsFormSettingsRow[];
}

export interface ImportResult {
  schema: FormSchema;
  warnings: string[];
}

/**
 * Convert a parsed XLSForm workbook into a GratisGIS FormSchema.
 * The caller is responsible for parsing the .xlsx binary into the
 * row arrays (typically via SheetJS).  Returns the translated
 * schema plus a list of human-readable warnings for anything that
 * didn't round-trip cleanly.
 */
export function importXlsForm(
  workbook: XlsFormWorkbook,
  opts: { itemId: string },
): ImportResult {
  const warnings: string[] = [];

  // ------ Settings ------
  const settings = workbook.settings[0] ?? {};
  const title =
    typeof settings.form_title === 'string' && settings.form_title.trim().length > 0
      ? settings.form_title.trim()
      : 'Imported survey';

  // ------ Choices: bucket by list_name ------
  const choicesByList = new Map<string, Choice[]>();
  for (const row of workbook.choices) {
    const list = typeof row.list_name === 'string' ? row.list_name.trim() : '';
    const value = typeof row.name === 'string' ? row.name.trim() : '';
    const label = pickLabel(row);
    if (!list || !value) continue;
    const bucket = choicesByList.get(list) ?? [];
    bucket.push({ value, label: label || value });
    choicesByList.set(list, bucket);
  }

  // ------ Walk survey rows with a container stack ------
  // The stack holds the question lists we're currently appending
  // into.  Top-level lives at stack[0]; begin_group / begin_repeat
  // push a new child list and end_group / end_repeat pop.  This
  // mirrors XLSForm's flat-row-with-markers shape.
  const root: Question[] = [];
  type Frame = { container: Question; list: Question[] };
  const stack: Frame[] = [];

  const idsTaken = new Set<string>();

  function pushTo(q: Question) {
    if (stack.length === 0) {
      root.push(q);
    } else {
      stack[stack.length - 1]!.list.push(q);
    }
  }

  function uniqueId(suggested: string): string {
    let id = sanitizeId(suggested);
    if (!id) id = 'q';
    let candidate = id;
    let n = 2;
    while (idsTaken.has(candidate)) {
      candidate = `${id}_${n}`;
      n += 1;
    }
    idsTaken.add(candidate);
    return candidate;
  }

  for (let i = 0; i < workbook.survey.length; i += 1) {
    const row = workbook.survey[i];
    if (!row) continue;
    const rawType = typeof row.type === 'string' ? row.type.trim() : '';
    if (!rawType) continue;

    // begin_group / end_group -- container open/close.
    if (rawType === 'begin_group' || rawType === 'begin group') {
      const id = uniqueId(row.name ?? `group_${i + 1}`);
      const q = defaultQuestion('group', id) as Question & {
        repeat?: boolean;
        children?: Question[];
        label: string;
      };
      q.label = pickLabel(row) || 'Group';
      const children: Question[] = [];
      (q as unknown as { children: Question[] }).children = children;
      pushTo(q);
      stack.push({ container: q, list: children });
      continue;
    }
    if (rawType === 'end_group' || rawType === 'end group') {
      stack.pop();
      continue;
    }
    if (rawType === 'begin_repeat' || rawType === 'begin repeat') {
      const id = uniqueId(row.name ?? `repeat_${i + 1}`);
      const q = defaultQuestion('group', id) as Question & {
        repeat?: boolean;
        children?: Question[];
        label: string;
      };
      q.label = pickLabel(row) || 'Repeat';
      // GratisGIS represents repeats as group questions with a
      // `repeat: true` flag (the form-schema's group type carries
      // an optional `repeat` boolean -- see GroupQuestion).  Per
      // user note: "begin_repeat... we have that, we just implement
      // it differently."
      (q as unknown as { repeat: boolean }).repeat = true;
      const children: Question[] = [];
      (q as unknown as { children: Question[] }).children = children;
      pushTo(q);
      stack.push({ container: q, list: children });
      continue;
    }
    if (rawType === 'end_repeat' || rawType === 'end repeat') {
      stack.pop();
      continue;
    }

    // Skip XLSForm meta-questions (start/end/today/deviceid/etc.)
    // -- they have no GratisGIS analogue and aren't user-visible
    // questions.  The runtime stamps its own timestamps via response
    // metadata, so we don't lose anything by dropping them.
    if (META_TYPES.has(rawType)) continue;

    // Resolve type.  For select_one / select_multiple / rank the
    // type column is "select_one <list_name>" so we split once.
    const [typeKey, listName] = splitTypeAndList(rawType);
    const mapping = mapType(typeKey);
    if (!mapping) {
      warnings.push(
        `Row ${i + 2}: unsupported XLSForm type "${rawType}" -- skipped.`,
      );
      continue;
    }

    // Type and appearance combine to pick the GratisGIS question
    // type.  E.g. text + appearance=multiline -> multiline; integer
    // + appearance=spinner -> integer (with a metadata hint).
    const appearance = (row.appearance ?? '').toString().toLowerCase();
    const gType = refineType(mapping, appearance);

    const id = uniqueId(row.name ?? `q_${i + 1}`);
    const q = defaultQuestion(gType, id) as Question & {
      label: string;
      hint?: string;
      required?: boolean | undefined;
      readOnly?: boolean | undefined;
      meta?: Record<string, unknown>;
    };
    q.label = pickLabel(row) || row.name?.toString() || id;

    const hint = typeof row.hint === 'string' ? row.hint : '';
    if (hint.trim().length > 0) q.hint = hint;

    if (parseBoolish(row.required)) q.required = true;
    if (parseBoolish(row.read_only) || parseBoolish(row.readonly)) {
      q.readOnly = true;
    }

    // Choices (select_one / select_multiple / rank).  Attach the
    // matching choices list to the question's `choices` field,
    // which all three select-shaped GratisGIS types share.
    if (listName) {
      const list = choicesByList.get(listName);
      if (!list || list.length === 0) {
        warnings.push(
          `Row ${i + 2}: choice list "${listName}" not found in the choices sheet.`,
        );
      } else if ('choices' in q) {
        (q as unknown as { choices: Choice[] }).choices = list.map((c) => ({
          ...c,
        }));
      }
    }

    // Default value: store on the question if the type carries a
    // `defaultValue` field (most do via shared metadata).  XLSForm
    // defaults are strings; numeric/boolean coercion happens at the
    // runtime side based on question type.
    if (typeof row.default === 'string' && row.default.length > 0) {
      (q as unknown as { defaultValue?: unknown }).defaultValue = row.default;
    }

    // Stash raw XLSForm expressions on q.meta so the form item
    // retains the original semantics until the author re-authors
    // them in the GratisGIS expression editor.  These are NOT
    // evaluated at runtime: nothing parses XPath today, so an
    // imported relevant / constraint / calculation has no effect
    // until re-authored (the warning below tells the author so).
    // The meta block preserves the intent for that re-authoring
    // and for a possible future XPath adapter slice.
    const xlsformMeta: Record<string, string> = {};
    if (typeof row.relevant === 'string' && row.relevant.trim().length > 0) {
      xlsformMeta.relevant = row.relevant.trim();
    }
    if (typeof row.constraint === 'string' && row.constraint.trim().length > 0) {
      xlsformMeta.constraint = row.constraint.trim();
    }
    if (
      typeof row.constraint_message === 'string' &&
      row.constraint_message.trim().length > 0
    ) {
      xlsformMeta.constraint_message = row.constraint_message.trim();
    }
    if (
      typeof row.calculation === 'string' &&
      row.calculation.trim().length > 0
    ) {
      xlsformMeta.calculation = row.calculation.trim();
    }
    if (
      typeof row.choice_filter === 'string' &&
      row.choice_filter.trim().length > 0
    ) {
      xlsformMeta.choice_filter = row.choice_filter.trim();
    }
    if (appearance.length > 0) xlsformMeta.appearance = appearance;
    if (Object.keys(xlsformMeta).length > 0) {
      q.meta = { ...(q.meta ?? {}), xlsform: xlsformMeta };
      if (xlsformMeta.relevant || xlsformMeta.constraint || xlsformMeta.calculation) {
        warnings.push(
          `Row ${i + 2} ("${q.label}"): expressions (relevant / constraint / calculation) preserved as raw strings on meta.xlsform; re-author in the GratisGIS expression editor.`,
        );
      }
    }

    pushTo(q);
  }

  if (stack.length > 0) {
    warnings.push(
      `${stack.length} unclosed group(s) at end of survey -- treated as still open.`,
    );
  }

  const schema: FormSchema = {
    schemaVersion: CURRENT_FORM_SCHEMA_VERSION,
    id: opts.itemId,
    title,
    questions: root,
  };

  return { schema, warnings };
}

// -------------------- helpers --------------------

/**
 * Pick the user-facing label from a row.  Prefer the bare `label`
 * column; otherwise fall back to the first `label::*` variant the
 * row carries (multi-language XLSForms).
 */
function pickLabel(
  row: XlsFormSurveyRow | XlsFormChoicesRow,
): string {
  const direct = typeof row.label === 'string' ? row.label.trim() : '';
  if (direct.length > 0) return direct;
  for (const k of Object.keys(row)) {
    if (!k.startsWith('label::')) continue;
    const v = (row as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

/**
 * Split a XLSForm type string into the bare type and the optional
 * choice-list name.  `select_one yes_no` -> ['select_one', 'yes_no'].
 * `integer` -> ['integer', null].
 */
function splitTypeAndList(raw: string): [string, string | null] {
  const m = raw.match(/^(\S+)\s+(\S+)$/);
  if (m) return [m[1]!.toLowerCase(), m[2]!];
  return [raw.toLowerCase(), null];
}

/** Pure XLSForm type -> GratisGIS QuestionType candidate (before
 *  appearance-driven refinement). */
function mapType(typeKey: string): QuestionType | null {
  switch (typeKey) {
    case 'text':
      return 'text';
    case 'integer':
      return 'integer';
    case 'decimal':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
    case 'dateTime':
      return 'datetime';
    case 'geopoint':
      return 'geopoint';
    case 'geotrace':
      return 'geotrace';
    case 'geoshape':
      return 'geoshape';
    case 'image':
      return 'photo';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'file':
      return 'file';
    case 'barcode':
      return 'barcode';
    case 'note':
      return 'note';
    case 'acknowledge':
      return 'acknowledge';
    case 'calculate':
      return 'calculated';
    case 'hidden':
      return 'hidden';
    case 'range':
      return 'slider';
    case 'rank':
      return 'ranking';
    case 'select_one':
    case 'select-one':
    case 'select_one_external':
      return 'select-one';
    case 'select_multiple':
    case 'select-multiple':
      return 'select-many';
    default:
      return null;
  }
}

/**
 * Apply XLSForm appearance-driven refinement.  Examples:
 *   - text + multiline -> multiline
 *   - text + url -> url
 *   - select_one + likert -> matrix-rating (single)
 *   - integer + signature -> signature
 * Falls back to the base mapping when the appearance doesn't change
 * the type.
 */
function refineType(
  base: QuestionType,
  appearance: string,
): QuestionType {
  if (base === 'text') {
    if (appearance.includes('multiline') || appearance.includes('multi-line')) {
      return 'multiline';
    }
    if (appearance.includes('url')) return 'url';
    if (appearance.includes('email')) return 'email';
  }
  if (base === 'integer') {
    if (appearance.includes('rating') || appearance.includes('distress')) {
      return 'rating';
    }
  }
  return base;
}

/** XLSForm meta-question types we drop on import. */
const META_TYPES = new Set([
  'start',
  'end',
  'today',
  'deviceid',
  'subscriberid',
  'simserial',
  'phonenumber',
  'username',
  'email',
  'audit',
  'start-geopoint',
  'start_geopoint',
]);

/** Truthy-strings used by XLSForm authors. */
function parseBoolish(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1';
}

/**
 * Trim a candidate id down to the regex shape GratisGIS uses for
 * question ids (start with a letter or underscore, alphanumerics +
 * underscore thereafter).  XLSForm name columns sometimes carry
 * hyphens or unicode; we ASCII-fold them to keep downstream code
 * (column-name generation, expression refs) deterministic.
 */
function sanitizeId(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .trim()
    .normalize('NFKD')
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (/^[0-9]/.test(s)) return `q_${s}`;
  return s;
}
