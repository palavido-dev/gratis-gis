/**
 * Auto-generate a FormSchema from a data_layer's column metadata.
 *
 * Used by the data_collection field-mode runtime to render an
 * editing form for a layer that has no explicit form binding. This
 * is the Field Maps default: tap a feature, get a form drawn from
 * the layer's schema (respecting popup config). Callers that want
 * a richer form bind one explicitly via DataCollectionFormBinding;
 * this generator handles the implicit case.
 *
 * Conventions:
 *   - Hide system fields (gid, global_id, created_by, edited_at,
 *     geom, etc.) — they're populated server-side and have no
 *     business in a collection form.
 *   - Respect popup config when present: field order, per-column
 *     label overrides, and explicit hidden lists.
 *   - Show every other field by default, matching Field Maps'
 *     "schema is the form" convention.
 *   - Map field types to question types via a small lookup. Unknown
 *     types fall back to plain text — the runtime can still capture
 *     and submit a string and the layer's type will coerce on write.
 *
 * Independent of @gratis-gis/shared-types so this package keeps its
 * zero-deps shape; callers shape their layer metadata into the
 * structural inputs below before calling.
 */

import type { Choice, FormSchema, Question, QuestionType } from './index';
import { CURRENT_FORM_SCHEMA_VERSION } from './index';

/** Layer field metadata accepted by {@link generateFormFromLayer}. Mirrors
 *  the shape FeatureField from @gratis-gis/shared-types but stays loose
 *  so this package keeps zero deps. */
export interface LayerFieldForGeneration {
  /** Column name in the underlying table. Becomes the question id +
   *  bindTo.column. */
  name: string;
  /** Source field type (string, integer, number, boolean, date,
   *  datetime, time, email, url, phone). Unknown values fall through
   *  to a text question. Case-insensitive. */
  type: string;
  /** Optional user-facing label override. When omitted, a humanised
   *  version of `name` is used. */
  label?: string;
  /** When false, the field is required (NOT NULL in the underlying
   *  table). Default true (nullable). */
  nullable?: boolean;
  /** Optional value-constraint domain. Inline coded-value lists
   *  generate select-one questions with embedded choices; coded-
   *  value-ref forwards the pick_list reference and the runtime
   *  resolves it. */
  domain?:
    | { type: 'coded-value'; values: Array<{ code: string | number; label: string }> }
    | { type: 'coded-value-ref'; pickListItemId: string }
    | { type: 'range'; min: number; max: number };
}

/** Optional popup configuration accepted by the generator. */
export interface LayerPopupConfigForGeneration {
  /** Ordered list of column names; fields not present append after. */
  fieldOrder?: string[];
  /** Column names to omit entirely. Authoritative — overrides any
   *  default-show behavior. */
  hidden?: string[];
  /** Per-column label overrides applied on top of the field's own
   *  `label`. */
  labelOverrides?: Record<string, string>;
}

/** A layer's metadata sufficient to derive a form. */
export interface LayerForGeneration {
  /** v3 sublayer key. Used as `linkedLayerKey` on the FormSchema. */
  key: string;
  /** Optional human-readable layer label; used as the form title
   *  unless overridden in {@link AutoFormOptions}. */
  label?: string;
  /** Layer's column schema. */
  fields: LayerFieldForGeneration[];
  /** Optional popup configuration honored when present. */
  popup?: LayerPopupConfigForGeneration;
}

/** Options the caller supplies that aren't part of the layer metadata. */
export interface AutoFormOptions {
  /** data_layer item id. Sets linkedLayerId on the generated form. */
  dataLayerId: string;
  /** Stable id assigned to the generated FormSchema. Use the layer
   *  key when there's no persisted form item; use the form item's
   *  uuid when persisting. */
  formId: string;
  /** Title override for the generated form. Defaults to
   *  `layer.label ?? layer.key`. */
  title?: string;
}

