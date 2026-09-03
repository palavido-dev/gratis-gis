// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one place a feature's attribute values are checked against the
 * layer schema that claims to describe them.
 *
 * Before this existed nothing validated a v3 feature write. The DTO
 * accepted a bare `properties` object, the service handed it to the
 * engine untouched, and the engine's own note said "attrs and geom are
 * explicitly nullable, everything else is structural". The layer's
 * `fields` were read only on the CSV and GeoParquet export paths. So
 * the declared schema was decoration: a number could land in a string
 * field, a value outside a coded-value domain could land in a domain
 * field, and a `nullable: false` field could be written empty. The
 * editor's `<select>` was the only guard anywhere, and it falls back to
 * free text when a pick list fails to resolve.
 *
 * An audit of the live demo before enforcement (2026-09-02) found what
 * that permissiveness actually produced, and it is why this module
 * coerces before it rejects:
 *
 *  - `osm_id` on the Elkins buildings layer is declared `string` and is
 *    a JSON number in all 4,734 rows, because the OSM save-as-layer
 *    path writes the raw id. Rejecting that outright would have broken
 *    a shipped importer over a difference with one obvious answer.
 *  - `sample_date` on the water-quality measurements layer is declared
 *    `string` and holds `{day, year, month}` in all 285,788 rows: a
 *    date struct that was never flattened on import. That one is not
 *    coercible to anything honest and is a data bug to repair, not to
 *    paper over.
 *  - The form-runtime submissions layer carries undeclared keys
 *    (`location`, plus the `_`-prefixed envelope). Real writers depend
 *    on them, so undeclared keys are REPORTED, never rejected: see
 *    `unknownFields` below.
 *
 * Policy, in one line: coerce what is lossless and unambiguous, reject
 * what is not, and never silently drop a value.
 */

import type { FeatureField, FieldDomain } from './data-layer';

export type FieldViolationCode =
  | 'type'
  | 'required'
  | 'domain'
  | 'range'
  | 'max-length'
  | 'precision';

export interface FieldViolation {
  /** Field name as declared in the layer schema. */
  field: string;
  code: FieldViolationCode;
  /** Operator-facing sentence. Safe to surface in a 400 body. */
  message: string;
}

export interface ValidateFeatureResult {
  ok: boolean;
  violations: FieldViolation[];
  /**
   * Keys present in the input that the layer schema does not declare.
   * Informational only. `_`-prefixed keys (the form-runtime envelope)
   * are not counted here at all. Callers persist these untouched: a
   * write path that silently discarded them would lose real data, and
   * one that rejected them would break the field app. Schema drift is
   * a thing to see and fix, not a reason to fail an edit.
   */
  unknownFields: string[];
  /**
   * The input with every coercion applied. Only meaningful when `ok`.
   * Callers MUST persist this rather than the raw input, or the
   * coercions are computed and thrown away.
   */
  value: Record<string, unknown>;
}

/**
 * Resolved entries for `coded-value-ref` domains, keyed by
 * `pickListItemId`. A ref with no entry here is left unchecked rather
 * than rejected: a deleted or unreadable pick list must not make every
 * edit on the layer impossible.
 */
export type ResolvedPickLists = Record<
  string,
  ReadonlyArray<{ code: string | number; label?: string }>
>;

export interface ValidateFeatureOptions {
  /**
   * 'create' also enforces `nullable: false` on fields the input omits
   * entirely, because a create is the whole record. 'patch' only judges
   * the keys the caller actually sent.
   *
   * Note that the v3 update path sends the complete property bag (it
   * replaces rather than merges), so 'patch' is about intent, not about
   * how many keys happen to be present.
   */
  mode?: 'create' | 'patch';
  pickLists?: ResolvedPickLists;
}

/** A value that means "no value here": null, undefined, or blank text. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  const t = typeof v;
  if (t === 'object') return 'an object';
  return `a ${t}`;
}

/**
 * A resolved domain, ready for membership tests.
 *
 * `codes` is a Set rather than the array the schema holds because the
 * check runs once per field per row, and a bulk import multiplies that
 * by every row in the batch; `Array.includes` over a few-thousand-entry
 * pick list, rebuilt per row, was measurable CPU on a single request.
 *
 * `listable` says whether an error message may enumerate the codes.
 * Inline `coded-value` domains live in the layer schema the caller can
 * already read, so listing them is help. A `coded-value-ref` points at
 * a separate pick_list item that the caller may NOT be able to open,
 * and the schema is read here with no share check on that list, so
 * listing its codes in a 400 would hand a layer author the contents of
 * any pick list they can name. Those stay unlisted.
 */
interface ResolvedDomain {
  codes: Set<string>;
  listable: boolean;
}

function resolveDomain(
  domain: FieldDomain | undefined,
  pickLists: ResolvedPickLists | undefined,
): ResolvedDomain | null {
  if (!domain) return null;
  if (domain.type === 'coded-value') {
    return {
      codes: new Set(domain.values.map((v) => String(v.code))),
      listable: true,
    };
  }
  if (domain.type === 'coded-value-ref') {
    const entries = pickLists?.[domain.pickListItemId];
    if (!entries) return null;
    return {
      codes: new Set(entries.map((e) => String(e.code))),
      listable: false,
    };
  }
  return null;
}

