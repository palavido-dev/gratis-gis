// SPDX-License-Identifier: AGPL-3.0-or-later
// Splits a map's layer list into the drawn layer tree and the
// non-spatial tables.
//
// "Add to map" and the Add Layer dialog both add a data layer's
// tables next to its spatial sublayers, so a related table (owners
// of parcels) is in the map for popups, the attribute table and
// search. A table draws nothing, so the layer list shows tables in
// their own section under the tree instead of mixed in with layers
// that have a symbol, an opacity and a draw order.

export interface TableSplitLayer {
  id: string;
  groupId?: string | null;
  source: { kind: string };
}

/**
 * `isTable(id)` answers from the layer's discovered metadata. Groups
 * are never tables. Order inside each list follows the input order.
 */
export function splitTableLayers<T extends TableSplitLayer>(
  layers: readonly T[],
  isTable: (id: string) => boolean,
): { tree: T[]; tables: T[] } {
  const tree: T[] = [];
  const tables: T[] = [];
  for (const l of layers) {
    if (l.source.kind !== 'group' && isTable(l.id)) tables.push(l);
    else tree.push(l);
  }
  return { tree, tables };
}
