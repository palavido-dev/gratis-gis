// SPDX-License-Identifier: AGPL-3.0-or-later
// Which typed column a form question gets on its linked layer, and
// how a form save merges those columns into the fields the layer
// already has.
//
// Moved out of the form designer page so it can be tested against the
// shared feature validator. Two defects lived here: checkbox, ranking
// and multi image-choice answers are lists but got a text column, and
// a dropdown's allowed values were frozen at the first save. In both
// cases the submission mirror rejected the row and only logged it.
import type { Question } from '@gratis-gis/form-schema';

export interface RawFeatureField {
  name: string;
  type?: string;
  label?: string;
  nullable?: boolean;
  /** Optional value-constraint. Mirrors shared-types FieldDomain:
   *  inline coded-values OR a reference to a pick_list item.
   *  fetchLayerSchema resolves the reference into LayerColumn.choices. */
  domain?:
    | {
        type: 'coded-value';
        values: Array<{ code: string | number; label: string }>;
      }
    | { type: 'coded-value-ref'; pickListItemId: string }
    | { type: 'range'; min: number; max: number };
}

function inlineDomain(
  choices: ReadonlyArray<{ value: string; label?: string }> | undefined,
): RawFeatureField['domain'] | undefined {
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return {
    type: 'coded-value',
    values: choices.map((c) => ({
      code: String(c.value),
      label: c.label ?? String(c.value),
    })),
  };
}

/** Question types whose answer is a list of picked values. */
function answersWithList(q: Question): boolean {
  return (
    q.type === 'select-many' ||
    q.type === 'ranking' ||
    (q.type === 'image-choice' && q.multi === true)
  );
}

/**
 * Map a form question to a FeatureField shape that the v3 layer can
 * provision as a typed column. Returns null when the question type
 * doesn't have a clean column representation; those values continue
 * to live in the layer's `properties` JSONB until a richer column
 * model lands (#281b mutation API).
 */
export function questionToFeatureField(q: Question): RawFeatureField | null {
  // Layout / structural / non-data question types: no column at all.
  if (
    q.type === 'page' ||
    q.type === 'note' ||
    q.type === 'divider' ||
    q.type === 'image-display' ||
    q.type === 'group' ||
    q.type === 'hidden' ||
    q.type === 'acknowledge'
  ) {
    return null;
  }
  // Attachments still ride along in properties JSONB until #292
  // refactors them into a child related-table.
  if (
    q.type === 'photo' ||
    q.type === 'audio' ||
    q.type === 'video' ||
    q.type === 'file' ||
    q.type === 'sketch' ||
    q.type === 'signature'
  ) {
    return null;
  }
  // Composite / nested-shape answers don't fit a single typed column
  // cleanly. Stash them in properties JSONB for now.
  if (
    q.type === 'name' ||
    q.type === 'address' ||
    q.type === 'matrix-single' ||
    q.type === 'matrix-multi' ||
    q.type === 'matrix-dropdown' ||
    q.type === 'matrix-rating' ||
    q.type === 'image-hotspot' ||
    q.type === 'pick-feature' ||
    q.type === 'route' ||
    q.type === 'area-buffer' ||
    q.type === 'geopoint' ||
    q.type === 'geotrace' ||
    q.type === 'geoshape'
  ) {
    return null;
  }
  // Use the question id as the column name. The form runtime writes
  // top-level keyed by question id (post-#288), so this name lines
  // up with the value it'll receive.
  const base: RawFeatureField = {
    name: q.id,
    label: q.label,
  };
  // Multi-value answers are lists, so they get a multi_select column.
  // The feature validator refuses a list for a text column ("is a
  // text field but received a list"), and nothing on the way joins
  // the list into text, so every submission that answered one of
  // these was kept out of the layer. Ranking keeps its order in the
  // list. The choice domain is checked per entry.
  if (answersWithList(q)) {
    const out: RawFeatureField = { ...base, type: 'multi_select' };
    const domain = inlineDomain((q as { choices?: Array<{ value: string; label?: string }> }).choices);
    if (domain) out.domain = domain;
    return out;
  }
  switch (q.type) {
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'integer':
    case 'number':
    case 'rating':
    case 'nps':
    case 'slider':
    case 'likert':
      return { ...base, type: 'number' };
    case 'date':
    case 'datetime':
      return { ...base, type: 'date' };
    case 'select-one': {
      const out: RawFeatureField = { ...base, type: 'string' };
      // Inline coded-value domain (the form designer's per-question
      // choice list). Pick-list-backed select-one keeps its
      // pickListId and we resolve it server-side at render time;
      // for the column-add path here we pin choices inline because
      // FeatureField doesn't carry pickListItemId yet.
      const domain = inlineDomain(q.choices);
      if (domain) out.domain = domain;
      return out;
    }
    // Single image-choice lands one value in a text column. Domain
    // not attached because the choices aren't textual labels here.
    // Everything else (text / multiline / email / url / phone /
    // regex / barcode / calculated / time) lands as string.
    default:
      return { ...base, type: 'string' };
  }
}

function sameDomain(
  a: RawFeatureField['domain'] | undefined,
  b: RawFeatureField['domain'] | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Merge the columns a form wants into the fields a sublayer already
 * has. Still additive: no field is renamed, dropped or narrowed.
 * Three things change an existing field:
 *
 *   - a missing column is added;
 *   - a text column for a checkbox, ranking or multi image-choice
 *     question becomes multi_select (an earlier designer made it
 *     text, and the mirror refused every list sent to it);
 *   - a coded-value list gains the question's new choices. It was
 *     copied once at the first save, so a choice added later was
 *     refused by the mirror. Old codes stay so rows that already
 *     hold them stay valid; labels follow the question.
 *
 * Fields whose list comes from a pick list, or that have no list,
 * are left alone.
 */
export function mergeQuestionFields(
  existing: RawFeatureField[],
  wanted: RawFeatureField[],
): { fields: RawFeatureField[]; changed: boolean; added: RawFeatureField[] } {
  const byName = new Map(wanted.map((f) => [f.name, f]));
  let changed = false;
  const fields = existing.map((cur) => {
    const want = byName.get(cur.name);
    if (!want) return cur;
    let next = cur;
    if (want.type === 'multi_select' && (cur.type ?? 'string') === 'string') {
      next = { ...next, type: 'multi_select' };
    }
    if (
      want.domain?.type === 'coded-value' &&
      next.domain?.type === 'coded-value'
    ) {
      const labels = new Map(want.domain.values.map((v) => [String(v.code), v.label]));
      const values = next.domain.values.map((v) => {
        const label = labels.get(String(v.code));
        return label !== undefined && label !== v.label ? { ...v, label } : v;
      });
      const have = new Set(values.map((v) => String(v.code)));
      for (const v of want.domain.values) {
        if (!have.has(String(v.code))) values.push(v);
      }
      const domain = { type: 'coded-value' as const, values };
      if (!sameDomain(domain, next.domain)) next = { ...next, domain };
    }
    if (next !== cur) changed = true;
    return next;
  });
  const have = new Set(existing.map((f) => f.name));
  const added = wanted.filter((f) => !have.has(f.name));
  if (added.length > 0) changed = true;
  return { fields: [...fields, ...added], changed, added };
}