/**
 * Property names that must never be assigned by bracket on a plain
 * object. Spread and `Object.keys` treat them as ordinary own keys, but
 * `out[name] = v` on a plain object invokes the `Object.prototype`
 * setter for `__proto__` and re-points the object's prototype. A field
 * name comes from item.data, which is author-editable, so it is
 * untrusted here even though it is not request input.
 */
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Largest list a multi_select field accepts. Anything a person picks from a list fits; anything larger is not a selection. */
const MAX_MULTI_SELECT_ENTRIES = 500;

interface CoerceOk {
  ok: true;
  value: unknown;
}
interface CoerceFail {
  ok: false;
  code: FieldViolationCode;
  message: string;
}

/**
 * Coerce a single non-empty value to the field's declared type.
 *
 * Every rule here has to be reversible in meaning, not just in syntax.
 * `310593699` to `"310593699"` keeps the identity. `true` to `1` does
 * not, so booleans are refused by numeric fields even though every
 * language will happily do it. A string to a number is allowed only
 * when the string round-trips exactly, which rejects `"12abc"` and
 * `"1e999"` (Infinity) while accepting `" 42 "`.
 */
function coerceValue(field: FeatureField, raw: unknown): CoerceOk | CoerceFail {
  const label = field.label?.trim() ? field.label : field.name;

  switch (field.type) {
    case 'string': {
      if (typeof raw === 'string') return { ok: true, value: raw };
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { ok: true, value: String(raw) };
      }
      if (typeof raw === 'boolean') return { ok: true, value: String(raw) };
      return {
        ok: false,
        code: 'type',
        message: `${label} is a text field but received ${typeName(raw)}.`,
      };
    }

    case 'number': {
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) {
          return {
            ok: false,
            code: 'type',
            message: `${label} is a number field and cannot hold ${String(raw)}.`,
          };
        }
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string') {
        const n = Number(raw.trim());
        if (raw.trim() !== '' && Number.isFinite(n)) {
          return { ok: true, value: n };
        }
        return {
          ok: false,
          code: 'type',
          message: `${label} is a number field; "${raw}" is not a number.`,
        };
      }
      return {
        ok: false,
        code: 'type',
        message: `${label} is a number field but received ${typeName(raw)}.`,
      };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true' || s === 'yes' || s === '1') return { ok: true, value: true };
        if (s === 'false' || s === 'no' || s === '0') return { ok: true, value: false };
      }
      if (raw === 1) return { ok: true, value: true };
      if (raw === 0) return { ok: true, value: false };
      return {
        ok: false,
        code: 'type',
        message: `${label} is a yes/no field; "${String(raw)}" is neither.`,
      };
    }

    case 'date': {
      // Dates persist as ISO-8601 text. A Date instance is accepted
      // because JSON.parse never produces one but in-process callers
      // can. Numbers are refused on purpose: an epoch is ambiguous
      // between seconds and milliseconds and guessing wrong moves a
      // record by five decades.
      if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) {
          return { ok: false, code: 'type', message: `${label} received an invalid date.` };
        }
        return { ok: true, value: raw.toISOString() };
      }
      if (typeof raw === 'string') {
        if (Number.isNaN(Date.parse(raw))) {
          return {
            ok: false,
            code: 'type',
            message: `${label} is a date field; "${raw}" is not a date we can read.`,
          };
        }
        return { ok: true, value: raw };
      }
      return {
        ok: false,
        code: 'type',
        message: `${label} is a date field but received ${typeName(raw)}.`,
      };
    }

    case 'multi_select': {
      if (Array.isArray(raw)) {
        if (raw.length > MAX_MULTI_SELECT_ENTRIES) {
          return {
            ok: false,
            code: 'type',
            message: `${label} accepts at most ${MAX_MULTI_SELECT_ENTRIES} selections; received ${raw.length}.`,
          };
        }
        const bad = raw.find((e) => typeof e !== 'string' && typeof e !== 'number');
        if (bad !== undefined) {
          return {
            ok: false,
            code: 'type',
            message: `${label} accepts a list of text values; one entry is ${typeName(bad)}.`,
          };
        }
        return { ok: true, value: raw.map((e) => String(e)) };
      }
      // Comma-separated text is the documented export/import boundary
      // shape for multi_select (see data-layer.ts), so accepting it on
      // the way back in is round-tripping, not guessing.
      if (typeof raw === 'string') {
        return {
          ok: true,
          value: raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
        };
      }
      return {
        ok: false,
        code: 'type',
        message: `${label} accepts a list of text values but received ${typeName(raw)}.`,
      };
    }

    default: {
      // Unreachable while FeatureFieldType is a closed union; keeps a
      // future type addition from silently validating as anything.
      const never: never = field.type;
      return {
        ok: false,
        code: 'type',
        message: `${label} has an unsupported field type ${String(never)}.`,
      };
    }
  }
}

