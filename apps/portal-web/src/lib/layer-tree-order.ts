// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Put map layers in the order the layer panel shows them.
 *
 * The panel draws a tree: each group header, then every layer whose
 * `groupId` names it, children in array order, depth first. The map
 * canvas ignores groups and draws strictly by array position. Moving
 * one element of the array (for example a group header on its own)
 * could therefore show the whole group in its new place while its
 * children kept their old draw order. Rewriting the array in tree
 * order after a move makes "top of the list draws on top" hold again.
 *
 * A layer whose `groupId` does not name a group header is a root, as
 * in the panel. Anything a cycle would hide is kept, at the end.
 */
type TreeLayer = {
  id: string;
  groupId?: string | undefined;
  source: { kind: string };
};

export function toTreeOrder<T extends TreeLayer>(layers: readonly T[]): T[] {
  const headerIds = new Set<string>();
  for (const l of layers) {
    if (l.source.kind === 'group') headerIds.add(l.id);
  }
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const l of layers) {
    if (l.groupId && headerIds.has(l.groupId) && l.groupId !== l.id) {
      const arr = children.get(l.groupId) ?? [];
      arr.push(l);
      children.set(l.groupId, arr);
    } else {
      roots.push(l);
    }
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly T[]) => {
    for (const l of items) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
      const kids = children.get(l.id);
      if (kids) walk(kids);
    }
  };
  walk(roots);
  for (const l of layers) {
    if (!seen.has(l.id)) {
      seen.add(l.id);
      out.push(l);
    }
  }
  return out;
}
