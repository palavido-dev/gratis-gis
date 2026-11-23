// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data access: expressions that read other rows. Related records,
 * other layers, keyed lookups, nearby features, and summaries over
 * them.
 *
 * The host (the API, or the field app offline) resolves names to
 * sources and enforces who may read what. The language only ever
 * names a source with a literal, so every source an expression can
 * touch is known before it runs: that list drives the item page's
 * dependencies, the sharing check and what the field app downloads
 * for offline use.
 */

import type { Expr, FieldRef } from './ast';
import { walkExpr } from './ast';

/** A table or layer an expression reads, as the host resolved it. */
export interface DataSource {
  /** Stable key, such as "<item id>/<layer id>". */
  key: string;
  /** Name for messages and the builder. */
  label: string;
  fields: FieldRef[];
  /** True when rows have geometry. */
  hasGeometry: boolean;
  /** Item id, for dependency tracking. */
  itemId: string;
  /** Sublayer id within the item. */
  layerId: string;
  /**
   * For a related table: the field on its rows holding the parent
   * feature's id.
   */
  parentFk?: string;
}

export type Resolved = DataSource | { error: string };

/** Resolves names to sources. Synchronous: hosts load what they need first. */
export interface DataResolver {
  /** A related table of the current layer, by name or label. */
  related(name: string): Resolved;
  /** Another layer: an item title or id, and optionally a sublayer. */
  layer(ref: string, sublayer?: string): Resolved;
}

/** Data functions and their help text, for the builder and the docs. */
export const DATA_FUNCTION_DOCS: Array<{
  name: string;
  signature: string;
  description: string;
  example?: string;
}> = [
  {
    name: 'related',
    signature: "related('table')",
    description: "The rows of a related table that belong to this feature, such as its inspections.",
    example: "count(related('inspections'))",
  },
  {
    name: 'layer',
    signature: "layer('layer name', 'sublayer'?)",
    description: 'Every row of another layer you can see. Name it by title or by item id.',
    example: "count(within_distance(layer('Hydrants'), 500, 'feet'))",
  },
  {
    name: 'filter',
    signature: 'filter(rows, condition)',
    description:
      'The rows where the condition is true. Inside the condition, {{field}} is a field of the row and $feature.field is a field of this feature.',
    example: "count(filter(related('inspections'), {{result}} == 'Fail'))",
  },
  {
    name: 'order_by',
    signature: "order_by(rows, value, 'desc'?)",
    description: "Sorts rows by a value, smallest first, or largest first with 'desc'.",
    example: "first(order_by(related('inspections'), {{inspected_on}}, 'desc')).inspector",
  },
  {
    name: 'top',
    signature: 'top(rows, n)',
    description: 'The first n rows.',
  },
  {
    name: 'first',
    signature: 'first(rows)',
    description: 'The first row. Read a field from it with .name.',
    example: "first(related('owners')).owner_name",
  },
  {
    name: 'last',
    signature: 'last(rows)',
    description: 'The last row.',
  },
  {
    name: 'count',
    signature: 'count(rows)',
    description: 'How many rows.',
    example: "count(related('inspections'))",
  },
  {
    name: 'exists',
    signature: 'exists(rows)',
    description: 'True when there is at least one row.',
  },
  {
    name: 'sum',
    signature: 'sum(rows, value)',
    description: 'Total of a value over the rows.',
    example: "sum(related('repairs'), {{cost}})",
  },
  {
    name: 'avg',
    signature: 'avg(rows, value)',
    description: 'Average of a value over the rows. Also mean and average.',
  },
  {
    name: 'min',
    signature: 'min(rows, value)',
    description: 'Smallest value over the rows: a number, a date or text.',
  },
  {
    name: 'max',
    signature: 'max(rows, value)',
    description: 'Largest value over the rows: the latest date, for example.',
    example: "max(related('inspections'), {{inspected_on}})",
  },
  {
    name: 'count_distinct',
    signature: 'count_distinct(rows, value)',
    description: 'How many different values.',
  },
  {
    name: 'list',
    signature: "list(rows, value, separator?)",
    description: "The values joined into one piece of text, in row order (', ' by default).",
    example: "list(intersecting(layer('Zoning')), {{zone}})",
  },
  {
    name: 'lookup',
    signature: "lookup(rows, 'key field', value, 'result field')",
    description: 'The result field of the first row whose key field equals the value.',
    example: "lookup(layer('Owners'), 'parcel_id', {{parcel_id}}, 'owner_name')",
  },
  {
    name: 'nearest',
    signature: "nearest(rows, max distance?, unit?)",
    description: 'The closest row to this feature, optionally only within a distance.',
    example: "nearest(layer('Hydrants'), 1000, 'feet').hydrant_id",
  },
  {
    name: 'distance_to',
    signature: "distance_to(rows, unit?)",
    description: 'Distance from this feature to the closest row (meters by default).',
    example: "round(distance_to(layer('Hydrants'), 'feet'))",
  },
  {
    name: 'within_distance',
    signature: 'within_distance(rows, distance, unit)',
    description: 'Rows within a distance of this feature.',
    example: "count(within_distance(layer('Wells'), 1, 'miles'))",
  },
  {
    name: 'intersecting',
    signature: 'intersecting(rows)',
    description: 'Rows whose shape touches or overlaps this feature.',
    example: "first(intersecting(layer('Parcels'))).apn",
  },
  {
    name: 'containing',
    signature: 'containing(rows)',
    description: 'Rows whose shape contains this feature, such as the district a point is in.',
    example: "first(containing(layer('Districts'))).name",
  },
  {
    name: 'within',
    signature: 'within(rows)',
    description: 'Rows inside this feature, such as the trees inside a park.',
    example: "count(within(layer('Trees')))",
  },
];