/** Post-coercion constraints: domain membership, range, length. */
function checkConstraints(
  field: FeatureField,
  value: unknown,
  domain: ResolvedDomain | null,
): FieldViolation | null {
  const label = field.label?.trim() ? field.label : field.name;

  if (domain && domain.codes.size > 0) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const c of candidates) {
      if (!domain.codes.has(String(c))) {
        let suffix = '.';
        if (domain.listable) {
          const all = [...domain.codes];
          const shown = all.slice(0, 8).join(', ');
          suffix =
            all.length > 8
              ? ` (allowed: ${shown}, and ${all.length - 8} more).`
              : ` (allowed: ${shown}).`;
        }
        return {
          field: field.name,
          code: 'domain',
          message: `${label} only accepts values from its list; "${String(c)}" is not one of them${suffix}`,
        };
      }
    }
  }

  if (field.domain?.type === 'range' && typeof value === 'number') {
    const { min, max } = field.domain;
    if (value < min || value > max) {
      return {
        field: field.name,
        code: 'range',
        message: `${label} must be between ${min} and ${max}; received ${value}.`,
      };
    }
  }

  const storage = field.storage;
  if (storage) {
    if (
      typeof value === 'string' &&
      typeof storage.maxLength === 'number' &&
      storage.maxLength > 0 &&
      value.length > storage.maxLength
    ) {
      return {
        field: field.name,
        code: 'max-length',
        message: `${label} is limited to ${storage.maxLength} characters; received ${value.length}.`,
      };
    }
    if (
      typeof value === 'number' &&
      storage.numberKind === 'integer' &&
      !Number.isInteger(value)
    ) {
      return {
        field: field.name,
        code: 'precision',
        message: `${label} is a whole-number field; received ${value}.`,
      };
    }
  }

  return null;
}

/**
 * Validate and coerce one feature's attributes against a layer schema.
 *
 * Never throws. Callers decide what a violation means: the interactive
 * write paths turn it into a 400, the bulk importer fails the job with
 * the same message so the operator learns which column is wrong.
 *
 * A layer with no declared fields validates everything (there is no
 * schema to disagree with), which keeps schema-free v3 layers writable.
 */
export function validateFeatureProperties(
  fields: readonly FeatureField[] | undefined,
  properties: Record<string, unknown> | undefined,
  options: ValidateFeatureOptions = {},
): ValidateFeatureResult {
  const input = properties ?? {};
  const mode = options.mode ?? 'patch';

  if (!fields || fields.length === 0) {
    return { ok: true, violations: [], unknownFields: [], value: { ...input } };
  }

  const violations: FieldViolation[] = [];
  const value: Record<string, unknown> = { ...input };
  const declared = new Set(fields.map((f) => f.name));
  // Resolved once per call, not once per field per row: see
  // ResolvedDomain. Callers that validate a batch still pay this per
  // row, which is bounded by field count rather than pick-list size.
  const domains = new Map<string, ResolvedDomain | null>();
  for (const field of fields) {
    domains.set(field.name, resolveDomain(field.domain, options.pickLists));
  }

  for (const field of fields) {
    if (RESERVED_FIELD_NAMES.has(field.name)) {
      violations.push({
        field: field.name,
        code: 'type',
        message: `"${field.name}" is not a usable field name.`,
      });
      continue;
    }
    const present = Object.prototype.hasOwnProperty.call(input, field.name);
    const raw = input[field.name];

    if (!present) {
      // A patch that does not mention a field is not an assertion
      // about it. Only a create is judged on absence.
      if (mode === 'create' && field.nullable === false) {
        violations.push({
          field: field.name,
          code: 'required',
          message: `${field.label?.trim() ? field.label : field.name} is required.`,
        });
      }
      continue;
    }

    if (isEmpty(raw)) {
      if (field.nullable === false) {
        violations.push({
          field: field.name,
          code: 'required',
          message: `${field.label?.trim() ? field.label : field.name} is required and cannot be cleared.`,
        });
        continue;
      }
      // Normalise blank text to null so a cleared cell reads as empty
      // everywhere rather than as '' in some layers and null in others.
      value[field.name] = null;
      continue;
    }

    const coerced = coerceValue(field, raw);
    if (!coerced.ok) {
      violations.push({ field: field.name, code: coerced.code, message: coerced.message });
      continue;
    }
    value[field.name] = coerced.value;

    const constraint = checkConstraints(
      field,
      coerced.value,
      domains.get(field.name) ?? null,
    );
    if (constraint) violations.push(constraint);
  }

  const unknownFields = Object.keys(input).filter(
    (k) => !declared.has(k) && !k.startsWith('_') && !RESERVED_FIELD_NAMES.has(k),
  );

  return { ok: violations.length === 0, violations, unknownFields, value };
}

/** One-line summary suitable for a 400 message or a job failure. */
export function describeViolations(violations: readonly FieldViolation[]): string {
  if (violations.length === 0) return '';
  const shown = violations.slice(0, 5).map((v) => v.message);
  const rest = violations.length - shown.length;
  return shown.join(' ') + (rest > 0 ? ` (and ${rest} more.)` : '');
}
