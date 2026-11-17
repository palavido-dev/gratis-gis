// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FILTER_IN_FIELD,
  FILTER_IN_MAX_VALUES,
  type MapLayerFilter,
} from '@gratis-gis/shared-types';

/** The server refuses a `where` with more clauses than this. */
export const MAX_SELECTION_FILTER_CLAUSES = 20;

export type SelectionFilterResult =
  | { ok: true; filter: MapLayerFilter }
  | {
      ok: false;
      /**
       * - `not-loaded`: some selected rows are not on the loaded page.
       * - `too-many`: more rows than one filter may name.
       * - `no-id-field`: no field tells the selected rows apart from
       *   every other loaded row.
       */
      reason: 'not-loaded' | 'too-many' | 'no-id-field';
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The exact filter for a current-format (v3) data layer: its rows are
 * keyed by the hidden `_global_id`, so the selection keys ARE the ids
 * and one `in` clause names exactly those features, loaded or not.
 * Null when the keys are not all feature ids (other layer kinds key
 * rows by position), so the caller falls back to an id field.
 */
export function buildIdSelectionFilter(
  keys: Iterable<string | number>,
): SelectionFilterResult | null {
  const ids: string[] = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !UUID_RE.test(k)) return null;
    ids.push(k);
  }
  if (ids.length === 0) return null;
  if (ids.length > FILTER_IN_MAX_VALUES) return { ok: false, reason: 'too-many' };
  return {
    ok: true,
    filter: {
      combinator: 'all',
      clauses: [{ field: FILTER_IN_FIELD, op: 'in', value: ids.join(',') }],
    },
  };
}

/**
 * Turn the table's selection into a layer filter that matches exactly
 * the selected rows, or say why it cannot.
 *
 * It used to pick the first field whose values were distinct among the
 * SELECTED rows only, so with one row selected any non-empty field
 * qualified and the filter became, say, city == "Riverside": every
 * Riverside parcel. It also wrote one clause per row with no cap, and
 * past 20 clauses the server refused the filter and the table broke
 * until it was removed by hand.
 *
 * `selected` holds row indexes into `features`; `requested` is how
 * many rows the user selected (some may not be on the loaded page).
 * Uniqueness is checked over every loaded row, which is exact when
 * the whole layer is loaded and the best this view can know otherwise.
 */
export function buildSelectionFilter(
  fields: readonly string[],
  features: ReadonlyArray<{ properties?: unknown }>,
  selected: ReadonlySet<number>,
  requested: number,
): SelectionFilterResult {
  if (selected.size < requested) return { ok: false, reason: 'not-loaded' };
  if (selected.size > MAX_SELECTION_FILTER_CLAUSES) {
    return { ok: false, reason: 'too-many' };
  }
  const idField = pickIdField(fields, features, selected);
  if (!idField) return { ok: false, reason: 'no-id-field' };
  const values = [...selected].map((i) => String(propsOf(features[i])[idField]));
  return {
    ok: true,
    filter: {
      combinator: 'any',
      clauses: values.map((value) => ({ field: idField, op: '==' as const, value })),
    },
  };
}

function propsOf(f: { properties?: unknown } | undefined): Record<string, unknown> {
  const p = f?.properties;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/**
 * A field that identifies each selected row: every selected row has a
 * value, and no other loaded row shares it. Fields literally named
 * id / fid / objectid are tried first, but only if they pass the same
 * test.
 */
export function pickIdField(
  fields: readonly string[],
  features: ReadonlyArray<{ properties?: unknown }>,
  selected: ReadonlySet<number>,
): string | null {
  const common = ['id', 'fid', 'objectid', 'OBJECTID', 'FID', 'ID'];
  const ordered = [
    ...common.filter((c) => fields.includes(c)),
    ...fields.filter((f) => !common.includes(f)),
  ];
  for (const field of ordered) {
    if (identifiesSelection(field, features, selected)) return field;
  }
  return null;
}

function identifiesSelection(
  field: string,
  features: ReadonlyArray<{ properties?: unknown }>,
  selected: ReadonlySet<number>,
): boolean {
  const counts = new Map<string, number>();
  for (const f of features) {
    const v = propsOf(f)[field];
    if (v === null || v === undefined) continue;
    const key = String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const i of selected) {
    const v = propsOf(features[i])[field];
    if (v === null || v === undefined) return false;
    if (counts.get(String(v)) !== 1) return false;
  }
  return true;
}
