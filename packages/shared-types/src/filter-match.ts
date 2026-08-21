// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A `MapLayerFilter` evaluated against one row's attributes, in
 * plain JavaScript.
 *
 * A filter already had two implementations: SQL, via the engine's
 * `compileAttrFilter`, for anything the server counts or pages; and a
 * MapLibre expression, via `clauseToExpr`, for what the map draws.
 * Neither can be used over an array of GeoJSON features already in
 * memory, which is what the attribute table has for a layer that is
 * not a portal data layer, so that table showed rows the map beside
 * it was hiding.
 *
 * A third implementation is not free, so the rules it has to match
 * are written down here rather than left to be rediscovered:
 *
 *   - `!=` is TRUE for a missing value. SQL says this with
 *     `IS DISTINCT FROM` (a plain `<>` against NULL is NULL, which
 *     drops the row); MapLibre says it by returning null from `get`
 *     on an absent property. A reader asking for "not closed"
 *     expects the rows with nothing recorded, so both are right and
 *     this must agree.
 *   - Numeric comparisons are FALSE for anything non-numeric rather
 *     than coercing. SQL guards with `pg_input_is_valid`; MapLibre
 *     drops the clause when the literal will not parse. `"n/a" < 5`
 *     must not be true.
 *   - Comparison is on the value's TEXT form. The engine reads
 *     `attrs->>field`, so `5` and `"5"` are the same value to `==`,
 *     and a filter written against a JSON number still matches a
 *     layer that stored it as a string.
 */
import type { MapLayerFilter } from './map';

/** Text form of an attribute, matching Postgres `attrs->>field`. */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Objects and arrays serialize the way `->>` renders them.
  return JSON.stringify(v);
}

/** Numeric form, or null when the value is not a number. */
function numberOf(v: unknown): number | null {
  const t = textOf(v);
  if (t === null || t.trim() === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function matchesClause(
  props: Record<string, unknown> | null | undefined,
  clause: MapLayerFilter['clauses'][number],
): boolean {
  if (!clause.field) return true;
  const raw = props ? props[clause.field] : undefined;
  const text = textOf(raw);
  switch (clause.op) {
    case '==':
      return text !== null && text === clause.value;
    case '!=':
      // Missing counts as "not equal". See the header.
      return text !== clause.value;
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const a = numberOf(raw);
      const b = numberOf(clause.value);
      if (a === null || b === null) return false;
      if (clause.op === '>') return a > b;
      if (clause.op === '>=') return a >= b;
      if (clause.op === '<') return a < b;
      return a <= b;
    }
    case 'contains':
      return text !== null && text.includes(clause.value);
    case 'is-null':
      return text === null;
    case 'is-not-null':
      return text !== null;
    default:
      // An operator this build does not know must not silently drop
      // rows: a filter nobody can evaluate is better read as absent
      // than as matching nothing.
      return true;
  }
}

/**
 * True when the row satisfies the filter. An absent or empty filter
 * matches everything, so callers can pass `layer.filter` straight
 * through without a null check.
 */
export function matchesFilter(
  props: Record<string, unknown> | null | undefined,
  filter: MapLayerFilter | null | undefined,
): boolean {
  if (!filter || filter.clauses.length === 0) return true;
  return filter.combinator === 'any'
    ? filter.clauses.some((c) => matchesClause(props, c))
    : filter.clauses.every((c) => matchesClause(props, c));
}