/** Names of every data function. */
export const DATA_FUNCTIONS = new Set([
  'related',
  'layer',
  'filter',
  'order_by',
  'orderby',
  'top',
  'first',
  'last',
  'exists',
  'sum',
  'avg',
  'mean',
  'average',
  'count_distinct',
  'list',
  'lookup',
  'nearest',
  'distance_to',
  'within_distance',
  'intersecting',
  'intersects',
  'containing',
  'within',
]);

/** Functions that return a set and take a set as their first argument. */
export const SET_TO_SET = new Set([
  'filter',
  'order_by',
  'top',
  'within_distance',
  'intersecting',
  'containing',
  'within',
]);

export const DATA_ALIASES: Record<string, string> = {
  orderby: 'order_by',
  mean: 'avg',
  average: 'avg',
  intersects: 'intersecting',
};

/** A literal source reference found in an expression. */
export interface DataRef {
  kind: 'related' | 'layer';
  name: string;
  sublayer?: string;
}

/**
 * Every related table and layer an expression names. Hosts call this
 * before checking to know what to resolve, and to record
 * dependencies.
 */
export function collectDataRefs(e: Expr): DataRef[] {
  const out: DataRef[] = [];
  const seen = new Set<string>();
  walkExpr(e, (n) => {
    if (n.kind !== 'func') return;
    if (n.name !== 'related' && n.name !== 'layer') return;
    const a0 = n.args[0];
    if (!a0 || a0.kind !== 'str') return;
    const a1 = n.args[1];
    const ref: DataRef = { kind: n.name, name: a0.value };
    if (n.name === 'layer' && a1?.kind === 'str') ref.sublayer = a1.value;
    const k = `${ref.kind}|${ref.name}|${ref.sublayer ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(ref);
    }
  });
  return out;
}

/** True when the expression reads any row other than its own. */
export function usesDataAccess(e: Expr): boolean {
  let found = false;
  walkExpr(e, (n) => {
    if (n.kind === 'func' && (n.name === 'related' || n.name === 'layer')) found = true;
  });
  return found;
}
