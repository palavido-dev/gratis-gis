// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MapLibre expressions for a map layer's attribute filter and its
 * time-bins renderer, shared by the map canvas and the print snapshot.
 *
 * The print snapshot kept its own copy of the paint logic and drifted:
 * it ignored the layer filter, so a PDF printed features the author
 * had filtered out, and it built time bins with `step`, which only
 * takes numbers, so those layers vanished from the PDF.
 */
import type * as maplibregl from 'maplibre-gl';
import { filterInValues } from '@gratis-gis/shared-types';
import type {
  ScopedLayerFilter,
  MapLayerFilterClause,
  MapLayerRenderer,
} from '@gratis-gis/shared-types';

type MlFilter = maplibregl.FilterSpecification;

/**
 * Translate a single filter clause to a MapLibre expression, or return
 * null if the clause is incomplete / unfit for the chosen operator
 * (e.g. a numeric comparison whose value is not a valid number).
 */
export function clauseToExpr(clause: MapLayerFilterClause): unknown[] | null {
  if (!clause.field) return null;
  const prop = ['get', clause.field];
  // Same rules as packages/shared-types/src/filter-match.ts and the
  // engine's SQL: equality on the text form (5 equals "5"), contains
  // ignoring case, and null meaning absent or JSON null.
  switch (clause.op) {
    case '==':
      return ['all', ['!=', prop, null], ['==', ['to-string', prop], clause.value]];
    case '!=':
      return ['any', ['==', prop, null], ['!=', ['to-string', prop], clause.value]];
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const n = Number(clause.value);
      if (Number.isNaN(n)) return null;
      return [clause.op, prop, n];
    }
    case 'contains':
      return [
        'all',
        ['!=', prop, null],
        ['>=', ['index-of', String(clause.value).toLowerCase(), ['downcase', ['to-string', prop]]], 0],
      ];
    case 'is-null':
      return ['==', prop, null];
    case 'is-not-null':
      return ['!=', prop, null];
    case 'in': {
      // A list of feature ids ("Use as filter" in the attribute
      // table). Every v3 tile carries `_global_id` as a property.
      const ids = filterInValues(clause.value);
      if (ids.length === 0) return null;
      return [
        'all',
        ['!=', prop, null],
        ['in', ['to-string', prop], ['literal', ids]],
      ];
    }
  }
}

/**
 * Combine the always-on geometry-type filter with any attribute clauses.
 * Clauses are joined via the user's chosen combinator (all == AND,
 * any == OR). Incomplete clauses (no field picked yet, or numeric
 * comparison with a non-numeric value) are silently dropped so the
 * map keeps rendering while the user is mid-edit.
 */
export function combineFilter(
  geomFilter: unknown[],
  filter: ScopedLayerFilter | null | undefined,
): MlFilter {
  if (!filter) return geomFilter as MlFilter;
  const parts: unknown[] = [geomFilter];
  for (const f of [filter, filter.and]) {
    if (!f) continue;
    const exprs = f.clauses
      .map((c) => clauseToExpr(c))
      .filter((e): e is unknown[] => e !== null);
    if (exprs.length > 0) parts.push([f.combinator === 'any' ? 'any' : 'all', ...exprs]);
  }
  // A cross-filter selection carried in `and` (ScopedLayerFilter) is
  // its own operand, so the author's "match any" stays an OR.
  if (parts.length === 1) return geomFilter as MlFilter;
  return (['all', ...parts] as unknown) as MlFilter;
}

/**
 * Time-bins color (#59). MapLibre's `step` only accepts a numeric
 * input, so this is a `case` chain comparing the field's string value
 * against each ISO-8601 boundary. ISO-8601 with consistent zero
 * padding sorts lexically the same as chronologically, so a plain `<`
 * gives the right bin. Features missing the field, or holding a value
 * that is not a string, get `defaultColor`. Null when the renderer is
 * not fully set up.
 */
export function timeBinsColorExpression(
  r: Extract<MapLayerRenderer, { kind: 'time-bins' }>,
): unknown[] | null {
  const validShape =
    r.field &&
    r.boundaries.length > 0 &&
    r.bins.length === r.boundaries.length + 1;
  if (!validShape) return null;
  const prop = ['get', r.field];
  const caseExpr: unknown[] = ['case'];
  caseExpr.push(['!', ['has', r.field]]);
  caseExpr.push(r.defaultColor);
  caseExpr.push(['!=', ['typeof', prop], 'string']);
  caseExpr.push(r.defaultColor);
  for (let i = 0; i < r.boundaries.length; i += 1) {
    caseExpr.push(['<', prop, r.boundaries[i]!]);
    caseExpr.push(r.bins[i]!.color);
  }
  // Final value: at or after the last boundary.
  caseExpr.push(r.bins[r.boundaries.length]!.color);
  return caseExpr;
}
