// SPDX-License-Identifier: AGPL-3.0-or-later
// Show / hide a layer in a custom app's layer list, cascading through
// layer groups.
//
// The map canvas knows nothing about groups, so hiding a group has to
// hide every descendant layer. Turning the group back on used to flip
// only the group, leaving every child hidden, because the hide had
// overwritten the children's own state. Each group now remembers what
// its descendants looked like when it was hidden and puts that back.

interface ToggleLayer {
  id: string;
  visible: boolean;
  groupId?: string | undefined;
}

/** Remembered descendant visibility, by group id. */
export type GroupVisibilityMemory = Map<string, Map<string, boolean>>;

function descendantsOf(layers: ToggleLayer[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const l of layers) {
      if (l.groupId !== parent || seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l.id);
      stack.push(l.id);
    }
  }
  return out;
}

export function toggleLayerVisibility<T extends ToggleLayer>(
  layers: T[],
  id: string,
  next: boolean,
  memory: GroupVisibilityMemory,
): T[] {
  const below = descendantsOf(layers, id);
  if (!next) {
    if (below.length > 0) {
      const saved = new Map<string, boolean>();
      for (const l of layers) if (below.includes(l.id)) saved.set(l.id, l.visible);
      memory.set(id, saved);
    }
    const off = new Set([id, ...below]);
    return layers.map((l) => (off.has(l.id) ? { ...l, visible: false } : l));
  }
  // Read, not removed: the next hide overwrites it, and leaving it in
  // place keeps this safe to run twice (React may call a state
  // updater twice in development).
  const saved = memory.get(id);
  return layers.map((l) => {
    if (l.id === id) return { ...l, visible: true };
    const was = saved?.get(l.id);
    return was !== undefined && was !== l.visible ? { ...l, visible: was } : l;
  });
}