/**
 * Column names that are always system-managed and therefore never
 * appear in an auto-generated form. Editor-tracking columns (#39)
 * are stamped server-side; the v3 primary keys are owned by the
 * layer engine; geometry is captured by the field runtime's tap
 * gesture, not by a form question. Surfacing any of these in the
 * collection UI would let a respondent overwrite values they don't
 * own and clutter the form with values they have no business
 * editing.
 *
 * Match is case-insensitive so column-name conventions don't have
 * to be uniform across data sources.
 */
const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  'gid',
  'global_id',
  'globalid',
  'objectid',
  'object_id',
  'created_by',
  'created_at',
  'edited_by',
  'edited_at',
  'geom',
  'geometry',
  'shape',
  'shape_length',
  'shape_area',
  'st_area',
  'st_length',
  'valid_from',
  'valid_to',
]);

function isSystemField(name: string): boolean {
  return SYSTEM_FIELDS.has(name.toLowerCase());
}

/**
 * Humanise a snake_case / kebab-case / camelCase column name into a
 * sentence-case label. Used as a fallback when the field carries no
 * explicit `label` and the popup config provides no override.
 */
function humanise(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (spaced.length === 0) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Map a layer field type to a FormSchema question type. The mapping
 * is intentionally narrow — anything unrecognised falls back to a
 * text input, and the underlying layer's column type does the final
 * coercion at write time. Adding new types here only matters for UX:
 * a misclassified field still submits valid data.
 */
function mapType(rawType: string): QuestionType {
  const t = rawType.trim().toLowerCase();
  switch (t) {
    case 'integer':
    case 'int':
    case 'int4':
    case 'int8':
    case 'bigint':
    case 'smallint':
      return 'integer';
    case 'number':
    case 'numeric':
    case 'decimal':
    case 'double':
    case 'double precision':
    case 'float':
    case 'float4':
    case 'float8':
    case 'real':
      return 'number';
    case 'boolean':
    case 'bool':
      return 'boolean';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return 'datetime';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'phone':
      return 'phone';
    case 'multiline':
    case 'text-long':
    case 'long-text':
      return 'multiline';
    default:
      return 'text';
  }
}

/**
 * Apply popup-config field ordering: fields named in fieldOrder
 * appear first in that order; the rest follow in their original
 * declaration order. Stable so a field that's not in fieldOrder
 * keeps its relative position. Hidden fields are stripped here so
 * downstream code never sees them.
 */
function applyPopupOrder(
  fields: LayerFieldForGeneration[],
  popup: LayerPopupConfigForGeneration | undefined,
): LayerFieldForGeneration[] {
  const hiddenSet = new Set(
    (popup?.hidden ?? []).map((h) => h.toLowerCase()),
  );
  const visible = fields.filter((f) => !hiddenSet.has(f.name.toLowerCase()));
  if (!popup?.fieldOrder || popup.fieldOrder.length === 0) return visible;
  const ordered: LayerFieldForGeneration[] = [];
  const consumed = new Set<string>();
  for (const colName of popup.fieldOrder) {
    const match = visible.find(
      (f) => f.name.toLowerCase() === colName.toLowerCase(),
    );
    if (match && !consumed.has(match.name)) {
      ordered.push(match);
      consumed.add(match.name);
    }
  }
  for (const f of visible) {
    if (!consumed.has(f.name)) ordered.push(f);
  }
  return ordered;
}

/**
 * Build a single Question from one layer field. Returns null when the
 * field should be skipped (currently only system fields, but the call
 * site already filters those out before reaching here).
 */
function fieldToQuestion(
  f: LayerFieldForGeneration,
  layerKey: string,
  popup: LayerPopupConfigForGeneration | undefined,
): Question | null {
  if (isSystemField(f.name)) return null;

  const labelOverride = popup?.labelOverrides?.[f.name];
  const label = labelOverride ?? f.label ?? humanise(f.name);
  const required = f.nullable === false;

  // Coded-value domains override the type mapping: regardless of the
  // underlying field type, a constrained value-set is best surfaced
  // as a select-one. Inline values become embedded choices; pick-list
  // references stash the id and let the runtime resolve at render.
  if (f.domain?.type === 'coded-value') {
    const choices: Choice[] = f.domain.values.map((v) => ({
      value: String(v.code),
      label: v.label,
    }));
    return {
      type: 'select-one',
      id: f.name,
      label,
      choices,
      ...(required ? { required: true } : {}),
      bindTo: { layerKey, column: f.name },
      // 'radio' for short lists, 'dropdown' for longer ones. Cutoff
      // is a UX convention: under ~5 options reads better as radios.
      appearance: choices.length <= 5 ? 'radio' : 'dropdown',
    };
  }
  if (f.domain?.type === 'coded-value-ref') {
    return {
      type: 'select-one',
      id: f.name,
      label,
      // Empty inline; the runtime resolves the pick_list and fills
      // choices at render time.
      choices: [],
      pickListId: f.domain.pickListItemId,
      ...(required ? { required: true } : {}),
      bindTo: { layerKey, column: f.name },
      appearance: 'dropdown',
    };
  }

  const qt = mapType(f.type);
  // Range domains tighten numeric questions but otherwise we leave
  // the field's mapped type alone.
  if (
    qt === 'number' &&
    f.domain?.type === 'range' &&
    typeof f.domain.min === 'number' &&
    typeof f.domain.max === 'number'
  ) {
    return {
      type: 'number',
      id: f.name,
      label,
      ...(required ? { required: true } : {}),
      bindTo: { layerKey, column: f.name },
      min: f.domain.min,
      max: f.domain.max,
    };
  }
  if (
    qt === 'integer' &&
    f.domain?.type === 'range' &&
    typeof f.domain.min === 'number' &&
    typeof f.domain.max === 'number'
  ) {
    return {
      type: 'integer',
      id: f.name,
      label,
      ...(required ? { required: true } : {}),
      bindTo: { layerKey, column: f.name },
      min: f.domain.min,
      max: f.domain.max,
    };
  }

  // Plain mapping: type-based question with no extra constraints.
  // We use a switch so each branch can supply only the fields the
  // narrowed Question shape requires (TS would error on excess
  // properties otherwise).
  switch (qt) {
    case 'integer':
      return {
        type: 'integer',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'number':
      return {
        type: 'number',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'boolean':
      return {
        type: 'boolean',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'date':
      return {
        type: 'date',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'datetime':
      return {
        type: 'datetime',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'time':
      return {
        type: 'time',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'email':
      return {
        type: 'email',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'url':
      return {
        type: 'url',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'phone':
      return {
        type: 'phone',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'multiline':
      return {
        type: 'multiline',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
    case 'text':
    default:
      return {
        type: 'text',
        id: f.name,
        label,
        ...(required ? { required: true } : {}),
        bindTo: { layerKey, column: f.name },
      };
  }
}

/**
 * Generate a FormSchema from a layer's column metadata. The result
 * binds every visible question to the corresponding column on the
 * layer (linkedLayerId + linkedLayerKey at the form level, bindTo
 * on each question) so the field runtime can write submissions
 * straight into feature rows.
 */
export function generateFormFromLayer(
  layer: LayerForGeneration,
  opts: AutoFormOptions,
): FormSchema {
  const ordered = applyPopupOrder(layer.fields, layer.popup);
  const questions: Question[] = [];
  for (const f of ordered) {
    const q = fieldToQuestion(f, layer.key, layer.popup);
    if (q) questions.push(q);
  }
  return {
    schemaVersion: CURRENT_FORM_SCHEMA_VERSION,
    id: opts.formId,
    title: opts.title ?? layer.label ?? layer.key,
    questions,
    linkedLayerId: opts.dataLayerId,
    linkedLayerKey: layer.key,
    meta: {
      autoGenerated: true,
      sourceLayerKey: layer.key,
    },
  };
}
